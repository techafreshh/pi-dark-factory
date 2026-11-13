/**
 * Daytona machine mode — the third exec-transport face of the plan, implement
 * and review stages (after instabox's ssh gateway and boxd's SDK exec).
 *
 * A lap machine is one disposable Daytona sandbox (https://daytona.io) booted
 * from the repo's golden snapshot via the official TypeScript SDK (officially
 * Bun-supported, @daytona/sdk). Lifecycle rides the SDK; everything inside
 * rides ONE hardened exec primitive — the same in-box setsid TERM→KILL
 * wrapper boxd proved (deadline enforced in-box, output in temp files catted
 * back so the exec stream always EOFs cleanly).
 *
 * Daytona-specific facts this driver is built on (SDK 0.231.1 types, 2026-11-12):
 *   - `executeCommand(command, cwd?, env?, timeoutSec?)` runs the command
 *     string via the sandbox's shell (zsh/bash/sh — the wrapper is sh-safe
 *     and the payload itself forces bash) and returns `result`, the COMBINED
 *     output (split stdout/stderr fields are not in a stable release yet, so
 *     parseWrap reads the framed markers from `result`).
 *   - The server-side kill IS enforced at `timeoutSec` — it defaults to 10
 *     seconds, so every call passes its own deadline; the in-box wrapper's
 *     124 fires first and the server kill is the margin behind it.
 *   - Auto-stop defaults to 15 minutes of INACTIVITY and internal processes
 *     do not reset it — creation pins `autoStopInterval: 0`; a wall-clock
 *     `ttlMinutes` remains the runaway cap.
 *   - Concurrency is bounded by the org's tier resource pool (Tier 1 = 10
 *     vCPU ≈ five 2-vCPU sandboxes); cap-rejects wait in the slot queue
 *     exactly like instabox/boxd.
 */
import { Daytona, type Sandbox } from "@daytona/sdk";
import {
  buildMachineEnvFile,
  bootstrapScriptFor,
  InfraUnavailableError,
  isInfraTransportText,
  outcomeFromRun,
  type LapMachineLike,
  type MachineStageResult,
  type ShRes,
} from "./machine";
import { execWrapper, parseWrap, raceDeadline, stageScriptFor } from "./machine-boxd";
import { machineNameFor } from "./instabox";
import { resolveSnapshotName } from "./sharedbase";
import { buildPiArgs } from "./pi";
import type { ModelSpec, RepoConfig, StageModels } from "./types";
import { branchName } from "./stages/intake";
import { dirname } from "node:path";

const STDOUT_CAP = 4_000_000;
const STDERR_CAP = 20_000;

export function daytonaClientFromEnv(): Daytona {
  const key = process.env.DAYTONA_API_KEY;
  if (!key) throw new Error("DAYTONA_API_KEY is not set — daytona-mode repos cannot boot sandboxes (set it in factoryd.env)");
  return new Daytona({ apiKey: key });
}

/** Run a script inside a Daytona sandbox. Same ShRes shape as every other
 *  transport — markers, gates and parsers stay identical. rc 124 = in-box
 *  deadline (timedOut), 125 = wrapper itself failed (platform). */
