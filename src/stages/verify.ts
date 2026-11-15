import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GhApi, } from "../gh";
import { waitChecks } from "../gh";
import { buildStageCmd } from "../env";
import { sh } from "../sh";
import { branchName } from "./intake";
import { changedPaths, changedPathsFromRef, issueDir, lockfileOnly, sourceDir, withSourceLock } from "../gitws";
import { loadScenario, resolveScenarioPort, runScenario, runScenarioInMachine, type ScenarioResult } from "../scenario";
import { repoDirFor } from "../machine";
import { e2eSuiteExists } from "../acceptance-state";
import { runSuiteInLane, shipSuiteInBox, BOX_SUITE_DIR, type E2eSummary, type SuiteRunResult } from "./acceptance";
import { e2eSuiteDir } from "../acceptance-state";
import { receipt } from "../receipts";
import { isMachineMode, type RepoConfig } from "../types";

export interface GateFailure {
  gate: string;
  detail: string;
  /** multi-line reproduction evidence for the repair round: the failing
   *  probe's command, expect, gate verdict, and the actual response body —
   *  the implementing agent must not have to guess at the failing input */
  repair?: string;
}

export interface VerifyProvenance {
  /** host/compose modes: the local worktree HEAD the gates probed */
  worktreeHead: string | null;
  /** the PR head every mode anchored on (machine mode verifies the pushed branch) */
  prHead: string | null;
  /** evidence sidecar path — unique per attempt, first failure survives retries */
  sidecar: string;
}

export interface VerifyOutcome {
  pass: boolean;
  failures: GateFailure[];
  scenarios: ScenarioResult[];
  /** the authored browser suite's gate result, when the repo turned it on
   *  and a suite exists (docs/acceptance.md) — a fail is a GateFailure too */
  e2e?: SuiteRunResult;
  provenance?: VerifyProvenance;
}

/**
 * Per-attempt evidence sidecar (archon-steal #6): which revision the gates
 * probed and exactly what they saw, in a path unique to this attempt so a
 * retry can never overwrite the first failure's bodies. Months later,
 * "which sha did the asterisk gate probe?" is answerable from disk.
 */
let evidenceSeq = 0;
export function writeVerifyEvidence(
  stateDir: string,
  slug: string,
  issue: number,
  data: {
    attempt?: number;
    pr: number | null;
    worktreeHead: string | null;
    prHead: string | null;
    failures: GateFailure[];
    scenarios: ScenarioResult[];
    e2e?: { pass: boolean; summary: string };
  }
): string {
  const dir = join(stateDir, "repos", slug, "issues", String(issue), "verify-evidence");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `attempt-${data.attempt ?? "x"}-${ts}-${++evidenceSeq}.json`);
  writeFileSync(path, JSON.stringify({ recordedAt: new Date().toISOString(), issue, ...data }, null, 2) + "\n");
  return path;
}

function summarizeScenario(s: ScenarioResult): string {
  if (s.error) return `${s.name}: ${s.error}`;
  const failed = s.results.filter((r) => !r.pass).map((r) => `${r.id} (${r.detail})`);
  return failed.length === 0 ? `${s.name}: all ${s.results.length} probes green` : `${s.name}: ${failed.join("; ")}`;
}

/** The repair round's eyes: for every failed probe, what was sent, what the
 *  gate expected, and (capped) what the product actually answered. Evidence,
 *  not verdicts — the agent reproduces, it doesn't take our word. */
function repairForScenario(s: ScenarioResult): string {
  if (s.error) return `The ${s.name} scenario itself errored before probing: ${s.error}`;
  const lines: string[] = [];
  for (const r of s.results.filter((x) => !x.pass)) {
    lines.push(`✗ ${r.id} — ${r.description}`);
    if (r.command) lines.push(`  probe ran: ${r.command}`);
    lines.push(`  gate said: ${r.detail}`);
    if (r.body !== undefined) {
      lines.push("  response body the server actually returned:");
      lines.push(r.body.split("\n").map((l) => "    " + l).join("\n"));
    }
  }
  return lines.join("\n");
}

