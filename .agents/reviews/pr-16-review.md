# Code Review: PR #16

## Metadata

| Field | Value |
|-------|-------|
| **Scope** | PR #16 "fix: browser-bake prepares /opt/pdf-e2e via sudo (non-root bake users on instabox/boxd)" |
| **PR Number** | 16 |
| **Branch** | feat/pr-evidence |
| **Base** | main |
| **Author** | techafreshh |
| **Date** | 2026-11-16 |
| **Gate** | high |
| **Recommendation** | NEEDS WORK |

## Summary

The PR title and description cover one change, the sudo-prepared `/opt/pdf-e2e` in the browser bake. The branch also carries the whole PR-evidence feature (verify-time branch penthera scan plus an evidence comment), the acceptance authoring-collection rewrite, a new boxd bake, and a flip of `acceptance.security_public` to default `true`. The code diff is about 800 lines in `src/`, `cli/`, `pi-skills/` and `docs/`, plus about 2,500 lines of `.agents/` artifacts. Type check and all 614 tests pass. Two logic problems block merge: the suite collector flattens the `tests/` layout that the same PR makes mandatory, and the new branch scan runs outside the per-repo source lock.

## Issues Found

### Critical
None.

### High Priority

**H1. Suite collection flattens `tests/`, which defeats the layout fix.**
`src/stages/acceptance.ts` (`collectSuiteFromBox`, the `walkDir` block) and the host-lane copy in `acceptanceWindow` (about line 531).
- The PR tells the authoring agent that the e2e framework's glob is `tests/**/*.e2e.ts`, and that files at the suite root fail with `NO_TESTS`. That is in `buildAcceptancePrompt` and in `pi-skills/prd-acceptance/SKILL.md`.
- The box-lane collector walks to any depth but copies every match to `join(dest, e.name)`. An authored `tests/home.e2e.ts` is stored as `<suite>/home.e2e.ts`. The new test `finds suite files at several roots and depths, copies them flat` asserts this.
- `shipSuiteInBox` then ships that flat directory, and the run hits the same `NO_TESTS` the PR set out to remove.
- The host-lane copy is unchanged. It is a non-recursive `readdirSync(outDir)`, so a `tests/` directory is skipped. Only `e2e.config.ts` lands, and `e2eSuiteExists` stays false.
- Same-named files from different roots overwrite each other, because only the basename is used.
- **Fix:** preserve each file's path relative to its suite root in both lanes. The `tests/` subdirectory must survive, and `tar`/`find` can emit root-relative paths. Replace the "copies them flat" assertion with one that expects `tests/home.e2e.ts` to be stored under `tests/`. Add a host-lane test with a nested `tests/` directory.

**H2. The branch scan runs outside the per-repo source lock and shares one scan directory.**
`src/security.ts` (`runSecurityScan`) and `src/stages/verify.ts` (the new step 5).
- `runSecurityScan` calls `ensureSource` (`git fetch --prune`, `reset --hard`, `clean -fdq`) with no `withSourceLock`. `gitws.ts:168` says parallel lanes share one source checkout and that git operations on it must take the lock. `tick.ts` wraps every other `ensureSource` call.
- Before this PR, the scan ran only post-merge. Now every lap's verify calls it, so parallel lanes (`scheduling.parallel`) run it concurrently with each other and with merge-queue ref reads.
- The scan directory `issues/security` is also shared. Each scan does `rmSync(scanRoot)` and `worktree add <scanRoot>/wt`, and its `finally` removes both. Two concurrent scans, or a verify scan racing the post-merge scan, delete each other's worktree mid-scan or fail `worktree add`.
- **Fix:** wrap the `ensureSource` and `worktree add` steps in `withSourceLock(cfg.slug, …)`. Give each scan a unique directory, for example `security-<ref-hash>` or `mkdtemp`. Alternatively serialize all scans per slug with the same lock mechanism.

### Medium Priority

**M1. `evidenceComment` never shows a scan error, and it mislabels one.**
`src/notify.ts`, the branch `else if (s.note && !s.summary)`.
- Every failing scan result sets a non-empty `summary`: `"scan errored"`, `"unparsable report (exit N)"`, `"worktree add failed"`, and the report-only `"N finding(s)…"`. That condition is therefore never true, so the `note` is never displayed.
- An errored scan falls through to the `mayDetailSecurity` branch. It prints `⚠ scan errored` followed by "The post-merge audit on merged main files the findings as issues", which is wrong because there are no findings.
- **Fix:** distinguish errors from findings with an explicit field (for example `kind: "findings" | "error"`) instead of inferring from `note`/`summary`. Add a test that feeds `evidenceComment` an errored result.

