# Plan: Parallel mode and the slot allocator

## Summary

Add a fleet-wide machine-slot allocator (SQLite-backed queue and leases, priority high/normal/low
with aging, first lanes before extra lanes, opt-in spill-over between InstaBox and boxd), then a
per-repo parallel mode on top of it: up to `max_lanes` laps of one repo run at once in the repo's
tick process, picked by critical path from the `Depends on:` graph, landing through an in-process
merge queue (ready order; foreman rebases in the lap's box and re-verifies; one free conflict
repair; second conflict re-plans). Discoveries get one lane and batch dedupe; the slicer gets a
foundation-issue rule in parallel mode; the dashboard gets a Scheduling page. Design and rationale:
`docs/parallel-mode.md`. Serial mode stays the default and keeps its behavior, except that its
machine laps now lease a slot before claiming.

## User Story

As the factory owner
I want independent issues of one PRD to build at the same time, and machine slots shared fairly by priority across all projects
So that a PRD finishes sooner without main ever taking a conflicting merge

## Metadata

| Field | Value |
|-------|-------|
| Type | NEW_CAPABILITY |
| Complexity | HIGH |
| Systems Affected | ledger, tick engine, intake, machines (instabox + boxd), janitor, factoryd, config, slicer, discoveries, dashboard server + UI, docs |
| Jira Issue | N/A |

## Decisions (owner, 2026-11-11)

| Topic | Decision |
|---|---|
| Goal | shortest time from PRD to finished product |
| Parallel mode | per-repo `scheduling.parallel`, machine modes only, default `max_lanes` 3 |
| Picking | dependency graph; critical path first |
| Landing | merge queue, ready order; foreman rebase + re-verify; conflict → 1 free repair → re-plan |
| Blocks | lane-scoped; siblings continue |
| Allocator | in factory state, driven by factoryd; covers serial repos too; slot granted before claim |
| Priority | high / normal / low, strict with aging (+1 level per 30 min) |
| Pools | instabox 5, boxd 10 (boxd cloud, account limit 100) |
| Spill-over | opt-in per repo (`scheduling.spill_over`) |
| Spend | shared per-repo `daily_attempts`; optional fleet ceiling |
| Discoveries | ≤1 lane, minors after PRD, batch dedupe, sibling-aware plan |
| Slicer | foundation issue first in parallel mode |
| Dashboard | everything: pools, queue, lanes, merge queue, spill |
| Pilot | `factory-boxd-smoke-1`, `factory-boxd-smoke-2` |
| Disk (95%) | separate task, not in this plan |

## Implementation decisions taken in this plan (flag on review)

1. **Allocator state in `factory.db`, not in daemon memory.** factoryd runs the grant pass and the
   dead-holder sweep every 15 s; requesters run the same pass when they poll. A daemon restart
   (`KillMode=process`) or a manual `foreman tick` never stalls a waiting lap. There is no
   daemon↔child IPC today, and adding one would make the daemon a single point of stall.
2. **First lanes before extra lanes, then priority.** Strict priority applies within each group.
   This is the "every active repo gets one lane first" rule from the design discussion.
3. **Requests park instead of waiting forever.** A tick waits up to `PDF_SLOT_WAIT_MS` (14 min),
   then parks its request (keeps `requested_at`) and exits; the repo's next tick adopts it. This
   keeps up to ~27 waiting tick processes (~50 MB each, 3 GB free on the VPS) bounded in time.
4. **The free conflict repair extends the lap's attempt cap by one** instead of re-numbering
   attempts, so per-attempt artifacts (`implement-<n>.jsonl`) never overwrite each other.
5. **Serial mode keeps oldest-first ordering.** Critical-path ranking only changes the total time
   when lanes run concurrently.
6. **Discovery dedupe is deterministic** (normalized title + word Jaccard ≥ 0.7), no model call.

---

## Patterns to Follow

### Additive ledger migration
```ts
// SOURCE: src/ledger.ts:90-116
this.db.exec("PRAGMA busy_timeout = 15000;");
this.db.exec("PRAGMA journal_mode=WAL;");
this.db.exec(SCHEMA);
try {
  this.db.run("ALTER TABLE stage_runs ADD COLUMN cost REAL");
} catch {}
this.db.exec("CREATE INDEX IF NOT EXISTS idx_laps_repo ON laps(repo, id);" + ...);
```
New tables go into `SCHEMA` as `CREATE TABLE IF NOT EXISTS`; new columns as try/catch ALTERs.

### Atomic claim shape
```ts
// SOURCE: src/ledger.ts:118-126
claim(repo: string, n: number): boolean {
  const r = this.db.query("INSERT OR IGNORE INTO issues (...) VALUES (?, ?, 'in_progress', 0, ?, ?)").run(repo, n, now(), now());
  return r.changes === 1;
}
```
Grants use `this.db.transaction(fn).immediate()` (bun:sqlite) so one writer decides at a time.

