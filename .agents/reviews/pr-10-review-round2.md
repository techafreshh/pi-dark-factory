# Code Review: PR #10 — round 2 (fix commit 3ef7b46)

## Metadata

| Field | Value |
|-------|-------|
| **Scope** | PR #10, delta `456d7ee..3ef7b46` (11 files, +358/−146) |
| **PR Number** | 10 |
| **Branch** | feat/prd-acceptance |
| **Base** | main |
| **Author** | techafreshh |
| **Date** | 2026-11-14 |
| **Gate** | high |
| **Recommendation** | APPROVE |

## Summary

The fix commit resolves both High findings from round 1 and most of the Mediums, each with a test or a documented decision. No Critical or High issues remain. Two Medium items are worth a follow-up: the new public-repo publish gate fails open when `gh` cannot answer, and the closed-issue re-filing item from round 1 was neither fixed nor documented.

## Round 1 follow-up

| # | Finding | Status |
|---|---------|--------|
| 1 (High) | Host drain-walk suite ran with the full service env | Fixed. `acceptanceSuiteEnv` (`agentEnv(pass_env)`) with `inheritEnv: false` at `acceptance.ts` `acceptanceWindow`. A test checks a sentinel secret is absent. |
| 2 (High) | `penthera@latest` ran with the full env | Fixed. Pinned to `penthera@2.4.0` (`PDF_PENTHERA_SPEC` overrides), run under `agentEnv([])` with `inheritEnv: false`. `host-tools` uses the same spec. A test pins the default. |
| 3 | Per-merge e2e machine had no janitor marker | Fixed. `withAcceptanceMarker` wraps boot and run in both the regression and the walk. A test checks the marker is present during `ensure()` and gone afterwards. |
| 4 | Acceptance machines bypass slot allocator | Documented as a deliberate trade-off (`docs/acceptance.md`), consistent with scen-test and bake machines. Accepted. |
| 5 | Manual verbs did not take the repo lock | Fixed in `opsAcceptanceRun` and `opsSecurityScan`, same pattern as `opsProveGates`. |
| 6 | Stale `accept-main` worktree blocked the host regression | Fixed (remove, `rm -rf`, `worktree prune` before add). |
| 7 | Security findings published on public repos | Fixed with `acceptance.security_public` (default false) and `mayFileSecurityFindings`. See Medium 1 below for a gap. |
| 8 | Closed false-positive re-filed on every merge | **Not addressed and not documented.** See Medium 2. |
| 9 | Extras latency inside the lap and merge queue | Documented as a trade-off, with the knobs named. Accepted. |
| Suggestions | unused `floor`, dead `if`, `PR #undefined`, machine-lane report, suffix mismatch, verdict-first parsing | All fixed. Verdict parsing now scans the whole text, with tests for both new branches. |

## Issues Found

### Critical
None

### High Priority
None

### Medium Priority

1. **The publish gate fails open when visibility is unreadable** — `src/security.ts:51-54` (`mayFileSecurityFindings`), `src/gh.ts:243` (`repoVisibility`)
   `repoVisibility` returns `null` on any `gh` failure (rate limit, expired token, network blip), and `mayFileSecurityFindings(null, cfg)` returns `true`. The test pins that behaviour. The gate exists to prevent a one-way disclosure, so the failure mode that publishes is the wrong default. The `repoVisibility` doc comment says "callers fail toward their safe default", which contradicts the code.
   **Fix:** treat `null` as "do not file". Keep the scan and receipt, and word the note as "visibility unreadable". Flip the test expectation. The cost of failing closed is a missed filing that the next merge's scan retries.

2. **Closed `[security]` / `[prd-gap]` issues are re-filed** — `src/fileissues.ts` (`gh.issueList("open", 100)`) (carried over from round 1, item 8)
   A human who closes a finding as "won't fix" or "false positive" sees it come back on the next merge. This is not in the commit message or the docs. Either fix it (also check recently closed issues carrying the class label, or honor a `wontfix` label) or add it to the "Deliberate trade-offs" list in `docs/acceptance.md`.

### Suggestions

- `src/stages/acceptance.ts` (`acceptanceWindow`) and `src/security.ts`: the env scoping is tested only through the pure helpers (`acceptanceSuiteEnv`, `pentheraSpec`). Nothing asserts the `sh` calls actually pass `env` and `inheritEnv: false`, so a later edit could drop it silently. A test that runs the walk's host lane with a sentinel in `process.env` and a suite command that prints its env would lock it in.
- `src/gh.ts:243`: `repoVisibility` has no test against the captured shape. The repo's boundary rule asks for one. I ran `gh repo view techafreshh/pi-dark-factory --json visibility` on gh 2.45.0 and got `{"visibility":"PUBLIC"}`, so the parser is right. The doc comment's `{"isPrivate":false,...}` is not what `--json visibility` returns. Paste the real output into `test/gh.test.ts`.
- `src/browserbake.ts` (`hostToolsScript`) and `opsHostTools`: the install runs under the full service env and installs unpinned `e2e`, `@e2e-dev/web`, `playwright-core` and `agent-browser` (npm install scripts run with the factory's keys in env). The verb is operator-initiated and later runs use the allowlist, so risk is lower than the per-merge case. Consider `inheritEnv: false` with the `agentEnv` base plus `SUDO`-relevant vars, or pin versions.
- Behaviour note for operators: on a public repo with `security: true` and no `security_public`, each merge runs a full scan and files nothing (receipt only). This is intended, but `status` shows `last_security: fail` indefinitely. A line in the dashboard or `docs/acceptance.md` would avoid confusion.

## Issue Count

| Severity | Count | Blocks Merge? |
|----------|-------|---------------|
| Critical | 0 | No |
| High | 0 | No |
| Medium | 2 | No |
| Suggestions | 4 | No |

## Validation Results

| Check | Status |
|-------|--------|
| Type Check (`bun run typecheck`) | PASS (0 errors) |
| Lint | N/A (no lint script) |
| Tests (`bun test`) | PASS (572 pass, 0 fail, 44 files) |

## What's Good

- Each High fix is in the right place and uses the repo's existing mechanism (`agentEnv`, `acquireRepoLock`) rather than a new one.
- `withAcceptanceMarker` removes the duplicated marker handling and covers both machine-booting paths.
- The marker test checks the marker during `ensure()`, which is the window the janitor bug lived in.
- The trade-offs the author chose not to fix are written down with the knobs to tune them.

## Recommendation

Ready to merge at gate=high. Medium 1 is a one-line change and worth doing before merge because it is a disclosure control. Medium 2 can be a follow-up if it is recorded.

## Audit Trail

| Artifact | Path |
|----------|------|
| Round 1 review | `.agents/reviews/pr-10-review.md` |
| This Review | `.agents/reviews/pr-10-review-round2.md` |
