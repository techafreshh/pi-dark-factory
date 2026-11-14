import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ledger } from "../ledger";
import {
  acceptanceRunningPath,
  acceptanceRunsToday,
  e2eSuiteDir,
  e2eSuiteExists,
  prdPath,
  readAcceptanceState,
  recordAcceptanceRun,
  writeAcceptanceState,
  type AcceptanceLast,
} from "../acceptance-state";
import { resolveScenarioPort, runScenario, runScenarioInMachine, loadScenario, type ScenarioSpec } from "../scenario";
import { fileFactoryIssues } from "../fileissues";
import { ensureSource, sourceDir } from "../gitws";
import type { GhApi } from "../gh";
import { buildMachineEnvFile, bootstrapScriptFor, type LapMachineLike, type MachineStageResult } from "../machine";
import { resolveModels } from "../config";
import { PRD_GAP_LABEL } from "../security";
import { buildStageCmd } from "../env";
import { receipt } from "../receipts";
import { sh } from "../sh";
import type { CallStageFn } from "../tick";
import { isMachineMode, type ModelSpec, type RepoConfig, type StageModels } from "../types";

/**
 * PRD-delivery acceptance (docs/acceptance.md) — the loops that check
 * whether the built product delivered the PRD, and turn every gap into an
 * issue the normal lap loop then fixes:
 *
 *  1. runE2eSuite — the authored browser suite (state/repos/<slug>/e2e/ +
 *     the `e2e` framework toolchain) run deterministically against a served
 *     product. The per-merge regression hook calls this on merged main.
 *  2. runPrdAcceptance — the drain-time pass: serve the product the way
 *     verify does (the scenario runners' deterministic setup → start →
 *     readiness), run the suite, then run the acceptance agent stage over
 *     the whole PRD with agent-browser while the product stays up. Gaps
 *     file as [prd-gap] issues; a walk that verifies everything records a
 *     PASS bound to (backlog generation, main HEAD).
 *
 * The acceptance never trusts an agent to start the product it is judged
 * on, and the PRD text lives in factory state, outside the repo — the same
 * "acceptance lives outside the repo" rule as runtime.json/holdout.json.
 */

export const ACCEPTANCE_SYSTEM = `You are the acceptance agent of an unattended software factory. The factory built this product from a PRD, issue by issue; your job is to judge whether the RUNNING PRODUCT delivers the PRD — not whether the code looks right.

Rules:
- Verify against the live app with a real browser: use the agent-browser CLI (the agent-browser skill documents every command) or plain curl for API-only claims. Never judge from source code alone.
- The product URL is given in your prompt. It is already running; do not start, stop or reconfigure it.
- Walk EVERY deliverable the PRD states. For each one, attempt it in the browser the way a user would, and record delivered or missing.
- If stored e2e suite results are given, weigh them but judge the PRD yourself: a green suite does not make a missing feature delivered, and a failing suite does not make a working feature missing.
- You may author or extend e2e tests (the \`e2e\` framework: files ending .e2e.ts plus an e2e.config.ts) into the output directory named in your prompt. Only encode behavior you actually SAW work or fail; prefer deterministic Playwright-style assertions, and use agent steps only where a flow truly needs judgment.
- Change nothing in the repo clone, and never fix code. You are a judge and a test author, not a builder.`;

export const ACCEPTANCE_DAILY_CAP = 2;

/** Lenient verdict parser — the review verdict's discipline: structure is
 *  parsed from the model's final text, and when neither a VERDICT line nor
 *  a GAPS section exists the walk fails closed (records a failed run, files
 *  nothing) instead of guessing. */
export interface AcceptanceGap {
  requirement: string;
  gap: string;
  severity: "major" | "minor";
  repro?: string;
}