### Config field + fail-fast validation
```ts
// SOURCE: src/config.ts:150, 179-181
limits: { ...DEFAULTS.limits, ...(raw.limits ?? {}) },
...
const daily = cfg.limits!.daily_attempts;
if (daily !== undefined && (!Number.isInteger(daily) || daily < 0))
  throw new Error(`config limits.daily_attempts must be a whole number, 0 for no ceiling (got ${JSON.stringify(daily)})`);
```
Add the key to `CONFIG_PATCH_ALLOW` (src/ops.ts:881) so `POST /repos/<slug>/config` accepts it.

### Env knobs
```ts
// SOURCE: src/machine.ts:578-579
const deadline = Date.now() + Number(process.env.PDF_SLOT_QUEUE_DEADLINE_MS ?? 10 * 60_000);
const delay = Number(process.env.PDF_SLOT_QUEUE_DELAY_MS ?? 60_000);
```
Read inline at the point of use, with the default in code.

### Receipts
```ts
// SOURCE: src/tick.ts (throughout)
repoReceipt(cfg.slug, stateDir, `lap #${n} DEFERRED — ${lastError.slice(0, 220)}; attempt budget preserved, next tick re-claims fresh`);
```
Every new state change (granted, parked, spilled, rebased, bounced) gets one receipt line naming
the repo, issue and reason.

### Typed infra failure
```ts
// SOURCE: src/machine.ts:531-538, src/tick.ts:835-847
export class InfraUnavailableError extends Error {
  constructor(message: string, public readonly kind: "ssh" | "quota") { super(message); }
}
```

### Process liveness
```ts
// SOURCE: src/lock.ts:4-33  (isAlive + looksLikeFactory — export both for lease sweeps)
```

### Tests
```ts
// SOURCE: test/ledger.test.ts (in-memory ledger)
const l = new Ledger(":memory:"); expect(l.claim("acme/app", 5)).toBe(true);
// SOURCE: test/tick.test.ts:116-198 (makeWorld: real bare git origin + FakeGh + fake callStage)
const w = makeWorld();
const outcome = await tickRepo(w.cfg, w.stateDir, { ledger: w.ledger, gh: w.gh, callStage: makeCallStage(w) });
// SOURCE: test/machine-boxd.test.ts:67-98 (stubClient with grpc8First for cap rejects)
// SOURCE: test/dashboard.test.ts:7-51 (tmp DASHBOARD_STATE_DIR before dynamic import; seed Ledger; assert pure compute fns)
```
Boundary rule (docs/development.md): any new gh/git/boxd/instabox stub uses recorded real shapes
or the real binary (real git in `makeWorld`).

---

## Files to Change

| File | Action | Purpose |
|------|--------|---------|
| `src/allocator.ts` | CREATE | slot queue: request, grant pass, poll/park/adopt, release, sweep, effective priority |
| `src/critpath.ts` | CREATE | `rankByCriticalPath` over the open-issue `Depends on:` graph |
| `src/parallel.ts` | CREATE | `runParallel` lane runner, `MergeQueue`, lane context, discovery lane rule |
| `src/dedupe.ts` | CREATE | normalized-title + Jaccard duplicate check for discoveries |
| `src/ledger.ts` | UPDATE | `slot_requests`, `merge_queue` tables + methods; `countStagesAll` |
| `src/lock.ts` | UPDATE | export `pidAlive(pid)` (isAlive && looksLikeFactory) |
| `src/types.ts` | UPDATE | `RepoConfig.scheduling` |
| `src/config.ts` | UPDATE | defaults + validation for `scheduling` |
| `src/ops.ts` | UPDATE | `CONFIG_PATCH_ALLOW` + `scheduling`; janitor slug bucketing; `fileDiscoveries` dedupe hook; slicer call passes `parallel`; `opsStatus` lanes/leases |
| `src/tick.ts` | UPDATE | lease around each machine lap in `runChain`; per-lap mode for spill; `runLap` lane hooks (merge via queue, deferred discoveries, siblings, bonus attempt, re-plan); `TickDeps.openMachine` seam; fleet ceiling; source lock on gate reads; dispatch `runParallel` |
| `src/machine.ts` | UPDATE | `LapMachineLike` interface; `rebaseScript` / `resetToBaseScript` |
| `src/stages/intake.ts` | UPDATE | `listClaimableDetailed` also returns `open` issues |
| `src/stages/plan.ts` | UPDATE | `buildPlanPrompt` option `siblings` |
| `src/slicer.ts` | UPDATE | `buildSlicerPrompt(prd, max, { parallel })` foundation rule |
| `src/factoryd.ts` | UPDATE | 15 s allocator pass; `/health` pools |
| `bin/dashboard.ts` | UPDATE | `computeScheduling(db)`, `/api/scheduling`, `slot_wait` needs-you kind |
| `dashboard-ui/src/lib/api.ts` | UPDATE | `Scheduling` types; `NeedsYou.kind` + `slot_wait` |
| `dashboard-ui/src/pages/scheduling.tsx` | CREATE | pools, queue, lanes, merge queues, spill |
| `dashboard-ui/src/pages/overview.tsx` | UPDATE | `slot_wait` in `NEED`; pools summary on the Machines card |
| `dashboard-ui/src/components/shell.tsx` | UPDATE | NAV entry |
| `dashboard-ui/src/App.tsx` | UPDATE | route `#/scheduling` |
| `dashboard-ui/dist/**` | UPDATE | rebuilt (`bun run build`), committed per docs/operations.md |
| `templates/repo.config.json` | UPDATE | `scheduling` block with defaults |
| `test/allocator.test.ts` | CREATE | ordering, aging, extra lanes, spill, park/adopt, sweep, multi-process grant |
| `test/critpath.test.ts` | CREATE | ranking on recorded-shape issue lists |
| `test/parallel.test.ts` | CREATE | lanes, inFlight filter, lane-scoped outcomes, merge queue paths with real git |
| `test/dedupe.test.ts` | CREATE | duplicate decisions |
| `test/plan.test.ts` | CREATE | sibling section in the plan prompt |
| `test/config.test.ts`, `test/tick.test.ts`, `test/machine-boxd.test.ts`, `test/scheduler.test.ts`, `test/dashboard.test.ts`, `test/slicer.test.ts`, `test/factoryd.test.ts` | UPDATE | new cases |
| `docs/parallel-mode.md` | UPDATE | status → built; any deviations |
| `docs/design-decisions.md`, `docs/lap-lifecycle.md`, `docs/execution-modes.md`, `docs/operations.md`, `docs/discoveries.md`, `DEPLOYMENT.md`, `README.md` | UPDATE | ordering & concurrency section, env vars, pools, Scheduling page |
| `.agents/skills/dark-factory/SKILL.md` | UPDATE | how to turn on parallel / spill / priority for a project |

