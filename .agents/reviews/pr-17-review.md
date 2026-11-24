# Code Review: PR #17 — docs: fix machine-platform and acceptance drift

## Metadata

| Field | Value |
|-------|-------|
| **Scope** | PR #17 (13 files, +53/−40) |
| **PR Number** | 17 |
| **Branch** | docs/platform-acceptance-drift |
| **Base** | main |
| **Author** | techafreshh |
| **Date** | 2026-11-24 |
| **Gate** | high |
| **Recommendation** | APPROVE |

## Summary

Docs, template and one `--help` string are brought in line with the shipped engine: five machine platforms, the e2e verify gate, `security_public`, the boxd config block. Every factual claim I checked against the code holds. The same drift survives in `DEPLOYMENT.md`, which the PR did not touch.

## Issues Found

### Critical
None

### High Priority
None

### Medium Priority

1. **`DEPLOYMENT.md` still carries the drift this PR fixes.** Same class of error, so the PR's "consistency sweep" claim is incomplete.
   - `DEPLOYMENT.md:12` — "`instabox` and `boxd` run them in a disposable machine per lap" omits daytona, e2b, instavm.
   - `DEPLOYMENT.md:133-134` — the optional pool block lists only `PDF_POOL_INSTABOX` and `PDF_POOL_BOXD`; add `PDF_POOL_DAYTONA=5`, `PDF_POOL_E2B=10`, `PDF_POOL_INSTAVM=5` (as done in `docker/.env.example`).
   - `DEPLOYMENT.md:166` — `/health` expectation reads "pools: instabox 5, boxd 10"; `src/allocator.ts:84-88` reports five pools.
   - `DEPLOYMENT.md:91` — "Neither lane needs Docker on the VPS" is left over from when there were two lanes; say "No machine lane".

### Suggestions

1. `src/foreman.ts:20` — "instabox/boxd machine flow" is vague. `bakeBoxd` (`src/ops.ts:520`) is a separate flow from instabox (first bake boots the shared base read-only and saves `<slug>-base`). Prefer naming boxd separately, e.g. "instabox machine flow; boxd shared-base flow; daytona sandbox flow; ...".
2. Source comments still say two platforms or "e2e regression": `src/types.ts:207` ("per-merge e2e regression suite on merged main", now a verify gate), `src/scenario.ts:399`, `src/tick.ts:229`, `src/webtools.ts:13`, `src/agentenv.ts:6`, `src/stages/verify.ts:118`, `src/ops.ts:1802`. The PR says no behavior change, so a comment-only follow-up is fine.
3. `docs/acceptance.md:149` ("merges re-run the regression") and the `.agents/skills/dark-factory/SKILL.md` acceptance row are accurate only if "regression" means `runPostMergeRegression`. One clarifying word would remove the ambiguity next to the new "e2e is a verify gate" wording.

## Verified against code

| Claim | Evidence |
|-------|----------|
| `security_public` defaults true | `src/config.ts:29-38`, `src/security.ts:62` |
| template `env.boxd` matches defaults | `src/config.ts:65-67`; template parses through `parseRepoConfig` (`repo_dir /home/boxd/repo`, snapshot `factory-base-boxd-r1`) |
| `acceptance` is a model stage inheriting `default` | `src/types.ts:265` |
| `acceptance` is in the config-patch allowlist | `src/ops.ts:1383` |
| five `PDF_POOL_*` defaults 5/10/5/10/5, five `DASHBOARD_POOL_*` | `src/allocator.ts:84-88`, `bin/dashboard.ts:568-572` |
| parallel/spill-over need any machine mode | `src/config.ts:253-260`, `MACHINE_MODES` in `src/types.ts:21` |
| boxd first bake: shared base → `<slug>-base`, base aliases refused | `src/ops.ts:524-545` |
| e2e is a verify gate; infra failures skip and retry next lap | `src/stages/verify.ts:165-290` |
| machine modes forward no ports | `src/scenario.ts:398-405`; `PortForwarder` is used only by tests |

## Issue Count

| Severity | Count | Blocks Merge? |
|----------|-------|---------------|
| Critical | 0 | No |
| High | 0 | No |
| Medium | 1 | No (gate=high) |
| Suggestions | 3 | No |

## Validation Results

| Check | Status |
|-------|--------|
| Type Check (`tsc --noEmit`) | PASS |
| Lint | N/A (no lint script) |
| Tests (`bun test`) | PASS — 618 pass / 0 fail |

## What's Good

- Claims are code-backed, and the PR notes explain the non-obvious calls (boxd literal snapshot, parallel mode for all five modes).
- The `docker/.env.example` and `docs/docker.md` pool tables now match the allocator exactly.
- The only code change is one help string.

## Recommendation

Ready to merge. Preferably fold the `DEPLOYMENT.md` fixes (Medium 1) into this PR, since it is the same drift.

## Audit Trail

| Artifact | Path |
|----------|------|
| This Review | `.agents/reviews/pr-17-review.md` |
