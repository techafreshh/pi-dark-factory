/**
 * InstaVM machine mode — the fifth exec-transport face of the plan, implement
 * and review stages.
 *
 * A lap machine is one disposable InstaVM Firecracker microVM
 * (https://instavm.io) booted from the repo's golden snapshot over the
 * documented REST API (raw fetch — the npm SDK is axios-based, stale, and
 * its client `timeout` doubles as the VM lifetime, a footgun; the REST
 * surface this driver needs is small and versioned).
 *
 * Everything inside rides ONE hardened exec primitive — the same in-box
 * setsid TERM→KILL wrapper boxd proved (deadline enforced in-box, output
 * catted back so the exec stream always EOFs cleanly).
 *
 * InstaVM-specific facts this driver is built on (docs, 2026-11-12):
 *   - VMs boot from a snapshot id resolved by name via GET /v1/snapshots;
 *     create takes `vm_lifetime_seconds` (a VM dies when it elapses — set
 *     explicitly, the plan cap is unpublished), `metadata` and `env`.
 *   - Wire shapes recorded from the official Python SDK source (instavm
 *     0.26.1, BandarLabs/sandbox_client, read 2026-11-13 after the first
 *     smoke run 405ed our guessed path): async exec is `POST /execute_async`
 *     (ROOT-level — no /v1) with `{command, session_id, language?}` →
 *     `{task_id}`; the result polls `GET /v1/executions/{task_id}` →
 *     `{is_complete, serialized_stdout, serialized_stderr, cpu_time, …}` —
 *     completion is a boolean flag, and stdout/stderr arrive SPLIT (the
 *     wrapper frames everything onto stdout, so parseWrap reads
 *     serialized_stdout). The sync `POST /execute`'s `timeout` is an HTTP
 *     REQUEST WAIT (max 600 s), NOT a kill — always async + poll; the in-box
 *     wrapper owns the deadline either way.
 *   - Exec takes no env param — the stage wire protocol's PDF_L_* lines are
 *     embedded as exports at the head of the script (they are base64-prefixed
 *     ASCII, safe to single-quote).
 *   - Still UNVERIFIED live (the Free tier 403s VM creation with
 *     `card_required` until a card is on file): whether a Free-tier VM
 *     reaches github.com (egress allowlist names only "package managers +
 *     AI APIs").
 */
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

const EXEC_ASYNC_PATH = "/execute_async"; // root-level — the /v1/executions/… namespace is read-only polling
const execPollMs = () => {
  const n = Number(process.env.PDF_INSTAVM_POLL_MS);
  return Number.isFinite(n) && n > 0 ? n : 3000;
};

export interface InstaVmClientLike {
  /** raw JSON request — the seam the bake paths and the gating smoke use to
   *  reach documented-but-not-yet-modeled endpoints */
  request(method: string, path: string, body?: unknown): Promise<any>;
  createVm(spec: Record<string, any>): Promise<any>;
  getVm(id: string): Promise<any>;
  listVms(): Promise<any[]>;
  deleteVm(id: string): Promise<void>;
  snapshotIdByName(name: string): Promise<string>;
  execAsync(sessionId: string, command: string): Promise<string>;
  pollExecution(taskId: string): Promise<{ is_complete?: boolean; status?: string; serialized_stdout?: string; output?: string }>;
}

