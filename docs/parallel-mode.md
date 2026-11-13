# Parallel mode and the slot allocator

Status: deployed 2026-11-11 (main 8ed2623) and piloted on the two boxd smoke repos (results below).
Implementation plan: `.agents/plans/completed/parallel-mode.plan.md`; report:
`.agents/reports/parallel-mode-report.md`.

Two features that ship together:

- **The slot allocator.** Every machine-mode lap, serial or parallel, leases a machine slot
  from a shared, priority-ordered queue before it claims an issue. This replaces today's
  first-come retry loop against the platform's own cap.
- **Parallel mode.** A per-repo option. Several laps of one repo run at the same time, each on
  an issue whose dependencies are closed, picked by critical path. Approved branches land
  through a per-repo merge queue, one at a time, so main stays conflict-free.

The goal is a shorter time from PRD to finished product. Serial mode is unchanged and stays
the default.

## Why this shape

`docs/design-decisions.md` records why laps inside a repo run one at a time. In the previous
factory, concurrent branches produced mid-flight union-merges, a stranded branch and
cross-worktree import contamination. Commit `a24e5c2` (2026-10-19) ran every claimable issue
in parallel. `82688cf` reverted it the same day, before it had a real run.

Parallel mode answers each failure with a structural rule:

| Failure | Answer |
|---|---|
| Union-merges, stranded branches | Serial landing: one merge at a time per repo, each on a branch rebased onto the current main and re-verified there |
| Cross-worktree contamination | Machine modes only (instabox, boxd): every lap has its own box and clone |
| Independent issues touching the same files | Rebase conflict → one free repair round → second conflict re-plans on fresh main |

The live ledger shows the width exists. On 2026-11-11, the `queued: … (N claimable behind it)`
receipts in `laps.log` had jetpack at 12–18 independent issues waiting, cluckstorm up to 13
and night-street-racer 3–7. Fully linear backlogs (mdrender, kvstore) gain nothing and lose
nothing.

## Configuration

Per repo, in `config.json` (patchable through `POST /repos/<slug>/config`):

```json
"scheduling": {
  "priority": "normal",
  "spill_over": false,
  "parallel": false,
  "max_lanes": 3
}
```

| Key | Default | Meaning |
|---|---|---|
| `priority` | `normal` | `high`, `normal` or `low`: the repo's place in the slot queue |
| `spill_over` | `false` | when the repo's own platform pool is full, a lap may run on any other machine platform (instabox, boxd, daytona, e2b, instavm — own mode first, then the rest in fleet order). Every platform block carries defaults; point the target's `snapshot` at a baked base before relying on it |
| `parallel` | `false` | run up to `max_lanes` laps at once. Requires `env.mode` `instabox` or `boxd` |
| `max_lanes` | `3` | lanes per repo in parallel mode (1–10) |

Fleet-wide, in `factoryd.env` (the daemon's children inherit it):

| Variable | Default | Meaning |
|---|---|---|
| `PDF_POOL_INSTABOX` | `5` | concurrent factory machines on InstaBox (entry tier) |
| `PDF_POOL_BOXD` | `10` | concurrent factory machines on boxd. The account limit is 100, so this is a cost cap |
| `PDF_POOL_DAYTONA` | `5` | concurrent factory sandboxes on Daytona (Tier 1 org pool ≈ five 2-vCPU sandboxes) |
| `PDF_POOL_E2B` | `10` | concurrent factory sandboxes on E2B (Hobby plan cap) |
| `PDF_POOL_INSTAVM` | `5` | concurrent factory VMs on InstaVM (Free plan cap) |
| `PDF_AGING_MINUTES` | `30` | a waiting request moves up one priority level per this many minutes |
| `PDF_SLOT_WAIT_MS` | `840000` (14 min) | how long a tick process waits for a grant before it parks its request and exits |
| `PDF_FLEET_DAILY_ATTEMPTS` | `0` (off) | implement attempts across every repo per UTC day |
| `PDF_SLOT_POLL_MS` | `5000` | how often a waiting lap polls (and runs a grant pass) |
| `PDF_PR_HEAD_POLL_MS` | `3000` | how often the merge queue checks that GitHub sees a rebased head |

## The slot allocator

### Where it lives

The queue and the leases are rows in `factory.db`. The grant decision is one SQLite
`BEGIN IMMEDIATE` transaction (`grantPass`) that orders every waiting request and grants
what fits. factoryd runs a grant pass and a dead-holder sweep every 15 seconds and reports
the pools on `/health`. Requesters also run a grant pass each time they poll. So a manual
`foreman tick`, or a lap running across a daemon restart (`KillMode=process` keeps children
alive), never stalls waiting for the daemon. The decision is global either way: a poll never
grants out of order, because it runs the same ordering over every row.

The alternative was the daemon as the only granter, reached over a socket. A daemon restart
would then freeze every waiting lap, and there is no IPC channel between the daemon and its
tick children today (`spawnRepoTick` strips the API keys and pipes nothing).

### Tables

```sql
slot_requests (id, repo, slug, lane, pools, priority, extra_lane, pid, state,
               requested_at, granted_at, pool, issue_number, lap_id, released_at, detail)
-- state: waiting | parked | granted | released | lost
```

One row per lane's request. `pools` is the ordered platform preference (`["instabox"]`, or
`[own mode, then the rest of the fleet]` with spill-over). `pool` is the platform granted.

