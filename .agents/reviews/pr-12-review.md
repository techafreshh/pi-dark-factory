# Code Review: PR #12 — e2e moves into the verify gate; browser acceptance baked into the Docker image

## Metadata

| Field | Value |
|-------|-------|
| **Scope** | PR #12 |
| **PR Number** | 12 |
| **Branch** | feat/e2e-verify-gate |
| **Base** | main |
| **Author** | techafreshh |
| **Date** | 2026-11-14 |
| **Gate** | high |
| **Recommendation** | NEEDS WORK |

## Summary

The PR moves the authored browser e2e suite from a per-merge post-merge hook into `runVerify`, and bakes Chromium, the e2e toolchain and penthera into the Docker image. The design is sound and fits the factory's "gates block" model. Type check and tests are green, but two defects only show up outside the tests. The default Docker build fails, and the host/compose lane leaves an untracked scratch directory in the lap's worktree. Neither is covered by a test.

## Issues Found

### Critical
None

### High Priority

**H1. The default Docker build fails: `npm install -g` runs as the non-root `factory` user.**
`docker/Dockerfile:67-68` (the toolchain layer after `USER factory`):
```
&& npm install -g --silent agent-browser \
&& agent-browser install \
```
The image installs `pi` globally earlier as root, so `/usr/local/lib/node_modules` is root-owned (`drwxr-xr-x root root`). The Dockerfile sets no `NPM_CONFIG_PREFIX` or `.npmrc`. I ran `npm install -g semver` as uid 1000 in `node:22-bookworm-slim` and it exited 243 with EACCES. Because the layer is one `&&` chain, `docker compose up --build` fails by default (`FACTORY_BROWSER_TOOLS=1`). `test/docker.test.ts` only reads Dockerfile text, and the PR's verification does not mention a build.
Fix: either install `agent-browser` in the root layer (`USER root` block, next to apt), or set `ENV NPM_CONFIG_PREFIX=/home/factory/.npm-global` and add its `bin` to `PATH`. Then build the image once with defaults and with `FACTORY_BROWSER_TOOLS=0`.

**H2. The host/compose e2e gate writes its scratch dir inside the lap's worktree, which breaks the next repair attempt.**
`src/stages/acceptance.ts:336` calls `runScenario(spec, join(worktree, ".pdf-e2e-scratch"), …)`, and `verify.ts` passes `scratchDir: opts.worktree`, which is the issue's worktree. `runScenario` creates the directory and writes `server.log` into it (`src/scenario.ts:280-281, 307`). Nothing removes it afterwards, and nothing adds it to `.git/info/exclude`. The old walk and per-merge run used a throwaway worktree, so this is new with the PR. The scenario gates in `verify.ts` use a scratch dir under `issueDir` (outside the repo).
Effect: after any verify that reaches the e2e step, `git status --porcelain` shows `?? .pdf-e2e-scratch/`. The next implement attempt, whether triggered by an e2e failure or a review REJECT, hits `uncommitted()` at `src/tick.ts:658` and fails the changed gate with "implementer left 1 uncommitted change(s)". The findings tell the agent to `git add -A && git commit EVERYTHING`, so the agent may commit `server.log` and the scratch dir into the product repo.
Fix: use `join(issueDir(stateDir, slug, issue), "e2e")` as the scratch dir. `runVerify` can compute that and pass it separately from `worktree`, which only needs to serve as the product's `WORKTREE`. Add a host-lane `runVerify` test that asserts `uncommitted(worktree)` is empty afterwards. All four new verify-gate tests use the fake machine lane, so the host lane has no coverage.

### Medium Priority

**M1. Environment failures are treated as product failures, with no repair evidence.**
`runE2eSuite` throws on transport errors (for example the suite tar or ship step), and `runVerify` (`verify.ts`, the e2e block) does not catch. The throw lands in the lap error path and books a failed attempt. A missing toolchain or browser (a bare VPS where `host-tools` was never run, or a machine snapshot baked before the flag was on) yields "no parsable e2e report (rc N)". `repairForE2e(null)` returns `undefined`, so the agent gets an empty repair and cannot fix it. The old per-merge hook was report-only, so a broken browser setup never stopped merges. Now it burns the attempt cap and blocks every issue in the repo.
Fix: distinguish "toolchain absent / transport error" from "suite ran and failed". Either skip the gate with a loud receipt, or pause the repo like a billing hold. Do not route it to the implementer.

