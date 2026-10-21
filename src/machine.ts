/**
 * InstaBox machine mode — the remote face of the implement-and-review stages.
 *
 * A lap machine is one disposable InstaBox microVM per issue, booted from the
 * repo's golden snapshot (or a template until it's baked). Stages run INSIDE
 * it over SSH (their gateway: token-as-username, local port forwarding
 * supported), so the factory host needs nothing but an ssh client: no Docker,
 * no bind mounts. The machine's /data holds the repo clone; the stage driver
 * enforces the same deterministic gates as the host (clean tree, real commits)
 * and pushes the branch itself — the foreman only fetches and re-checks.
 *
 * Wire protocol (ssh stdin, `read` lines):
 *   line 1: base64 of the static stage driver
 *   line 2: PDFENV   <base64 of env.sh>   — env exports + stage constants
 *   line 3: PDFARGS  <base64 of pi argv>  — NUL-joined
 *   line 4: PDFPROMPT <base64 of prompt>
 * The ssh command string itself is a fixed bootstrap; prompts and keys never
 * appear in it.
 *
 * Machine lifetime: created lazily at the first implement attempt, reused
 * across repair rounds and reclaimed laps (its clone is the worktree), deleted
 * when the lap books out. An infra crash leaves it parked for the janitor.
 */
import { killTree, sh } from "./sh";
import { buildPiArgs, type PiOutcome } from "./pi";
import { parseEventStream } from "./pievents";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { InstaBox, machineNameFor, type InstaMachine, type InstaSshToken } from "./instabox";
import type { ModelSpec, RepoConfig, StageModels } from "./types";
import { branchName } from "./stages/intake";

export interface SshTarget {
  host: string;
  port: number;
  user: string; // an ibssh_ token: username auth, keyless
}