---

## Tasks

Execute in order. Every phase ends with `bun run check` green (0 type errors, all tests) and leaves
the factory deployable on its own. Phases 1–2 change behavior only for repos that opt in, except
the lease in serial machine laps (Phase 1), which is the point of the allocator.

### Phase 1 — Slot allocator (serial fleet benefits immediately)

#### Task 1.1: Config `scheduling`
- **Files**: `src/types.ts` (after `limits?` at :139), `src/config.ts` (DEFAULTS :4-60, merge at :150, checks after :181), `src/ops.ts:881`, `templates/repo.config.json`
- **Implement**:
  - `scheduling?: { priority?: "high"|"normal"|"low"; spill_over?: boolean; parallel?: boolean; max_lanes?: number }`, doc-commented like `limits`.
  - Defaults `{ priority: "normal", spill_over: false, parallel: false, max_lanes: 3 }`; shallow merge.
  - Validate: priority enum; booleans are booleans; `max_lanes` integer 1–10; `parallel` requires `env.mode` instabox|boxd; `spill_over` requires the other platform's block usable (`env.boxd.repo_dir` when primary is instabox; `env.instabox.repo_dir` and a `snapshot` or `template` when primary is boxd), and machine mode.
  - Add `"scheduling"` to `CONFIG_PATCH_ALLOW`.
- **Mirror**: `src/config.ts:172-181`
- **Validate**: `bun test test/config.test.ts` with new cases (bad enum, parallel on host, spill without boxd block, patch accepted).

#### Task 1.2: Ledger tables
- **File**: `src/ledger.ts`
- **Implement**: in `SCHEMA`:
  ```sql
  CREATE TABLE IF NOT EXISTS slot_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL, slug TEXT NOT NULL, lane INTEGER NOT NULL,
    pools TEXT NOT NULL,            -- JSON ["instabox"] | ["instabox","boxd"]
    priority TEXT NOT NULL, extra_lane INTEGER NOT NULL,
    pid INTEGER, state TEXT NOT NULL, -- waiting|parked|granted|released|lost
    requested_at TEXT NOT NULL, granted_at TEXT, pool TEXT,
    issue_number INTEGER, lap_id INTEGER, released_at TEXT, detail TEXT
  );
  CREATE TABLE IF NOT EXISTS merge_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL, issue_number INTEGER NOT NULL, lap_id INTEGER NOT NULL,
    state TEXT NOT NULL,            -- waiting|rebasing|reverifying|merging|merged|bounced
    entered_at TEXT NOT NULL, updated_at TEXT NOT NULL, detail TEXT
  );
  ```
  Indexes: `slot_requests(state, pool)`, `slot_requests(repo, state)`, `merge_queue(repo, state)`.
  Add `countStagesAll(stage, sinceIso)` (fleet ceiling, Task 2.6).
- **Mirror**: `src/ledger.ts:46-116`, `countStages` at :212-219
- **Validate**: `bun test test/ledger.test.ts` (tables exist on a fresh and on an old db file).

#### Task 1.3: `pidAlive` export
- **File**: `src/lock.ts`
- **Implement**: `export function pidAlive(pid: number): boolean { return isAlive(pid) && looksLikeFactory(pid); }`. Also fix the stale comment at :53-58 ("Laps themselves run in parallel inside it").
- **Validate**: `bun run typecheck`