/**
 * All deterministic gates in one place. Nothing here trusts anything an
 * agent said: changed-paths come from git, CI state from GitHub, runtime
 * behavior from black-box scenario probes.
 */
export async function runVerify(
  cfg: RepoConfig,
  gh: GhApi,
  opts: {
    stateDir: string;
    issue: number;
    /** host/compose mode: the local worktree the change lives in */
    worktree?: string;
    /** instabox/boxd machine mode: scenario setup/start run inside this machine */
    machine?: { bash(script: string, opts?: { timeoutMs?: number }): Promise<import("../machine").ShRes> };
    pr: number | null;
    attempt?: number;
  }
): Promise<VerifyOutcome> {
  const failures: GateFailure[] = [];
  const scenarios: ScenarioResult[] = [];

  // provenance anchors, captured BEFORE probing: the merge refuses to run if
  // the PR head later differs from the prHead recorded here (TOCTOU guard)
  let worktreeHead: string | null = null;
  if (opts.worktree) {
    const r = await sh(["git", "-C", opts.worktree, "rev-parse", "HEAD"], { timeoutMs: 15000 });
    worktreeHead = r.code === 0 ? r.stdout.trim() || null : null;
  }
  let prHead: string | null = null;
  if (opts.pr !== null) {
    try { prHead = await gh.prHeadSha(opts.pr); } catch { prHead = null; }
  }

  // 1. changed gate (re-checked here so repairs are judged the same way).
  // Machine mode judges the fetched pushed branch — same diff, another side
  // of the tunnel.
  const paths = opts.machine
    ? await withSourceLock(cfg.slug, () => changedPathsFromRef(sourceDir(opts.stateDir, cfg.slug), cfg.default_branch, branchName(opts.issue)))
    : await changedPaths(opts.worktree!, cfg.default_branch);
  if (paths.length === 0) {
    failures.push({
      gate: "changed",
      detail: "no changed paths vs base — nothing was implemented",
      repair: "The previous attempt produced no commits ahead of the base branch. Implement the issue per the plan and git-commit every change before finishing — an uncommitted worktree is indistinguishable from no work.",
    });
  } else if (lockfileOnly(paths)) {
    failures.push({
      gate: "changed",
      detail: `only lockfiles changed (${paths.join(", ")}) — no substantive work`,
      repair: `Only lockfiles changed (${paths.join(", ")}). The commit gate needs substantive changes on top of the base branch.`,
    });
  }

  // 2. CI gate
  if (opts.pr !== null) {
    const ci = await waitChecks(gh, opts.pr, cfg.merge.required_checks, cfg.timeouts.checks_minutes * 60_000);
    if (!ci.pass) failures.push({ gate: "ci", detail: ci.detail });
  }

  // the e2e gate rides the runtime scenario's window via afterProbes; the
  // holder harvests the lane result across the loop below
  const e2eHolder: { result?: SuiteRunResult; infra?: string } = {};
  const gateApplies = !!cfg.acceptance?.e2e && e2eSuiteExists(opts.stateDir, cfg.slug) && !!cfg.scenario.runtime;
  if (gateApplies && opts.machine) {
    // the box needs the suite before the runtime window opens; a shipping
    // failure is INFRA (the infra rule, not the lap error path)
    try {
      await shipSuiteInBox(opts.machine, e2eSuiteDir(opts.stateDir, cfg.slug), BOX_SUITE_DIR);
    } catch (e) {
      e2eHolder.infra = `could not ship the suite into the box: ${e instanceof Error ? e.message.slice(0, 200) : e}`;
    }
  }
  const runE2eAfterProbes = async (ctx: { port: number; scratchDir?: string; env?: Record<string, string>; repoDir?: string; probesPassed: boolean }): Promise<void> => {
    if (e2eHolder.infra) return; // the real cause (a ship failure) must not be blamed on the probes
    if (!ctx.probesPassed) {
      e2eHolder.infra = "skipped: the scenario probes already failed (fail-fast — a broken product wastes the browser)";
      return;
    }
    try {
      e2eHolder.result = await runSuiteInLane({
        lane: opts.machine ? "box" : "host",
        port: ctx.port,
        suiteDir: opts.machine ? BOX_SUITE_DIR : e2eSuiteDir(opts.stateDir, cfg.slug),
        timeoutMs: (cfg.acceptance?.e2e_minutes ?? 10) * 60_000,
        env: ctx.env,
        machineBash: opts.machine ? (script, o) => opts.machine!.bash(script, o) : undefined,
      });
    } catch (e) {
      e2eHolder.infra = `transport error: ${e instanceof Error ? e.message.slice(0, 200) : e}`;
    }
  };

  // 3. runtime + holdout scenarios (outside the repo by contract). Container
  // mode: setup/start/teardown run in the product's worker container (PORT
  // forwarded explicitly — docker does not inherit the client's env), probes
  // stay host-side and black-box against the published ports.
  for (const [key, file] of [
    ["runtime", cfg.scenario.runtime],
    ["holdout", cfg.scenario.holdout],
  ] as const) {
    if (!file) continue;
    const path = join(opts.stateDir, "repos", cfg.slug, file);
    let spec;
    try {
      spec = loadScenario(path);
      spec.port = resolveScenarioPort(spec, cfg.scenario.ports);
    } catch (e: any) {
      failures.push({ gate: key, detail: `bad scenario file ${path}: ${e.message}` });
      continue;
    }
    const scratch = join(issueDir(opts.stateDir, cfg.slug, opts.issue), key === "runtime" ? "verify" : "holdout");
    mkdirSync(join(scratch, ".."), { recursive: true });
    let result: ScenarioResult;
    if (opts.machine && isMachineMode(cfg.env.mode)) {
      // setup + start run inside the machine; every probe judges the box's OWN
      // loopback over the machine's exec/bash primitive (instabox: ssh gateway
      // channel; boxd: hardened exec wrapper). $WORKTREE is the machine's copy
      // of the product — the same contract compose mode forwards over.
      // preClean's container analogue is the runner's own pidfile kill: a
      // previous run's server group dies before the next start.
      result = await runScenarioInMachine(spec, {
        bash: (script, timeoutMs) => opts.machine!.bash(script, { timeoutMs: timeoutMs ?? 600000 }),
        repoDir: repoDirFor(cfg),
      }, {
        readinessSeconds: cfg.timeouts.readiness_seconds,
        defaultProbeMs: cfg.timeouts.probe_ms,
        key: `${cfg.slug}-${opts.issue}-${key}`,
        reservedPorts: cfg.scenario.ports,
        afterProbes: key === "runtime" && gateApplies ? (ctx) => runE2eAfterProbes(ctx) : undefined,
      });
    } else {
      const envBuild =
        cfg.env.mode === "compose"
          ? buildStageCmd(cfg, opts.worktree!, opts.stateDir, `pdf-${cfg.slug}-${opts.issue}-${key}`, {
              extraEnv: { PORT: String(spec.port), WORKTREE: opts.worktree! },
              publishPorts: true, // scenario runs are the ONLY publishers of the port pair
            })
          : undefined;
      result = await runScenario(spec, scratch, {
        readinessSeconds: cfg.timeouts.readiness_seconds,
        defaultProbeMs: cfg.timeouts.probe_ms,
        worktree: opts.worktree,
        preClean: `pdf-${cfg.slug}-`,
        passEnv: cfg.env.pass_env,
        wrap: envBuild
          ? { argvPrefix: envBuild.argvPrefix, cleanup: () => sh(envBuild.cleanup!, { timeoutMs: 20000 }) }
          : undefined,
        afterProbes: key === "runtime" && gateApplies ? (ctx) => runE2eAfterProbes(ctx) : undefined,
      });
    }
    scenarios.push(result);
    if (!result.pass) {
      failures.push({ gate: key, detail: summarizeScenario(result), repair: repairForScenario(result) });
    }
  }

  // 4. the e2e verdict, harvested from the runtime window's afterProbes seam
  // (docs/acceptance.md): the suite ran in the SAME product-up window as the
  // probes — the product starts once per lap, no separate box per merge. A
  // suite that RAN and failed is a GATE failure (repair loop, the failing
  // tests are the findings); a suite that could NOT run (transport throw, no
  // report, failed-probe skip) is INFRA — receipted loudly, never a gate
  // failure, never an attempt burn. The gate skips while no suite exists
  // (the drain-time walk authors one) or the flag is off.
  let e2e: SuiteRunResult | undefined;
  if (e2eHolder.infra) {
    receipt(opts.stateDir, `e2e gate skipped (infra, not a product failure — the next lap retries): ${e2eHolder.infra}`, cfg.slug);
  } else if (e2eHolder.result) {
    e2e = e2eHolder.result;
    // a product failure is one the implementer can ACT on: the report lists
    // actual test failures. Everything else — no report, a passed report
    // with a nonzero runner rc (it died after the tests), a non-passed
    // status with an empty failure list (interrupted mid-run) — carries no
    // actionable evidence, so it is infra: receipted, retried next lap.
    const productFailure = !!e2e.report && e2e.report.failures.length > 0;
    if (!e2e.pass && productFailure) {
      failures.push({ gate: "e2e", detail: e2e.summary, repair: repairForE2e(e2e.report) });
    } else if (!e2e.pass) {
      e2e = undefined;
      const why = !e2eHolder.result.report
        ? "the suite produced no parsable report"
        : e2eHolder.result.report.status === "passed"
          ? "the suite passed but the runner exited nonzero"
          : `the run ended without test failures (status ${e2eHolder.result.report.status})`;
      receipt(opts.stateDir, `e2e gate skipped (infra): ${why} — the next lap retries`, cfg.slug);
    }
  }

  const sidecar = writeVerifyEvidence(opts.stateDir, cfg.slug, opts.issue, {
    attempt: opts.attempt,
    pr: opts.pr,
    worktreeHead,
    prHead,
    failures,
    scenarios,
    e2e: e2e ? { pass: e2e.pass, summary: e2e.summary } : undefined,
  });
  return { pass: failures.length === 0, failures, scenarios, e2e, provenance: { worktreeHead, prHead, sidecar } };
}

