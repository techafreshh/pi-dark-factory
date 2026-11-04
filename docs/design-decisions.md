# Design decisions — every wound answered structurally

The factory replaced an Archon-based engine that kept wedging; every failure class of that
era is answered here structurally — by mechanism, not by prompt:

| Old wound | Mechanism in this factory |
|---|---|
| Already-delivered issues re-claimed forever | **SQLite claim ledger** — intake only picks issues with no row (or a crashed `in_progress` row below the attempt cap). GitHub labels are cosmetic. |
| Hung laps / silent streams | Every stage is a **one-shot subprocess with a wall-clock watchdog**; kill = kill the process group (setsid). Timeouts are generous and per-stage (`plan_minutes` / `implement_minutes` / `review_minutes`) — they exist to break hangs, not to throttle work. |
| Orphaned workers needing targeted kills | Everything is a child of the oneshot service cgroup — systemd reaps leftovers. Plus a janitor pass (`foreman cleanup`) for stale `pi --mode json` processes older than 2h and leftover machines. |
| Worktree/session reuse confusing resumed runs | One worktree per issue (created at first implement, deleted at merge), reused only within that issue's repair loop. Every stage is a fresh process reading current disk truth — there is no cached-node replay to poison. |
| Structured output failures / "turn off thinking" | **No schema-valid JSON is ever demanded from a model.** All structure is Pi tool calls and text; verdicts are parsed leniently with up to five re-asks, then fail closed. |
| False-green traveling two gates | Green = `git diff` vs base + `gh pr checks` + black-box scenario probes. Agent self-report is never a gate; lockfile-only changes don't count. |
| Model bindings frozen at dispatch | Models are chosen **fresh from config at every spawn**, with a per-stage fallback chain (provider errors fail over; timeouts don't — a hung stream is a host problem). |
| Unattended permission prompts | JSON mode has no ask-path; tools are allowlisted per stage (`plan_tools` are read-only). |
| Stale-memory API claims | Lap agents carry **web grounding** (TinyFish `web_search` + `web_fetch`, on by default, per-repo toggleable) and are prompted to verify external API/endpoint/version claims against current docs before acting on them; fetched pages are injected as untrusted data, never instructions. |
| Unanswerable issues eating laps | The planner may escape with **`INSUFFICIENT_CONTEXT: <question>`** for missing product decisions: the question (plus the defaults it would have assumed) is posted on the issue and parked under the `factory:needs-info` label until a human edits the answer into the body and drops the label. Technical choices are never an escape — the planner decides and records them. |
| Crash mid-lap = lost issue forever | **Reconciliation pass** every tick: a delivered-but-unbooked merge is detected from merged PRs and closed out; a crashed lap at the attempt cap is marked blocked and notified; a crashed lap below cap is resumable with its persisted `plan.md`. |

Blocked issues (attempt cap exhausted, default 3) get a GitHub comment with the failure receipt,
the last error, and the exact unblock command — and are **never** auto-retried, same for
`factory:needs-info` parks.

## Ordering & concurrency (by design)

A repo's backlog is a dependency chain: the slicer writes `Depends on: #n`, and a lap takes the
repo's **oldest claimable issue** — one whose deps are all closed by merged PRs. One lap per repo
per tick; the next tick (15 min later) takes the next link. Repos run concurrently with each
other (`--concurrency N` / `PI_FACTORY_CONCURRENCY` caps cross-repo parallelism; default
unlimited). The previous factory's runs supplied the evidence for this shape: serial delivery
shipped 11 of 12 issues in perfect order with zero conflicts, while concurrent branches produced
mid-flight union-merges, a stranded never-delivered branch, and cross-worktree import
contamination.

Model bindings are read fresh at each spawn, so provider switching never wedges in-flight work;
the SQLite ledger is WAL and single-writer-per-process-safe; per-repo git operations
(fetch/worktree add/worktree remove) are mutexed even under manual concurrency.
