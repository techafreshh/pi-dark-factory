# Code Review: PR #19 — per-platform shared dev bases + remote bake jobs

## Metadata

| Field | Value |
|-------|-------|
| **Scope** | PR #19 (31 files, +2348 / -246) |
| **PR Number** | 19 |
| **Branch** | feat/platform-dev-bases |
| **Base** | main |
| **Author** | techafreshh |
| **Date** | 2026-11-24 |
| **Gate** | high |
| **Recommendation** | APPROVE |

## Summary

Adds a `platforms` map to `shared-base` aliases (resolved per machine platform), a fleet dev-base bake (`foreman base bake`, `base list`), detached daemon-side bake jobs with status files and pidfile locks, new factoryd routes, and CLI verbs (`base list|bake|ensure`, `bake`). The design is consistent with the existing detached-tick pattern, fails closed on an unmapped platform, and refuses to overwrite a shared base from a per-repo bake. No Critical or High issues. Three Medium robustness gaps are worth fixing before or soon after merge.

## Issues Found

### Critical
None.

### High Priority
None.

### Medium Priority

1. **A job can stay `running` forever and block every later bake** — `src/bakejobs.ts:94`, `:216`, `:281`.
   `readBakeStatus` only fails a running job when `typeof job.pid === "number"`. If `spawn` yields no pid (async ENOENT, or the daemon dies between the "running" write and the pid write), the status keeps `running` with no pid. Every later `spawnBaseBake`/`spawnRepoBake` then answers 409 "already live (pid pending)" until someone deletes the status file by hand. Reproduced with a fake spawn returning `pid: undefined`.
   Fix: treat a `running` status with no pid and `started_at` older than a short grace period (for example 60 s) as failed on read. Alternatively, mark the job failed in `spawnDetached` when `child.pid` is undefined.

2. **`setBasePlatform` can destroy other aliases and is not atomic** — `src/sharedbase.ts:173`, `:206`.
   An unparseable `base-snapshot.json` is swallowed by `catch {}` and then overwritten with only the new platform entry, so every other alias (for example `godot-base`) is lost. Reproduced. `writeFileSync` in place can also leave a half-written file for a lap that reads it at that moment, and `readBases` then returns `{}`, so `shared-base` is treated as a literal snapshot name. Two bakes on different platforms hold different locks and can lose one update.
   Fix: if the file exists but fails to parse, throw instead of overwriting. Write to a temp file and `renameSync`. Optionally serialize on a `base-snapshot` lock.

3. **A legacy flat `shared-base` still resolves to the InstaBox name on every platform** — `src/sharedbase.ts:145`, `:147`.
   With `{"snapshot":"factory-base-r3"}` and no `platforms`, `resolveSnapshotName(..., "daytona")` returns `factory-base-r3`. That is the "snapshot not found" class the PR describes fixing, and it remains until the first new bake migrates the file. Reproduced.
   Fix: when a platform is given and the entry is flat, return the snapshot only for `instabox` and throw the "no <platform> snapshot — bake one first" error otherwise. Alternatively, migrate the flat entry on read. Update the matching sharedbase test.

### Suggestions

- `src/basebake.ts:236`: with an unmapped `shared-base` (no state file), `resolveRepoBakeNames` takes the literal path, sets `name = "shared-base"`, and fails with "is a base alias — a per-repo bake must save a literal snapshot name". The message misleads. Check the unmapped case first and say "bake the platform base first".
- `src/sharedbase.ts:129` and `:139`: the error tells an instavm repo to run `foreman base bake --platform instavm`, which is rejected. Special-case instavm with "InstaVM has no shared base; use a literal snapshot".
- `src/foreman.ts:169` (and the `acquireBakeLock` failure just below it): these throw before the status file's `failed` write, so a CLI `--wait` shows the generic "bake process N is gone" message instead of the real reason ("a tick is live"). Write the failure to the status file on these paths too.
- `src/bakejobs.ts:249` and `src/factoryd.ts` (`POST /repos/<slug>/bake`): `name` and `from` are not checked with `assertBaseName`. A value starting with `--` would be mis-parsed by foreman's `parseArgs`. Validate both at the trust boundary.
- `src/basebake.ts:549`: E2B build-log lines go to `laps.log` through `receipt` without `redact()`, unlike `ops.ts` `bakeE2b`. Apply `redact` for consistency.
- `src/bakejobs.ts` / scheduler: a tick can start while a repo bake runs (the bake checks for a live tick, but the scheduler does not check `bakeLockHeld`). The bake switches the config at the end, so a lap that starts mid-bake can boot the pre-switch snapshot. Consider a scheduler skip while `bake-repo-<slug>.lock` is held.
- `src/ops.ts` (onboard comment): "Clear a platform's snapshot to '' before a per-repo bake" contradicts the new layering behavior. Reword it.
- `cli/bin/dark-factory.js` `cmdBaseEnsure`: the "already mapped" check is hard-coded to `shared-base` even when `--alias` is given.
- Base scripts use unpinned `curl | bash` (NodeSource, bun.sh). This is acceptable for an operator-run bake. A pinned version would make bases reproducible.

## Issue Count

| Severity | Count | Blocks Merge? |
|----------|-------|---------------|
| Critical | 0 | No |
| High | 0 | No |
| Medium | 3 | No (gate=high) |
| Suggestions | 9 | No |

## Validation Results

| Check | Status |
|-------|--------|
| Type Check (`tsc --noEmit`) | PASS (0 errors) |
| Lint | N/A (no lint script in this repo) |
| Tests (`bun test`) | PASS (658 pass / 0 fail) when run from a path containing `pi-dark-factory` |

Note: run from `/tmp/pr19` (a path without `pi-dark-factory`), 21 tests fail. `src/lock.ts` identifies factory processes by that substring in the cwd, so that failure comes from the checkout path and not from the PR. The same suite is green from `/tmp/rv/pi-dark-factory`.

Not verified: real cloud bakes (the PR also leaves these unrun), so the Daytona/E2B/boxd SDK call shapes (`createSnapshot`, `Template.build`, `snapshots.create`) are unconfirmed against live APIs.

## What's Good

- The per-platform scoping fails closed: an alias whose `platforms` map lacks the platform throws a clear, actionable error and never falls back to another platform's name.
- Legacy-file migration keeps the old InstaBox snapshot bootable under `platforms.instabox`.
- Per-repo bake refuses to overwrite any alias key or any physical snapshot owned by an alias.
- Detached jobs reuse the tick pattern: pidfile locks (`bake-*.lock`, with the factory-process check), an in-process `pending` guard, a failed-on-read stale-pid rule, and env without `FACTORY_API_KEY`.
- The API maps validation to 400/404/409/422 and starts jobs with 202. Status path components are sanitized.
- Good test coverage: alias resolution and migration, validation, spawn args, locks, API routes, and CLI 409/`--yes` paths.

## Recommendation

Mergeable at gate=high. Fix Medium 1 to 3 in this PR or an immediate follow-up, since each is a small, local change. After deploy, run the PR's rollout step (`dark-factory base ensure --platform daytona --yes --wait`) and confirm the first real bake on one platform before the others.

## Audit Trail

| Artifact | Path |
|----------|------|
| Plan | none found |
| Implementation Report | none found |
| This Review | `.agents/reviews/pr-19-review.md` |