### Ordering

A waiting request's effective priority is its base level (low 0, normal 1, high 2) plus one
level per `PDF_AGING_MINUTES` waited, capped at high. A grant pass walks the waiting
requests sorted by:

1. **first lanes before extra lanes.** A repo's second or third lane only gets a slot once
   every waiting first lane is served. With 27 instabox repos on 5 slots, extra lanes on
   instabox will rarely run, which is the point: one wide repo must not starve the fleet.
   Extra lanes get their room from boxd, directly or by spill-over.
2. **effective priority, highest first.**
3. **`requested_at`, oldest first.**

Each request takes the first pool in its preference list that has a free slot. A granted
lease is never pre-empted: the box lives from plan through review, so priority only decides
who gets the next free slot.

### Lifecycle

1. A lane checks that something is claimable (so it never holds a slot for nothing), then
   calls `acquireSlot` before it claims. A request that waits does not hold an `in_progress`
   row, so intake, `unblock` and the janitor see nothing in flight. After the grant the lane
   picks again: the wait may have outlived the first pick.
2. The process polls every 5 s. After `PDF_SLOT_WAIT_MS` without a grant it marks the request
   `parked` (no pid) and the tick exits. The repo's next tick adopts the parked row, keeping
   its `requested_at`, so aging keeps counting. Waiting tick processes stay bounded in time and
   memory, as today's 10-minute slot queue is. A parked row nobody adopts within 60 minutes is
   dropped.
3. On grant, the lane claims an issue and records `issue_number` and `lap_id` on the lease.
4. The lease is released in `runLap`'s `finally`, after `machine.destroy()`.
5. A lease or request whose pid is dead (checked like `lock.ts` does: alive and looks like a
   factory process) is marked `lost` by the sweep. The machine it left is the janitor's, and
   the `in_progress` row is reconcile's, exactly as today.

The platform's own cap-reject retry inside `LapMachine.ensure` and `BoxdLapMachine.ensure`
stays as a fallback. Machines the allocator does not count (bake machines, `scen-test`
machines, anything else in the org) can still fill a platform.

### Spill-over

A spilled lap runs with a per-lap copy of the repo config whose `env.mode` is the granted
platform. `repoDirFor`, `openMachine`, the runtime context and verify all branch on
`cfg.env.mode`, so the copy is the whole change. It is rebuilt after `runChain`'s per-lap
config reload. Before enabling spill-over on a repo, run `scenario --test` on every
platform you spill to: snapshots differ in toolchain (the instabox base ships node, the
boxd base ships bun; the daytona/e2b/instavm bases ship bun + node + git + gh + python3).

The janitor buckets repos onto every machine platform, so a boxd-primary repo's spilled InstaBox
machine would be reaped as "unknown repo" mid-lap. The janitor change: a slug known to any
onboarded config is a known repo on both platforms. The live-lap guard (`in_progress` row)
is unchanged.

## Parallel mode

### Lanes

`runParallel` replaces `runChain` for a repo with `scheduling.parallel`. Inside the repo's
one tick process (the repo pidfile still guarantees only one), it runs `max_lanes` lane
loops concurrently. Each lane loop:

1. stops if the repo is paused, or a daily ceiling is reached (per-repo `limits.daily_attempts`,
   shared by all lanes, or the fleet-wide one);
