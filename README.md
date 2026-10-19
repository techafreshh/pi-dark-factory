# pi-dark-factory

An unattended software factory built on the **Pi** coding agent (`pi --mode json`), written in
TypeScript on Bun, with **zero frameworks and zero external dependencies**. A systemd timer fires
`foreman tick`; one lap takes the oldest unclaimed GitHub issue from intake through
plan → implement → verify → review → squash-merge → close — with **every gate deterministic** and
the LLM never trusted.

It replaces an Archon-based factory whose engine kept wedging. Every one of those failure
classes is answered structurally here:

| Old wound | Mechanism in this factory |
|---|---|
| Already-delivered issues re-claimed forever | **SQLite claim ledger** — intake only picks issues with no row (or a crashed `in_progress` row below the attempt cap). GitHub labels are cosmetic. |
| Hung laps / silent streams | Every stage is a **one-shot subprocess with a wall-clock timeout**; kill = kill the process group (setsid). Laps are serialized (one at a time, pidfile + systemd). |
| Orphaned workers needing targeted kills | Everything is a child of the oneshot service cgroup — systemd reaps leftovers. Plus a janitor pass (`foreman cleanup`) for stale `pi --mode json` processes older than 2h. |
| Worktree/session reuse confusing resumed runs | One worktree per issue (created at first implement, deleted at merge), reused only within that issue's repair loop. Every stage is a fresh process reading current disk truth — there is no cached-node replay to poison. |
| Structured output failures / "turn off thinking" | **No schema-valid JSON is ever demanded from a model.** All structure is Pi tool calls and text; verdicts are parsed leniently with one re-ask, then fail closed. |
| False-green traveling two gates | Green = `git diff` vs base + `gh pr checks` + black-box scenario probes. Agent self-report is never a gate; lockfile-only changes don't count. |
| Model bindings frozen at dispatch | Models are chosen **fresh from config at every spawn**, with a per-stage fallback chain (provider errors fail over; timeouts don't — a hung stream is a host problem). |
| Unattended permission prompts | JSON mode has no ask-path; tools are allowlisted per stage (`plan_tools` are read-only). |
| Crash mid-lap = lost issue forever | **Reconciliation pass** every tick: a delivered-but-unbooked merge is detected from merged PRs and closed out; a crashed lap at the attempt cap is marked blocked and notified; a crashed lap below cap is resumable with its persisted `plan.md`. |

Blocked issues (attempt cap exhausted, default 3) get a GitHub comment with the failure receipt,
the last error, and the exact unblock command — and are **never** auto-retried.

## Lifecycle (one lap, per tick)

1. **Intake** — deterministic: oldest open issue with no ledger row, no foreign PR claiming it,
   no unmet `Depends on: #n`, none of `skip_labels`.
2. **Plan** (planner model, read-only) — writes `plan.md`; replies `NO_ACTION: <reason>` for
   tracker/meta issues.
3. **Implement** (implementer model, full tools, in the issue's worktree) — must commit
   everything and push `factory/issue-<n>`; the PR is opened by the foreman, not the agent.
4. **Verify** — deterministic only: clean tree, real commits vs base, required CI checks,
   **runtime scenario** and **holdout scenario** (adversarial, second port) run black-box from
   files that live **outside the repo** so the agent can never tune against its own acceptance.
5. **Review** (reviewer model, read-only) — `VERDICT: APPROVE|REJECT`; rejection routes the
   findings back into the next implement attempt (repair loop, bounded by the attempt cap).
6. **Merge** — squash, close the issue, delete the worktree, close the ledger row, receipt.

## Commands

```
bun src/foreman.ts tick   [--repo <slug>]        # one lap cycle (what the timer runs)
bun src/foreman.ts status [--repo <slug>]       # ledger, laps, stages, worktrees
bun src/foreman.ts onboard <owner/name>         # config + scenario templates + reserved ports
bun src/foreman.ts backlog <slug> --prd <path>  # PRD → ordered GitHub issues (dedup by title)
bun src/foreman.ts unblock <slug> <issue>        # [--prune] drop the ledger row (± PR/branch/worktree)
bun src/foreman.ts cleanup                      # dep caches, stale pi workers, disk report
```

`--state-dir <path>` overrides the state root (default `$PI_FACTORY_STATE` or `./state`).

## State layout (outside the repo, survives code updates)

```
<state>/
  factory.db                # claim ledger + laps + stage runs (token usage per stage)
  laps.log                  # receipts — the audit spine
  repos/<slug>/config.json  # per-repo config (see templates/repo.config.json)
  repos/<slug>/runtime.json  # black-box acceptance (OUTSIDE the product repo)
  repos/<slug>/holdout.json  # adversarial acceptance, second port
  repos/<slug>/source/       # main checkout (fetch + hard reset each tick; agent never works here)
  repos/<slug>/issues/<n>/   # plan.md + Pi session JSONLs (forensics)
  worktrees/<slug>/issue-<n>/ # the only place agents ever work
```

## Scenario & probe contract

`runtime.json` / `holdout.json`: `setup`, `start` (**foreground** server command — the harness
backgrounds it and always kills its process group), `readiness_path`, `teardown`, `probes[]`.
Every command gets `PORT` env. Probes are shell commands judged by `expect` tokens
(space-separated, values must be space-free):

```
status:200                 last stdout line equals 200 (use curl -s -o /dev/null -w '%{http_code}')
json:data[0].name=ok       walk stdout as JSON; lenient value comparison (true/3/"ok")
body_contains:text         stdout includes text
body_matches:^[0-9]{3}$    regex against stdout
exit:3                     exit code (implicit exit:0 unless overridden)
max_ms:3000                probe timeout for the runner
```

Unknown tokens fail closed. A busy port (any listener, factory or not) fails the scenario before
anything runs. Ports are reserved per-config at onboard time (config inventory + live probe).

## Models

```jsonc
"models": {
  "default":   { "provider": "zai", "model": "glm-5.3", "thinking": "medium", "fallback": [] },
  "implement": { "provider": "deepseek", "model": "deepseek-v4.1-flash", "fallback": ["zai/glm-5.3:high"] },
  "review":    {}
}
```

`default` applies to every stage until overridden; stage entries inherit unspecified fields.
Fallback strings are `provider/model[:thinking]`. Provider errors advance the chain; timeouts
and spawn errors stop it. Tier lesson from the old factory's logs: cheap model for plan fan-out,
disciplined model for implement/review.

## Development

```
bun install
bun test          # 62 tests: parser, ledger, probes, spawner (fake pi binary),
                  # scenario harness (real python3 server), tick integration (real git, fake gh)
```

No external runtime dependencies — `bun:sqlite` and the Bun standard library only.

See `DEPLOYMENT.md` for the VPS runbook (factory user, Pi install + provider auth, systemd
timer, first-lap smoke test).
