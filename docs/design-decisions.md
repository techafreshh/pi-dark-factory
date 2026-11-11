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
| Unattended permission prompts | JSON mode has no ask-path; tools are allowlisted per stage (`plan_tools` has no edit/write; in machine mode the stage driver also resets the clone after plan and review). |
| Stale-memory API claims | Lap agents carry **web grounding** (TinyFish `web_search` + `web_fetch`, on by default, per-repo toggleable) and are prompted to verify external API/endpoint/version claims against current docs before acting on them; fetched pages are injected as untrusted data, never instructions. |
| Unanswerable issues eating laps | The planner may escape with **`INSUFFICIENT_CONTEXT: <question>`** for missing product decisions: the question (plus the defaults it would have assumed) is posted on the issue and parked under the `factory:needs-info` label until a human edits the answer into the body and drops the label. Technical choices are never an escape — the planner decides and records them. |
| Crash mid-lap = lost issue forever | **Reconciliation pass** every tick: a delivered-but-unbooked merge is detected from merged PRs and closed out; a crashed lap at the attempt cap is marked blocked and notified; a crashed lap below cap is resumable with its persisted `plan.md`. A lap whose process died is closed as `interrupted` and its issue gets that as `last_error`. A lap that throws (a failed push, a GitHub API error) books the error and the phase it died in like any failed attempt, and its issue waits for the next tick instead of being re-picked inside the same outage. |
| ClinePass weekly cap killing ~13 laps / unbounded spend | Provider keys fan over the **key router** (see docs/keyrouter.md). A stage whose every model (base and each fallback) failed on a provider `402` (out of credit) or `401` (bad key) is a **billing hold**: the attempt is refunded, the repo pauses itself with the reason in its `paused` marker, and every later tick's skip receipt repeats it until someone runs `unpause`. One model failing for another reason (a 500, a cooling key pool) makes it an ordinary failed attempt, because that can clear on its own. A per-repo **daily ceiling** (`limits.daily_attempts`, default 60 implement attempts per UTC day, counted from the ledger so revives and unblocks cannot reset it) stops a runaway chain until the next UTC day. |

Blocked issues (attempt cap exhausted, default 3) get a GitHub comment with the failure receipt,
the last error, and the exact unblock command. Later ticks auto-revive a blocked issue with a
fresh attempt budget and a fresh plan: the plan that failed is retired (renamed, kept for
forensics), and the new planner and the first implement attempt both see the last round's
findings, which are saved per issue in `findings.md`. Two fuses bound the revives: at most 3 revives per issue per day, and none once
the same failure signature has blocked 3 rounds in a row (a summary comment then asks for a
human). A config or scenario write resets both fuses. `unblock --prune` retires the plan and
the findings too, so the issue starts over. `factory:needs-info` parks are never
retried: a human answers in the issue body and removes the label.

## Ordering & concurrency (by design)

A repo's backlog is a dependency chain: the slicer writes `Depends on: #n`, and a lap takes the
repo's **oldest claimable issue** — one whose deps are all closed by merged PRs. Laps inside a
repo run strictly one at a time: a merge re-intakes at once, so a tick chains up to 6 laps per
repo inside a 12-minute budget (`PDF_CHAIN_BUDGET_MS`), re-syncing main before each, and the
next tick takes the rest. Repos run concurrently with each
other (`--concurrency N` / `PI_FACTORY_CONCURRENCY` caps cross-repo parallelism; default
unlimited). The previous factory's runs supplied the evidence for this shape: serial delivery
shipped 11 of 12 issues in perfect order with zero conflicts, while concurrent branches produced
mid-flight union-merges, a stranded never-delivered branch, and cross-worktree import
contamination.

Model bindings are read fresh at each spawn, so provider switching never wedges in-flight work;
the SQLite ledger is WAL and single-writer-per-process-safe; per-repo git operations
(fetch/worktree add/worktree remove) are mutexed even under manual concurrency.
