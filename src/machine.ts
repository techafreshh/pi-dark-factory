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
import { dirname } from "node:path";
import { InstaBox, machineNameFor, type InstaMachine, type InstaSshToken } from "./instabox";
import type { ModelSpec, RepoConfig, StageModels } from "./types";
import { extensionFiles, webToggle } from "./webtools";
import { branchName } from "./stages/intake";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
 * no matter which side of an SSH tunnel they run on. The push is a FORCE:
 * factory/issue-* branches are factory-owned (humans never commit there),
 * and a polluted remote branch (the 2026-10-24 double-work era left PR
 * branches with racing commits) would otherwise reject every fresh
 * machine's non-fast-forward push and wedge the issue's whole repair ladder.
 */
/** exported for tests: the static in-box stage script (env arrives via PDFENV) */
export const STAGE_DRIVER = [
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
  // provider credentials for the box's own pi (see buildMachineEnvFile) —
  // land before any stage exec so the first model call is already authed
  `AD="$HOME/.pi/agent"; mkdir -p "$AD"`,
  `[ -n "\${PDF_PI_AUTH_B64:-}" ] && printf %s "$PDF_PI_AUTH_B64" | base64 -d > "$AD/auth.json" || true`,
  `[ -n "\${PDF_PI_MODELS_B64:-}" ] && printf %s "$PDF_PI_MODELS_B64" | base64 -d > "$AD/models.json" || true`,
  // web-grounding extension: materialized into pi's auto-discovery dir so
  // the stage's pi gets web_search/web_fetch (the --tools allowlist decides
  // whether the stage actually sees them)
  `if [ -n "\${PDF_PI_EXT_MAIN_B64:-}" ] && [ -n "\${PDF_PI_EXT_LIB_B64:-}" ]; then mkdir -p "$AD/extensions"; printf %s "$PDF_PI_EXT_MAIN_B64" | base64 -d > "$AD/extensions/pdf-tinyfish.ts"; printf %s "$PDF_PI_EXT_LIB_B64" | base64 -d > "$AD/extensions/pdf-tinyfish-client.ts"; fi`,
  `cd "$REPO_DIR" || { echo "PDFRC=94" >&2; echo "cd $REPO_DIR failed" >&2; exit 94; }`,
  `mapfile -d '' PI_ARGS < "$D/args.bin"`,
  `"$PI_BIN" "\${PI_ARGS[@]}" < "$D/prompt.md" > "$D/pi.jsonl" 2> "$D/pi.err"`,
  `RC=$?`,
  `MARK="PDFRC=$RC"`,
  `if [ "$PDF_GATES" = "1" ] && [ "$RC" -eq 0 ]; then`,
  // .pdf-sessions is FACTORY state — the sessions must never fail the
  // cleanliness gate nor ride into a commit (an implementer following
  // "git add -A && commit EVERYTHING" would ship them in the PR). The
  // session dir itself now lives OUTSIDE the clone (/data/.pdf-sessions);
  // the exclusion is belt-and-braces for residue in reused machines.
  `  DIRTY=$(git status --porcelain -- ':!.pdf-sessions' | head -5)`,
  `  if [ -n "$DIRTY" ]; then`,
  `    echo "$DIRTY" >&2`,
  `    MARK="PDFGATE=uncommitted changes left behind"`,
  `  else`,
  `    AHEAD=$(git rev-list --count "origin/$PDF_BASE..HEAD" 2>/dev/null || echo 0)`,
  `    if [ "\${AHEAD:-0}" -lt 1 ]; then`,
  `      MARK="PDFGATE=no commits ahead of base — nothing was implemented"`,
    `    elif ! git push -q --force origin "HEAD:refs/heads/$PDF_BRANCH" 2> "$D/push.err"; then`,
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
  // the service env names the token GH_TOKEN while pass_env lists GITHUB_TOKEN
  // — resolve either, or the box's git and gh silently run credential-less
  // (observed: every machine push dying as "could not read from remote
  // repository" while the host held a valid token the whole time)
  const gh = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (gh) lines.push(`export GITHUB_TOKEN=${escapeSh(gh)}`);
  // the box's pi needs the factory's own provider credentials: compose mode
  // gets them for free by bind-mounting ~/.pi into the stage container, but
  // a machine has its own root — ship auth.json/models.json over the same
  // ssh channel that already carries GITHUB_TOKEN, and the stage driver
  // materializes them under $HOME/.pi/agent before pi starts
  for (const [name, file] of [
    ["PDF_PI_AUTH_B64", "auth.json"],
    ["PDF_PI_MODELS_B64", "models.json"],
  ] as const) {
    try {
      const p = join(homedir(), ".pi", "agent", file);
      if (existsSync(p)) lines.push(`export ${name}=${escapeSh(readFileSync(p).toString("base64"))}`);
    } catch {}
  }
  // web-grounding tools ride the same channel: the pi extension pair is
  // embedded base64 (when the repo wants web tools and the checkout carries
  // them) and materialized into $AD/extensions/ — no snapshot re-bake, the
  // box always gets the current extension on its next stage
  const wt = webToggle(cfg);
  if (wt.search || wt.fetch) {
    for (const { name, b64 } of extensionFiles()) {
      lines.push(`export ${name === "pdf-tinyfish.ts" ? "PDF_PI_EXT_MAIN_B64" : "PDF_PI_EXT_LIB_B64"}=${escapeSh(b64)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Where the machine clones the repo from. */
export function originUrlFor(cfg: RepoConfig): string {
  return cfg.origin_url ?? `https://github.com/${cfg.repo}.git`;
}

/** Idempotent: clone once, fetch after; keep a repair round's local branch.
 *  `from: "branch"` starts the branch at origin/<branch> (the scenario TEST
 *  BENCH: the branch's tree must be what's under test — the default
 *  origin/<default_branch> base left --test machines on main's tree, so
 *  web/ was missing and setup ENOENT'd, bi-ai-ui 2026-10-25). Laps keep the
 *  default: a new issue's branch starts at the base branch, and the
 *  implementer commits on top. */
export function bootstrapScriptFor(cfg: RepoConfig, branch: string, opts: { from?: "base" | "branch" } = {}): string {
  const ibx = cfg.env.instabox;
  const b = (s: string) => escapeSh(s);
  const startRef = opts.from === "branch" ? `origin/${b(branch)}` : `"origin/${cfg.default_branch}"`;
  return [
    `set -eu`,
    `if [ -n "\${GITHUB_TOKEN:-}" ]; then git config --global url."https://x-access-token:$GITHUB_TOKEN@github.com/".insteadOf "https://github.com/" 2>/dev/null || true; fi`,
    // /data ships root-owned (it is the machine's persistent disk); the agent
    // user must own the clone's parent — and any half-cloned leftovers —
    // before git can create the work tree. sudo -n is baked into the factory
    // snapshots (used at bake time for the global pi install); best-effort,
    // so a sudo-less snapshot still fails at the clone with git's own message.
    `P=$(dirname ${b(ibx.repo_dir)}); sudo -n mkdir -p "$P" 2>/dev/null || true; sudo -n chown -R "$(id -u):$(id -g)" "$P" 2>/dev/null || true`,
    `if [ ! -d ${b(ibx.repo_dir)}/.git ]; then`,
    `  git clone --no-checkout ${b(originUrlFor(cfg))} ${b(ibx.repo_dir)} || git clone ${b(originUrlFor(cfg))} ${b(ibx.repo_dir)}`,
    `else`,
    `  git -C ${b(ibx.repo_dir)} fetch origin --prune || true`,
    `fi`,
    `cd ${b(ibx.repo_dir)}`,
    `if git show-ref --verify -q refs/heads/${b(branch)}; then`,
    `  git checkout -q ${b(branch)}`,
    `else`,
    // a REVIVED lap continues the previous lap's branch instead of
    // re-implementing from the plan — the branch is the record, and re-doing
    // paid-for work on every block→revive cycle burned a full re-implementation
    // per round (bi-ai-ui #1, 2026-10-26). First-ever laps (no remote branch)
    // still start at the base branch; the --test bench (`from: "branch"`)
    // still hard-fails when its branch is missing — startRef covers both.
    `  if git show-ref --verify -q refs/remotes/origin/${b(branch)}; then`,
    `    git checkout -q -B ${b(branch)} origin/${b(branch)}`,
    `  else`,
    `    git checkout -q -B ${b(branch)} ${startRef}`,
    `  fi`,
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
    return { outcome: { kind: "provider_error", usage: parsed.usage ?? null, error: `pi exited ${rc} in machine: ${(detail || "unknown").slice(0, 500)}` }, raw };
  }
  if (parsed.assistantText === null) {
    const detail = (parsed.errorHint ?? res.stderr.trim()).slice(0, 300);
    return { outcome: { kind: "provider_error", usage: parsed.usage ?? null, error: `machine model produced no final text: ${detail}` }, raw };
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
  private exited = false;

  static start(conn: SshTarget, ports: number[]): PortForwarder {
    if (ports.length === 0) return new PortForwarder();
    const argv = [
      sshBin(),
      "-N",
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=15",
      // keepalives: an idle tunnel through the gateway dies mid-setup
      // (bi-ai-ui 2026-10-25: the runtime forward idled through minutes of
      // npm install, then readiness polled a corpse — "server never became
      // ready" while the in-box server was demonstrably healthy; the
      // short-setup holdout forward on the same machine always survived)
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
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
      child.once("exit", (code) => {
        f.exited = true;
        resolve(code ?? 0);
      });
    }).catch(() => 0) as Promise<number>;
    return f;
  }

  /** Did the tunnel survive its first `ms`? With ExitOnForwardFailure, an
   *  early exit means the forward never bound — infra, not the server. */
  async established(ms = 2500): Promise<boolean> {
    if (!this.proc) return false;
    await new Promise((r) => setTimeout(r, ms));
    return !this.exited;
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
    private log: (msg: string) => void = () => {},
    gen?: number
  ) {
    this.name = machineNameFor(cfg.slug, issue, gen);
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
    // source the machine env before the bootstrap: its insteadOf rewrite
    // needs the GitHub token, and a bare ssh exec never sees the stage
    // driver's env.sh — without this the clone runs anonymous and every
    // later push from the box dies credential-less
    const env = buildMachineEnvFile(this.cfg, {
      gates: false,
      branch: branchName(this.issue),
      base: this.cfg.default_branch,
    });
    const res = await this.bash(env + "\n" + bootstrapScriptFor(this.cfg, branchName(this.issue)), { timeoutMs: 10 * 60_000 });
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
      // OUTSIDE the clone (sibling of repo_dir): session files inside $REPO_DIR
      // tripped the driver's own cleanliness gate and risked being committed
      // into the PR by a literal "git add -A" implementer (bi-ai-ui 2026-10-26)
      sessionDir: `${dirname(this.ibx().repo_dir)}/.pdf-sessions/issue-${this.issue}`,
      timeoutMs: o.timeoutMs,
    });
    return { ...res, stage };
  }

  /** Best-effort deletion; a lap machine is always safe to lose. */
  async destroy(): Promise<void> {
    this.conn = null;
    try {
      // DELETE resolves machine IDs only — a name-path delete 404s, and the
      // client swallowed that 404 as "already gone": every lap logged a
      // false "deleted" while its machine lingered running (tic-tac-toe
      // 2026-10-24: three merged-issue boxes outlived their own destroy
      // receipts until a janitor killed them by id)
      const m = this.machine ?? (await this.ib.machineByName(this.name));
      if (m) await this.ib.deleteMachine(m.id);
      // delete is eventually-consistent platform-side (phantom records were
      // observed ~2h after successful deletes) — surface the lag instead of
      // a false "deleted", so a same-name recreate race is at least visible
      try {
        const still = await this.ib.machineByName(this.name);
        if (still) {
          this.log(`machine ${this.name} delete not yet visible (platform lag) — janitor will reap the leftover`);
          return;
        }
      } catch {}
      this.log(`machine ${this.name} deleted`);
    } catch (e: any) {
      this.log(`machine ${this.name} delete failed (janitor will catch it): ${String(e.message).slice(0, 150)}`);
    }
  }
}

export function openLapMachine(cfg: RepoConfig, issue: number, log?: (msg: string) => void, gen?: number): LapMachine {
  const ib = InstaBox.fromEnv(cfg.env.instabox);
  return new LapMachine(ib, cfg, issue, log, gen);
}
