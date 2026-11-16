# Code Review: PR #10 — PRD-delivery acceptance

## Metadata

| Field | Value |
|-------|-------|
| **Scope** | PR #10 (e2e regression, drain-time PRD walk, penthera security audit) |
| **PR Number** | 10 |
| **Branch** | feat/prd-acceptance |
| **Base** | main |
| **Author** | techafreshh |
| **Date** | 2026-11-14 |
| **Gate** | high (default) |
| **Recommendation** | NEEDS WORK |

## Summary

The PR adds three opt-in loops (per-merge e2e, drain-time PRD walk, per-merge penthera scan). The structure is sound and the test coverage is strong. The pure parsers are judged against captured real tool output, and all three loops default off. Two places break the repo's own rule that nothing run on the VPS sees the service environment, and one janitor guard is missing for the per-merge e2e machine.

## Issues Found

### Critical
None

### High Priority

1. **Agent-authored e2e tests run with the full factory environment** — `src/stages/acceptance.ts:413`
   In `acceptanceWindow`, the host/compose branch runs the stored suite with `sh(["bash","-c", ...], { cwd, timeoutMs, killGroup })`. It sets no `inheritEnv: false`, so the child inherits `process.env`. That env holds `FACTORY_API_KEY`, the GitHub token, the model keys and the machine-platform keys. The suite files (`*.e2e.ts`, `e2e.config.ts`) are written by the acceptance agent, which reads the live product and its pages (untrusted data), and are then executed on the VPS. The README safety model and `src/agentenv.ts` say host-side agent-influenced code must run under the allowlist. The per-merge path (line 312) does this correctly, because `runScenario` passes `env` and `inheritEnv: false`.
   **Fix:** pass the `env` that `runScenario`'s `onReady` receives (or `agentEnv(cfg.env.pass_env)`) with `inheritEnv: false`, as line 312 does. Add `PORT`/`APP_URL` explicitly. Add a test that a sentinel var in `process.env` is absent from the suite's environment.

2. **Unpinned `npx -y penthera@latest` runs with the full factory environment** — `src/security.ts:126`
   Every merge downloads and executes whatever `latest` is at that moment, as the factory user, with the service environment inherited. A compromised or buggy release gets all of the factory's keys on a schedule nobody controls. `PDF_PENTHERA_SPEC` exists as an override, but the default is the risky one.
   **Fix:** run it with `inheritEnv: false` and a minimal env (`PATH`, `HOME`, `TMPDIR`, proxy and `NODE_` vars). Default `pentheraSpec()` to the version the parsers were captured against (`penthera@2.4.0`) and bump it deliberately. Apply the same pinning to the `npx -y penthera@latest` line in `hostToolsScript` (`src/browserbake.ts`).

### Medium Priority

3. **The per-merge e2e machine has no janitor marker** — `src/postmerge.ts:48`, `src/ops.ts` (`acceptanceMachineLive`)
   Only `runPrdAcceptance` writes `acceptance.running`. `runMergedMainSuite` boots `pdf-<slug>-i0` and never writes it. The scheduler pass and every full tick run `reapOrphanMachines`. For issue 0 there is no ledger row, so a live regression machine is deleted mid-run. The result is a thrown error, an "errored (chain unaffected)" receipt, and no e2e signal for that merge. Boot (up to 10 min) plus suite (`e2e_minutes`) makes the window large.
   **Fix:** write and remove the marker around the machine's lifetime in `runMergedMainSuite`, preferably through a small helper shared with `runPrdAcceptance`. Add a janitor test for it.

4. **Acceptance machines bypass the fleet slot allocator** — `src/tick.ts` (both `openLapMachineFor(c, 0, ...)` call sites), `src/postmerge.ts:48`
   Lap machines lease a slot (`acquireSlot`) before they boot. The per-merge e2e machine, the drain walk and the manual `acceptance` verb boot without one. On a platform at its cap (InstaBox about 5, Daytona Tier 1 about 5), an acceptance machine can take a slot a lap needs or fail to boot. In parallel mode, `landViaQueue` boots one more machine while `max_lanes` leases are held.
   **Fix:** lease a slot for these machines, or document the over-subscription and add a headroom rule.