**M2. The suite starts the product in its own extra window, not "the same product-up window the scenario probes use".**
`runE2eSuite` calls `runScenario` / `runScenarioInMachine` again with `probes: []`, so it repeats setup and start. In machine mode, a lap with runtime and holdout scenarios therefore does setup+start three times, with a possible build in each. The PR description and the comments in `verify.ts` say it reuses the window. Either reuse the runtime window through its `onReady` seam, or correct the description and docs and accept the extra setup time (`e2e_minutes` does not cap it).

**M3. Docs and comments still describe the removed per-merge e2e step.**
- `docs/acceptance.md:97-102` still lists "2. the e2e suite … against merged main", the short-lived `pdf-<slug>-i0` machine and the `[e2e-regression]` issue. Line 91 says `[e2e-regression]` issues stay re-fileable, and line 106 says the "suite result also updates last_security/receipts".
- `docs/acceptance.md:1` still has the title "e2e regression, the drain-time walk, and the security audit".
- `src/postmerge.ts:33` (the `runPostMergeExtras` doc comment) still says it runs "the e2e suite (… machine modes on a short-lived acceptance machine)".

The PR says §2 was restructured, but this text remains. It contradicts the new behavior.

### Suggestions

- `src/stages/verify.ts:212` (`scenarios.push(result);`): the line is indented two spaces too far.
- `docker/Dockerfile`: the toolchain layer installs three browsers (apt `chromium`, Playwright's Chromium, and the Chrome that `agent-browser install` downloads). If `agent-browser` and the e2e runner can share one browser, the image shrinks by several hundred MB.
- `docker/Dockerfile`: `npm cache clean --force` leaves `~/.npm/_npx` in place (I checked), so the pre-seeded penthera survives. A `docker run … npx --no-install penthera@2.4.0 --version` check in the PR's smoke notes would prove it.
- Existing issues labelled `e2e-regression` on already-onboarded repos lose their `prioritizeDiscoveries` ordering after `E2E_REGRESSION_LABEL` was removed. This is probably harmless, but add a line to the PR notes.
- A flaky browser suite now blocks merges with no retry. Consider one automatic re-run of failed tests before the gate fails (Playwright's `retries`), or document that suite authors must keep tests deterministic.

## Issue Count

| Severity | Count | Blocks Merge? |
|----------|-------|---------------|
| Critical | 0 | No |
| High | 2 | Yes |
| Medium | 3 | No (at gate=high) |
| Suggestions | 5 | No |

## Validation Results

| Check | Status |
|-------|--------|
| Type Check (`tsc --noEmit -p .`) | PASS (0 errors) |
| Lint | N/A (the project has none) |
| Tests (`bun test`) | PASS (584 pass, 0 fail) |
| Docker build (default args) | NOT RUN, expected to FAIL per H1 (reproduced the `npm install -g` EACCES in `node:22-bookworm-slim` as uid 1000) |

## What's Good

- The gate is placed correctly. It runs after the scenarios, fails fast, and its failures go through the existing `GateFailure` and repair-loop path. The sidecar and review prompt carry the outcome.
- `SuiteMachine` is a minimal structural type, so one runner serves both the lap's box and the drain walk.
- Setting `PLAYWRIGHT_BROWSERS_PATH` in both lanes fixes a real host-lane bug, and the test was updated to match.
- Removing the per-merge machine boot and the post-hoc issue class simplifies the merge path, and the `postmerge.ts` deletions are clean.
- The Dockerfile bake is opt-out, runs after `useradd`, and has tests pinning ordering and that it holds no secrets.

## Recommendation

Fix H1 and H2 before merging, and build the image once for real. Address M1 to M3 in the same PR if possible: M3 is quick, M1 is the main operational risk of the new gate.

## Audit Trail

| Artifact | Path |
|----------|------|
| Plan | not found |
| Implementation Report | not found |
| This Review | `.agents/reviews/pr-12-review.md` |