2. acquires a slot (lane 0 as a first lane, the others as extra lanes);
3. picks the best claimable issue not already in flight in this process;
4. runs the lap with a lane context (siblings, merge queue, deferred discoveries);
5. releases the slot, records the outcome, loops.

The in-process `inFlight` set matters. Intake treats an `in_progress` row below the attempt
cap as an interrupted lap and returns it as claimable. In serial mode that is safe because
no other lap can be live. In parallel mode a sibling's live issue would be re-picked
without the filter.

Outcomes stay lane-scoped:

| Outcome | Serial (today) | Parallel |
|---|---|---|
| blocked | chain waits 10 min, one revive | only that lane moves on; dependents stay gated; revive runs at the next tick's start |
| error | issue waits for next tick | same (`retryNextTick` shared by lanes) |
| infra_deferred | rest of the chain deferred | no new laps start this tick; in-flight siblings finish |
| billing_hold | repo pauses | repo pauses; lanes stop before their next lap; in-flight siblings finish |

New laps start inside the chain budget (`PDF_CHAIN_BUDGET_MS`, 12 min) and the per-tick
start cap (6 × `max_lanes`); a started lap always finishes. Reconcile still runs once at tick
start under the repo lock, before any lane, when nothing can be live.

### Critical path

Intake already fetches every open issue with its body. `rankByCriticalPath` builds the
`Depends on:` graph over the open issues and scores each claimable issue by the longest chain
of open issues waiting on it, then by how many open issues depend on it transitively, then by
issue number. The longest chain is what bounds the time to finish the PRD, so it starts
first. Serial mode keeps oldest-first: with one lane, the order does not change the total time.

### Merge queue

All lanes of a repo run in one process, so the queue is an in-process FIFO mutex: ready order
is arrival order. Its state is mirrored to a `merge_queue` table for the dashboard
(`waiting | rebasing | reverifying | merging | merged | bounced`).

After review approves, the lap enters the queue. At the front:

1. `git fetch` main in the source checkout (under the source lock).
2. **Branch already contains main** (`merge-base --is-ancestor origin/main origin/<branch>`):
   merge on verify's head anchor, exactly as today.
3. **Main moved:** rebase inside the lap's machine (still alive, still holding its lease) and
   force-push. Then re-run verify on the rebased branch: changed gate, CI, runtime and holdout
   scenarios. Green verify gives a new head anchor, and the merge uses it. No second review:
   the agent changed nothing, and verify covers behavior.
4. **Rebase conflict:** abort the rebase. The conflicting files and the issues merged ahead
   become findings, and the lap leaves the queue for an implement round in the same box.
   That round costs no attempt (the cap is extended by one) but counts toward the daily
   ceilings. Because the agent touched code, that round goes through verify and review
   again, then re-enters the queue.
5. **Second conflict in the same lap:** retire `plan.md`, reset the box's branch to fresh main,
   and re-plan. This costs a normal attempt; the attempt cap still ends the lap as blocked.

The queue holds its turn through re-verify, CI included, because main must not move between
the verify that proved the branch and the merge. That is the price of a conflict-free main,
and it is paid only by laps whose base moved.

Humans pushing to main between the check and the merge still make `gh pr merge` fail. That
lands in the existing error path.

## Discoveries

- **At most one discovery lap in flight per repo.** A discovery issue has no `Depends on:`,
  so it always looks independent and would otherwise fill every lane (the jetpack starvation
  of 2026-11-02, multiplied by the width). Majors still drain first, in that one lane. Minors
  still wait until no product issue is claimable.
- **Filed at lap end, deduped across siblings.** A parallel lap stores its harvest and files it
  when the lap ends. Titles are compared normalized (case, punctuation, the `[discovery]`
  prefix) and by word overlap (Jaccard ≥ 0.7) against open issues and against what siblings
  filed this tick. Serial filing uses the same comparison against open issues. Reworded
  duplicates with different words still get through.
- **Minors** wait until no product issue is claimable, counting product issues still in
  flight in a sibling lane (the PRD backlog has not drained while one is being built).
- **Sibling-aware plans.** The plan prompt lists the issues in flight in sibling lanes, so a
  discovery whose code a sibling is rewriting can end as `NO_ACTION`.
- Unchanged: the recursion gate, the severity axis, auto-filing behind `discoveries.auto_file`.

## Slicer