export async function daytonaBash(
  sandbox: Pick<Sandbox, "process">,
  script: string,
  opts: { timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<ShRes> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const nonce = Math.random().toString(36).slice(2, 8);
  const wrapped = execWrapper(Buffer.from(script, "utf8").toString("base64"), timeoutMs, nonce);
  let raw: any;
  try {
    // server-side kill in SECONDS, +5s behind the in-box deadline so 124 (not
    // a platform kill) owns the timeout verdict; the SDK long-polls the call.
    const secs = Math.ceil(timeoutMs / 1000) + 5;
    raw = await raceDeadline(sandbox.process.executeCommand(wrapped, undefined, opts.env, secs), timeoutMs + 20_000);
  } catch (e: any) {
    throw new InfraUnavailableError(`daytona exec transport failure: ${String(e?.message ?? e).slice(0, 160)}`, "ssh");
  }
  // 0.231.x returns combined output in `result`; split fields ride artifacts when they land
  const p = parseWrap(String(raw?.result ?? raw?.artifacts?.stdout ?? ""), nonce);
  return { code: p.rc, stdout: p.out.slice(0, STDOUT_CAP), stderr: p.err.slice(0, STDERR_CAP), timedOut: p.rc === 124 };
}

/** One stage with the fallback semantics of callMachineStage: provider errors
 *  advance the chain; timeouts and spawn/gate errors stop it. */
export async function callDaytonaStage(
  sandbox: Pick<Sandbox, "process">,
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
  let last: MachineStageResult["outcome"] = { kind: "provider_error", error: "no models configured" };
  let raw = "";
  for (const spec of chain) {
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
      PDF_L_ENV: `PDFENV ${Buffer.from(o.envFile, "utf8").toString("base64")}`,
      PDF_L_ARGS: `PDFARGS ${Buffer.from(piArgs.join("\0"), "utf8").toString("base64")}`,
      PDF_L_PROMPT: `PDFPROMPT ${Buffer.from(o.prompt, "utf8").toString("base64")}`,
    };
    const res = await daytonaBash(sandbox, stageScriptFor(), { timeoutMs: o.timeoutMs, env });
    const r = outcomeFromRun(res, spec);
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

/** One Daytona sandbox for one issue's lap: created from the golden snapshot
 *  on first use, kept across repair rounds (its clone IS the worktree),
 *  deleted when the lap books out. Mirrors BoxdLapMachine's surface exactly —
 *  tick.ts dispatches on mode and holds either behind the same calls. */
export class DaytonaLapMachine implements LapMachineLike {
  readonly name: string;
  private client: Daytona;
  private sandbox: Sandbox | null = null;

  constructor(
    private cfg: RepoConfig,
    public issue: number,
    private log: (msg: string) => void = () => {},
    gen?: number,
    private stateDir?: string,
    client?: Daytona
  ) {
    this.client = client ?? daytonaClientFromEnv();
    this.name = machineNameFor(cfg.slug, issue, gen);
  }

  private snapshotName(): string {
    const raw = this.cfg.env.daytona?.snapshot ?? "";
    return this.stateDir ? resolveSnapshotName(this.stateDir, raw) : raw;
  }

  private isQuota(e: any): boolean {
    return e?.status === 429 || /quota|limit|capacity|vcpu|too many|resource exhausted/i.test(String(e?.message ?? e));
  }

  async ensure(): Promise<Sandbox> {
    if (this.sandbox) return this.sandbox;
    const snap = this.snapshotName();
    if (!snap) throw new Error(`no golden snapshot configured for daytona — bake it first: foreman bake ${this.cfg.slug}`);
    const spec = {
      snapshot: snap,
      name: this.name,
      labels: { factory: "1", repo: this.cfg.repo, issue: String(this.issue) },
      // auto-stop is inactivity-based and internal processes do NOT reset it —
      // a lap whose agent only writes files would be stopped mid-flight
      autoStopInterval: 0,
      ttlMinutes: Math.max(1, Math.floor(Number(process.env.PDF_DAYTONA_TTL_MINUTES ?? 180))),
    };
    // the SLOT QUEUE, same shape as instabox/boxd: the org's tier pool is a
    // shared resource; a cap-reject waits, receipted, until a bookout frees it.
    const deadline = Date.now() + Number(process.env.PDF_SLOT_QUEUE_DEADLINE_MS ?? 10 * 60_000);
    const delay = Number(process.env.PDF_SLOT_QUEUE_DELAY_MS ?? 60_000);
    let waits = 0;
    for (;;) {
      try {
        // 600s create wait: a first-ever boot from a stock image pulls it
        // cold (recorded: >300s on the first ubuntu:24.04, 2026-11-13);
        // snapshot boots are warm. A create that times out may still have
        // landed — the janitor reaps it by name/labels.
        this.sandbox = await this.client.create(spec, { timeout: 600 });
        if (waits > 0) this.log(`machine-slot queue: slot freed after ${waits} wait(s) — booting ${this.name}`);
        break;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (!this.isQuota(e)) {
          // a missing/typo'd snapshot is a config problem, never an outage —
          // it must fail the lap loudly, not park it in the slot queue
          if (/snapshot/i.test(msg)) throw new Error(`daytona create failed: ${msg.slice(0, 200)}`);
          throw new InfraUnavailableError(`daytona sandbox create failed: ${msg.slice(0, 160)}`, "ssh");
        }
        if (Date.now() + delay > deadline) {
          throw new InfraUnavailableError(`machine-slot queue exhausted after ${waits} wait(s): ${msg.slice(0, 120)}`, "quota");
        }
        waits++;
        this.log(`machine-slot queue: daytona org pool at cap — waiting ${delay / 1000}s for a slot (wait ${waits}, attempt budget preserved)`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    this.log(`daytona sandbox ${this.name} ready (${this.sandbox.id})`);
    return this.sandbox;
  }

  async bash(script: string, opts: { timeoutMs?: number } = {}): Promise<ShRes> {
    const sbx = await this.ensure();
    return daytonaBash(sbx, script, opts);
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
      // 125 = the wrapper itself failed (transport/platform); transport text
      // matches the shared classifier — never an attempt burn
      if (res.code === 125 || isInfraTransportText(detail)) {
        await this.destroy().catch(() => {});
        this.sandbox = null;
        throw new InfraUnavailableError(`daytona bootstrap unavailable (exit ${res.code}): ${detail}`, "ssh");
      }
      throw new Error(`daytona bootstrap failed (exit ${res.code}): ${detail}`);
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
    // same rules as every driver: plan and implement bootstrap the clone,
    // implement alone gates and pushes, plan and review are undone
    if (stage === "plan" || stage === "implement") await this.bootstrap();
    const gates = stage === "implement";
    const envFile = buildMachineEnvFile(this.cfg, { gates, restore: !gates, branch: branchName(this.issue), base: this.cfg.default_branch });
    const sbx = await this.ensure();
    const res = await callDaytonaStage(sbx, {
      models: o.models,
      gates,
      branch: branchName(this.issue),
      base: this.cfg.default_branch,
      envFile,
      prompt: o.prompt,
      systemPrompt: o.systemPrompt,
      tools: o.tools,
      extraArgs: o.extraArgs,
      // OUTSIDE the clone (sibling of repo_dir) — session files must never
      // trip the driver's cleanliness gate nor ride into a PR
      sessionDir: `${dirname(repoDirOf(this.cfg))}/.pdf-sessions/issue-${this.issue}`,
      timeoutMs: o.timeoutMs,
    });
    return { ...res, stage };
  }

  /** Best-effort deletion; a lap machine is always safe to lose. */
  async destroy(): Promise<void> {
    try {
      const sbx = this.sandbox ?? (await this.findByName());
      if (!sbx) return;
      await this.client.delete(sbx);
      // platform-lag visibility, same receipt discipline as instabox/boxd
      try {
        if (await this.findByName()) {
          this.log(`daytona sandbox ${this.name} delete not yet visible (platform lag) — janitor will reap the leftover`);
          return;
        }
      } catch {}
      this.log(`daytona sandbox ${this.name} deleted`);
    } catch (e: any) {
      this.log(`daytona sandbox ${this.name} delete failed (janitor will catch it): ${String(e.message).slice(0, 150)}`);
    } finally {
      this.sandbox = null;
    }
  }

  private async findByName(): Promise<Sandbox | null> {
    try {
      for await (const s of this.client.list({ labels: { factory: "1" } })) {
        if (s.name === this.name) return s;
      }
    } catch {}
    return null;
  }
}

function repoDirOf(cfg: RepoConfig): string {
  return cfg.env.daytona?.repo_dir ?? "";
}

export function openDaytonaLapMachine(cfg: RepoConfig, issue: number, log?: (msg: string) => void, gen?: number, stateDir?: string, client?: Daytona): DaytonaLapMachine {
  return new DaytonaLapMachine(cfg, issue, log, gen, stateDir, client);
}
