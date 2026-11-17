# Implementation Report

**Plan**: the six-item fix list from the 2026-11-09 review of the tick system (conversation, no plan file)
**Branch**: `feature/factory-hardening` (6 commits on top of `main` at 176e5f2, not pushed)
**Status**: COMPLETE in code. Not deployed: deploy steps and the production-side changes need the owner.

## Summary

| # | Commit | What changed |
|---|--------|--------------|
| 1 | d95c4a8 | Intake claims only issues opened by the repo owner, the factory's gh login or `trusted_authors`. Host-side pi stages and scenario commands get an env allowlist instead of the service env. |
| 2 | 31467bb | Any error that ends a lap is booked (phase + message, lap ended, block comment on the last attempt). An errored issue waits for the next tick. Reconcile closes dead laps as `interrupted`. |
| 3 | 8953b0d | Findings persist in `findings.md`. Auto-revive retires `plan.md`, and the re-plan sees the last findings. `unblock --prune` retires both. |
| 4 | 1fcb7c1 | A 402/401 provider failure is a billing hold (attempt refunded, repo paused with the reason). `limits.daily_attempts` (default 60) caps implement attempts per repo per UTC day. |
| 5 | 9754bf2 | Daemon scheduler: one `foreman tick --repo` process per idle repo, opt-in with `PDF_SCHEDULER_MINUTES`. API ticks run as child processes. |
| 6 | 7255b2b | `tsc --noEmit` from 100 errors to 0 (three live bugs fixed). TypeScript 7.0.2 pinned. `bun run check` and `.githooks/pre-push`. |

## Validation Results

| Check | Result |
|-------|--------|
| Type check (`tsc --noEmit -p .`) | 0 errors (was 100) |
| Tests (`bun test`) | 354 pass, 0 fail (was 322) |
| Live boundary: `gh issue list --json author` + `gh api user` | real logins returned, trusted set = owner |
| Live boundary: `pi --version` under `agentEnv` | exit 0 |
| E2E: real factoryd with the scheduler at 6 s | started a tick process, answered 409 while it ran, the tick finished and released its lock after the daemon was killed |
| E2E: pre-push hook | passes on the tree; exits 1 on a planted type error |

## Deviations from the proposal

- Item 2: errors outside the agent's control still spend the attempt. Refunding it would let a persistent push failure buy an implement stage every tick forever. Instead the error is recorded and the issue is not re-picked in the same chain.
- Item 5: opt-in, because it needs a systemd drop-in (`KillMode=process`) and disabling the timer, both production changes.
- Item 1: `bash` stays in `plan_tools` and the factory user stays in the `docker` group. Both are owner decisions.

## Tests Written

| Test file | Cases |
|-----------|-------|
| test/agentenv.test.ts | live env names reduce to the allowlist; prefix families |
| test/intake.test.ts | stranger skipped; owner/viewer/trusted_authors, case-insensitive; missing author fails closed; unreadable viewer login |
| test/gh.test.ts | recorded author shape; junk shapes |
| test/pi.test.ts | env allowlist end to end through a fake pi; billingFailure on the recorded 402, a 401, and non-billing errors |
| test/scenario.test.ts | setup and probes never see the factory key; pass_env rides in |
| test/config.test.ts | trusted_authors and limits.daily_attempts defaults and validation |
| test/tick.test.ts | interrupted lap closed; thrown error booked; thrown error on the last attempt blocks; errored issue waits a tick; reclaim and revive repair from saved findings; revive re-plans; billing hold; daily ceiling |
| test/revive.test.ts | revive retires the plan, keeps the findings |
| test/ops.test.ts | unblock --prune retires plan and findings |
| test/scheduler.test.ts | idle repos started, running one skipped, stale lock ignored, concurrency cap, real child process |
| test/factoryd.test.ts | 409 while the repo lock is held |
| test/keyrouter.test.ts | reasoning_effort default injected; explicit value wins |