**M2. `security_public` now defaults to `true`, and the PR does not mention it.**
`src/config.ts`, `src/security.ts` (`mayFileSecurityFindings`), `src/types.ts`, `docs/acceptance.md`.
- Existing public-repo configs that omit the key flip from "scan and receipt only" to "file issues with file, line and sink on the public tracker" on the next merge.
- The code comments call this an operator decision, so the intent is clear. The change is security-relevant and sits under a `fix:` title about `sudo`.
- Please state it in the PR description. Consider a release note for operators with existing public repos.

**M3. The PR scope and description do not match the content.**
- Title and body describe only the `/opt/pdf-e2e` sudo fix.
- The branch also includes the evidence comment, the branch scan, the boxd bake (`bakeBoxd`), the authoring-collection rewrite, the `--status` CLI flag, and the default flip. This makes the diff hard to review and hard to revert.
- Roughly 2,500 lines of `.agents/{plans,reports,reviews}` were committed as well.
- Update the description, or split the PR.

**M4. Candidate root `"."` in `BOX_AUTHORING_ROOTS` can sweep up product test files.**
`src/stages/acceptance.ts`, `collectSuiteFromBox`.
- The `find` runs from the box's working directory, which is probably the product clone, with `-maxdepth 2` and no exclusion of tracked files. A product with its own `*.e2e.ts` or `e2e.config.ts` would have those copied into the factory suite.
- The cwd of `machine.bash` is not stated in the diff, so I could not confirm the exact directory.
- Exclude paths that are tracked by git, or restrict the roots to the authoring directories.

**M5. Verify posts a new PR comment on every attempt.**
`src/stages/verify.ts`, the end of `runVerify`.
- Each repair attempt and each merge-queue re-verify adds a comment, so a PR with three attempts gets three near-identical comments.
- Edit one marked comment in place, or collapse older ones.

### Suggestions

- `src/stages/verify.ts`: the branch scan still runs when scenario or e2e gates have already failed. Check whether that spends up to 10 minutes of `SCAN_TIMEOUT_MS` per repair attempt for no gain.
- `src/browserbake.ts`: if `sudo -n mkdir` succeeds but `sudo -n chown` fails, the `|| mkdir -p` fallback is a no-op on the now root-owned dirs. The later npm installs would then hit `EACCES`. This is unlikely, but a `-w` check after the fallback would turn it into a clear error.
- `src/stages/acceptance.ts`: the "no suite files landed" receipt says "searched the box's …" even on the host lane.
- `summarizeE2e` puts up to 220 characters of the runner log into a PR comment. Scrub or cap it for public repos.

## Issue Count

| Severity | Count | Blocks Merge? |
|----------|-------|---------------|
| Critical | 0 | No |
| High | 2 | Yes |
| Medium | 5 | No (gate=high) |
| Suggestions | 4 | No |

## Validation Results

| Check | Status |
|-------|--------|
| Type Check (`bun run typecheck`) | PASS |
| Lint | N/A (no lint script in this repo) |
| Tests (`bun test`, 614 tests, 44 files) | PASS |

## What's Good

- The sudo bake fix itself is minimal and well commented. It falls back cleanly for root lanes, and the installs stay unprivileged.
- Failures now name their cause: the runner log tail is framed in the e2e run, the walk narration is persisted, and drain progress lines are no longer silenced.
- The branch scan is report-only and never writes the merged-main verdict. The `!opts.ref` guard keeps `last_security` clean.
- `BOXD_DEFAULT_SNAPSHOT` is now shared between the lap machine and the bake, and the bake refuses to re-save a shared base alias.
- New pure functions (`evidenceComment`, `parseE2eRunOutput`) have direct tests. The parser tests use captured real report shapes, as `docs/development.md` requires.

## Recommendation

Fix H1 and H2, add tests for each, and correct M1. Then update the PR description for M2 and M3, or split the PR. Re-review after those changes.

## Audit Trail

| Artifact | Path |
|----------|------|
| Plan | not found for this PR |
| Implementation Report | not found for this PR |
| This Review | `.agents/reviews/pr-16-review.md` |