export interface ShRes {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const STDOUT_CAP = 4_000_000;
const STDERR_CAP = 20_000;

export function escapeSh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Test seam: tests point PDF_SSH_BIN at a fake gateway (and custom ssh paths can too). */
const sshBin = () => process.env.PDF_SSH_BIN || "ssh";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/**
 * Run a shell script inside the machine. The script rides on stdin as a
 * single base64 line; the ssh command is a fixed bootstrap — no quoting of
 * user-controlled text ever passes through a shell on either side.
 */
export async function machineBash(conn: SshTarget, script: string, opts: { timeoutMs?: number } = {}): Promise<ShRes> {
  const res = await sh(sshArgv(conn, BASH_S_REMOTE), {
    input: b64(script) + "\n",
    timeoutMs: opts.timeoutMs ?? 120000,
    killGroup: true,
  });
  return { code: res.code, stdout: res.stdout.slice(0, STDOUT_CAP), stderr: res.stderr.slice(0, STDERR_CAP), timedOut: res.timedOut };
}

export function sshArgv(conn: SshTarget, remoteCommand: string): string[] {
  return [
    sshBin(),
    "-p", String(conn.port),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15",
    `${conn.user}@${conn.host}`,
    remoteCommand,
  ];
}

const BASH_S_REMOTE = `cat > /tmp/.pdfin.$$; base64 -d /tmp/.pdfin.$$ | bash; RC=$?; rm -f /tmp/.pdfin.$$; exit $RC`;

const STAGE_BOOTSTRAP_REMOTE =
  `read -r L; printf %s "$L" | base64 -d > /tmp/.pdfdrv.$$; bash /tmp/.pdfdrv.$$; RC=$?; rm -f /tmp/.pdfdrv.$$; exit $RC`;

/**
 * The stage driver. Static code; all per-run values arrive through env.sh.
 * Gate order mirrors the host implementation exactly: clean tree, ≥1 real
 * commit ahead of base, then the push — because state gates stay deterministic
 * no matter which side of an SSH tunnel they run on.
 */
const STAGE_DRIVER = [
  `set -u`,
  `read -r L_ENV || exit 90`,
  `read -r L_ARGS || exit 90`,
  `read -r L_PROMPT || exit 90`,
  `D=$(mktemp -d "\${TMPDIR:-/tmp}/pdfstage.XXXXXX")`,
  `trap 'rm -rf "$D"' EXIT`,
  `printf %s "\${L_ENV#PDFENV }" | base64 -d > "$D/env.sh"`,
  `printf %s "\${L_ARGS#PDFARGS }" | base64 -d > "$D/args.bin"`,
  `printf %s "\${L_PROMPT#PDFPROMPT }" | base64 -d > "$D/prompt.md"`,
  `. "$D/env.sh"`,
  `cd "$REPO_DIR" || { echo "PDFRC=94" >&2; echo "cd $REPO_DIR failed" >&2; exit 94; }`,
  `mapfile -d '' PI_ARGS < "$D/args.bin"`,
  `"$PI_BIN" "\${PI_ARGS[@]}" < "$D/prompt.md" > "$D/pi.jsonl" 2> "$D/pi.err"`,
  `RC=$?`,
  `MARK="PDFRC=$RC"`,
  `if [ "$PDF_GATES" = "1" ] && [ "$RC" -eq 0 ]; then`,
  `  DIRTY=$(git status --porcelain | head -5)`,
  `  if [ -n "$DIRTY" ]; then`,
  `    echo "$DIRTY" >&2`,
  `    MARK="PDFGATE=uncommitted changes left behind"`,
  `  else`,
  `    AHEAD=$(git rev-list --count "origin/$PDF_BASE..HEAD" 2>/dev/null || echo 0)`,
  `    if [ "\${AHEAD:-0}" -lt 1 ]; then`,
  `      MARK="PDFGATE=no commits ahead of base — nothing was implemented"`,
  `    elif ! git push -q origin "HEAD:refs/heads/$PDF_BRANCH" 2> "$D/push.err"; then`,
  `      tail -c 600 "$D/push.err" >&2`,
  `      MARK="PDFGATE=git push of $PDF_BRANCH failed"`,
  `    fi`,
  `  fi`,
  `fi`,
  `echo "$MARK"`,
  `if [ "$RC" -ne 0 ]; then tail -c 1200 "$D/pi.err" >&2; fi`,
  `cat "$D/pi.jsonl"`,
].join("\n");

/** Which host env vars ride into the machine for every stage (keys, GH token). */
export function buildMachineEnvFile(cfg: RepoConfig, stage: { gates: boolean; branch: string; base: string }): string {
  const lines = [
    `export PI_BIN=${escapeSh(cfg.pi.binary)}`,
    `export REPO_DIR=${escapeSh(cfg.env.instabox.repo_dir)}`,
    `export PDF_GATES=${stage.gates ? "1" : "0"}`,
    `export PDF_BRANCH=${escapeSh(stage.branch)}`,
    `export PDF_BASE=${escapeSh(stage.base)}`,
  ];
  for (const key of cfg.env.pass_env ?? []) {
    const v = process.env[key];
    if (v !== undefined && v !== "") lines.push(`export ${key}=${escapeSh(v)}`);
  }
  return lines.join("\n") + "\n";
}

/** Where the machine clones the repo from. */
export function originUrlFor(cfg: RepoConfig): string {
  return cfg.origin_url ?? `https://github.com/${cfg.repo}.git`;
}

/** Idempotent: clone once, fetch after; keep a repair round's local branch. */
export function bootstrapScriptFor(cfg: RepoConfig, branch: string): string {
  const ibx = cfg.env.instabox;
  const b = (s: string) => escapeSh(s);
  return [
    `set -eu`,
    `if [ -n "\${GITHUB_TOKEN:-}" ]; then git config --global url."https://x-access-token:$GITHUB_TOKEN@github.com/".insteadOf "https://github.com/" 2>/dev/null || true; fi`,
    `if [ ! -d ${b(ibx.repo_dir)}/.git ]; then`,
    `  git clone --no-checkout ${b(originUrlFor(cfg))} ${b(ibx.repo_dir)} || git clone ${b(originUrlFor(cfg))} ${b(ibx.repo_dir)}`,
    `else`,
    `  git -C ${b(ibx.repo_dir)} fetch origin --prune || true`,
    `fi`,
    `cd ${b(ibx.repo_dir)}`,
    `if git show-ref --verify -q refs/heads/${b(branch)}; then`,
    `  git checkout -q ${b(branch)}`,
    `else`,
    `  git checkout -q -B ${b(branch)} "origin/${cfg.default_branch}"`,
    `fi`,
    `echo "BOOTSTRAP_OK"`,
  ].join("\n");
}

export interface MachineStageResult {
  outcome: PiOutcome;
  modelsTried: { spec: ModelSpec; outcome: PiOutcome["kind"]; error?: string }[];
  /** raw pi JSONL from the winning attempt — the machine-side forensics */
  raw: string;
}

function outcomeFromRun(res: ShRes, spec: ModelSpec): { outcome: PiOutcome; raw: string } {
  if (res.timedOut) return { outcome: { kind: "timeout" }, raw: "" };
  const lines = res.stdout.split("\n");
  const markerIdx = lines.findIndex((l) => /^(PDFRC=|PDFGATE=)/.test(l.trim()));
  if (markerIdx < 0) {
    const detail = res.stderr.trim().split("\n").slice(-4).join("; ").slice(0, 300) || "no output";
    return {
      outcome: { kind: "spawn_error", error: `no stage marker from machine (exit ${res.code}): ${detail}` },
      raw: "",
    };
  }
  const marker = lines[markerIdx].trim();
  const jsonl = lines.slice(markerIdx + 1).filter((l) => l.trim().length > 0);
  const raw = jsonl.join("\n") + (jsonl.length ? "\n" : "");
  if (marker.startsWith("PDFGATE=")) {
    const detail = res.stderr.trim().split("\n").slice(-6).join(" | ").slice(0, 400);
    return {
      outcome: { kind: "spawn_error", error: `machine gate failed (${marker.slice("PDFGATE=".length)}): ${detail}` },
      raw,
    };
  }
  const rc = Number(marker.slice("PDFRC=".length));
  const parsed = parseEventStream(jsonl);
  if (rc !== 0) {
    const detail = parsed.errorHint ?? res.stderr.trim().split("\n").slice(-4).join("; ");
    return { outcome: { kind: "provider_error", error: `pi exited ${rc} in machine: ${(detail || "unknown").slice(0, 500)}` }, raw };
  }
  if (parsed.assistantText === null) {
    const detail = (parsed.errorHint ?? res.stderr.trim()).slice(0, 300);
    return { outcome: { kind: "provider_error", error: `machine model produced no final text: ${detail}` }, raw };
  }
  return { outcome: { kind: "ok", text: parsed.assistantText, usage: parsed.usage }, raw };
}

async function runOneStage(
  conn: SshTarget,
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
  const payload = [
    b64(STAGE_DRIVER),
    `PDFENV ${b64(envFile)}`,
    `PDFARGS ${b64(piArgs.join("\0"))}`,
    `PDFPROMPT ${b64(o.prompt)}`,
  ].join("\n") + "\n";
  const res = await sh(sshArgv(conn, STAGE_BOOTSTRAP_REMOTE), {
    input: payload,
    timeoutMs: o.timeoutMs,
    killGroup: true,
  });
  return outcomeFromRun(
    { code: res.code, stdout: res.stdout.slice(0, STDOUT_CAP), stderr: res.stderr.slice(0, STDERR_CAP), timedOut: res.timedOut },
    spec
  );
}

/**
 * One stage with the fallback semantics of callPiWithFallback: provider
 * errors advance the chain; timeouts and spawn/gate errors stop it (a gate
 * failure is our wrapper's verdict, not the model's, and re-asking another
 * model re-runs the same gates).
 */
export async function callMachineStage(
  conn: SshTarget,
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
    const r = await runOneStage(conn, o.envFile, { gates: o.gates, branch: o.branch, base: o.base }, spec, {
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

/** Keep forwarded ports alive for the duration of a scenario run. */
export class PortForwarder {
  private proc: any = null;
  private exit: Promise<number> = Promise.resolve(0);

  static start(conn: SshTarget, ports: number[]): PortForwarder {
    if (ports.length === 0) return new PortForwarder();
    const argv = [
      sshBin(),
      "-N",
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=15",
      "-p", String(conn.port),
      `${conn.user}@${conn.host}`,
      ...ports.flatMap((p) => ["-L", `127.0.0.1:${p}:127.0.0.1:${p}`]),
    ];
    const f = new PortForwarder();
    // node:child_process detached — same transport lesson sh.ts carries: the
    // Bun spawn parked inside long-lived factory processes; detached also puts
    // the tunnel in its own process group so killTree reaps ssh + children.
    let child: ChildProcess;
    try {
      child = nodeSpawn(argv[0], argv.slice(1), {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {
      return new PortForwarder(); // nothing to stop later
    }
    f.proc = child;
    f.exit = new Promise<number>((resolve) => {
      child.once("exit", (code) => resolve(code ?? 0));
    }).catch(() => 0) as Promise<number>;
    return f;
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    killTree(this.proc.pid);
    await Promise.race([this.exit, new Promise((r) => setTimeout(r, 5000))]).catch(() => {});
    this.proc = null;
  }
}

/**
 * One machine for one issue's lap: ensured from the golden snapshot on first
 * use, kept across repair rounds (its clone IS the worktree), deleted when
 * the lap books out.
 */
export class LapMachine {
  readonly name: string;
  private machine: InstaMachine | null = null;
  private conn: SshTarget | null = null;
  private connExpires = 0;

  constructor(
    private ib: InstaBox,
    private cfg: RepoConfig,
    public issue: number,
    private log: (msg: string) => void = () => {}
  ) {
    this.name = machineNameFor(cfg.slug, issue);
  }

  private ibx() {
    return this.cfg.env.instabox;
  }

  private async snapshotIdByName(name: string): Promise<string> {
    const snaps = await this.ib.listSnapshots();
    const hit = snaps.find((s) => s.name === name);
    if (!hit) throw new Error(`instabox snapshot "${name}" not found — bake it first: foreman bake ${this.cfg.slug}`);
    return hit.id;
  }

  async ensure(): Promise<InstaMachine> {
    const ibx = this.ibx();
    this.machine = await this.ib.ensureRunning({
      name: this.name,
      template: ibx.snapshot ? undefined : ibx.template,
      snapshotId: ibx.snapshot ? await this.snapshotIdByName(ibx.snapshot) : undefined,
      metadata: { factory: "1", repo: this.cfg.repo, issue: String(this.issue) },
    });
    return this.machine;
  }

  /** SSH target against the machine's gateway, with a cached live token. */
  async ssh(): Promise<SshTarget> {
    if (this.conn && Date.now() < this.connExpires - 5 * 60_000) return this.conn;
    if (!this.machine) await this.ensure();
    const tok: InstaSshToken = await this.ib.createSshToken(this.machine!.id, { name: "factory", ttlSeconds: 8 * 3600 });
    this.conn = { host: tok.host, port: tok.port, user: tok.token };
    this.connExpires = tok.expiresAt ? Date.parse(tok.expiresAt) : Date.now() + 8 * 3600_000;
    return this.conn;
  }

  async bash(script: string, opts: { timeoutMs?: number } = {}): Promise<ShRes> {
    return machineBash(await this.ssh(), script, opts);
  }

  /** Clone/fetch + check out the issue branch — idempotent, per attempt. */
  async bootstrap(): Promise<void> {
    const res = await this.bash(bootstrapScriptFor(this.cfg, branchName(this.issue)), { timeoutMs: 10 * 60_000 });
    if (res.code !== 0 || !res.stdout.includes("BOOTSTRAP_OK")) {
      throw new Error(`machine bootstrap failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300) || res.stdout.trim().slice(0, 300)}`);
    }
  }

  /**
   * Run plan-less stages (implement/review) in the machine. Returns the same
   * shape the host stages produce, plus the raw JSONL for forensics.
   */
  async callStage(
    stage: "implement" | "review",
    o: {
      models: StageModels;
      prompt: string;
      systemPrompt: string;
      tools?: string[];
      extraArgs?: string[];
      timeoutMs: number;
    }
  ): Promise<MachineStageResult & { stage: typeof stage }> {
    const conn = await this.ssh();
    if (stage === "implement") await this.bootstrap();
    const gates = stage === "implement";
    const envFile = buildMachineEnvFile(this.cfg, { gates, branch: branchName(this.issue), base: this.cfg.default_branch });
    const res = await callMachineStage(conn, {
      models: o.models,
      gates,
      branch: branchName(this.issue),
      base: this.cfg.default_branch,
      envFile,
      prompt: o.prompt,
      systemPrompt: o.systemPrompt,
      tools: o.tools,
      extraArgs: o.extraArgs,
      sessionDir: `${this.ibx().repo_dir}/.pdf-sessions/issue-${this.issue}`,
      timeoutMs: o.timeoutMs,
    });
    return { ...res, stage };
  }

  /** Best-effort deletion; a lap machine is always safe to lose. */
  async destroy(): Promise<void> {
    this.conn = null;
    try {
      await this.ib.deleteMachine(this.name);
      this.log(`machine ${this.name} deleted`);
    } catch (e: any) {
      this.log(`machine ${this.name} delete failed (janitor will catch it): ${String(e.message).slice(0, 150)}`);
    }
  }
}

export function openLapMachine(cfg: RepoConfig, issue: number, log?: (msg: string) => void): LapMachine {
  const ib = InstaBox.fromEnv(cfg.env.instabox);
  return new LapMachine(ib, cfg, issue, log);
}
