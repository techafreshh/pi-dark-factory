# Code Review: PR #10 — round 3 (fix commit 40bb87d)

## Metadata

| Field | Value |
|-------|-------|
| **Scope** | PR #10, delta `3ef7b46..40bb87d` (9 files, +169/−22) |
| **PR Number** | 10 |
| **Branch** | feat/prd-acceptance |
| **Base** | main |
| **Author** | techafreshh |
| **Date** | 2026-11-14 |
| **Gate** | high |
| **Recommendation** | NEEDS WORK |

## Summary

The publish gate now fails closed, the walk's env scoping is tested behaviorally, and `host-tools` runs under the allowlist. The change that closes round-2 item 8 (`dedupeClosed`) introduces a logic error: it cannot tell a human "won't fix" close from a close the factory itself performs when it merges the fix. That silences real findings and breaks the loop the PR is built on.

## Round 2 follow-up

| Finding | Status |
|---------|--------|
| Medium 1: publish gate fails open | Fixed. `mayFileSecurityFindings(null)` is false, the receipt names "visibility unreadable", test flipped. |
| Medium 2: closed findings re-filed | Implemented, but the implementation is wrong. See High 1. |
| `repoVisibility` captured-shape test | Added (`parseRepoVisibility`), with a minor accuracy issue (Suggestion 1). |
| Behavioral env test for the walk's host lane | Added, with a fake toolchain that records its env. It cannot pass vacuously. |
| `host-tools` env | Fixed (`agentEnv([])`, `inheritEnv: false`). |
| Docs for the publish gate | Added. |

## Issues Found

### Critical
None

### High Priority

1. **`dedupeClosed` suppresses findings the factory already "fixed", so an incomplete fix or a regression is never re-filed** — `src/fileissues.ts` (`dedupeClosed` branch), used from `src/security.ts` and `src/stages/acceptance.ts`
   The factory closes issues itself: the PR body carries `Closes #n` (`src/tick.ts:254`) and the merge path calls `gh.issueClose` (`src/tick.ts:300`, `:908`). `dedupeClosed` adds every closed issue title to `seen`, with no way to tell a human "won't fix" from a factory merge. Consequences:
   - A lap merges a fix for `[security] X`, the issue closes, the next scan still reports X (incomplete fix). The title matches the closed issue, so nothing is filed. The finding stays in the code and nobody is told.
   - A previously fixed vulnerability that regresses later is silenced the same way.
   - For `[prd-gap]`: the walk finds the same gap after its issue was closed by a merge. Nothing is filed, so the backlog looks drained and the walk re-runs (2 per day) and fails without filings forever. This is the loop the daily cap was added to bound.
   The new test closes the issue with `gh.issueClose`, which is exactly what the factory does, so it asserts the buggy behavior as the intended one.
   `isDuplicateTitle` uses a Jaccard overlap of 0.7 across up to 500 closed issues of any class (including product issues), so near matches widen the effect. The 500 cap also means stickiness expires for old closes.
   **Fix:** apply the closed-dedupe only to closes that are a human decision. `gh issue list --json stateReason` is not available on gh 2.45.0 (I ran it: `Unknown JSON field: "stateReason"`), so use one of:
   - a `wontfix` (or `factory:ignore`) label as the explicit signal, applied by the human before or when closing; or
   - exclude issues whose number has a `merged` ledger row, or whose closing PR was a factory PR (`factory/issue-<n>` branch).
   Add a test where the factory merges a fix and closes the issue, the finding recurs, and it IS re-filed. Add a test where a `wontfix`-labelled closed issue is skipped. Update the docs paragraph accordingly.

### Medium Priority
None

### Suggestions

1. `test/gh.test.ts`: the test comment says "verbatim capture" but the input `{"isPrivate":false,"visibility":"PUBLIC"}` is not what gh 2.45.0 returns for `--json visibility` (I ran it and got `{"visibility":"PUBLIC"}`). The commit message states the right shape. Use the real string, since the boundary rule is about pasting real output.
2. `src/agentenv.ts` forces `TINYFISH_API_KEY` into every `agentEnv()` result. That now includes the penthera scan, the `host-tools` installer and the host e2e suite. One key, low impact, but the scanner and installer don't need it. Consider an `agentEnv([], { alwaysKeys: false })` option for non-agent callers.
3. `opsAcceptanceRun` / `opsSecurityScan` hold the repo lock for the full walk (up to `prd_minutes` plus boot time). That is the intended behaviour and `factoryd` ticks for the repo are skipped meanwhile. A one-line note in the docs would save an operator a support question.

## Issue Count

| Severity | Count | Blocks Merge? |
|----------|-------|---------------|
| Critical | 0 | No |
| High | 1 | Yes |
| Medium | 0 | No |
| Suggestions | 3 | No |

## Validation Results

| Check | Status |
|-------|--------|
| Type Check (`bun run typecheck`) | PASS (0 errors) |
| Lint | N/A (no lint script) |
| Tests (`bun test`) | PASS (576 pass, 0 fail, 44 files) |

## What's Good

- The fail-closed visibility fix is minimal, tested, and the receipt text names the cause.
- The behavioral env test runs the real walk path with a fake toolchain and checks for both absence of the secret and presence of `HOME`, so it proves the suite ran.
- Parsing for `repoVisibility` is now a pure function with tests.
- `host-tools` now follows the same env rule as everything else that executes downloaded code.

## Recommendation

Do not ship `dedupeClosed` as written. Either narrow it to explicit human decisions (label or ledger check) or revert it to open-only dedupe and track the human-close case separately, as it was before this commit. Everything else in the commit is ready.

## Audit Trail

| Artifact | Path |
|----------|------|
| Round 1 review | `.agents/reviews/pr-10-review.md` |
| Round 2 review | `.agents/reviews/pr-10-review-round2.md` |
| This Review | `.agents/reviews/pr-10-review-round3.md` |
