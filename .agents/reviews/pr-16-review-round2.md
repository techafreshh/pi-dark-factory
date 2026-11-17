# Code Review: PR #16 (round 2)

## Metadata

| Field | Value |
|-------|-------|
| **Scope** | PR #16, commit `de571c6` ("PR #16 review round 1") against the round-1 report |
| **PR Number** | 16 |
| **Branch** | feat/pr-evidence |
| **Base** | main |
| **Date** | 2026-11-16 |
| **Gate** | high |
| **Recommendation** | APPROVE |

## Summary

Both blocking findings from round 1 are fixed, with tests. Type check passes and `bun test` passes (618 tests, up from 614). The PR description now names every stacked change and calls out the `security_public` default flip. Remaining items are low severity.

## Round 1 disposition

| Finding | Status | Evidence |
|---------|--------|----------|
| H1 collector flattens `tests/` | Fixed | Both lanes go through `collectWalk`, which keeps the path relative to the root. `suiteRelPath` strips the `tmp/pdf-e2e-out/` and `e2e-out/` prefixes. Tests assert `tests/home.e2e.ts` is stored under `tests/` for the box lane and `tests/a.e2e.ts` for the host lane. |
| H2 scan outside `withSourceLock`, shared scan dir | Fixed | `ensureSource`, `rev-parse` and `worktree add` run inside `withSourceLock`. Each scan uses its own `mkdtemp` worktree. The worktree removal takes the lock. The scanner run stays outside the lock. |
| M1 error branch unreachable | Fixed | `SecurityScanResult.kind` is set on every return path, and `evidenceComment` has an explicit `kind === "error"` branch with a test. |
| M2 `security_public` flip unmentioned | Fixed | The PR body has an explicit callout. |
| M3 scope and description | Fixed | The PR body lists the stacked changes by component. |
| M4 `"."` root | Fixed | The root is removed and a test asserts it stays out. |
| M5 comment stacking | Fixed | `runVerify` updates the previous `## Acceptance evidence` comment in place. A test covers two attempts producing one comment. |
| Suggestions | Taken | The scan is skipped when another gate has already failed. The bake checks `[ -w /opt/pdf-e2e ]` after the mkdir/chown fallback. The "searched" receipt names the host dir on the host lane. |

## Issues Found

### Critical
None.

### High Priority
None.

### Medium Priority
None.

### Suggestions

1. **`src/security.ts` (`finally`)**: `src` is `""` when `ensureSource` throws, so cleanup runs `git -C "" worktree remove --force <wt>`. `git -C ""` leaves the working directory unchanged, so this runs in the factory process's cwd. Git refuses because `wt` is not a worktree of that repo, so it is harmless. Guard it with `if (src)`.
2. **`src/security.ts`**: the old `rmSync(scanRoot)` at the start of every scan cleaned up after crashed scans. With per-scan `wt-*` directories, a process kill leaves the directory and a stale `.git/worktrees/*` entry behind. Consider `git worktree prune` plus removing old `wt-*` directories at scan start, or in the janitor.
3. **`src/gh.ts` (`issueComments`)**: `gh api .../comments` returns the first 30 comments only. On a PR with more comments than that, the evidence comment is not found and a new one is posted. The matcher also accepts any author's comment that starts with `## Acceptance evidence`, and a PATCH on someone else's comment would fail (the failure is receipted, so the lap is unaffected). Filter on the factory's login and paginate (`--paginate` with a per-item `--jq`). `test/gh.test.ts` has no recorded-shape test for the two new verbs, which `docs/development.md` asks for.
4. **`src/stages/acceptance.ts` (`collectFromHostDir`)**: the host-lane walk recurses into a real `node_modules` if the agent ran an install inside `outDir`. The box lane excludes it in `find`. Skip `node_modules` and `.e2e` directories here too.
5. **Tests**: nothing exercises two concurrent `runSecurityScan` calls on one slug. The lock and unique-directory fix is correct by reading, but not pinned.

## Issue Count

| Severity | Count | Blocks Merge? |
|----------|-------|---------------|
| Critical | 0 | No |
| High | 0 | No |
| Medium | 0 | No |
| Suggestions | 5 | No |

## Validation Results

| Check | Status |
|-------|--------|
| Type Check | PASS |
| Lint | N/A (no lint script) |
| Tests | PASS (618) |

## Recommendation

Ready to merge. The suggestions can go into a follow-up.
