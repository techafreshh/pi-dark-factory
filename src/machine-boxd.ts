/**
 * boxd machine mode — the SDK-driven face of the plan, implement and review
 * stages.
 *
 * A lap machine is one disposable boxd microVM (https://boxd.sh) booted from
 * the org's golden snapshot via the official SDK's gRPC control plane. Machine
 * lifecycle (create-from-snapshot / wait / delete / usage) rides the SDK;
 * everything inside the box rides ONE hardened exec primitive — no ssh, no
 * gateway, no port forwards. The scenario runner judges the box's own loopback
 * over that primitive, identically to the instabox lane.
 *
 * Why the wrapper: the SDK's server-side exec `timeoutMs` never surfaces under
 * Bun (the promise neither resolves nor rejects — observed 2026-11-07, all
 * three shapes of backgrounded children), and orphaned children survive. So
 * the deadline is enforced IN-BOX: the payload runs in its own setsid process
 * group, a poll loop TERM→KILLs the group at the deadline, output lands in
 * temp files and is catted back so the exec stream always EOFs cleanly. The
 * client adds a belt-and-suspenders race whose only job is to detect a hung
 * TRANSPORT — its handler is the typed InfraUnavailableError, which the lap
 * defers on exactly like an ssh outage (attempt budget preserved, janitor
 * reaps the box).
 */
import { Boxd } from "@boxd-sh/sdk";
import { buildMachineEnvFile, bootstrapScriptFor, outcomeFromRun, STAGE_DRIVER, InfraUnavailableError, isInfraTransportText, type MachineStageResult, type ShRes } from "./machine";
import { machineNameFor } from "./instabox";
import { resolveSnapshotName } from "./sharedbase";
import { buildPiArgs, type PiOutcome } from "./pi";
import type { ModelSpec, RepoConfig, StageModels } from "./types";
import { branchName } from "./stages/intake";
import { dirname } from "node:path";

const STDOUT_CAP = 4_000_000;
const STDERR_CAP = 20_000;

export function boxdClientFromEnv(): Boxd {
  const key = process.env.BOXD_API_KEY;
  if (!key) throw new Error("BOXD_API_KEY is not set — boxd-mode repos cannot boot machines (set it in factoryd.env)");
  return new Boxd({ apiKey: key });
}

/** The in-box exec wrapper. Proven live 2026-11-07: rc/out/err propagate,
 *  the deadline TERM→KILLs the whole group, zero orphans, streams always EOF. */
export function execWrapper(payloadB64: string, timeoutMs: number, nonce: string): string {
  const deadline = Date.now() + timeoutMs; // box clocks are NTP'd real time
  return `
set -u
# exec hands the box a minimal env — no login shell, so ~/.bun/bin (pi) is
# missing and every stage died 127 "pi: command not found" on the first lap.
# Export the standard PATH before the payload; the inner bash inherits it.
export PATH="$HOME/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
U=/tmp/.pdf-${nonce}-$$
printf %s '${payloadB64}' > $U.b64
setsid bash -c "base64 -d $U.b64 | bash > $U.out 2> $U.err; echo \\$? > $U.rc" &
WP=$!
PG=$(ps -o pgid= -p $WP 2>/dev/null | tr -d ' ')
DEAD=${deadline}
while kill -0 $WP 2>/dev/null; do
  [ "$(date +%s%3N)" -ge "$DEAD" ] && { kill -TERM -- -$PG 2>/dev/null; sleep 1; kill -KILL -- -$PG 2>/dev/null; echo 124 > $U.rc; break; }
  sleep 0.25
done
RC=$(cat $U.rc 2>/dev/null || echo 125)
echo "PDFRC-${nonce}:$RC"
echo "PDFO-${nonce}-START"
head -c ${STDOUT_CAP} $U.out 2>/dev/null
# guarantee a newline BEFORE the END marker: a payload whose last output line
# lacks one (curl -w '%{http_code}' never emits a trailing newline) would fuse
# with the marker and the frame regex would silently drop the whole capture —
# this ate every readiness probe on the first smoke laps (the probes said 200)
echo
echo "PDFO-${nonce}-END"
echo "PDFE-${nonce}-START"
head -c ${STDERR_CAP} $U.err 2>/dev/null
echo
echo "PDFE-${nonce}-END"
rm -f $U.b64 $U.out $U.err $U.rc
`;
}