With `scheduling.parallel`, the slicer prompt gets one more invariant: shared groundwork
(routing, schema, dependencies, app shell, navigation) goes in an early foundation issue that
the features depend on, so independent features do not collide on the same files. Dependency
honesty is unchanged: no invented edges.

## Dashboard

A new **Scheduling** page (`#/scheduling`, `GET /api/scheduling`), plus slot usage on the
overview's Machines card:

- **Pools:** per platform, cap, leases (repo, issue, lane, priority, effective priority, age,
  spilled), and the waiting queue in grant order with effective priority after aging.
- **Lanes:** per parallel repo, in-flight laps by lane with their stage.
- **Merge queues:** per repo, order and state.
- **Spill-over:** recent leases granted on a platform other than the repo's own.
- **Needs you:** a new `slot_wait` item for a request waiting more than 60 minutes.

The dashboard keeps its rule of no imports from `src/`. The effective-priority formula is
duplicated there, and a test pins both copies to the same results. Pool caps come from
factoryd's `/health` when the daemon answers, else from `DASHBOARD_POOL_INSTABOX` /
`DASHBOARD_POOL_BOXD` / `DASHBOARD_POOL_DAYTONA` / `DASHBOARD_POOL_E2B` / `DASHBOARD_POOL_INSTAVM` (each falling back to its `PDF_POOL_*`, then the defaults 5 / 10 / 5 / 10 / 5)

## Prompts

- The **plan** prompt of a parallel lap lists the issues in flight in sibling lanes and asks
  for `NO_ACTION` when one of them already covers this issue.
- The **implement** prompt no longer tells the agent to integrate main itself ("parallel laps
  may merge…", a leftover of the reverted `a24e5c2`). It says the factory rebases before
  merging and hands a conflict back as findings, and allows a rebase only when the findings
  ask for one.

## Pilot results (2026-11-11, production)

Deployed at 20:15 UTC (ledger backed up first to `state/factory.db.pre-parallel-2026-11-11`).

**Parallel lanes, `factory-boxd-smoke-1`** (boxd, `max_lanes` 3). Three independent issues
(#4 `/time`, #5 `/echo`, #6 `/version`), all editing the one file `app.py`:

| Time (UTC) | Event |
|---|---|
| 20:16:25 | 3 lanes start #4, #5, #6 at once on 3 boxd machines |
| 20:21:2x | all three verify green |
| 20:21:55 | #6 merges first |
| 20:21:57 / 20:22:06 | #4 and #5: rebase conflict in `app.py` → free repair round each |
| 20:27:08 | #4 merges after its repair |
| 20:27:21 | #5 conflicts again (now with #4) → plan retired, re-planned on fresh main |
| 20:33:01 | #5 merges; main serves all three endpoints, probed by hand |

17 minutes from start to the third merge. A clean lap here takes about 5.5 minutes, so the
same three issues run serially would also take about 17 minutes: in this pilot the
conflicts cost what the parallel start gained. All three issues edited the same
route-dispatch block of a one-file service, which is the worst case for parallel mode. It
exercised the repair and re-plan paths; the clean-rebase path, where the speedup comes
from, is covered by tests but has not run in production yet. A backlog whose issues touch
different files is the real test of the speedup. The reviews filed one discovery, which the next tick ran in
the single discovery lane and merged at 20:50.

**Spill-over, `factory-boxd-smoke-2`** (boxd repo, `spill_over` on, `env.instabox.snapshot`
`shared-base`). A manual tick with `PDF_POOL_BOXD=0` received an instabox slot at once
(`slot granted on instabox — spilled over (boxd pool full)`). The lap ran plan, implement,
verify (scenarios in the InstaBox machine) and review there, and merged #4 at 20:44. The
chained discovery lap spilled the same way and merged at 20:51. Its machine survived the
20:45 janitor pass.

Not yet seen in production: a serial instabox lap taking a lease (no instabox repo had
claimable work in the passes after the deploy), the 30-minute aging, a parked request.
All three are covered by tests.

## Not in scope

- Host and compose repos in parallel mode (one port pair per repo, one shared checkout).
- Self-hosted boxd (`BOXD_BASE_URL`) and multiple factory hosts. The lease table is local
  SQLite; several hosts would need a shared database.
- Shadow mode (logging parallel decisions while running serial).
- Counting non-lap machines (bake, `scen-test`) in the pools.
