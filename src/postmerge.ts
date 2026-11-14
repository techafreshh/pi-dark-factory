import { existsSync } from "node:fs";
import { join } from "node:path";
import { e2eSuiteExists, prdPath, withAcceptanceMarker } from "./acceptance-state";
import { fileFactoryIssues } from "./fileissues";
import { ensureSource } from "./gitws";
import { listClaimable, DISCOVERY_LABEL, MINOR_LABEL, PRD_GAP_LABEL, SECURITY_LABEL, E2E_REGRESSION_LABEL } from "./stages/intake";
import { loadScenario, resolveScenarioPort } from "./scenario";
import { runSecurityScan } from "./security";
import { bootAcceptanceMachine, runE2eSuite, runPrdAcceptance, type AcceptanceDeps } from "./stages/acceptance";
import { sh } from "./sh";
import type { LapMachineLike } from "./machine";
import type { GhApi } from "./gh";
import type { Ledger } from "./ledger";
import type { CallStageFn } from "./tick";
import { isMachineMode, type RepoConfig } from "./types";

/**
 * The acceptance hooks of the lap lifecycle (docs/acceptance.md):
 *
 *  - runPostMergeExtras runs after EVERY squash-merge (serial post-merge
 *    block and the parallel merge queue alike): the penthera security scan
 *    and the authored e2e suite against merged main. Both are report-only —
 *    failures file issues, the chain always moves on ("nothing after the
 *    merge may route the lap into the error path").
 *  - maybeDrainAcceptance is the end-of-project gate: when a tick finds
 *    nothing claimable and every open issue is a deferred factory class, it
 *    runs the full PRD acceptance walk (the agent judges the live product
 *    against the stored PRD and files [prd-gap] issues).
 */

/** boots the per-mode machine at issue 0 — the acceptance machine family
 *  (pdf-<slug>-i0), guarded from the janitor by acceptance.running. tick.ts
 *  supplies it (its injected test factory wins; else the per-mode dispatch). */
export type OpenMachineFor = (cfg: RepoConfig, log: (m: string) => void) => LapMachineLike;

/** The merged-main e2e regression: suite against origin/main, host lane or
 *  a short-lived acceptance machine. Files ONE deduped [e2e-regression]
 *  issue on failure; returns a receipt line either way. */
