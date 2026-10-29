import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GhApi, } from "../gh";
import { waitChecks } from "../gh";
import { buildStageCmd } from "../env";
import { sh } from "../sh";
import { branchName } from "./intake";
import { changedPaths, changedPathsFromRef, issueDir, lockfileOnly, sourceDir } from "../gitws";
import { loadScenario, resolveScenarioPort, runScenario, runScenarioInMachine, type ScenarioResult } from "../scenario";
import type { SshTarget } from "../machine";
import type { RepoConfig } from "../types";

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
    /** instabox machine mode: scenario setup/start run inside this machine */
    machine?: { ssh(): Promise<SshTarget> };
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
    ? await changedPathsFromRef(sourceDir(opts.stateDir, cfg.slug), cfg.default_branch, branchName(opts.issue))
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
    if (opts.machine && cfg.env.mode === "instabox") {
      // setup + start run inside the machine; probes stay host-side behind an
      // ssh -L forward of the scenario port. $WORKTREE is the machine's copy
      // of the product — the same contract compose mode forwards over.
      // preClean's container analogue is the runner's own pidfile kill: a
      // previous run's server group dies before the next start.
      result = await runScenarioInMachine(spec, { ssh: () => opts.machine!.ssh(), repoDir: cfg.env.instabox.repo_dir }, {
        readinessSeconds: cfg.timeouts.readiness_seconds,
        defaultProbeMs: cfg.timeouts.probe_ms,
        key: `${cfg.slug}-${opts.issue}-${key}`,
        reservedPorts: cfg.scenario.ports,
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
        wrap: envBuild
          ? { argvPrefix: envBuild.argvPrefix, cleanup: () => sh(envBuild.cleanup!, { timeoutMs: 20000 }) }
          : undefined,
      });
    }
    scenarios.push(result);
    if (!result.pass) {
      failures.push({ gate: key, detail: summarizeScenario(result), repair: repairForScenario(result) });
    }
  }

  const sidecar = writeVerifyEvidence(opts.stateDir, cfg.slug, opts.issue, {
    attempt: opts.attempt,
    pr: opts.pr,
    worktreeHead,
    prHead,
    failures,
    scenarios,
  });
  return { pass: failures.length === 0, failures, scenarios, provenance: { worktreeHead, prHead, sidecar } };
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
    try {
      const open = await gh.issueListOpen(100);
      if (!open.some((i) => i.title === title)) issue = await gh.issueCreate(title, body);
    } catch {}
    return { pass: false, summary, issue };
  } finally {
    await sh(["git", "-C", src, "worktree", "remove", "--force", wt], { timeoutMs: 30_000 });
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