/** The e2e gate's repair evidence: the failing tests with their recorded
 *  errors — the implementing agent reproduces from these, not from a
 *  one-line verdict. (The full report.json stays in factory state.) */
function repairForE2e(report: E2eSummary | null): string | undefined {
  if (!report || report.failures.length === 0) return undefined;
  return report.failures
    .slice(0, 10)
    .map((f) => `✗ ${f.file} :: ${f.testId} (${f.status})${f.error ? `: ${f.error}` : ""}`)
    .join("\n");
}

export function scenarioSummary(scenarios: ScenarioResult[]): string {
  return scenarios.length === 0 ? "(no scenarios configured)" : scenarios.map(summarizeScenario).join("\n");
}

/**
 * Post-merge regression pass (archon-steal #1, report-only form): re-run the
 * repo's scenario contracts against the ACTUAL merged main. A chained lap
 * verifies its branch pre-merge, but main's post-squash tree is one no gate
 * has probed whenever a human push landed between laps — this is the
 * standing "main is contract-green" receipt. Report-only by design: it
 * repairs nothing and pauses nothing; a failure files one deduped evidence
 * issue and the chain moves on. Blocking semantics come later, once the
 * pass has proven quiet. Host/compose repos only — machine-mode repos get
 * their per-lap verify against current main already.
 */