export function parseWrap(stdout: string, nonce: string): { rc: number; out: string; err: string } {
  const rcM = stdout.match(new RegExp(`PDFRC-${nonce}:(\\d+)`));
  // the wrapper guarantees exactly one newline before each END marker; strip
  // it so the capture stays byte-identical to the payload's own stdout
  const out = stdout.match(new RegExp(`PDFO-${nonce}-START\\n([\\s\\S]*?)\\nPDFO-${nonce}-END`))?.[1]?.replace(/\n$/, "") ?? "";
  const err = stdout.match(new RegExp(`PDFE-${nonce}-START\\n([\\s\\S]*?)\\nPDFE-${nonce}-END`))?.[1]?.replace(/\n$/, "") ?? "";
  return { rc: rcM ? Number(rcM[1]) : 125, out, err };
}

const raceDeadline = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`transport hung past ${ms}ms deadline`)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });

/** Run a script inside a boxd machine. Returns the same ShRes the ssh
 *  transport produces — markers, gates and parsers stay identical. rc 124 =
 *  in-box deadline (timedOut), 125 = wrapper itself failed (platform). */
export async function boxdBash(
  client: Boxd,
  machineId: string,
  script: string,
  opts: { timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<ShRes> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const nonce = Math.random().toString(36).slice(2, 8);
  const wrapped = execWrapper(Buffer.from(script, "utf8").toString("base64"), timeoutMs, nonce);
  let raw: any;
  try {
    // NO server-side timeoutMs — it never returns under Bun; the wrapper owns
    // the deadline, this race only detects a hung transport.
    raw = await raceDeadline((client.machines as any).exec(machineId, { command: ["bash", "-c", wrapped], env: opts.env }), timeoutMs + 15_000);
  } catch (e: any) {
    throw new InfraUnavailableError(`boxd exec transport failure: ${String(e?.message ?? e).slice(0, 160)}`, "ssh");
  }
  const p = parseWrap(String(raw?.stdout ?? ""), nonce);
  return {
    code: p.rc,
    stdout: p.out.slice(0, STDOUT_CAP),
    stderr: p.err.slice(0, STDERR_CAP),
    timedOut: p.rc === 124,
  };
}

/** The stage wire protocol over exec env instead of ssh stdin: the driver
 *  script is byte-identical, only its three `read` lines become assignments
 *  from exec env (base64 payload + "PDFENV " prefix ride env vars safely). */
function stageScriptFor(): string {
  const body = STAGE_DRIVER.split("\n").filter((l) => !/^read -r L_(ENV|ARGS|PROMPT)/.test(l.trim())).join("\n");
  return [`L_ENV="$PDF_L_ENV"`, `L_ARGS="$PDF_L_ARGS"`, `L_PROMPT="$PDF_L_PROMPT"`, body].join("\n");
}

async function runOneStageBoxd(
  client: Boxd,
  machineId: string,
  envFile: string,
  stage: { gates: boolean; branch: string; base: string },
  spec: ModelSpec,
  o: { prompt: string; systemPrompt: string; tools?: string[]; extraArgs?: string[]; sessionDir?: string; timeoutMs: number }
): Promise<{ outcome: PiOutcome; raw: string }> {
  const piArgs = buildPiArgs({
    model: spec,
    tools: o.tools,
    sessionDir: o.sessionDir,
    systemPrompt: o.systemPrompt,
    extraArgs: o.extraArgs,
    prompt: "",
    cwd: "",
    binary: "pi", // unused by buildPiArgs; PI_BIN in the machine decides
  } as any);
  const env = {
    PDF_L_ENV: `PDFENV ${Buffer.from(envFile, "utf8").toString("base64")}`,
    PDF_L_ARGS: `PDFARGS ${Buffer.from(piArgs.join("\0"), "utf8").toString("base64")}`,
    PDF_L_PROMPT: `PDFPROMPT ${Buffer.from(o.prompt, "utf8").toString("base64")}`,
  };
  const res = await boxdBash(client, machineId, stageScriptFor(), { timeoutMs: o.timeoutMs, env });
  return outcomeFromRun(res, spec);
}

/** One stage with the fallback semantics of callMachineStage: provider errors
 *  advance the chain; timeouts and spawn/gate errors stop it. */
export async function callBoxdStage(
  client: Boxd,
  machineId: string,
  o: {
    models: StageModels;
    gates: boolean;
    branch: string;
    base: string;
    envFile: string;
    prompt: string;
    systemPrompt: string;
    tools?: string[];
    extraArgs?: string[];
    sessionDir?: string;
    timeoutMs: number;
  }
): Promise<MachineStageResult> {
  const chain = [o.models.base, ...o.models.fallback];
  const tried: MachineStageResult["modelsTried"] = [];
  let last: PiOutcome = { kind: "provider_error", error: "no models configured" };
  let raw = "";
  for (const spec of chain) {
    const r = await runOneStageBoxd(client, machineId, o.envFile, { gates: o.gates, branch: o.branch, base: o.base }, spec, {
      prompt: o.prompt,
      systemPrompt: o.systemPrompt,
      tools: o.tools,
      extraArgs: o.extraArgs,
      sessionDir: o.sessionDir,
      timeoutMs: o.timeoutMs,
    });
    tried.push({
      spec,
      outcome: r.outcome.kind,
      error: r.outcome.kind === "ok" ? undefined : ("error" in r.outcome ? r.outcome.error : r.outcome.kind),
    });
    last = r.outcome;
    raw = r.raw;
    if (r.outcome.kind === "ok") return { outcome: r.outcome, modelsTried: tried, raw };
    if (r.outcome.kind === "timeout" || r.outcome.kind === "spawn_error") return { outcome: r.outcome, modelsTried: tried, raw };
  }
  return { outcome: last, modelsTried: tried, raw };
}

/**
 * One boxd machine for one issue's lap: created from the golden snapshot on
 * first use, kept across repair rounds (its clone IS the worktree), deleted
 * when the lap books out. Mirrors LapMachine's surface exactly — tick.ts
 * dispatches on mode and holds either behind the same calls.
 */
export class BoxdLapMachine {
  readonly name: string;
  private client: Boxd;
  private machine: any = null;

  constructor(
    private cfg: RepoConfig,
    public issue: number,
    private log: (msg: string) => void = () => {},
    gen?: number,
    private stateDir?: string,
    client?: Boxd
  ) {
    this.client = client ?? boxdClientFromEnv();
    this.name = machineNameFor(cfg.slug, issue, gen);
  }

  private bdx() {
    return this.cfg.env.boxd!;
  }

  private snapshotName(): string {
    const raw = this.bdx().snapshot ?? "factory-base-boxd-r1";
    return this.stateDir ? resolveSnapshotName(this.stateDir, raw) : raw;
  }

  async ensure(): Promise<any> {
    if (this.machine) return this.machine;
    const spec = {
      name: this.name,
      fromSnapshot: this.snapshotName(),
      labels: { factory: "1", repo: this.cfg.repo, issue: String(this.issue) },
    };
    // the SLOT QUEUE, same shape as instabox: the org machine cap is a shared
    // resource; a cap-reject waits, receipted, until a bookout frees a slot.
    const deadline = Date.now() + Number(process.env.PDF_SLOT_QUEUE_DEADLINE_MS ?? 10 * 60_000);
    const delay = Number(process.env.PDF_SLOT_QUEUE_DELAY_MS ?? 60_000);
    let waits = 0;
    for (;;) {
      try {
        this.machine = await (this.client.machines as any).create(spec);
        if (waits > 0) this.log(`machine-slot queue: slot freed after ${waits} wait(s) — booting ${this.name}`);
        break;
      } catch (e: any) {
        const quota = e?.grpcCode === 8 || e?.code === 8 || /machine limit|too many machines|quota|resource.?exhausted/i.test(String(e?.message ?? e));
        if (!quota) throw new InfraUnavailableError(`boxd machine create failed: ${String(e?.message ?? e).slice(0, 160)}`, "ssh");
        if (Date.now() + delay > deadline) {
          throw new InfraUnavailableError(`machine-slot queue exhausted after ${waits} wait(s): ${String(e?.message ?? e).slice(0, 120)}`, "quota");
        }
        waits++;
        this.log(`machine-slot queue: org at its machine cap — waiting ${delay / 1000}s for a slot (wait ${waits}, attempt budget preserved)`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    await (this.client.machines as any).waitUntilReady(this.machine.id, { timeoutMs: 120_000 });
    this.log(`boxd machine ${this.name} ready (${this.machine.id})`);
    return this.machine;
  }

  async bash(script: string, opts: { timeoutMs?: number } = {}): Promise<ShRes> {
    const m = await this.ensure();
    return boxdBash(this.client, m.id, script, opts);
  }

  /** Clone/fetch + check out the issue branch — the same script instabox runs. */
  async bootstrap(): Promise<void> {
    const env = buildMachineEnvFile(this.cfg, {
      gates: false,
      branch: branchName(this.issue),
      base: this.cfg.default_branch,
    });
    const res = await this.bash(env + "\n" + bootstrapScriptFor(this.cfg, branchName(this.issue)), { timeoutMs: 10 * 60_000 });
    if (res.code !== 0 || !res.stdout.includes("BOOTSTRAP_OK")) {
      const detail = (res.stderr.trim() || res.stdout.trim()).slice(0, 300);
      // 255/125 + transport text = PLATFORM failure (gateway-less, but the
      // class is the same: the box or its exec channel is gone) — never an
      // attempt burn. Tear the half-booted box down and defer.
      if (res.code === 255 || res.code === 125 || isInfraTransportText(detail)) {
        await this.destroy().catch(() => {});
        this.machine = null;
        throw new InfraUnavailableError(`boxd machine bootstrap unavailable (exit ${res.code}): ${detail}`, "ssh");
      }
      throw new Error(`boxd machine bootstrap failed (exit ${res.code}): ${detail}`);
    }
  }

  async callStage(
    stage: "plan" | "implement" | "review",
    o: {
      models: StageModels;
      prompt: string;
      systemPrompt: string;
      tools?: string[];
      extraArgs?: string[];
      timeoutMs: number;
    }
  ): Promise<MachineStageResult & { stage: typeof stage }> {
    // same rules as LapMachine.callStage: plan and implement bootstrap the
    // clone, implement alone gates and pushes, plan and review are undone
    if (stage === "plan" || stage === "implement") await this.bootstrap();
    const gates = stage === "implement";
    const envFile = buildMachineEnvFile(this.cfg, { gates, restore: !gates, branch: branchName(this.issue), base: this.cfg.default_branch });
    const m = await this.ensure();
    const res = await callBoxdStage(this.client, m.id, {
      models: o.models,
      gates,
      branch: branchName(this.issue),
      base: this.cfg.default_branch,
      envFile,
      prompt: o.prompt,
      systemPrompt: o.systemPrompt,
      tools: o.tools,
      extraArgs: o.extraArgs,
      // OUTSIDE the clone (sibling of repo_dir) — same rule as instabox: session
      // files must never trip the driver's cleanliness gate nor ride into a PR
      sessionDir: `${dirname(this.repoDir())}/.pdf-sessions/issue-${this.issue}`,
      timeoutMs: o.timeoutMs,
    });
    return { ...res, stage };
  }

  private repoDir(): string {
    return this.bdx().repo_dir;
  }

  /** Best-effort deletion; a lap machine is always safe to lose. */
  async destroy(): Promise<void> {
    try {
      const id = this.machine?.id ?? (await this.findByName())?.id;
      if (!id) return;
      await (this.client.machines as any).delete(id);
      // eventual-consistency lag check, same receipt discipline as instabox
      try {
        if (await this.findByName()) {
          this.log(`boxd machine ${this.name} delete not yet visible (platform lag) — janitor will reap the leftover`);
          return;
        }
      } catch {}
      this.log(`boxd machine ${this.name} deleted`);
    } catch (e: any) {
      this.log(`boxd machine ${this.name} delete failed (janitor will catch it): ${String(e.message).slice(0, 150)}`);
    } finally {
      this.machine = null;
    }
  }

  private async findByName(): Promise<any> {
    try {
      const list = await (this.client.machines as any).list({ region: "all" });
      return (list.machines ?? list).find?.((m: any) => m.name === this.name) ?? null;
    } catch {
      return null;
    }
  }
}

export function openBoxdLapMachine(cfg: RepoConfig, issue: number, log?: (msg: string) => void, gen?: number, stateDir?: string, client?: Boxd): BoxdLapMachine {
  return new BoxdLapMachine(cfg, issue, log, gen, stateDir, client);
}
