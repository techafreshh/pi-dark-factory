# Lap lifecycle

Each repo works its claimable issues one lap at a time, oldest first, through six deterministic stages.

A merge (or a block) re-intakes at once, so one tick chains up to 6 laps per repo inside a
12-minute budget (`PDF_CHAIN_BUDGET_MS`), re-syncing the source checkout to main before each
chained lap; whatever remains resumes on the next tick. Strict one-at-a-time order inside a
repo is what keeps main conflict-free.

## Lifecycle (one lap)

1. **Intake** — deterministic: oldest open issue with no ledger row, opened by a trusted author
   (the repo owner, the factory's own gh account, or the config's `trusted_authors`), no
   foreign PR claiming it, no unmet `Depends on: #n`, none of `skip_labels` (or the factory's
   `needs-info` label).
2. **Plan** (planner model, read-only) — writes `plan.md` in a fixed skeleton (approach with
   rejected alternatives, assumptions, repo patterns to mirror with `file:line` citations, files
   to change, anchored steps, validation, out-of-scope). Escapes: `NO_ACTION: <reason>` for
   tracker/meta issues; `INSUFFICIENT_CONTEXT: <question>` when a product decision is missing: the question (plus the defaults it would have assumed) is posted on the issue, parked under `factory:needs-info`, and answered by a human in the issue body.
3. **Implement** (implementer model, full tools, in the issue's worktree or machine) — must
   commit everything and push `factory/issue-<n>`; the PR is opened by the foreman, not the
   agent.
4. **Verify** — deterministic only: clean tree, real commits vs base, required CI checks,
   **runtime scenario** and **holdout scenario** (adversarial, second port) run black-box from
   files that live **outside the repo** so the agent can never tune against its own acceptance.
5. **Review** (reviewer model, read-only) — `VERDICT: APPROVE|REJECT` with an evidence bar:
   unproven findings are silence, one unmet acceptance criterion is a reject. Rejection routes
   the findings back into the next implement attempt (repair loop, bounded by the attempt cap;
   findings must be dispositioned — fixed or declined with a reason).
6. **Merge** — squash, close the issue, delete the worktree (or machine), close the ledger
   row, receipt.