async function runMergedMainSuite(cfg: RepoConfig, gh: GhApi, opts: { stateDir: string; pr?: number; openMachineFor: OpenMachineFor }): Promise<string> {
  const { stateDir } = opts;
  if (!cfg.scenario.runtime) return "e2e regression skipped: no runtime scenario";
  if (!e2eSuiteExists(stateDir, cfg.slug)) return "e2e regression skipped: no authored suite yet (the next drain walk authors one)";
  const spec = loadScenario(join(stateDir, "repos", cfg.slug, cfg.scenario.runtime));
  spec.port = resolveScenarioPort(spec, cfg.scenario.ports);

  let res: Awaited<ReturnType<typeof runE2eSuite>>;
  if (isMachineMode(cfg.env.mode)) {
    const machine = opts.openMachineFor(cfg, (m) => m);
    try {
      // the marker is the ONLY janitor protection an issue-0 machine has —
      // the per-merge regression machine carries it exactly like the walk's
      res = await withAcceptanceMarker(stateDir, cfg.slug, async () => {
        await bootAcceptanceMachine(cfg, machine);
        return runE2eSuite(cfg, spec, { stateDir, machine, repoDir: ((cfg.env as any)[cfg.env.mode]?.repo_dir as string) ?? "" });
      });
    } finally {
      await machine.destroy().catch(() => {});
    }
  } else {
    // host / compose: one detached worktree of merged main — the same shape
    // runPostMergeRegression uses for the scenario lanes (verify.ts). A
    // crash between `worktree add` and the finally leaves the tree behind
    // and would block every later run, so the root is cleared first.
    const src = await ensureSource(stateDir, cfg);
    const root = join(stateDir, "repos", cfg.slug, "issues", "accept-main");
    const wt = join(root, "wt");
    await sh(["git", "-C", src, "worktree", "remove", "--force", wt], { timeoutMs: 30_000 }); // stale leftover, if any
    await sh(["rm", "-rf", root], { timeoutMs: 30_000 });
    await sh(["git", "-C", src, "worktree", "prune"], { timeoutMs: 30_000 });
    const added = await sh(["git", "-C", src, "worktree", "add", "--detach", wt, `origin/${cfg.default_branch}`], { timeoutMs: 120_000 });
    if (added.code !== 0) throw new Error(`could not worktree merged main: ${added.stderr.trim().slice(0, 200)}`);
    try {
      res = await runE2eSuite(cfg, spec, { stateDir, scratchDir: wt });
    } finally {
      await sh(["git", "-C", src, "worktree", "remove", "--force", wt], { timeoutMs: 60_000 });
      await sh(["rm", "-rf", root], { timeoutMs: 30_000 });
    }
  }

  if (res.pass) return `e2e regression: ${res.summary}`;
  const failures = res.report?.failures ?? [];
  const body = [
    `The authored browser e2e suite failed against \`origin/${cfg.default_branch}\` (report-only: the chain was not paused).`,
    opts.pr ? `Merged via PR #${opts.pr}; the suite had last passed before the squash.` : "Ran against merged main.",
    "",
    `Suite result: ${res.summary}`,
    "",
    ...(failures.length
      ? failures.slice(0, 10).map((f) => `- ${f.file} :: ${f.testId} (${f.status})${f.error ? `: ${f.error}` : ""}`)
      : [res.summary]),
    failures.length > 10 ? `\n… and ${failures.length - 10} more` : "",
    "",
    "Fix order for the lap loop: reproduce from the failing step above, repair, and keep the scenario + e2e gates green. Host-lane runs keep the full report at state/repos/" +
      cfg.slug +
      "/e2e/.e2e/report.json; in-box (machine-mode) runs keep it in the machine — the failing steps above are the evidence.",
  ].join("\n");
  const filed = await fileFactoryIssues(
    stateDir,
    cfg.slug,
    gh,
    [
      {
        title: `[e2e-regression] merged main fails the browser suite after PR #${opts.pr ?? "?"}`,
        body,
        labels: [E2E_REGRESSION_LABEL],
        labelDescriptions: { [E2E_REGRESSION_LABEL]: "the authored e2e suite fails on merged main" },
      },
    ],
    { via: "e2e regression" }
  );
  return `e2e regression: ${res.summary}${filed.length ? ` (issue #${filed[0].issue})` : ""}`;
}

/** Everything that runs after a merge: penthera (every mode — it is a
 *  static host-side scan) and the e2e suite (host/compose host-side,
 *  machine modes on a short-lived acceptance machine). Every step is
 *  individually try/caught: a hook failure is a receipt, never a lap error. */
export async function runPostMergeExtras(
  cfg: RepoConfig,
  gh: GhApi,
  opts: { stateDir: string; pr?: number; atDrain?: boolean; openMachineFor: OpenMachineFor }
): Promise<string> {
  const lines: string[] = [];
  if (cfg.acceptance?.security) {
    try {
      const r = await runSecurityScan(cfg, gh, { stateDir: opts.stateDir, pr: opts.pr, atDrain: opts.atDrain });
      lines.push(
        `security: ${r.summary}${r.note ? ` (${r.note})` : ""}${r.filed.length ? ` — filed ${r.filed.map((f) => "#" + f.issue).join(", ")}` : ""}`
      );
    } catch (e) {
      lines.push(`security scan errored (chain unaffected): ${e instanceof Error ? e.message.slice(0, 200) : e}`);
    }
  }
  if (cfg.acceptance?.e2e) {
    try {
      lines.push(await runMergedMainSuite(cfg, gh, opts));
    } catch (e) {
      lines.push(`e2e regression errored (chain unaffected): ${e instanceof Error ? e.message.slice(0, 200) : e}`);
    }
  }
  return lines.join(" ; ");
}

/** True when every open issue belongs to a deferred factory class — the
 *  "backlog drained" shape. A repo with open product issues (dep-gated,
 *  needs-info, foreign-PR'd) is STARVED, not finished, and never walks. */
export function openIssuesAllDeferred(open: { labels?: string[] }[]): boolean {
  const deferred = [DISCOVERY_LABEL, SECURITY_LABEL, PRD_GAP_LABEL, MINOR_LABEL];
  return open.every((i) => (i.labels ?? []).some((l) => deferred.includes(l)));
}

/** The drain-time gate. Called from tickBody's per-repo task (inside the
 *  repo lock) when the tick's work ended with nothing claimable. The walk
 *  itself double-checks due-ness, the daily cap and the stored PRD. */
export async function maybeDrainAcceptance(
  cfg: RepoConfig,
  stateDir: string,
  deps: { gh: GhApi; ledger: Ledger; callStage?: CallStageFn; openMachineFor: OpenMachineFor }
): Promise<void> {
  if (!cfg.acceptance?.prd_check) return;
  if (!existsSync(prdPath(stateDir, cfg.slug))) return;
  // still-drained re-check: the chain re-intakes after every lap, so this
  // usually matches the caller's reason for calling — but a manual tick or
  // a race (an issue filed seconds ago) must not trigger a walk
  const claimable = await listClaimable(cfg, deps.ledger, deps.gh).catch(() => null);
  if (!claimable || claimable.length > 0) return;
  const open = await deps.gh.issueList("open", 1000).catch(() => null);
  if (!open || !openIssuesAllDeferred(open)) return;

  const log = (m: string) => m; // runPrdAcceptance receipts the outcomes itself
  // the walk receipts its own outcomes; wiring/cap refusals stay quiet
  await runPrdAcceptance(cfg, {
    stateDir,
    gh: deps.gh,
    ledger: deps.ledger,
    callStage: deps.callStage,
    openMachine: deps.openMachineFor,
    log,
  });
}
