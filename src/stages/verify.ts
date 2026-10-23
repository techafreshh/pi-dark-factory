import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GhApi, } from "../gh";
import { waitChecks } from "../gh";
import { buildStageCmd } from "../env";
import { sh } from "../sh";
import { changedPaths, issueDir, lockfileOnly } from "../gitws";
import { loadScenario, resolveScenarioPort, runScenario, type ScenarioResult } from "../scenario";
import type { RepoConfig } from "../types";

export interface GateFailure {
  gate: string;
  detail: string;
  /** multi-line reproduction evidence for the repair round: the failing
   *  probe's command, expect, gate verdict, and the actual response body —
   *  the implementing agent must not have to guess at the failing input */
  repair?: string;
}

export interface VerifyOutcome {
  pass: boolean;
  failures: GateFailure[];
  scenarios: ScenarioResult[];
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
    worktree: string;
    pr: number | null;
  }
): Promise<VerifyOutcome> {
  const failures: GateFailure[] = [];
  const scenarios: ScenarioResult[] = [];

  // 1. changed gate (re-checked here so repairs are judged the same way)
  const paths = await changedPaths(opts.worktree, cfg.default_branch);
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
    const envBuild =
      cfg.env.mode === "compose"
        ? buildStageCmd(cfg, opts.worktree, opts.stateDir, `pdf-${cfg.slug}-${opts.issue}-${key}`, {
            extraEnv: { PORT: String(spec.port), WORKTREE: opts.worktree },
            publishPorts: true, // scenario runs are the ONLY publishers of the port pair
          })
        : undefined;
    const result = await runScenario(spec, scratch, {
      readinessSeconds: cfg.timeouts.readiness_seconds,
      defaultProbeMs: cfg.timeouts.probe_ms,
      worktree: opts.worktree,
      preClean: `pdf-${cfg.slug}-`,
      wrap: envBuild
        ? { argvPrefix: envBuild.argvPrefix, cleanup: () => sh(envBuild.cleanup!, { timeoutMs: 20000 }) }
        : undefined,
    });
    scenarios.push(result);
    if (!result.pass) {
      failures.push({ gate: key, detail: summarizeScenario(result), repair: repairForScenario(result) });
    }
  }

  return { pass: failures.length === 0, failures, scenarios };
}

export function scenarioSummary(scenarios: ScenarioResult[]): string {
  return scenarios.length === 0 ? "(no scenarios configured)" : scenarios.map(summarizeScenario).join("\n");
}
