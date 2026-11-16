# Implementation Report

**Plan**: `.agents/plans/completed/parallel-mode.plan.md`
**Branch**: `feature/parallel-mode` (4 commits on `main` at 2af556b, not pushed, not deployed)
**Status**: COMPLETE in code. Phase 6.2 (pilot) needs the owner: deploy and token spend.

## Summary

| Commit | What changed |
|---|---|
| 0a67281 | Slot allocator. Machine-mode laps lease a slot before they claim. The queue lives in `factory.db` (`slot_requests`); grant order is first lanes, then priority with 30-min aging, then oldest. Pools: instabox 5, boxd 10. Opt-in spill-over runs a lap on the other platform. Requests park after 14 min and the next tick adopts them. The janitor knows spilled machines. factoryd runs a 15 s heartbeat; `/health` and `status` report the pools. |
| 8b6a335 | Parallel mode. `runParallel` lanes rank issues by critical path; an in-process in-flight set stops a live issue being picked twice. Blocks are lane-scoped. The merge queue rebases in the box, waits for GitHub to see the new head, re-verifies, gives one free conflict repair, and re-plans after a second conflict. One discovery lane; discoveries are filed at lap end and deduped. Plans list sibling issues. The slicer gets a foundation rule. Fleet daily ceiling. Gate ref reads take the source lock. |
| 847af3f | Dashboard. Scheduling page with pools, leases, the waiting queue in grant order, lanes, merge queues and spill-over. `slot_wait` added to needs-you. Slot usage shown on the overview. |
| (docs commit) | Docs, `DEPLOYMENT.md`, README, and the dark-factory skill. |

## Validation Results

| Check | Result |
|---|---|
| Type check (`tsc --noEmit -p .`) | 0 errors |
| UI type check + build (`dashboard-ui`) | 0 errors, built |
| Tests (`bun test`) | 446 pass, 0 fail (baseline 386) |
| E2E: real factoryd with the scheduler on, `PDF_POOL_BOXD=2`, 3 waiting requests held by the daemon's pid | the heartbeat granted exactly 2 and receipted both; `/health` showed `boxd used 2, waiting 1` |
| E2E: dashboard against a seeded state dir, checked in Chromium (agent-browser) | Scheduling page renders pools (1/5, 2/10), leases with stage and a `spilled` badge, the queue in grant order (`low → high` after aging, the extra lane second), lanes 2/3 and 1/2, merge queue rows; overview shows a `slot wait` item and `1/5 slots · 2 waiting` |
| Integration (real git, fake GitHub, fake machines) | 3 lanes concurrent (barrier proved 3 live implement rounds); 2 rebases plus re-verifies; a dependent planned only after its dependency closed; a lane blocks while its sibling merges; pause stops new laps; first conflict repaired at attempts=1 thanks to the bonus round; second conflict re-planned (plan.superseded file, 2 plan stages); a reworded discovery filed once |

The production dashboard (`pi-factory-dashboard`, factory user, `/home/factory/pi-dark-factory`) was not touched; every test server ran from this checkout on throwaway ports and state dirs.

## Deviations from the plan

- **The lane checks for claimable work before requesting a slot, and picks again after the grant.** This stops a lane from holding a slot when there is nothing to build. The claim still happens only after the grant.
- **The merge queue waits for GitHub to show the rebased head** (`waitForPrHead`, up to 90 s) before re-verifying. Without the wait, verify could anchor on the pre-rebase head and merge code that was never verified against the new main.
- **Serial discovery filing also uses the fuzzy dedupe** (one shared `fileDiscoveries`). This means slightly more dedupe than before.
- **The implement prompt's leftover line from a24e5c2 was replaced.** It told the agent to integrate main itself and said "do not rewrite history"; both contradict the merge queue's rebase repair.
- **`withSourceLock` moved to `src/gitws.ts`** so verify can take it (tick imports verify, so verify can't import tick).
- **The minor-discovery rule counts product issues in flight in sibling lanes as not drained yet.**
- **Two extra test knobs:** `PDF_SLOT_POLL_MS` and `PDF_PR_HEAD_POLL_MS`. The dashboard also takes `DASHBOARD_POOL_*` fallbacks when `/health` is unreachable.
- **`buildPlanPrompt` had no test before**, so `test/plan.test.ts` is new.

## Known limits

- Bake and `scen-test` machines are not counted in the pools. The platform's own cap-reject retry covers them.
- A lap killed during the free repair round has `attempts` > `cfg.attempts`, so reconcile books it as blocked. Auto-revive picks it up as usual.
- Dedupe misses rewordings that use different words.

## Not done (needs the owner)

1. Deploy: merge the branch, `git pull` in `/home/factory/pi-dark-factory`, `bun install`, restart `pi-factoryd` and `pi-factory-dashboard`. Serial machine laps will then receipt slot grants.
2. Pilot (plan Task 6.2): `scheduling.parallel` on `factory-boxd-smoke-1`; `spill_over` on `factory-boxd-smoke-2` after baking an InstaBox snapshot. Record the timings in `docs/parallel-mode.md`.

## Tests Written

| Test file | Cases |
|---|---|
| test/allocator.test.ts | aging; priority order; FIFO; caps; aging beats fresh; first lanes before extra; spill; blocked request doesn't stop another pool; env caps; queue position; dead-holder sweep (seam + real exited pid); park/adopt/expire; acquire grant/park/pause/spill; lanePools; configForPool; 4-process concurrent grant never exceeds the cap |
| test/lease.test.ts | lease before claim, bound, released after destroy; host never leases; spill-over lap runs on boxd; full pool parks with no claim |
| test/parallel.test.ts | concurrency + rebase + re-verify; dependency ordering; lane-scoped block; pause; free repair; re-plan; cross-lane discovery dedupe; pickForLane rules; MergeQueue order/bounce; reconcile closes open turns |
| test/critpath.test.ts | longest chain first; fan-out tie-break; closed dependents; cycles; self/unknown deps |
| test/dedupe.test.ts | normalization; Jaccard; non-duplicates; empty |
| test/plan.test.ts | sibling section; implement-prompt rebase wording |
| test/config.test.ts | scheduling defaults, merge, validation, machine-mode and spill requirements |
| test/ops.test.ts | janitor spares a boxd repo's spilled InstaBox machine |
| test/factoryd.test.ts, test/scheduler.test.ts | `/health` pools; daemon heartbeat grants and receipts |
| test/dashboard.test.ts | computeScheduling pools/queue/leases/lanes/merge queues/spills; slot_wait; effectivePriority copies agree |
| test/slicer.test.ts | foundation rule only in parallel mode |
