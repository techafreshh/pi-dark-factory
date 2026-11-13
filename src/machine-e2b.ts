/**
 * E2B machine mode — the fourth exec-transport face of the plan, implement
 * and review stages.
 *
 * A lap machine is one disposable E2B Firecracker sandbox (https://e2b.dev)
 * booted from the repo's golden template via the official TypeScript SDK
 * (`e2b`). Lifecycle rides the SDK's control plane; everything inside rides
 * ONE hardened exec primitive — the same in-box setsid TERM→KILL wrapper
 * boxd proved (deadline enforced in-box, output catted back so the exec
 * stream always EOFs cleanly).
 *
 * E2B-specific facts this driver is built on (SDK e2b@2.63.0 types, 2026-11-12):
 *   - `Sandbox.create(template, {timeoutMs, metadata, envs})` — the create
 *     TTL defaults to 300 SECONDS when omitted, and its default expiry
 *     action is a silent KILL. Every create passes an explicit TTL
 *     (PDF_E2B_TTL_MS, default 55 min — Hobby plans cap continuous runtime
 *     at 1 h) and every stage refreshes it from now via `setTimeout`.
 *   - `commands.run(cmd, {timeoutMs, envs})` executes as `/bin/bash -l -c`
 *     and returns CommandResult{exitCode, stdout, stderr} — but THROWS
 *     `CommandExitError` (which carries the result) on a non-zero exit. The
 *     wrapper always exits 0 on its own, so a thrown error with a `stdout`
 *     field is still parsed for markers, not treated as infra.
 *   - The server-side command kill IS enforced at `timeoutMs` (default
 *     60 s!) — every call passes its own deadline +30 s behind the in-box
 *     wrapper's 124.
 *   - Sandbox resources (vCPU/RAM) come from the TEMPLATE's build settings,
 *     not per-create options.
 */
import { Sandbox } from "e2b";
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

const DEFAULT_TTL_MS = 55 * 60_000;

/** The SDK seam: statics on the real Sandbox class are awkward to stub, so
 *  the driver talks to this narrow face and tests inject fakes. Listing only
 *  promises the fields the driver reads — the full SandboxInfo stays the
 *  SDK's business. */
export interface E2bSandboxRef {
  sandboxId: string;
  metadata?: Record<string, string>;
}
export interface E2bLike {
  create(template: string, opts: { timeoutMs: number; metadata: Record<string, string> }): Promise<any>;
  list(): Promise<E2bSandboxRef[]>;
  kill(id: string): Promise<unknown>;
  setTimeout(id: string, ms: number): Promise<unknown>;
}

export function e2bFromEnv(): E2bLike {
  if (!process.env.E2B_API_KEY)
    throw new Error("E2B_API_KEY is not set — e2b-mode repos cannot boot sandboxes (set it in factoryd.env)");
  return {
    async create(template, opts) {
      return Sandbox.create(template, opts);
    },
    async list() {
      const page = Sandbox.list({ query: { metadata: { factory: "1" } } });
      const out: E2bSandboxRef[] = [];
      while (page.hasNext) out.push(...(await page.nextItems()));
      return out;
    },
    kill(id) {
      return Sandbox.kill(id);
    },
    setTimeout(id, ms) {
      return Sandbox.setTimeout(id, ms);
    },
  };
}