export function instavmClientFromEnv(cfg?: RepoConfig): InstaVmClientLike {
  const key = process.env.INSTAVM_API_KEY;
  if (!key) throw new Error("INSTAVM_API_KEY is not set — instavm-mode repos cannot boot VMs (set it in factoryd.env)");
  const base = (cfg?.env.instavm?.api_base ?? process.env.PDF_INSTAVM_API_BASE ?? "https://api.instavm.io").replace(/\/$/, "");
  async function request(method: string, path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { "X-API-Key": key!, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e: any) {
      throw new InfraUnavailableError(`instavm ${method} ${path} transport failure: ${String(e?.message ?? e).slice(0, 140)}`, "ssh");
    }
    const text = await res.text().catch(() => "");
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 400) };
    }
    if (!res.ok) {
      const err: any = new Error(`instavm ${method} ${path} -> ${res.status}: ${text.slice(0, 200) || "(empty)"}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }
  return {
    request,
    async createVm(spec) {
      // ?wait=true: the create endpoint's documented wait-for-provisioning query
      return request("POST", "/v1/vms?wait=true", spec);
    },
    async getVm(id) {
      return request("GET", `/v1/vms/${encodeURIComponent(id)}`);
    },
    async listVms() {
      const res = await request("GET", "/v1/vms");
      // the SDK's list returns a BARE ARRAY (recorded from sandbox_client.py)
      return Array.isArray(res) ? res : (res.vms ?? res.items ?? []);
    },
    async deleteVm(id) {
      await request("DELETE", `/v1/vms/${encodeURIComponent(id)}`);
    },
    async snapshotIdByName(name) {
      const res = await request("GET", "/v1/snapshots");
      const items = Array.isArray(res) ? res : (res.snapshots ?? res.items ?? []);
      const hit = items.find((s: any) => s.name === name);
      if (!hit) throw new Error(`instavm snapshot "${name}" not found — bake it first: foreman bake <slug>`);
      return String(hit.id ?? hit.snapshot_id);
    },
    async execAsync(sessionId, command) {
      // recorded: POST {root}/execute_async {command, session_id, language?} → {task_id}
      const res = await request("POST", EXEC_ASYNC_PATH, { command, session_id: sessionId, language: "bash" });
      return String(res.task_id ?? res.taskId ?? res.execution_id ?? "");
    },
    async pollExecution(taskId) {
      // recorded: GET /v1/executions/{task_id} → {is_complete, serialized_stdout, …}
      return request("GET", `/v1/executions/${encodeURIComponent(taskId)}`);
    },
  };
}

const envLines = (env?: Record<string, string>): string =>
  Object.entries(env ?? {})
    .map(([k, v]) => `export ${k}='${v}'`)
    .join("\n");

/** Run a script inside an InstaVM VM: async exec + poll. Same ShRes shape as
 *  every other transport. rc 124 = in-box deadline, 125 = wrapper failed. */
export async function instavmBash(
  client: InstaVmClientLike,
  sessionId: string,
  script: string,
  opts: { timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<ShRes> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const nonce = Math.random().toString(36).slice(2, 8);
  const wrapped = execWrapper(Buffer.from(script, "utf8").toString("base64"), timeoutMs, nonce);
  const head = envLines(opts.env);
  // submit + poll failures are the PLATFORM (an HTTP error or a dead
  // transport can never be the implementer's work) — typed defer either way
  const taskId = await raceDeadline(
    (async () => {
      let t: string;
      try {
        t = await client.execAsync(sessionId, head ? `${head}\n${wrapped}` : wrapped);
      } catch (e: any) {
        if (e instanceof InfraUnavailableError) throw e;
        throw new InfraUnavailableError(`instavm exec submit failure: ${String(e?.message ?? e).slice(0, 140)}`, "ssh");
      }
      if (!t) throw new InfraUnavailableError("instavm async exec returned no task id", "ssh");
      return t;
    })(),
    30_000
  );
  // poll past the deadline so a task that is merely queued is not read as hung
  const raw = await raceDeadline(
    (async () => {
      for (;;) {
        let r: { is_complete?: boolean; status?: string; serialized_stdout?: string; output?: string };
        try {
          r = await client.pollExecution(taskId);
        } catch (e: any) {
          if (e instanceof InfraUnavailableError) throw e;
          throw new InfraUnavailableError(`instavm exec poll failure: ${String(e?.message ?? e).slice(0, 140)}`, "ssh");
        }
        // recorded completion shape: a boolean is_complete flag (status is a
        // legacy fallback); failures surface on the next parse (rc != 0/125)
        if (r?.is_complete === true) return r;
        const status = String(r?.status ?? "").toLowerCase();
        if (status === "completed" || status === "failed" || status === "error" || status === "done") return r;
        await new Promise((res) => setTimeout(res, execPollMs()));
      }
    })(),
    timeoutMs + 120_000
  );
  // serialized_stdout carries the framed capture (the wrapper prints every
  // frame to stdout); `output` stays the fallback for older shapes
  const p = parseWrap(String(raw?.serialized_stdout ?? raw?.output ?? ""), nonce);
  return { code: p.rc, stdout: p.out.slice(0, STDOUT_CAP), stderr: p.err.slice(0, STDERR_CAP), timedOut: p.rc === 124 };
}

/** One stage with the fallback semantics of callMachineStage. */
export async function callInstavmStage(
  client: InstaVmClientLike,
  sessionId: string,
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
    const res = await instavmBash(client, sessionId, stageScriptFor(), { timeoutMs: o.timeoutMs, env });
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

/** One InstaVM VM for one issue's lap. Mirrors BoxdLapMachine's surface. */
export class InstavmLapMachine implements LapMachineLike {
  readonly name: string;
  private client: InstaVmClientLike;
  private vm: any = null;

  constructor(
    private cfg: RepoConfig,
    public issue: number,
    private log: (msg: string) => void = () => {},
    gen?: number,
    private stateDir?: string,
    client?: InstaVmClientLike
  ) {
    this.client = client ?? instavmClientFromEnv(cfg);
    this.name = machineNameFor(cfg.slug, issue, gen);
  }

  private snapshotName(): string {
    const raw = this.cfg.env.instavm?.snapshot ?? "";
    return this.stateDir ? resolveSnapshotName(this.stateDir, raw) : raw;
  }

  private isQuota(e: any): boolean {
    return e?.status === 429 || /quota|limit|concurrent|capacity|too many/i.test(String(e?.message ?? e));
  }

  async ensure(): Promise<any> {
    if (this.vm) return this.vm;
    const snap = this.snapshotName();
    if (!snap) throw new Error(`no golden snapshot configured for instavm — bake it first: foreman bake ${this.cfg.slug}`);
    const snapshotId = await this.client.snapshotIdByName(snap);
    const spec = {
      snapshot_id: snapshotId,
      vm_lifetime_seconds: Math.max(600, Math.floor(Number(process.env.PDF_INSTAVM_TTL_S ?? 7200))),
      metadata: { factory: "1", repo: this.cfg.repo, issue: String(this.issue), name: this.name },
      env: {},
    };
    // the SLOT QUEUE, same shape as the other drivers: the plan's concurrent-VM
    // cap (5 on Free) is a shared resource; a cap-reject waits, receipted.
    const deadline = Date.now() + Number(process.env.PDF_SLOT_QUEUE_DEADLINE_MS ?? 10 * 60_000);
    const delay = Number(process.env.PDF_SLOT_QUEUE_DELAY_MS ?? 60_000);
    let waits = 0;
    for (;;) {
      try {
        this.vm = await this.client.createVm(spec);
        if (waits > 0) this.log(`machine-slot queue: slot freed after ${waits} wait(s) — booting ${this.name}`);
        break;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (!this.isQuota(e)) {
          if (/snapshot/i.test(msg)) throw new Error(`instavm create failed: ${msg.slice(0, 200)}`);
          throw new InfraUnavailableError(`instavm VM create failed: ${msg.slice(0, 160)}`, "ssh");
        }
        if (Date.now() + delay > deadline) {
          throw new InfraUnavailableError(`machine-slot queue exhausted after ${waits} wait(s): ${msg.slice(0, 120)}`, "quota");
        }
        waits++;
        this.log(`machine-slot queue: instavm plan at its VM cap — waiting ${delay / 1000}s for a slot (wait ${waits}, attempt budget preserved)`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    this.log(`instavm VM ${this.name} ready (${this.vm.vm_id ?? this.vm.id})`);
    return this.vm;
  }

  private vmId(): string {
    return String(this.vm?.vm_id ?? this.vm?.id ?? "");
  }

  private sessionId(): string {
    return String(this.vm?.session_id ?? this.vmId());
  }

  async bash(script: string, opts: { timeoutMs?: number } = {}): Promise<ShRes> {
    await this.ensure();
    try {
      return await instavmBash(this.client, this.sessionId(), script, opts);
    } catch (e: any) {
      // a VM that hit its lifetime wall (or is simply gone) is the platform,
      // not the work — tear the VM down and defer, whatever wrapper class the
      // failure arrived in (submit/poll failures come pre-wrapped as infra)
      const msg = String(e?.message ?? e);
      if (/lifetime|expired|terminated|not found|no longer/i.test(msg)) {
        await this.destroy().catch(() => {});
        this.vm = null;
        throw new InfraUnavailableError(`instavm VM unavailable: ${msg.slice(0, 160)}`, "ssh");
      }
      if (e instanceof InfraUnavailableError) throw e;
      throw e;
    }
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
        this.vm = null;
        throw new InfraUnavailableError(`instavm bootstrap unavailable (exit ${res.code}): ${detail}`, "ssh");
      }
      throw new Error(`instavm bootstrap failed (exit ${res.code}): ${detail}`);
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
    await this.ensure();
    const res = await callInstavmStage(this.client, this.sessionId(), {
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
    const found: any = this.vm ?? (await this.findByName());
    const id = this.vm ? this.vmId() : String(found?.vm_id ?? found?.id ?? "");
    try {
      if (!id) return;
      await this.client.deleteVm(String(id));
      this.log(`instavm VM ${this.name} deleted`);
    } catch (e: any) {
      this.log(`instavm VM ${this.name} delete failed (janitor will catch it): ${String(e.message).slice(0, 150)}`);
    } finally {
      this.vm = null;
    }
  }

  private async findByName(): Promise<any> {
    try {
      const all = await this.client.listVms();
      return all.find((m) => m?.metadata?.name === this.name) ?? null;
    } catch {
      return null;
    }
  }
}

function repoDirOf(cfg: RepoConfig): string {
  return cfg.env.instavm?.repo_dir ?? "";
}

export function openInstavmLapMachine(cfg: RepoConfig, issue: number, log?: (msg: string) => void, gen?: number, stateDir?: string, client?: InstaVmClientLike): InstavmLapMachine {
  return new InstavmLapMachine(cfg, issue, log, gen, stateDir, client);
}