#### Task 1.4: `src/allocator.ts`
- **Implement** (pure functions over a `Ledger`; no module state):
  - `type Pool = "instabox" | "boxd"`; `poolCaps()` from `PDF_POOL_INSTABOX` (5) and `PDF_POOL_BOXD` (10).
  - `effectivePriority(base, requestedAt, now, agingMin = PDF_AGING_MINUTES ?? 30): 0|1|2` = min(2, base + floor(waitMin / agingMin)). Export; Task 5.1 duplicates it with a pinning test.
  - `requestSlot(ledger, { repo, slug, lane, pools, priority, extraLane })`: adopt the newest `parked` row for (repo, lane) younger than 60 min (set `pid = process.pid`, `state = waiting`, keep `requested_at`); else insert `waiting`. Returns the row id.
  - `grantPass(ledger, now)`: one immediate transaction:
    1. sweep: `waiting`/`granted` rows whose pid is not `pidAlive` → `lost`; `parked` older than 60 min → `released` with detail `abandoned`.
    2. used per pool = count `granted`.
    3. order `waiting` rows (pid not null) by `extra_lane ASC, effectivePriority DESC, requested_at ASC, id ASC`.
    4. for each: first pool in `pools` with `used < cap` → `granted`, `pool`, `granted_at`; `used++`.
    Returns the rows granted in this pass.
  - `acquireSlot(ledger, req, { log, isPaused, waitMs, pollMs = 5000 })`: `requestSlot`, then loop `grantPass` + read own row; on `granted` return `{ id, pool }`; on pause → `released` and return null; after `waitMs` → `parked` (pid null) and return null. Receipt on wait start, every 10 min, on grant (name the pool, `spilled` when pool ≠ first preference), on park.
  - `bindLease(ledger, id, issue, lapId)`, `releaseSlot(ledger, id, detail)`.
  - `poolStatus(ledger, now)` for `/health` and `opsStatus`: per pool `{ cap, used, waiting }`.
- **Mirror**: claim atomicity `src/ledger.ts:118-126`; liveness `src/lock.ts:88-95`
- **Validate**: `bun test test/allocator.test.ts`:
  - order: first lanes beat extra lanes of higher priority; high beats normal beats low; FIFO within a level;
  - aging: a low request 61 min old outranks a fresh normal one (`PDF_AGING_MINUTES=30`);
  - caps: never more than cap granted per pool; spill takes boxd only when instabox is full and the request lists boxd;
  - park/adopt keeps `requested_at`; abandoned parked rows drop after 60 min;
  - sweep: a row with a dead pid (spawn `bun -e "0"`, wait for exit, use its pid) becomes `lost` and frees capacity;
  - multi-process: two `Bun.spawn` children run `grantPass` on the same file concurrently and the total granted never exceeds the cap (mirror `test/ledger.test.ts:73-101`).

#### Task 1.5: Lease every machine lap in serial `runChain`
- **File**: `src/tick.ts` (`runChain` :1166-1313, `runLap` :284-905)
- **Implement**:
  - In the chain loop, after the pause and ceiling checks and the source refresh, when `cfg.env.mode` is instabox|boxd: `acquireSlot(lane 0, extraLane false, pools = [mode] + (spill_over ? [other] : []))`. `null` (paused or parked) → receipt and `break` (endedQuietly).
  - Pass `{ lease }` into `runLap` via a new optional 5th param `opts: RunLapOpts = {}`. `runLap` calls `bindLease` right after `startLap` (:290) and `releaseSlot` in its `finally` (:894-902), after `machine.destroy()`.
  - Per-lap spill config: `const lapCfg = lease.pool === cfg.env.mode ? cfg : { ...cfg, env: { ...cfg.env, mode: lease.pool } }`. Pass `lapCfg` to `runLap`. Receipt `lap #n spills to <pool> (<own pool> full)`.
  - Host/compose repos are untouched.
- **Mirror**: chain checks at `src/tick.ts:1186-1230`
- **Gotcha**: `runChain` reassigns `cfg` from disk before each lap (:1186-1188); derive `lapCfg` after that.
- **Before this task**: do Task 2.1 (machine seam). It changes no behavior and makes this task testable.
- **Validate**: `bun test test/tick.test.ts` — new cases: a host-mode lap writes no `slot_requests` row; a machine-mode lap with an injected `LapMachineLike` leases before `claim` and releases after `destroy`; with `PDF_POOL_INSTABOX=0` and `spill_over` the lap runs with `env.mode` boxd and receipts the spill; with the pool full and no spill the request parks after `PDF_SLOT_WAIT_MS` and the issue has no ledger row.

#### Task 1.6: Janitor knows every onboarded slug on both platforms
- **File**: `src/ops.ts:1292-1320` (`reapOrphanMachines`), `:1378-1438` (`reapInstaboxMachines`)
- **Implement**: build one `knownBySlug` map from every loadable config regardless of mode; use it for the "unknown repo" decision in the instabox lane and for repo lookup in the boxd lane. Keep the per-platform client choice: run the instabox lane when any config has an `env.instabox` block and an InstaBox key, the boxd lane when `BOXD_API_KEY` is set and any config is boxd or `spill_over`. The live-lap guard stays `ledger.getIssue(...).state === "in_progress"`.
- **Validate**: `bun test test/scheduler.test.ts` — boxd-primary repo with `spill_over`, an in-progress row, and a fake InstaBox listing its `pdf-<slug>-i<n>-g<id>` machine: not deleted; an unknown slug still is.