export function e2bTtlMs(): number {
  const n = Number(process.env.PDF_E2B_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

/** Run a script inside an E2B sandbox. Same ShRes shape as every other
 *  transport. rc 124 = in-box deadline (timedOut), 125 = wrapper failed. */
export async function e2bBash(
  sbx: { commands: { run(cmd: string, opts?: any): Promise<any> } },
  script: string,
  opts: { timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<ShRes> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const nonce = Math.random().toString(36).slice(2, 8);
  const wrapped = execWrapper(Buffer.from(script, "utf8").toString("base64"), timeoutMs, nonce);
  let raw: any;
  try {
    // /bin/bash -l -c runs the string; server kill rides +30s behind the
    // in-box deadline so rc 124 owns the timeout verdict
    raw = await raceDeadline(sbx.commands.run(wrapped, { timeoutMs: timeoutMs + 30_000, envs: opts.env }), timeoutMs + 45_000);
  } catch (e: any) {
    // CommandExitError carries the CommandResult — the wrapper's framed
    // output is still in stdout; only a transport-shaped failure is infra
    if (e && typeof e === "object" && "exitCode" in e && "stdout" in e) {
      raw = e;
    } else {
      throw new InfraUnavailableError(`e2b exec transport failure: ${String(e?.message ?? e).slice(0, 160)}`, "ssh");
    }
  }
  const p = parseWrap(String(raw?.stdout ?? ""), nonce);
  return { code: p.rc, stdout: p.out.slice(0, STDOUT_CAP), stderr: p.err.slice(0, STDERR_CAP), timedOut: p.rc === 124 };
}

/** One stage with the fallback semantics of callMachineStage. */
export async function callE2bStage(
  sbx: { commands: { run(cmd: string, opts?: any): Promise<any> } },
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
      binary: "pi",
    } as any);
    const env = {
      PDF_L_ENV: `PDFENV ${Buffer.from(o.envFile, "utf8").toString("base64")}`,
      PDF_L_ARGS: `PDFARGS ${Buffer.from(piArgs.join("\0"), "utf8").toString("base64")}`,
      PDF_L_PROMPT: `PDFPROMPT ${Buffer.from(o.prompt, "utf8").toString("base64")}`,
    };
    const res = await e2bBash(sbx, stageScriptFor(), { timeoutMs: o.timeoutMs, env });
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

/** One E2B sandbox for one issue's lap. Mirrors BoxdLapMachine's surface. */
export class E2bLapMachine implements LapMachineLike {
  readonly name: string;
  private client: E2bLike;
  private sbx: any = null;

  constructor(
    private cfg: RepoConfig,
    public issue: number,
    private log: (msg: string) => void = () => {},
    gen?: number,
    private stateDir?: string,
    client?: E2bLike
  ) {
    this.client = client ?? e2bFromEnv();
    this.name = machineNameFor(cfg.slug, issue, gen);
  }

  private templateName(): string {
    const raw = this.cfg.env.e2b?.snapshot ?? "";
    return this.stateDir ? resolveSnapshotName(this.stateDir, raw) : raw;
  }

  private isQuota(e: any): boolean {
    return (
      e?.status === 429 ||
      /quota|limit|capacity|too many|cluster_at_capacity|sandbox_capacity|placement/i.test(String(e?.message ?? e))
    );
  }

  async ensure(): Promise<any> {
    if (this.sbx) return this.sbx;
    const template = this.templateName();
    if (!template) throw new Error(`no golden template configured for e2b — bake it first: foreman bake ${this.cfg.slug}`);
    const spec = {
      timeoutMs: e2bTtlMs(),
      metadata: { factory: "1", repo: this.cfg.repo, issue: String(this.issue), name: this.name },
    };
    // the SLOT QUEUE, same shape as instabox/boxd/daytona: the plan's
    // concurrency is a shared resource; a cap/capacity reject waits, receipted.
    const deadline = Date.now() + Number(process.env.PDF_SLOT_QUEUE_DEADLINE_MS ?? 10 * 60_000);
    const delay = Number(process.env.PDF_SLOT_QUEUE_DELAY_MS ?? 60_000);
    let waits = 0;
    for (;;) {
      try {
        this.sbx = await this.client.create(template, spec);
        if (waits > 0) this.log(`machine-slot queue: slot freed after ${waits} wait(s) — booting ${this.name}`);
        break;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (!this.isQuota(e)) {
          if (/template/i.test(msg)) throw new Error(`e2b create failed: ${msg.slice(0, 200)}`);
          throw new InfraUnavailableError(`e2b sandbox create failed: ${msg.slice(0, 160)}`, "ssh");
        }
        if (Date.now() + delay > deadline) {
          throw new InfraUnavailableError(`machine-slot queue exhausted after ${waits} wait(s): ${msg.slice(0, 120)}`, "quota");
        }
        waits++;
        this.log(`machine-slot queue: e2b plan at its concurrency cap — waiting ${delay / 1000}s for a slot (wait ${waits}, attempt budget preserved)`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    this.log(`e2b sandbox ${this.name} ready (${this.sbx.sandboxId})`);
    return this.sbx;
  }

  async bash(script: string, opts: { timeoutMs?: number } = {}): Promise<ShRes> {
    const sbx = await this.ensure();
    return e2bBash(sbx, script, opts);
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
      if (res.code === 125 || isInfraTransportText(detail)) {
        await this.destroy().catch(() => {});
        this.sbx = null;
        throw new InfraUnavailableError(`e2b bootstrap unavailable (exit ${res.code}): ${detail}`, "ssh");
      }
      throw new Error(`e2b bootstrap failed (exit ${res.code}): ${detail}`);
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
    if (stage === "plan" || stage === "implement") await this.bootstrap();
    const gates = stage === "implement";
    const envFile = buildMachineEnvFile(this.cfg, { gates, restore: !gates, branch: branchName(this.issue), base: this.cfg.default_branch });
    const sbx = await this.ensure();
    // the create TTL counts from NOW and its expiry action is a silent kill —
    // refresh it before every stage so a lap that lives stage-to-stage never
    // dies mid-stream (Hobby caps the continuous window at 1 h total)
    try {
      await this.client.setTimeout(sbx.sandboxId, e2bTtlMs());
    } catch {}
    const res = await callE2bStage(sbx, {
      models: o.models,
      gates,
      branch: branchName(this.issue),
      base: this.cfg.default_branch,
      envFile,
      prompt: o.prompt,
      systemPrompt: o.systemPrompt,
      tools: o.tools,
      extraArgs: o.extraArgs,
      // OUTSIDE the clone (sibling of repo_dir) — same rule as every driver
      sessionDir: `${dirname(repoDirOf(this.cfg))}/.pdf-sessions/issue-${this.issue}`,
      timeoutMs: o.timeoutMs,
    });
    return { ...res, stage };
  }

  /** Best-effort deletion; a lap machine is always safe to lose. */
  async destroy(): Promise<void> {
    const id = this.sbx?.sandboxId ?? (await this.findByName())?.sandboxId;
    try {
      if (!id) return;
      await this.client.kill(id);
      this.log(`e2b sandbox ${this.name} deleted`);
    } catch (e: any) {
      this.log(`e2b sandbox ${this.name} delete failed (janitor will catch it): ${String(e.message).slice(0, 150)}`);
    } finally {
      this.sbx = null;
    }
  }

  private async findByName(): Promise<E2bSandboxRef | null> {
    try {
      const all = await this.client.list();
      return all.find((s) => s.metadata?.name === this.name) ?? null;
    } catch {
      return null;
    }
  }
}

function repoDirOf(cfg: RepoConfig): string {
  return cfg.env.e2b?.repo_dir ?? "";
}

export function openE2bLapMachine(cfg: RepoConfig, issue: number, log?: (msg: string) => void, gen?: number, stateDir?: string, client?: E2bLike): E2bLapMachine {
  return new E2bLapMachine(cfg, issue, log, gen, stateDir, client);
}