5. **Manual runs do not take the repo lock** — `src/ops.ts:1162` (`opsAcceptanceRun`), `src/ops.ts:1182` (`opsSecurityScan`)
   `opsProveGates` takes `acquireRepoLock`. The new verbs run beside a live tick and share state with it:
   - the `pdf-<slug>-i0` machine name,
   - the reserved scenario ports,
   - `issues/security/` (the scan `rmSync`s its root at start, which can delete a concurrent scan's worktree),
   - the `acceptance.running` marker (the first finisher deletes the other's).
   **Fix:** take the repo lock as `opsProveGates` does and answer 409 when it is held.

6. **A stale `accept-main` directory blocks the host e2e regression permanently** — `src/postmerge.ts:59`
   The security scan clears its scan root before use. `runMergedMainSuite` does not clear `issues/accept-main`. A crash between `worktree add` and the `finally` leaves `wt` behind, so every later `worktree add` fails ("already exists"), and the regression is skipped for good with only a receipt.
   **Fix:** `git worktree remove --force` and `rm -rf` the root before adding, and run `git worktree prune`.

7. **Security findings are published on the repo's issue tracker** — `src/security.ts:162-185`
   For a public repo, an unfixed `critical` command-injection finding (file, line, sink) becomes a public issue within minutes of the merge that introduced it. Penthera masks secret values, but exploit details are not masked. `intake` trusts the issues, so privacy is the only cost, but it is a one-way disclosure.
   **Fix:** add an `acceptance.security_issue_visibility` option, or at minimum skip filing (receipt-only) when the repo is public unless explicitly enabled, and note this in `docs/acceptance.md`.

8. **A closed false-positive is re-filed on every merge** — `src/fileissues.ts` (dedupe uses `issueList("open", 100)`)
   If a human closes a `[security]` issue as "won't fix", the next merge's scan files it again, because dedupe only looks at open issues. Same for `[prd-gap]` after a human close.
   **Fix:** also consult recently closed issues with the class label (or a `wontfix`/`factory:ignore` label) before filing.

9. **Per-merge extras run synchronously inside the lap, and in parallel mode inside the merge-queue turn** — `src/tick.ts` (serial block and `landViaQueue`)
   Worst case: scan up to 10 min + machine bootstrap up to 10 min + suite `e2e_minutes`. That is added to every merge in a chain with a 12-minute budget. Under parallel mode it also holds the queue while other lanes wait to land. The code is report-only, but latency is not.
   **Fix:** run the extras after the lap releases the queue and/or detach them from the chain budget, or document the cost and add a `PDF_*` timeout cap for the whole extras step.

### Suggestions

- `src/security.ts:111`: `const floor = floorRank(...)` is unused. The same value is recomputed inside `findingsAboveFloor`.
- `src/postmerge.ts:170-173`: the `if (r.reason && ...)` block has an empty body. Delete it or log the reason.
- `src/security.ts:157`: the non-drain provenance line prints `PR #undefined` when `opts.pr` is missing (the manual `security-scan` verb passes `atDrain: true`, so this is only reachable by other callers). Guard it.
- `src/postmerge.ts:84`: the issue body points at `state/repos/<slug>/e2e/.e2e/report.json`, which does not exist for machine modes (the report stays in the box; `runE2eSuite` returns `report: null` at `acceptance.ts:293`). The failure list is also empty in that lane. Either pull the report back or change the text.
- `src/acceptance-state.ts` `e2eSuiteExists` accepts `.spec.ts/.spec.js`. `collectSuiteFromBox` and the host collector copy only `.e2e.ts/.e2e.js`.
- `parseAcceptanceVerdict` returns on the first `VERDICT: DELIVERED` line, so `GAPS` bullets that follow it are ignored. Rare, but a verdict line placed first would hide gaps. Consider scanning the whole text and requiring the verdict to be the last line.

## Issue Count

| Severity | Count | Blocks Merge? |
|----------|-------|---------------|
| Critical | 0 | No |
| High | 2 | Yes |
| Medium | 7 | No (at gate=high) |
| Suggestions | 6 | No |

## Validation Results

| Check | Status |
|-------|--------|
| Type Check (`bun run typecheck`, `tsc --noEmit`) | PASS (0 errors) |
| Lint | N/A (the repo has no lint script) |
| Tests (`bun test`) | PASS (566 pass, 0 fail, 44 files) |

## What's Good

- Everything is opt-in and default-off, with strict config validation (`validateAcceptance`).
- Acceptance state (PRD, suite, verdict) lives outside the repo, so the implementing agent cannot tune against its own gate.
- Parsers are written against real captured penthera and e2e output, per the repo's boundary rule. Unparsable output fails closed and files nothing.
- Report-only wrapping around every post-merge step keeps the chain from entering the error path.
- Daily cap, generation-bound PASS verdicts, and the shared `fileFactoryIssues` (which also reduced duplicated code in `fileDiscoveries`) are well thought out.
- The `onReady` seam leaves the default probe path unchanged, and the pre-existing tests stayed green.

## Recommendation

Fix the two High findings (environment scoping for the host suite run and for penthera, plus pinning the scanner) before merging. Items 3, 5 and 6 are small and worth taking in the same pass. Items 4, 7, 8 and 9 can be follow-ups if tracked.

## Audit Trail

| Artifact | Path |
|----------|------|
| Plan | none found for this PR |
| Implementation Report | none found for this PR |
| This Review | `.agents/reviews/pr-10-review.md` |
