# Code Review: PR #10 — round 4 (fix commit 8475c4d)

## Metadata

| Field | Value |
|-------|-------|
| **Scope** | PR #10, delta `40bb87d..8475c4d` (10 files) |
| **PR Number** | 10 |
| **Branch** | feat/prd-acceptance |
| **Base** | main |
| **Author** | techafreshh |
| **Date** | 2026-11-14 |
| **Gate** | high |
| **Recommendation** | APPROVE |

## Summary

`dedupeClosed` is replaced by `dedupeWontfix`. Only closed issues that carry the `wontfix` label suppress a re-filing, so the factory's own merge-close no longer silences a finding that survived its fix or regressed. Tests cover both directions and the three round-3 suggestions are done. No Critical, High or Medium issues remain.

## Round 3 follow-up

| Finding | Status |
|---------|--------|
| High: `dedupeClosed` suppressed factory-closed findings | Fixed. `fileFactoryIssues` now adds a closed issue's title to the seen set only when it carries `wontfix` (`src/fileissues.ts`). Used by both `[security]` and `[prd-gap]` filings. |
| Test closed the issue the way the factory does and asserted suppression | Rewritten. One test closes without the label and expects a re-file (the incomplete-fix case). A second adds `wontfix`, closes, and expects a skip. The second test's comment notes only the closed-and-labelled branch could supply the title. |
| Docs claimed bare closes were sticky | Rewritten around the label, with the reason (`stateReason` unreadable on gh 2.45). |
| Suggestion: "verbatim capture" test input | Fixed. The test uses `{"visibility":"PUBLIC"}`, which matches what I got from `gh repo view … --json visibility`. |
| Suggestion: `TINYFISH_API_KEY` forwarded to non-agent callers | Fixed. `agentEnv(…, { always: false })` is used by the penthera scan, `host-tools` and the suite runner. Agent stages keep the key. |
| Suggestion: lock-hold note for manual verbs | Added to `docs/acceptance.md`. |

## Issues Found

### Critical
None

### High Priority
None

### Medium Priority
None

### Suggestions

- `src/agentenv.ts`: the new `always: false` option has no direct test. The behavior is covered only indirectly (the env test checks a different sentinel). A two-line unit test (`agentEnv([], {TINYFISH_API_KEY:"x", PATH:"/bin"}, {always:false})` has no key, default has it) would pin it.
- `src/stages/acceptance.ts` (the added `Not going to build it?` lines in the `[prd-gap]` body): the new array entries are indented two spaces less than their neighbours. Cosmetic only.
- The sticky signal depends on a `wontfix` label existing in the repo and on a human applying it. GitHub's default label set includes `wontfix`, so most repos have it. A line in `docs/acceptance.md` saying to create it if missing would cover the rest.

## Issue Count

| Severity | Count | Blocks Merge? |
|----------|-------|---------------|
| Critical | 0 | No |
| High | 0 | No |
| Medium | 0 | No |
| Suggestions | 3 | No |

## Validation Results

| Check | Status |
|-------|--------|
| Type Check (`bun run typecheck`) | PASS (0 errors) |
| Lint | N/A (no lint script) |
| Tests (`bun test`) | PASS (577 pass, 0 fail, 44 files) |

## What's Good

- The round-3 flaw was fixed by changing the signal, not by patching the symptom, and the commit message and docs now state why a bare close must not be sticky.
- The issue bodies tell the human how to suppress a finding, so the mechanism is discoverable where it is needed.
- Across four rounds, every High and Medium finding was either fixed with a test or recorded as a deliberate trade-off in `docs/acceptance.md`.

## Recommendation

Ready to merge. The three suggestions are optional.

## Audit Trail

| Artifact | Path |
|----------|------|
| Round 1 review | `.agents/reviews/pr-10-review.md` |
| Round 2 review | `.agents/reviews/pr-10-review-round2.md` |
| Round 3 review | `.agents/reviews/pr-10-review-round3.md` |
| This Review | `.agents/reviews/pr-10-review-round4.md` |