export function parseAcceptanceVerdict(text: string): { delivered: boolean | null; gaps: AcceptanceGap[] } {
  const gaps: AcceptanceGap[] = [];
  let inGaps = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^VERDICT\s*:\s*DELIVERED/i.test(line)) return { delivered: gaps.length === 0, gaps };
    if (/^VERDICT\s*:\s*GAPS/i.test(line)) inGaps = true;
    if (/^#{1,4}\s*GAPS?/i.test(line) || /^GAPS?\s*:?\s*$/i.test(line)) inGaps = true;
    // a new markdown heading (other than GAPS) ends the section
    else if (/^#{1,4}\s/.test(line)) inGaps = false;
    if (!inGaps) continue;
    // "- requirement :: gap :: major|minor :: repro" — a missing severity
    // defaults to major (fail-safe: majors are worked first; a mislabeled
    // minor would silently defer)
    if (!/^[-*]\s/.test(line)) continue;
    const parts = line.replace(/^[-*]\s*/, "").split("::").map((s) => s.trim());
    if (parts.length < 2 || !parts[0]) continue;
    gaps.push({
      requirement: parts[0],
      gap: parts[1],
      severity: /minor/i.test(parts[2] ?? "") ? "minor" : "major",
      repro: parts[3] || undefined,
    });
  }
  if (gaps.length > 0) return { delivered: false, gaps };
  return { delivered: null, gaps: [] };
}

/** The e2e run's machine-readable contract, typed from the captured fixture
 *  (test/fixtures/e2e-report-pass.json — e2e 0.23.1). Defensive: fields may
 *  be absent on odd exits; everything read is optional. */
export interface E2eSummary {
  status: string;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  failures: { file: string; testId: string; status: string; error?: string }[];
}

export function parseE2eReport(text: string): E2eSummary | null {
  try {
    const j = JSON.parse(text);
    const run = j?.run;
    if (!run || typeof run !== "object" || typeof run.status !== "string") return null;
    const s = run.summary ?? {};
    const failures = (Array.isArray(run.results) ? run.results : [])
      .filter((r: any) => r?.status && r.status !== "passed")
      .map((r: any) => {
        const att = Array.isArray(r.attempts) ? r.attempts[r.attempts.length - 1] : undefined;
        return {
          file: String(r.file ?? "?"),
          testId: String(r.testId ?? r.titlePath?.join(" > ") ?? "?"),
          status: String(r.status),
          error: att?.error?.message
            ? String(att.error.message).slice(0, 400)
            : att?.failure
              ? String(JSON.stringify(att.failure)).slice(0, 400)
              : undefined,
        };
      });
    return {
      status: String(run.status ?? "unknown"),
      passed: Number(s.passed) || 0,
      failed: Number(s.failed) || 0,
      flaky: Number(s.flaky) || 0,
      skipped: Number(s.skipped) || 0,
      failures,
    };
  } catch {
    return null;
  }
}

/** One shared toolchain per lane: host-side the host-tools verb installs it
 *  under ~/.pdf/e2e-toolchain; in-box the bake script puts it at /opt/pdf-e2e
 *  (browsers beside it, at <toolchain>-browsers). Overridable without a deploy. */
export const hostToolchainDir = () => process.env.PDF_E2E_TOOLCHAIN_DIR ?? join(process.env.HOME ?? "", ".pdf", "e2e-toolchain");
export const boxToolchainDir = () => process.env.PDF_E2E_BOX_TOOLCHAIN_DIR ?? "/opt/pdf-e2e";

/** The command that runs the suite against the product the scenario runner
 *  already started ($PORT is exported by both lanes). The suite resolves the
 *  toolchain through a symlinked node_modules — ESM import specifiers ignore
 *  NODE_PATH, a symlink walks the real tree. Prints "PDFE2ERC=<n>" then the
 *  report.json base64 (or PDFE2ENOREPORT), and EXITS with the suite's rc. */
export function e2eRunCommand(opts: { suiteDir: string; toolchainDir: string; inBox: boolean }): string {
  return [
    `cd ${opts.suiteDir}`,
    `[ -e node_modules ] || ln -sfn ${opts.toolchainDir}/node_modules node_modules`,
    `export APP_URL="http://127.0.0.1:$PORT"`,
    `export CI=1`,
    ...(opts.inBox ? [`export PLAYWRIGHT_BROWSERS_PATH=${opts.toolchainDir}-browsers`] : []),
    `npx --no-install e2e run > run.log 2>&1`,
    `RC=$?`,
    `echo "PDFE2ERC=$RC"`,
    `if [ -f .e2e/report.json ]; then base64 -w0 .e2e/report.json; else echo PDFE2ENOREPORT; fi`,
    `exit $RC`,
  ].join("\n");
}