#### Task 1.7: factoryd drives the allocator
- **File**: `src/factoryd.ts` (health :52-73, entrypoint :304-323)
- **Implement**: when the scheduler is on, `setInterval(() => grantPass(ledger, Date.now()), 15_000)` with a long-lived `Ledger`, errors receipted once per distinct message. `/health` gains `pools: poolStatus(...)`.
- **Validate**: `bun test test/factoryd.test.ts` — `/health` reports pools with caps from env.

**Phase 1 gate**: `bun run check`. Deploy note: no config change needed; serial machine laps now
receipt `slot granted (instabox)` before `lap #n`.

### Phase 2 — Parallel lanes

#### Task 2.1: Machine seam + shared interface
- **Files**: `src/machine.ts` (after `LapMachine` :544), `src/machine-boxd.ts`, `src/tick.ts` (TickDeps :197-201, `openMachine` :332-335)
- **Implement**: `export interface LapMachineLike { name: string; issue: number; bash(...); bootstrap(); callStage(...); destroy(); }` (both classes already match structurally). `TickDeps.openMachine?: (cfg, n, log, lapId, stateDir) => LapMachineLike`; `runLap` uses it when present.
- **Validate**: `bun run typecheck`; existing machine tests pass.

#### Task 2.2: Intake returns the open issues
- **File**: `src/stages/intake.ts` (`listClaimableDetailed` ~:102-168)
- **Implement**: return `{ claimable, skips, open: issues }`. No behavior change; callers that destructure keep working.
- **Validate**: `bun test test/intake.test.ts`

#### Task 2.3: `src/critpath.ts`
- **Implement**: `rankByCriticalPath(claimable: IssueLite[], open: IssueLite[]): IssueLite[]`. Edges from `parseDepends(body)` restricted to open issues; `depth(i) = 1 + max(depth(dependent))` memoized, cycle-safe (a cycle node scores 1 and is receipted by the caller); sort by depth desc, transitive dependent count desc, number asc.
- **Validate**: `bun test test/critpath.test.ts` — chain A→B→C plus a leaf D: A first; a fan-out root beats an equal-depth chain head; cycles do not hang. Issue fixtures use the label-object shape from `test/gh.test.ts`.

#### Task 2.4: Source lock on host-side gate reads
- **File**: `src/tick.ts:582-588`, `src/stages/verify.ts:128-130`
- **Implement**: wrap `commitsAheadRef` and `changedPathsFromRef` calls in `withSourceLock(cfg.slug, …)` (export `withSourceLock` for verify, or pass a wrapper in opts). Concurrent lanes fetch into the same `source/.git`.
- **Validate**: `bun test test/verify.test.ts test/tick.test.ts`

