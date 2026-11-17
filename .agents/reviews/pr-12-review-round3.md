# Code Review: PR #12 — round 3 (re-review of 7314fe6)

## Metadata

| Field | Value |
|-------|-------|
| **Scope** | PR #12, fix commit `7314fe6` on top of `cdb127b` |
| **PR Number** | 12 |
| **Branch** | feat/e2e-verify-gate |
| **Base** | main |
| **Author** | techafreshh |
| **Date** | 2026-11-14 |
| **Gate** | high |
| **Recommendation** | APPROVE |

## Summary

The round 2 findings are fixed: browsers install to the directory the runners read, the report is cleared before each run, and a ship failure is infra. Type check and all 589 tests pass. The re-review found two small defects in the new infra handling. Both are Medium or lower, so neither blocks the merge at the default gate, but both are one-line fixes worth taking.

## Round 2 status

| Finding | Status | Evidence |
|---|---|---|
| H3 browsers installed outside `$TC-browsers` | **Fixed** | `hostToolsScript()` and the box bake now set `PLAYWRIGHT_BROWSERS_PATH` on the install line. Host-tools skips the download when `chromium-*` already exists in `$TC-browsers`. Text-invariant test added. I did not re-run `host-tools` in an image. |
| M-new-1 stale report | **Fixed** | `rm -rf .e2e` runs before `e2e run`. New test plants a stale passed report, runs a toolchain that dies without writing one, and expects an infra skip. |
| L1 ship failure burns an attempt | **Fixed, with a defect (M-r3-2)** | `shipSuiteInBox` is wrapped and sets `e2eHolder.infra`. |
| Host-lane failing-suite test | **Added** | Asserts the `e2e` gate failure carries the file, test and error text. |
| Stale doc line 184 | **Fixed** | |

## Issues Found

### Critical
None

### High Priority
None

### Medium Priority

**M-r3-1. A passing report with a non-zero exit code becomes a gate failure with no evidence.**
`runSuiteInLane` now returns `pass: report.status === "passed" && rc === 0` (`src/stages/acceptance.ts:342`), and its comment calls the non-zero-exit case infra. `runVerify` still treats any `!pass && report` as a product failure (`verify.ts`, the `e2e` block near line 267). I reproduced it with a fake runner that writes a passed report and exits 1: `pass: false`, `summary: "suite passed: 3 passed, 0 failed"`, `report.failures: []`. The lap would get a gate failure that says "suite passed" and carries no repair text, so the implementer cannot act on it.
Fix: in `runVerify`, push the gate failure only when the report shows failures (`e2e.report.status !== "passed"` or `report.failures.length > 0`). Otherwise take the infra branch and receipt it. Add a test with a `passed-but-exit-1` toolchain.

### Suggestions

- **M-r3-2 (low).** In `runE2eAfterProbes` (`verify.ts`), the guard `if (e2eHolder.infra || !ctx.probesPassed)` then overwrites `e2eHolder.infra` with "skipped: the scenario probes already failed". When the real cause was a ship failure, the receipt blames the probes. Only set that message when `!ctx.probesPassed` and `infra` is unset. A test where `shipSuiteInBox` throws would pin it.
- The host-tools skip test (`^chromium-`) only checks the script text. Playwright also creates `chromium_headless_shell-*`. The smoke that follows still launches a browser, so a wrong skip would show up there, but a real-image check of the skip path is cheap.
- `FACTORY_BROWSER_TOOLS=0` build is still unexercised on my side.

## Issue Count

| Severity | Count | Blocks Merge? |
|----------|-------|---------------|
| Critical | 0 | No |
| High | 0 | No |
| Medium | 1 | No (at gate=high) |
| Suggestions | 3 | No |

## Validation Results

| Check | Status |
|-------|--------|
| Type Check (`tsc --noEmit -p .`) | PASS (0 errors) |
| Lint | N/A |
| Tests (`bun test`) | PASS (589 pass, 0 fail) |

## What's Good

- The fixes are minimal and each has a test that fails without it (stale report, ship path, host-lane failure evidence, install path text).
- `rm -rf .e2e` in the shared command covers both lanes and both the persistent host suite dir and the reused box.
- The infra versus product split now has tests on the no-toolchain, died-before-report and host-failure paths.

## Recommendation

Mergeable at the default gate. Take M-r3-1 and M-r3-2 in a follow-up commit or the same PR, since both touch the infra path this PR introduces.

## Audit Trail

| Artifact | Path |
|----------|------|
| Round 1 | `.agents/reviews/pr-12-review.md` |
| Round 2 | `.agents/reviews/pr-12-review-round2.md` |
| This Review | `.agents/reviews/pr-12-review-round3.md` |