/** Parse the framed output of e2eRunCommand (rc line + report b64). */
export function parseE2eRunOutput(stdout: string): { rc: number | null; report: E2eSummary | null } {
  const lines = stdout.split("\n");
  const rcLine = lines.find((l) => l.startsWith("PDFE2ERC="));
  const rc = rcLine ? Number(rcLine.slice("PDFE2ERC=".length)) : null;
  const b64 = lines.filter((l) => /^[A-Za-z0-9+/=]{100,}$/.test(l.trim())).pop()?.trim();
  const report = b64 && b64 !== "PDFE2ENOREPORT" ? parseE2eReport(Buffer.from(b64, "base64").toString("utf8")) : null;
  return { rc, report };
}

export function summarizeE2e(report: E2eSummary | null, rc: number | null): string {
  return report
    ? `suite ${report.status}: ${report.passed} passed, ${report.failed} failed${report.flaky ? `, ${report.flaky} flaky` : ""}`
    : `no parsable e2e report (rc ${rc ?? "?"})`;
}

const b64TarOf = async (dir: string, timeoutMs = 60_000): Promise<string> => {
  const res = await sh(["bash", "-c", `tar czf - -C ${dir} --exclude=node_modules --exclude=.e2e --exclude=run.log . | base64 -w0`], { timeoutMs });
  return res.stdout.trim();
};

/** Ship the suite files into the box (b64 tar over the exec channel — the
 *  same channel skills ride). */
async function shipSuiteInBox(machine: LapMachineLike, suiteDir: string, boxDir: string): Promise<void> {
  const b64 = await b64TarOf(suiteDir);
  if (!b64) throw new Error(`could not tar the e2e suite at ${suiteDir}`);
  const res = await machine.bash(
    `rm -rf ${boxDir} && mkdir -p ${boxDir} && printf %s ${b64} | base64 -d | tar xzf - -C ${boxDir} && echo SHIPPED`,
    { timeoutMs: 120_000 }
  );
  if (!res.stdout.includes("SHIPPED")) {
    throw new Error(`could not ship the e2e suite into the box: ${(res.stderr.trim() || res.stdout.trim()).slice(0, 200)}`);
  }
}

/** Collect the suite files the walk agent authored in the box back into
 *  factory state (discoveries-<attempt>.json rides back the same way). */