#### Task 2.5: `src/parallel.ts` — lane runner
- **Implement** `runParallel(cfg, stateDir, deps, initial: IssueLite[])`:
  - Shared state: `inFlight: Map<number, { lane, title, isDiscovery }>`, `retryNextTick: Set<number>`, `stopNew` flag (infra_deferred), `started` counter, chain budget `PDF_CHAIN_BUDGET_MS`, start cap `6 * max_lanes`.
  - Lane loop `lane = 0..max_lanes-1`, run with `Promise.all`:
    1. stop on `stopNew`, paused marker, per-repo `daily_attempts` (counted from the ledger, so lanes share it), fleet ceiling (Task 2.6), budget or start cap;
    2. `acquireSlot({ lane, extraLane: lane > 0, … })`; null → end lane;
    3. reload config in place (mirror :1186-1188); re-intake (`listClaimableDetailed`) → filter `inFlight` and `retryNextTick` → `rankByCriticalPath` → `pickForLane` (Task 4.1; until then: first product issue, majors first) → none: release slot, wait for any sibling to finish (a shared `Promise` resolver), retry once, then end lane;
    4. `inFlight.set`, `runLap(lapCfg, …, { lease, lane: laneCtx })`, `inFlight.delete`, release (in runLap's finally);
    5. outcome handling: `error`/null → `retryNextTick`; `infra_deferred` → `stopNew = true`; `billing_hold` → the paused marker stops the others at step 1.
  - Receipts: `lane <k>: #n "<title>" (critical path <d>, <m> in flight)`; one tail receipt per tick like `runChain`'s.
  - No in-tick 10-minute revive cooldown; revive runs at tick start (`tickBody` already calls `autoReviveBlocked` before `prepareRepo`).
- **File**: `src/tick.ts` `tickBody` (:1350-1352): `cfg.scheduling?.parallel && machineMode ? runParallel(...) : runChain(...)`.
- **Validate**: `bun test test/parallel.test.ts` with `makeWorld`-style real git, FakeGh, a fake `LapMachineLike` (commits in a local clone, pushes to the bare origin), `PDF_POOL_BOXD=3`:
  - three independent issues run concurrently (fake implement awaits a barrier all three must reach);
  - a dependent issue starts only after its dependency merges;
  - an in-flight issue is never picked by a sibling lane;
  - one lane blocks, the others merge; `infra_deferred` stops new starts but siblings finish;
  - pause between laps stops all lanes before their next lap.

#### Task 2.6: Fleet daily ceiling
- **Files**: `src/tick.ts` (`runChain` ceiling block :1206-1215), `src/parallel.ts`
- **Implement**: `PDF_FLEET_DAILY_ATTEMPTS` (0 = off) checked next to the per-repo ceiling via `countStagesAll("implement", utcMidnight)`; receipt names both numbers.
- **Validate**: `bun test test/tick.test.ts`

**Phase 2 gate**: `bun run check`. Parallel repos merge straight from `runLap` until Phase 3 lands,
so do **not** enable `scheduling.parallel` on any repo before Phase 3.

### Phase 3 — Merge queue

#### Task 3.1: Rebase and reset scripts
- **File**: `src/machine.ts` (next to `bootstrapScriptFor` ~:276)
- **Implement**:
  - `rebaseScript(cfg, branch)`: env file + `cd repo_dir && git fetch origin <base> && git rebase origin/<base>`; on failure print `PDFCONFLICT:` + `git diff --name-only --diff-filter=U`, `git rebase --abort`, exit 3; on success `git push -q --force origin HEAD:refs/heads/<branch>`, print `PDFREBASED:<sha>`.
  - `resetToBaseScript(cfg, branch)`: `git fetch origin && git checkout -q -B <branch> origin/<base>`.
  - Both run through `machine.bash`, quoted with `escapeSh` like the bootstrap.
- **Validate**: `bun test test/machine.test.ts` against a real git clone through the fake gateway (mirror existing machine tests): clean rebase, conflicting rebase (abort leaves the tree clean), push.

#### Task 3.2: `MergeQueue`
- **File**: `src/parallel.ts`
- **Implement**: `class MergeQueue { run<T>(issue, lapId, fn: (set: (state, detail?) => void) => Promise<T>): Promise<T> }`: FIFO promise chain (mirror `withSourceLock`, `src/tick.ts:214-224`), writes `merge_queue` rows on enter, each `set`, and exit (`merged` | `bounced`).
- **Validate**: `bun test test/parallel.test.ts` — ready order holds; a throwing holder releases the queue.

#### Task 3.3: Land through the queue in `runLap`
- **File**: `src/tick.ts` merge block (:757-777)
- **Implement** when `opts.lane` is set (serial path unchanged):
  1. `await lane.mergeQueue.run(n, lapId, async (set) => { … })`:
     - `withSourceLock(fetch origin <base>)`; `git merge-base --is-ancestor origin/<base> origin/<branch>` in `source/` (fetch the branch first);
     - ancestor → existing TOCTOU guard + `prMerge(probedHead)`;
     - else `set("rebasing")` → `machine.bash(rebaseScript)`:
       - `PDFREBASED` → `set("reverifying")` → `runVerify(...)` (same opts as :631). Fail → findings + `bounced`, return `{ requeue: "verify" }`. Pass → TOCTOU guard on the new `provenance.prHead` → `set("merging")` → `prMerge`.
       - `PDFCONFLICT` → return `{ requeue: "conflict", files }`.
  2. Back in the attempt loop:
     - `verify` → `continue outer` (normal attempt).
     - `conflict`, first in this lap → `findings = keepFindings(conflictFindings(files, mergedAhead))`, `bonusAttempts++` (loop condition `attempt <= cfg.attempts + bonusAttempts`), receipt `rebase conflict on #n (<files>) — one free repair round`, `continue outer`.
     - `conflict`, second → `supersedeIssueFiles(stateDir, slug, n, ["plan.md"])`, `plan = null`, `machine.bash(resetToBaseScript)`, findings say "re-planned on fresh main after two rebase conflicts", `continue outer`.
  - `mergedAhead`: issues merged by this repo's queue since this lap's verify (the queue keeps a list), named in the findings with titles.
  - The blocked comment and receipts keep using `cfg.attempts` as the cap; the bonus round is receipted.
- **Mirror**: findings + `continue outer` pattern at :640-646; TOCTOU guard :766-776
- **Validate**: `bun test test/parallel.test.ts`, real git:
  - two siblings touching different files: the second rebases, re-verifies, merges; main has both;
  - two siblings editing the same line: the second gets the free repair (fake implement resolves by rebasing in the clone), re-reviews, merges; `attempts` ledger value includes the bonus round;
  - a second conflict re-plans (plan.md retired to `plan.superseded-*`), and the attempt cap still blocks.

#### Task 3.4: Crash and restart behavior
- **Implement**: `reconcile` (`src/tick.ts:226-277`) also marks `merge_queue` rows still `waiting|rebasing|reverifying|merging` for the repo as `bounced` (`detail: interrupted`), and `slot_requests` rows of dead pids are the sweep's. A lap killed mid-rebase leaves a force-pushed branch that the reclaimed lap continues from (bootstrap prefers `origin/<branch>`, `src/machine.ts:299-306`).
- **Validate**: `bun test test/revive.test.ts test/parallel.test.ts`

**Phase 3 gate**: `bun run check`; then enable parallel on `factory-boxd-smoke-1` only (Task 6.2).

### Phase 4 — Discoveries and the slicer

#### Task 4.1: Discovery lane rule
- **File**: `src/parallel.ts`
- **Implement** `pickForLane(ranked, inFlight)`: if no discovery is in flight → first major discovery, else first product issue; if a discovery is in flight → first product issue; minors only when no product issue is claimable and no discovery is in flight. Same policy as `prioritizeDiscoveries` (`src/stages/intake.ts:215-233`), applied per lane.
- **Validate**: `bun test test/parallel.test.ts` — two majors + two product issues with 3 lanes: exactly one discovery in flight.

#### Task 4.2: Deferred, deduped filing
- **Files**: `src/dedupe.ts` (CREATE), `src/ops.ts` `fileDiscoveries` (:586-624), `src/tick.ts` harvest block (:715-747)
- **Implement**:
  - `isDuplicateTitle(a, b)`: strip `[discovery]`, normalize with the slicer's existing `normalizeTitle` (`src/slicer.ts`); equal, or word-set Jaccard ≥ 0.7.
  - `fileDiscoveries(…, opts: { alsoSeen?: string[] })` uses `isDuplicateTitle` against open issues and `alsoSeen`.
  - With `opts.lane`: the harvest still writes the sidecar at once, but `fileDiscoveries` runs in `runLap`'s finally path (before `releaseSlot`), with `alsoSeen = lane.filedThisTick` (titles appended after filing). The recursion gate is unchanged.
- **Validate**: `bun test test/dedupe.test.ts test/parallel.test.ts`

#### Task 4.3: Sibling-aware plans
- **Files**: `src/stages/plan.ts` (`buildPlanPrompt` :49-67), `src/tick.ts` plan call (:466)
- **Implement**: option `siblings?: { number: number; title: string }[]`; when non-empty, a short section: "Issues in flight in parallel lanes: … — another lap is changing that code now; if this issue is already covered by one of them, answer NO_ACTION with the reason." Replace the stale "Parallel factory laps may merge…" line (:67) with text that is true in both modes.
- **Validate**: new `test/plan.test.ts` (no prompt test exists for `buildPlanPrompt` yet): the section appears only with siblings; the stale line is gone.

#### Task 4.4: Slicer foundation rule
- **Files**: `src/slicer.ts` (`buildSlicerPrompt` :47-84), `src/ops.ts` `slice()` (:830)
- **Implement**: `buildSlicerPrompt(prd, max, { parallel = false } = {})`; parallel adds the invariant "Shared groundwork that several features would otherwise each edit (routing, schema, dependencies, app shell, navigation) goes in an early foundation issue the features depend on; independent features then touch separate files." and changes the `WHY:` line to say laps run concurrently on issues whose dependencies are closed. `slice()` passes `cfg.scheduling?.parallel`.
- **Validate**: `bun test test/slicer.test.ts` — the invariant appears only with `parallel`.

**Phase 4 gate**: `bun run check`.

### Phase 5 — Dashboard

#### Task 5.1: Server
- **File**: `bin/dashboard.ts`
- **Implement**:
  - Local copy of `effectivePriority` (comment: mirrors `src/allocator.ts`; no `src/` imports by design).
  - `computeScheduling(db)`: pools (caps from `DASHBOARD_POOL_INSTABOX`/`_BOXD`, defaulting to 5/10, or from factoryd `/health` pools when reachable), granted leases with repo/slug/issue/lane/pool/priority/age/spilled (`pool` ≠ the repo's `env.mode` from `repoInfo`), waiting and parked requests in grant order with effective priority, lanes per parallel repo (granted leases joined to live laps and their latest stage, as `liveLaps` does at :315-324), merge queues (open rows + last 20 finished per repo), spill events in the last 24 h.
  - `GET /api/scheduling` in `route()` (~:841).
  - `needsYou`: kind `slot_wait` for any `waiting|parked` request older than 60 min.
  - `repoInfo` reads `scheduling` (priority, parallel, max_lanes, spill_over).
- **Validate**: `bun test test/dashboard.test.ts` — seeded rows produce the expected pools, order and `slot_wait`; the effective-priority copies agree on a table of cases (import both).

#### Task 5.2: UI
- **Files**: `dashboard-ui/src/lib/api.ts`, `dashboard-ui/src/pages/scheduling.tsx` (CREATE), `dashboard-ui/src/pages/overview.tsx` (`NEED` :9-15, Machines card :180-211), `dashboard-ui/src/components/shell.tsx` (NAV :5-10), `dashboard-ui/src/App.tsx` (:23-28)
- **Implement**: Scheduling page with five cards (Pools, Waiting queue, Lanes, Merge queues, Spill-over) built from `Card`, `CardHeader`, `Table`, `Badge`, `Empty` (`dashboard-ui/src/components/ui.tsx`), polling `api/scheduling` every 15 s via `useApi`. Overview: `slot_wait` entry in `NEED`; the Machines card shows `used / cap` per pool and links to `#/scheduling`.
- **Validate**: `cd dashboard-ui && bun run build`; load the page against a seeded state dir (`DASHBOARD_STATE_DIR=<tmp> DASHBOARD_HOST=127.0.0.1 bun bin/dashboard.ts`) with agent-browser and check each card renders.

**Phase 5 gate**: `bun run check`; commit the rebuilt `dashboard-ui/dist`.

### Phase 6 — Docs and pilot

#### Task 6.1: Docs
- `docs/design-decisions.md` "Ordering & concurrency": serial stays the default; parallel mode's three structural answers; link `docs/parallel-mode.md`.
- `docs/lap-lifecycle.md`: slot lease before intake; merge queue step in parallel mode.
- `docs/execution-modes.md`: spill-over and the snapshot requirement.
- `docs/operations.md` + `DEPLOYMENT.md` §4: the five `PDF_*` variables; `/health` pools; Scheduling page.
- `docs/discoveries.md`: one lane, deferred filing, dedupe.
- `README.md`: one line in "What it is" and the docs table.
- `.agents/skills/dark-factory/SKILL.md`: how to enable `scheduling.*` for a project, and to `scenario --test` on both platforms before `spill_over`.
- `docs/parallel-mode.md`: status line → built, plus any deviation from this plan.

#### Task 6.2: Pilot (needs the owner: deploy + spend)
1. Deploy (git pull, `bun install`, restart factoryd and the dashboard). Watch one scheduler pass: serial machine laps receipt `slot granted`.
2. `factory-boxd-smoke-1`: patch `scheduling: { parallel: true, max_lanes: 3 }`; slice a small PRD with ≥3 independent issues and one shared file; watch lanes, one clean rebase, one conflict repair.
3. `factory-boxd-smoke-2`: `spill_over: true` with a baked InstaBox snapshot; force spill with `PDF_POOL_BOXD=0` on a manual tick.
4. Record merged/blocked counts, total time vs the serial estimate, and conflict counts in `docs/parallel-mode.md`.

---

## Risks

| Risk | Mitigation |
|---|---|
| A repo's wide parallel backlog starves the fleet | extra lanes only after every waiting first lane; boxd pool separate from instabox |
| Grant races between processes | single `BEGIN IMMEDIATE` grant pass; multi-process test in 1.4 |
| Lease holder dies, slot leaks | pid sweep in every grant pass and every 15 s from factoryd |
| ~27 waiting tick processes on a VPS with 3 GB free | park after 14 min; adoption keeps aging |
| Spilled lap fails because the other snapshot lacks a toolchain | opt-in per repo; `scenario --test` on both platforms first; failures take the existing infra/verify paths |
| Janitor reaps a spilled machine | Task 1.6 slug bucketing + test |
| Merge queue holds its turn through CI | only laps whose base moved pay it; serial repos never queue |
| Live `in_progress` sibling re-picked by intake | in-process `inFlight` filter, tested |
| Discoveries fill lanes | one discovery lane; recursion gate unchanged |
| Reworded duplicate discoveries | Jaccard check; accepted residual |
| Humans pushing to main mid-queue | `prMerge` fails into the existing error path (attempt spent, retried next tick) |
| Disk at 95% on the VPS | separate task; parallel machine laps add little host disk (no host worktrees) |

---

## Validation

```bash
bun run check                         # tsc --noEmit (0 errors) + bun test
bun test test/allocator.test.ts test/critpath.test.ts test/parallel.test.ts test/dedupe.test.ts
cd dashboard-ui && bun run build      # UI type-check + bundle
```

## Acceptance Criteria

- [ ] All tasks completed; `bun run check` green after every phase
- [ ] Serial host/compose repos behave exactly as before (existing tests unchanged and passing)
- [ ] Every machine-mode lap holds a lease from before its claim until after its machine is destroyed
- [ ] Never more than `PDF_POOL_INSTABOX` / `PDF_POOL_BOXD` granted leases (multi-process test)
- [ ] Grant order: first lanes, then effective priority with 30-min aging, then FIFO
- [ ] Spill-over only for repos with `spill_over: true`, and the spilled machine survives the janitor
- [ ] Parallel repo: independent issues run concurrently; a dependent starts only after its dependency merges; no issue runs twice
- [ ] Merge queue: ready order; moved base → rebase + re-verify; first conflict free repair; second re-plans
- [ ] At most one discovery lap in flight per parallel repo; deduped filing
- [ ] Slicer foundation rule only in parallel mode
- [ ] Dashboard Scheduling page shows pools, waiting queue with effective priority, lanes, merge queues, spill events; `slot_wait` in needs-you
- [ ] Docs updated; pilot results recorded
