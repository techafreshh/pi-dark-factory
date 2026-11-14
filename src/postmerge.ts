import { existsSync } from "node:fs";
import { prdPath } from "./acceptance-state";
import { listClaimable, DISCOVERY_LABEL, MINOR_LABEL, PRD_GAP_LABEL, SECURITY_LABEL } from "./stages/intake";
import { runSecurityScan } from "./security";
import { runPrdAcceptance, type AcceptanceDeps } from "./stages/acceptance";
import type { LapMachineLike } from "./machine";
import type { GhApi } from "./gh";
import type { Ledger } from "./ledger";
import type { CallStageFn } from "./tick";
import type { RepoConfig } from "./types";

/**
 * The acceptance hooks of the lap lifecycle (docs/acceptance.md):
 *
 *  - runPostMergeExtras runs after EVERY squash-merge (serial post-merge
 *    block and the parallel merge queue alike): the penthera security scan
 *    against merged main, report-only — failures file issues, the chain
 *    always moves on ("nothing after the merge may route the lap into the
 *    error path"). The browser e2e suite is NOT here: it is a verify-stage
 *    gate (src/stages/verify.ts) whose failures block the merge through the
 *    repair loop.
 *  - maybeDrainAcceptance is the end-of-project gate: when a tick finds
 *    nothing claimable and every open issue is a deferred factory class, it
 *    runs the full PRD acceptance walk (the agent judges the live product
 *    against the stored PRD and files [prd-gap] issues).
 */

/** boots the per-mode machine at issue 0 — the acceptance machine family
 *  (pdf-<slug>-i0), guarded from the janitor by acceptance.running. tick.ts
 *  supplies it (its injected test factory wins; else the per-mode dispatch). */
export type OpenMachineFor = (cfg: RepoConfig, log: (m: string) => void) => LapMachineLike;

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
  // the browser e2e suite is NOT here anymore: it runs as a verify gate on
  // the lap's own machine (docs/acceptance.md) — failures block the merge
  // through the repair loop instead of filing issues after the fact
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