async function collectSuiteFromBox(machine: LapMachineLike, boxDir: string, stateDir: string, slug: string): Promise<boolean> {
  const res = await machine.bash(
    `cd ${boxDir} 2>/dev/null && ls *.e2e.ts e2e.config.ts >/dev/null 2>&1 && tar czf - --exclude=node_modules --exclude=.e2e --exclude=run.log . | base64 -w0 || true`,
    { timeoutMs: 60_000 }
  );
  const out = res.stdout.trim().split("\n").filter((l) => /^[A-Za-z0-9+/=]{100,}$/.test(l.trim())).pop()?.trim();
  if (!out) return false;
  const dest = e2eSuiteDir(stateDir, slug);
  const tmp = mkdtempSync(join(tmpdir(), `pdf-e2e-collect-${slug}-`));
  try {
    const x = await sh(["bash", "-c", `printf %s ${out} | base64 -d | tar xzf - -C ${tmp}`], { timeoutMs: 30_000 });
    if (x.code !== 0) return false;
    let copied = false;
    for (const e of readdirSync(tmp)) {
      if (e.endsWith(".e2e.ts") || e.endsWith(".e2e.js") || e === "e2e.config.ts") {
        mkdirSync(dest, { recursive: true });
        cpSync(join(tmp, e), join(dest, e));
        copied = true;
      }
    }
    return copied;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Boot + bootstrap an acceptance machine at origin/main (the scenario-test
 *  bench's shape — NOT an issue branch). Shared by the drain walk and the
 *  per-merge e2e regression. Throws on transport/bootstrap failure. */
export async function bootAcceptanceMachine(cfg: RepoConfig, machine: LapMachineLike): Promise<void> {
  await machine.ensure();
  const envFile = buildMachineEnvFile(cfg, { gates: false, restore: false, branch: cfg.default_branch, base: cfg.default_branch });
  const boot = await machine.bash(envFile + "\n" + bootstrapScriptFor(cfg, cfg.default_branch, { from: "branch" }), { timeoutMs: 10 * 60_000 });
  if (boot.code !== 0 || !boot.stdout.includes("BOOTSTRAP_OK")) {
    throw new Error(`acceptance machine bootstrap failed: ${(boot.stderr.trim() || boot.stdout.trim()).slice(0, 300)}`);
  }
}

export interface SuiteRunResult {
  pass: boolean;
  summary: string;
  report: E2eSummary | null;
}

function readReportSafe(suiteDir: string): string {
  try {
    return readFileSync(join(suiteDir, ".e2e", "report.json"), "utf8");
  } catch {
    return "";
  }
}

/** Run the authored suite against the product a scenario window serves.
 *  `machine` present = machine-mode lane (suite ships to the box, runs
 *  in-box); absent = host/compose lane (suite runs host-side against the
 *  published 127.0.0.1 port). Throws on transport failure; a failing SUITE
 *  is a result, not a throw. */
export async function runE2eSuite(
  cfg: RepoConfig,
  runtimeSpec: ScenarioSpec,
  opts: { stateDir: string; machine?: LapMachineLike; repoDir?: string; scratchDir?: string }
): Promise<SuiteRunResult> {
  const suiteDir = e2eSuiteDir(opts.stateDir, cfg.slug);
  const timeoutMs = (cfg.acceptance?.e2e_minutes ?? 10) * 60_000;
  const spec: ScenarioSpec = { ...runtimeSpec, probes: [] };

  if (opts.machine) {
    const boxDir = "/tmp/pdf-e2e-suite";
    await shipSuiteInBox(opts.machine, suiteDir, boxDir);
    const target = {
      bash: (script: string, t?: number) => opts.machine!.bash(script, { timeoutMs: t }),
      repoDir: opts.repoDir ?? "",
    };
    const result = await runScenarioInMachine(spec, target, {
      readinessSeconds: cfg.timeouts.readiness_seconds,
      defaultProbeMs: cfg.timeouts.probe_ms,
      key: `${cfg.slug}-accept`,
      reservedPorts: cfg.scenario.ports,
      onReady: async ({ port }) => {
        const res = await target.bash(`export PORT=${port}\n` + e2eRunCommand({ suiteDir: boxDir, toolchainDir: boxToolchainDir(), inBox: true }), timeoutMs + 60_000);
        const { rc, report } = parseE2eRunOutput(res.stdout);
        return report && report.status === "passed" ? null : summarizeE2e(report, rc);
      },
    });
    return { pass: result.pass, summary: result.pass ? "suite passed" : result.error ?? "suite failed", report: null };
  }

  const worktree = opts.scratchDir!;
  const envBuild =
    cfg.env.mode === "compose"
      ? buildStageCmd(cfg, worktree, opts.stateDir, `pdf-${cfg.slug}-accept`, {
          extraEnv: { PORT: String(resolveScenarioPort(runtimeSpec, cfg.scenario.ports)), WORKTREE: worktree },
          publishPorts: true,
        })
      : undefined;
  const result = await runScenario(spec, join(worktree, ".pdf-e2e-scratch"), {
    readinessSeconds: cfg.timeouts.readiness_seconds,
    defaultProbeMs: cfg.timeouts.probe_ms,
    worktree,
    preClean: `pdf-${cfg.slug}-`,
    passEnv: cfg.env.pass_env,
    wrap: envBuild ? { argvPrefix: envBuild.argvPrefix, cleanup: () => sh(envBuild.cleanup!, { timeoutMs: 20000 }) } : undefined,
    onReady: async ({ env }) => {
      const res = await sh(["bash", "-c", e2eRunCommand({ suiteDir, toolchainDir: hostToolchainDir(), inBox: false })], {
        cwd: suiteDir,
        env,
        inheritEnv: false,
        timeoutMs,
        killGroup: true,
      });
      const report = parseE2eReport(readReportSafe(suiteDir));
      return report && report.status === "passed" ? null : summarizeE2e(report, res.code);
    },
  });
  return { pass: result.pass, summary: result.pass ? "suite passed" : result.error ?? "suite failed", report: parseE2eReport(readReportSafe(suiteDir)) };
}

export interface AcceptanceDeps {
  stateDir: string;
  gh: GhApi;
  /** stage rows (lap_id 0) record every acceptance walk like any stage */
  ledger: Ledger;
  /** host/compose lane: the tick's stage runner (makeCallStage) */
  callStage?: CallStageFn;
  /** machine lane: boots the acceptance machine per env.mode (tick's
   *  openMachine dispatch, issue 0) */
  openMachine?: (cfg: RepoConfig, log: (m: string) => void) => LapMachineLike;
  log: (m: string) => void;
}

export interface AcceptanceResult {
  ran: boolean;
  pass?: boolean;
  /** why the walk did not run (cap, no PRD, already green) — receipt text */
  reason?: string;
  summary?: string;
  filed: { issue: number; title: string }[];
  suite?: SuiteRunResult | null;
}

function repoDirOf(cfg: RepoConfig): string {
  return ((cfg.env as any)[cfg.env.mode as string]?.repo_dir as string) ?? "";
}

export function buildAcceptancePrompt(
  cfg: RepoConfig,
  o: { prd: string; url: string; suiteSummary: string; outDir: string; authoring: boolean; inBox: boolean }
): string {
  return [
    `# PRD acceptance walk — ${cfg.repo}`,
    "",
    `The product is running at ${o.url} (served from ${cfg.default_branch}; do not start or stop it).`,
    "",
    `## The PRD (the delivery contract — judge EVERY deliverable below against the live product)`,
    "",
    o.prd.slice(0, 60_000),
    "",
    `## Stored e2e suite`,
    "",
    o.authoring
      ? `No suite exists yet. AUTHOR one this run: write e2e tests (the \`e2e\` framework; a toolchain is installed — create \`package.json\` with {"type":"module"}, symlink the toolchain's node_modules with \`ln -sfn ${o.inBox ? boxToolchainDir() : hostToolchainDir()}/node_modules node_modules\`, add an \`e2e.config.ts\` whose target app.url reads process.env.APP_URL) into: ${o.outDir}`
      : `Last deterministic run: ${o.suiteSummary}. Extend or correct it in ${o.outDir} if it is stale against today's PRD — never delete tests to make a run pass.`,
    "",
    `## Output contract (your final message — parseable, no extra prose after it)`,
    "",
    "After walking every PRD deliverable, end your final message EXACTLY with:",
    "",
    "```",
    "GAPS:",
    "- <requirement from the PRD> :: <what is missing or wrong> :: major|minor :: <how you reproduced it>",
    "...",
    "VERDICT: DELIVERED   (only when the live product delivers every PRD requirement)",
    "```",
    "",
    "The GAPS section lists what the product does NOT deliver (omit it entirely when everything is delivered, but always end with a VERDICT line). Severity major = a PRD deliverable the build lacks or breaks; minor = polish/edge behavior.",
  ].join("\n");
}

/** The acceptance window body, run by the scenario runners' onReady seam
 *  while the product is up: suite (in place, no nested window), then the
 *  walk agent stage, then collection of authored files. Returns the agent's
 *  final text for verdict parsing; throws on transport/stage failure. */
async function acceptanceWindow(
  cfg: RepoConfig,
  deps: AcceptanceDeps,
  args: { port: number; prd: string; machine: LapMachineLike | null; cwd: string }
): Promise<string> {
  const stateDir = deps.stateDir;
  const slug = cfg.slug;
  // 1. deterministic suite first — its results feed the agent's judgment
  const suiteExisted = e2eSuiteExists(stateDir, slug);
  let suiteSummary = "no authored suite yet — the walk authors one";
  if (suiteExisted) {
    const timeoutMs = (cfg.acceptance?.e2e_minutes ?? 10) * 60_000;
    if (args.machine) {
      const res = await args.machine.bash(
        `export PORT=${args.port}\n` + e2eRunCommand({ suiteDir: "/tmp/pdf-e2e-suite", toolchainDir: boxToolchainDir(), inBox: true }),
        { timeoutMs: timeoutMs + 60_000 }
      );
      const { rc, report } = parseE2eRunOutput(res.stdout);
      suiteSummary = summarizeE2e(report, rc);
    } else {
      const suiteDir = e2eSuiteDir(stateDir, slug);
      const res = await sh(
        ["bash", "-c", `export PORT=${args.port}\n` + e2eRunCommand({ suiteDir, toolchainDir: hostToolchainDir(), inBox: false })],
        { cwd: suiteDir, timeoutMs, killGroup: true }
      );
      const report = parseE2eReport(readReportSafe(suiteDir));
      suiteSummary = summarizeE2e(report, res.code);
    }
    deps.log(`acceptance suite: ${suiteSummary}`);
  }

  // 2. the walk agent stage (recorded in stage_runs with lap_id 0)
  const ledgerRow = deps.ledger.startStage(cfg.repo, 0, 0, "acceptance", 1, "acceptance");
  const outDir = args.machine ? "/tmp/pdf-e2e-out" : join(args.cwd, "e2e-out");
  const prompt = buildAcceptancePrompt(cfg, {
    prd: args.prd,
    url: `http://127.0.0.1:${args.port}`,
    suiteSummary,
    outDir,
    authoring: !suiteExisted,
    inBox: !!args.machine,
  });
  const tried = (r: MachineStageResult | { modelsTried: { spec: ModelSpec; outcome: string }[] }) =>
    JSON.stringify(r.modelsTried?.map((t) => `${t.spec.provider}/${t.spec.model}:${t.outcome}`) ?? []);
  const record = (exit: string, tokens: any, error: string | null, modelsTried: string) =>
    deps.ledger.endStage(ledgerRow, exit, tokens, error, modelsTried);

  const models: StageModels = resolveModels(cfg, "acceptance");
  const tools = cfg.pi.tools;
  const timeoutMs = (cfg.acceptance?.prd_minutes ?? 25) * 60_000;
  const res = args.machine
    ? await args.machine.callStage("acceptance", { models, prompt, systemPrompt: ACCEPTANCE_SYSTEM, tools, timeoutMs })
    : await deps.callStage!("acceptance", {
        models,
        prompt,
        systemPrompt: ACCEPTANCE_SYSTEM,
        tools,
        cwd: args.cwd,
        sessionDir: join(stateDir, "repos", slug, "issues", "acceptance", "sessions"),
        name: `pdf-${slug}-accept`,
        timeoutMs,
      });
  const usageOf = () => ("usage" in res.outcome ? res.outcome.usage ?? null : null);
  if (res.outcome.kind !== "ok") {
    const error = res.outcome.kind === "timeout" ? "acceptance stage timed out" : String((res.outcome as any).error ?? res.outcome.kind);
    record(res.outcome.kind === "timeout" ? "timeout" : "error", usageOf(), error, tried(res));
    throw new Error(`acceptance stage failed: ${error}`);
  }
  record("ok", res.outcome.usage, null, tried(res));
  deps.log(`acceptance walk stage ok (${res.outcome.usage?.output_tokens ?? 0} out tokens)`);

  // 3. collect the authored suite files
  if (args.machine) {
    const got = await collectSuiteFromBox(args.machine, "/tmp/pdf-e2e-out", stateDir, slug);
    if (got) deps.log("acceptance: authored suite files collected from the box into factory state");
  } else {
    const dest = e2eSuiteDir(stateDir, slug);
    let copied = false;
    try {
      for (const e of readdirSync(outDir)) {
        if (e.endsWith(".e2e.ts") || e.endsWith(".e2e.js") || e === "e2e.config.ts") {
          mkdirSync(dest, { recursive: true });
          cpSync(join(outDir, e), join(dest, e));
          copied = true;
        }
      }
    } catch {}
    if (copied) deps.log("acceptance: authored suite files stored in factory state");
  }
  return res.outcome.text;
}

/** The drain-time PRD acceptance walk. Best-effort by contract: every
 *  transport/platform failure is receipted and returned, never thrown into
 *  the tick's lap. */
export async function runPrdAcceptance(cfg: RepoConfig, deps: AcceptanceDeps, opts: { force?: boolean } = {}): Promise<AcceptanceResult> {
  const { stateDir } = deps;
  const slug = cfg.slug;
  const filed: { issue: number; title: string }[] = [];
  const marker = acceptanceRunningPath(stateDir, slug);
  const prd = readPrdSafe(stateDir, slug);
  if (!prd) return { ran: false, filed, reason: "no prd.md stored (slice a backlog or POST /repos/<slug>/prd first)" };

  const st = readAcceptanceState(stateDir, slug);
  let mainHead = "";
  try {
    const src = await ensureSource(stateDir, cfg);
    mainHead = (await sh(["git", "-C", src, "rev-parse", `origin/${cfg.default_branch}`], { timeoutMs: 30_000 })).stdout.trim();
  } catch (e) {
    return { ran: false, filed, reason: `could not resolve origin/${cfg.default_branch}: ${e instanceof Error ? e.message.slice(0, 150) : e}` };
  }
  if (!opts.force && st.last?.status === "pass" && st.last.main_head === mainHead && st.last.gen === st.gen) {
    return { ran: false, filed, reason: `already DELIVERED on this main (${mainHead.slice(0, 12)}) for backlog generation ${st.gen}` };
  }
  if (!opts.force && acceptanceRunsToday(stateDir, slug) >= ACCEPTANCE_DAILY_CAP) {
    return { ran: false, filed, reason: `daily acceptance cap (${ACCEPTANCE_DAILY_CAP}) reached — the next drain retries` };
  }
  const machineMode = isMachineMode(cfg.env.mode);
  if (machineMode && !deps.openMachine) return { ran: false, filed, reason: "machine mode but no openMachine dep (internal wiring bug)" };
  if (!machineMode && !deps.callStage) return { ran: false, filed, reason: "host mode but no callStage dep (internal wiring bug)" };
  if (!cfg.scenario.runtime) return { ran: false, filed, reason: "no runtime scenario configured — the walk cannot serve the product" };

  recordAcceptanceRun(stateDir, slug);
  writeFileSync(marker, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n");
  let machine: LapMachineLike | null = null;
  let scratchRoot = "";
  // the window's final agent text — the verdict source. The onReady seam
  // communicates pass/fail by return value, so the text rides a holder.
  const holder: { text: string } = { text: "" };
  try {
    const spec = loadScenario(join(stateDir, "repos", slug, cfg.scenario.runtime));
    spec.port = resolveScenarioPort(spec, cfg.scenario.ports);

    if (machineMode) {
      machine = deps.openMachine!(cfg, (m) => deps.log(m));
      // the clone lands on origin/main (the scenario-test bench's shape),
      // NOT an issue branch — then the suite ships before the window opens
      await bootAcceptanceMachine(cfg, machine);
      if (e2eSuiteExists(stateDir, slug)) await shipSuiteInBox(machine, e2eSuiteDir(stateDir, slug), "/tmp/pdf-e2e-suite");
      const target = {
        bash: (script: string, t?: number) => machine!.bash(script, { timeoutMs: t }),
        repoDir: repoDirOf(cfg),
      };
      const result = await runScenarioInMachine({ ...spec, probes: [] }, target, {
        readinessSeconds: cfg.timeouts.readiness_seconds,
        defaultProbeMs: cfg.timeouts.probe_ms,
        key: `${slug}-accept`,
        reservedPorts: cfg.scenario.ports,
        onReady: async ({ port }) => {
          holder.text = await acceptanceWindow(cfg, deps, { port, prd, machine, cwd: target.repoDir });
          return null; // the window's own verdict is parsed below; never fail the window here
        },
      });
      if (!result.pass && result.error) throw new Error(`acceptance window failed: ${result.error}`);
    } else {
      scratchRoot = mkdtempSync(join(tmpdir(), `pdf-accept-${slug}-`));
      const src = sourceDir(stateDir, slug);
      const wt = join(scratchRoot, "wt");
      const add = await sh(["git", "-C", src, "worktree", "add", "--detach", wt, `origin/${cfg.default_branch}`], { timeoutMs: 120_000 });
      if (add.code !== 0) throw new Error(`could not worktree merged main: ${add.stderr.trim().slice(0, 200)}`);
      const envBuild =
        cfg.env.mode === "compose"
          ? buildStageCmd(cfg, wt, stateDir, `pdf-${slug}-accept`, {
              extraEnv: { PORT: String(spec.port), WORKTREE: wt },
              publishPorts: true,
            })
          : undefined;
      try {
        const result = await runScenario({ ...spec, probes: [] }, join(scratchRoot, "scratch"), {
          readinessSeconds: cfg.timeouts.readiness_seconds,
          defaultProbeMs: cfg.timeouts.probe_ms,
          worktree: wt,
          preClean: `pdf-${slug}-`,
          passEnv: cfg.env.pass_env,
          wrap: envBuild ? { argvPrefix: envBuild.argvPrefix, cleanup: () => sh(envBuild.cleanup!, { timeoutMs: 20000 }) } : undefined,
          onReady: async ({ port }) => {
            holder.text = await acceptanceWindow(cfg, deps, { port, prd, machine: null, cwd: wt });
            return null;
          },
        });
        if (!result.pass && result.error) throw new Error(`acceptance window failed: ${result.error}`);
      } finally {
        await sh(["git", "-C", src, "worktree", "remove", "--force", wt], { timeoutMs: 60_000 });
      }
    }

    // ── verdict + filing (fail closed on an unparsable walk) ──
    const verdict = parseAcceptanceVerdict(holder.text);
    if (verdict.delivered === null) {
      const last: AcceptanceLast = {
        status: "fail",
        main_head: mainHead,
        gen: st.gen,
        at: new Date().toISOString(),
        summary: "acceptance walk produced no parsable verdict (VERDICT/GAPS missing) — no gaps filed, fail closed",
      };
      writeAcceptanceState(stateDir, slug, { ...readAcceptanceState(stateDir, slug), last });
      return { ran: true, pass: false, summary: last.summary, filed };
    }
    for (const g of verdict.gaps) {
      const items = [
        {
          title: `[prd-gap] ${g.requirement.slice(0, 120)}`,
          body: [
            `Requirement (from the PRD): ${g.requirement}`,
            "",
            `What is missing or wrong: ${g.gap}`,
            g.repro ? `\nReproduction: ${g.repro}` : "",
            "",
            `Severity: ${g.severity === "minor" ? "minor — polish/edge; deferred until the product backlog drains" : "major — a PRD deliverable the current build does not deliver"}`,
            "",
            `Found by the drain-time PRD acceptance walk on origin/${cfg.default_branch} (${mainHead.slice(0, 12)}, backlog generation ${st.gen}).`,
            "",
            "This issue is a build order like any other: plan from the requirement, implement, keep every gate green. The acceptance walk re-runs when the backlog drains again.",
          ]
            .filter(Boolean)
            .join("\n"),
          labels: [PRD_GAP_LABEL, ...(g.severity === "minor" ? ["minor"] : [])],
          labelDescriptions: {
            [PRD_GAP_LABEL]: "PRD deliverable gap found by the acceptance walk",
            minor: "minor gap — deferred until the product backlog drains",
          },
        },
      ];
      filed.push(...(await fileFactoryIssues(stateDir, slug, deps.gh, items, { via: "prd acceptance" })));
    }
    const pass = verdict.delivered && verdict.gaps.length === 0;
    const last: AcceptanceLast = {
      status: pass ? "pass" : "fail",
      main_head: mainHead,
      gen: st.gen,
      at: new Date().toISOString(),
      summary: pass
        ? `prd acceptance: DELIVERED (all PRD requirements verified against the live product)`
        : `prd acceptance: ${verdict.gaps.length} gap(s) filed (${verdict.gaps.filter((g) => g.severity === "major").length} major)`,
    };
    writeAcceptanceState(stateDir, slug, { ...readAcceptanceState(stateDir, slug), last });
    receipt(stateDir, `acceptance walk: ${last.summary}${filed.length ? ` — filed ${filed.length} issue(s)` : ""}`, slug);
    return { ran: true, pass, summary: last.summary, filed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    receipt(stateDir, `acceptance walk errored (nothing filed): ${msg.slice(0, 300)}`, slug);
    return { ran: true, pass: false, summary: `walk errored: ${msg.slice(0, 200)}`, filed, reason: "error" };
  } finally {
    rmSync(marker, { force: true });
    if (machine) await machine.destroy().catch(() => {});
    if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function readPrdSafe(stateDir: string, slug: string): string | null {
  try {
    return readFileSync(prdPath(stateDir, slug), "utf8");
  } catch {
    return null;
  }
}
