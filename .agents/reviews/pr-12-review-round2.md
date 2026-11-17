# Code Review: PR #12 — round 2 (re-review of cdb127b)

## Metadata

| Field | Value |
|-------|-------|
| **Scope** | PR #12, fix commit `cdb127b` on top of `94f2cda` |
| **PR Number** | 12 |
| **Branch** | feat/e2e-verify-gate |
| **Base** | main |
| **Author** | techafreshh |
| **Date** | 2026-11-14 |
| **Gate** | high |
| **Recommendation** | NEEDS WORK |

## Summary

Round 1's findings are fixed. I built the image with default args and ran it, and the e2e gate now chains onto the runtime scenario's window. The re-review turned up one new High. The host lane now forces `PLAYWRIGHT_BROWSERS_PATH=$TC-browsers`, but `foreman host-tools` still installs Playwright's browser to `~/.cache`, so on a systemd VPS the gate has no browser. There is also one new Medium (a stale report can fake a green gate).

## Round 1 status

| Finding | Status | Evidence |
|---|---|---|
| H1 Docker `npm install -g` as non-root | **Fixed** | `docker build -f docker/Dockerfile .` with default args succeeds (image 3.86 GB). In the container as `factory`: Playwright launches Chromium and reads a page title (`TITLE ok-title`), `agent-browser 0.43.0` is on PATH, `npx --no-install penthera@2.4.0 --version` answers offline (`penthera v2.4.0`), `~/.pdf` is owned by `factory`. I did not build with `FACTORY_BROWSER_TOOLS=0`. |
| H2 scratch dir in the lap worktree | **Fixed** | The standalone window is gone. The suite runs through a new `afterProbes` seam on the runtime scenario's own window, with scratch under the issue dir. New host-lane test asserts `uncommitted(wt)` is empty. |
| M1 infra vs product failure | **Mostly fixed** | A suite that cannot run (no report, transport throw, probe-fail skip) is receipted and skipped, and `pass` stays true. Gap: see L1 and M-new-1. |
| M2 product started more than once | **Fixed** | One window carries probes and suite. Holdout keeps its own. |
| M3 stale docs and comments | **Fixed** | `acceptance.md` and the `postmerge.ts` comment updated. |
| Suggestions | Indent fixed, apt chromium removed, flake note added. |

## Issues Found

### Critical
None

### High Priority

**H3. The host lane now looks for browsers in a directory `host-tools` never fills (regression on systemd VPS installs).**
This PR changed `e2eRunCommand` to export `PLAYWRIGHT_BROWSERS_PATH=${toolchainDir}-browsers` in the host lane too (`src/stages/acceptance.ts:176`). The PR description says "`host-tools` installed browsers to `$TC-browsers`", but `hostToolsScript()` in `src/browserbake.ts:89` runs `node "$TC/node_modules/playwright-core/cli.js" install chromium` with no `PLAYWRIGHT_BROWSERS_PATH`. I ran `foreman host-tools` in the built image and it printed `Chrome Headless Shell … downloaded to /home/factory/.cache/ms-playwright/…`, a second browser copy outside `$TC-browsers`. The image works only because the Dockerfile bake installs to `$TC-browsers` itself.
On a bare VPS (the tested shape) `host-tools` fills `~/.cache`, and the runner now looks in `$TC-browsers`, so the browser is missing. The system-chromium smoke can also pass (`CHROME_OK system`) while the suite has no Playwright browser. A missing browser typically makes each test fail inside a report, so it counts as a product failure and routes to the implementer. That is the scenario M1 meant to prevent, and the infra check does not catch it.
The machine-lane bake has the same gap at `src/browserbake.ts:43` (its install line also has no `PLAYWRIGHT_BROWSERS_PATH`, and the smoke accepts a system Chromium). That one predates this PR, but the box runner has always used `/opt/pdf-e2e-browsers`, so fix it in the same change.
Fix: set `PLAYWRIGHT_BROWSERS_PATH="$TC-browsers"` on the install line in `hostToolsScript()` (and `${BOX_TOOLCHAIN_DIR}-browsers` on line 43), and make the smoke check the same path (it already does for the Playwright branch). Add a test asserting the install line carries the variable. Optionally, make `host-tools` skip the download when `$TC-browsers` already holds a Chromium (the PR says it "skips what it finds").

### Medium Priority

**M-new-1. A stale `report.json` can fake a green gate or blame the agent for old failures.**
`e2eRunCommand` never clears `.e2e/report.json` before `e2e run`. The host suite dir (`state/repos/<slug>/e2e`) persists across laps, and the box copy persists across repair attempts (the tar excludes `.e2e`). If a run dies before writing a report (browser launch failure, config error), the old report is read. `runSuiteInLane` passes the gate when `report.status === "passed"` and ignores the exit code. The infra rule ("no parsable report") depends on the report being fresh.
Fix: `rm -rf .e2e` (or just `.e2e/report.json`) in `e2eRunCommand` before `npx --no-install e2e run`. Also consider treating a non-zero exit with a `passed` report as infra.

### Suggestions

- **L1.** `shipSuiteInBox` runs outside the try/catch in `runVerify` (`verify.ts`, `gateApplies && opts.machine`). A tar or exec failure throws into the lap error path and burns an attempt, which contradicts the new infra rule. Wrap it, set `e2eHolder.infra`, and carry on without the gate for that run.
- The host lane's `afterProbes` gets `ctx.env` from `runScenario`. The `PLAYWRIGHT_BROWSERS_PATH` and `APP_URL` exports live in the command script, so this is fine, but no test runs the host lane with a failing suite. Add one: a failing fake suite should produce an `e2e` gate failure with test evidence.
- `docs/acceptance.md:184` still says "A per-merge regression or a drain walk can therefore over-subscribe a platform". The per-merge e2e regression no longer takes a machine, so only the drain walk and the scenario regression do.

## Issue Count

| Severity | Count | Blocks Merge? |
|----------|-------|---------------|
| Critical | 0 | No |
| High | 1 | Yes |
| Medium | 1 | No (at gate=high) |
| Suggestions | 3 | No |

## Validation Results

| Check | Status |
|-------|--------|
| Type Check (`tsc --noEmit -p .`) | PASS (0 errors) |
| Lint | N/A |
| Tests (`bun test`) | PASS (586 pass, 0 fail) |
| Docker build, default args | PASS (built and smoked; test image removed afterwards) |
| Docker build, `FACTORY_BROWSER_TOOLS=0` | NOT RUN |

## What's Good

- The `afterProbes` seam is small, leaves the default probe path unchanged, and makes the "product starts once per lap" claim true.
- The infra-versus-product split is explicit, receipted, and tested for the no-toolchain case.
- The Dockerfile now ships a bake that works, and the invariant test pins that every `npm install -g` sits in a root layer.
- The host-lane test asserts the worktree stays clean, which is the property H2 broke.

## Recommendation

Fix H3 (one line in `hostToolsScript()` plus a test) and M-new-1 (one line in `e2eRunCommand`), then this is ready to merge. L1 is worth taking in the same commit.

## Audit Trail

| Artifact | Path |
|----------|------|
| Round 1 | `.agents/reviews/pr-12-review.md` |
| This Review | `.agents/reviews/pr-12-review-round2.md` |