export async function runPostMergeRegression(
  cfg: RepoConfig,
  gh: GhApi,
  opts: { stateDir: string; pr: number }
): Promise<{ pass: boolean; summary: string; issue: number | null }> {
  const src = sourceDir(opts.stateDir, cfg.slug);
  const tmpRoot = join(opts.stateDir, "repos", cfg.slug, "issues", "regression");
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });
  const wt = join(tmpRoot, "wt");
  const fetched = await sh(["git", "-C", src, "fetch", "origin", cfg.default_branch, "--prune"], { timeoutMs: 120_000 });
  if (fetched.code !== 0) return { pass: false, summary: `fetch failed: ${fetched.stderr.trim().slice(0, 200)}`, issue: null };
  const added = await sh(["git", "-C", src, "worktree", "add", "--detach", wt, `origin/${cfg.default_branch}`], { timeoutMs: 120_000 });
  if (added.code !== 0) return { pass: false, summary: `worktree add failed: ${added.stderr.trim().slice(0, 200)}`, issue: null };
  try {
    const scenarios: ScenarioResult[] = [];
    for (const [key, file] of [
      ["runtime", cfg.scenario.runtime],
      ["holdout", cfg.scenario.holdout],
    ] as const) {
      if (!file) continue;
      const path = join(opts.stateDir, "repos", cfg.slug, file);
      let spec;
      try {
        spec = loadScenario(path);
        spec.port = resolveScenarioPort(spec, cfg.scenario.ports);
      } catch (e: any) {
        scenarios.push({ name: key, pass: false, error: `bad scenario file ${path}: ${e.message}`, results: [] });
        continue;
      }
      const scratch = join(tmpRoot, key);
      const envBuild =
        cfg.env.mode === "compose"
          ? buildStageCmd(cfg, wt, opts.stateDir, `pdf-${cfg.slug}-regress-${key}`, {
              extraEnv: { PORT: String(spec.port), WORKTREE: wt },
              publishPorts: true,
            })
          : undefined;
      const result = await runScenario(spec, scratch, {
        readinessSeconds: cfg.timeouts.readiness_seconds,
        defaultProbeMs: cfg.timeouts.probe_ms,
        worktree: wt,
        preClean: `pdf-${cfg.slug}-`,
        passEnv: cfg.env.pass_env,
        wrap: envBuild
          ? { argvPrefix: envBuild.argvPrefix, cleanup: () => sh(envBuild.cleanup!, { timeoutMs: 20000 }) }
          : undefined,
      });
      scenarios.push(result);
    }
    const failed = scenarios.filter((s) => !s.pass);
    const summary = scenarios.length === 0 ? "no scenarios configured" : scenarios.map(summarizeScenario).join("\n");
    if (failed.length === 0) return { pass: true, summary, issue: null };

    const failingNames = failed.map((s) => s.name).join("+");
    const title = `[regression] ${cfg.default_branch} broke the ${failingNames} contract after PR #${opts.pr}`;
    const body = [
      `Post-merge regression pass against \`origin/${cfg.default_branch}\` (report-only: the chain was not paused).`,
      `Merged via PR #${opts.pr}; the scenarios had passed on the branch before the squash.`,
      "",
      ...failed.map((s) => repairForScenario(s)),
      "",
      "This issue is evidence, not a repair order — the next lap or a human decides.",
    ].join("\n");
    let issue: number | null = null;
    let notFiled = "";
    try {
      const open = await gh.issueList("open", 100);
      if (!open.some((i) => i.title === title)) issue = await gh.issueCreate(title, body);
    } catch (e) {
      // still never fatal to the chain, but no longer silent: a bare catch
      // here hid a call to issueListOpen — a method GhApi never had — so not
      // one regression issue was ever filed
      notFiled = `\n(regression issue NOT filed: ${e instanceof Error ? e.message : String(e)})`;
    }
    return { pass: false, summary: summary + notFiled, issue };
  } finally {
    await sh(["git", "-C", src, "worktree", "remove", "--force", wt], { timeoutMs: 30_000 });
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
