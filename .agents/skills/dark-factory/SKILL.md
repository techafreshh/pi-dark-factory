---
name: dark-factory
description: >-
  Operate pi-dark-factory remotely through the dark-factory CLI (npm
  @techafresh/dark-factory) and GitHub: onboard a repo (PRD check, config,
  scenarios, backlog, first lap), read status, logs and live sessions, fire
  ticks, pause, unblock, clean up, and diagnose blocked or stuck issues. Use
  whenever the user mentions the factory or dark factory, adding a repo or PRD
  to it, slicing a backlog, firing a lap, why an issue is blocked, provider
  credit or billing holds, factory machines, or says things like "get X built
  by the factory" or "is the factory running".
---

# dark-factory (remote operator)

pi-dark-factory is an unattended loop on a VPS that turns GitHub issues into
merged PRs. You drive it with the `dark-factory` CLI over HTTPS and check its
work with a local `gh`. You never SSH to the server. Anything that exists only
server-side is handed to the operator as an exact command (see
[Server-side operations](#server-side-operations)).

## How the factory works

- **Scheduling.** Every 15 minutes the daemon starts one tick process per
  onboarded repo, unless that repo's previous tick still runs. A per-repo
  pidfile arbitrates, so a manual `tick` can never double-run a lap.
- **Chain.** A tick works one issue at a time and chains to the next claimable
  one after each lap. It stops after 6 laps or 12 minutes, whichever comes
  first; the in-flight lap always finishes, and the next tick continues.
- **Intake.** An issue is claimable when all of these hold:
  - it is open and its author is trusted: the repo owner, the factory's own
    GitHub account, or a login in `trusted_authors`;
  - it has no `skip_labels` label and no `factory:needs-info` label;
  - it has no ledger row, or an `in_progress` row below the attempt cap;
  - no foreign open PR claims it (`closes #N`);
  - every issue in its `Depends on: #a, #b` line is closed.

  Oldest first. Major `discovery` issues jump the queue; `minor` discoveries
  wait until no product issue is claimable.
- **Lap.** plan → implement → verify (CI checks + runtime and holdout scenarios)
  → review → squash-merge → close the issue. Each issue gets `attempts`
  (default 3); a failed attempt writes findings that the next attempt repairs.
- **Where stages run** (`env.mode`):

  | mode | where the agent runs |
  |---|---|
  | `instabox` | one disposable InstaBox VM per lap (`pdf-<slug>-i<issue>-g<lapId>`), all stages |
  | `boxd` | the same, on a boxd microVM |
  | `daytona` | the same, on a Daytona cloud sandbox (SDK transport) |
  | `e2b` | the same, on an E2B Firecracker sandbox (SDK transport) |
  | `instavm` | the same, on an InstaVM microVM (raw REST; needs a card on file even on Free) |
  | `compose` | root inside the product's docker-compose worker service |
  | `host` | plain processes on the VPS |

  In machine modes, plan and review keep bash, and the clone is reset after
  each of them. The machine is deleted when the lap ends; a janitor reaps
  leftovers every scheduler pass.
- **Ledger.** The ledger is the source of truth; a delivered issue is never
  re-claimed. Issue states are `in_progress`, `merged`, `blocked` and
  `no_action`.
- **Blocked issues revive by themselves.** Each tick gives a blocked issue a
  fresh attempt budget. Two fuses stop this:
  - at most 3 revives per issue per UTC day;
  - a stagnation breaker when the same failure repeats.

  When a fuse trips, the factory posts a FAILURE SUMMARY comment on the issue.
  Any `config` or `scenario` write resets both fuses for that repo (the
  "inputs epoch").

### Lap outcomes

| outcome | meaning | attempt |
|---|---|---|
| `merged` | PR merged, issue closed | — |
| `blocked` | attempts exhausted; GitHub comment with the last error | spent |
| `error` | an unexpected throw (git/gh/network); retried next tick | spent |
| `interrupted` | the process died mid-lap; the next tick reconciles the row | the spent ones carry over |
| `no_action` | the planner found nothing to change; commented on the issue | — |
| `needs_context` | the planner asked a question; issue parked under `factory:needs-info`, row dropped | fresh budget on return |
| `infra_deferred` | machine platform down or at its cap; claim dropped, chain deferred | not spent |
| `billing_hold` | every model in the chain failed on billing (402/401); repo paused | refunded |

Other stops show up only in receipts:
- **Daily ceiling.** `limits.daily_attempts` (default 60) caps implement runs
  per repo per UTC day. Reaching it stops the chain until 00:00 UTC.
- **Connection-blip cooldown.** An attempt that dies within 2 minutes to a
  connection error waits 120 s before the next attempt.

## Rules

- **Get a yes before anything that spends tokens or writes:** `tick`, `backlog`
  (the preview runs the LLM slicer too), `backlog --create`, `onboard`,
  `config --json`, scenario writes, `discoveries --file`, `unblock --prune`.
  Show the exact payload or file first.
- **Confirm results on GitHub.** A `merged` row is real once `gh pr view`
  shows the PR merged and the issue closed.
- **Never echo a secret.** The API key lives in `~/.dark-factory/config.json`
  (600) or env; provider keys stay on the server. Print names, never values.
- **Never edit the ledger or receipts.** They change only through verbs.
  Config goes through `config`; the one exception is a key outside the
  allowlist, which the operator edits server-side.
- **Scenarios are the verifier.** Never show their contents to the implementer
  and never move them into the product repo.
- **A slug names one repo.** Never touch another repo's rows.
- **Don't busy-poll.** A lap takes tens of minutes. Check once after a few
  minutes, report, and wait.
- **After a server-side fix, prove it once.** Watch one green run of the fixed
  path before re-driving laps.

## Connect

From any machine with Node ≥ 18:

```bash
npx @techafresh/dark-factory setup https://<factory-domain> <KEY>
dark-factory doctor
```

- **The key.** `FACTORY_API_KEY` or `DARK_FACTORY_LAPTOP_KEY` from
  `/home/factory/factoryd.env`. The operator reads it on the server once; it
  never goes into chat.
- **Precedence.** `--url/--key` flags beat the `DARK_FACTORY_URL` /
  `DARK_FACTORY_API_KEY` env vars, which beat the config file. `where` shows
  the active connection with the key masked (`where` and `session` ignore the
  flags).
- **`doctor` reports:**
  - the daemon version;
  - web-tools readiness;
  - which snapshot each stack base alias (`shared-base`, …) maps to, and its
    contents;
  - onboarded repos.
- **Errors.** A 401 means a wrong key. A connection error that is not a 401
  means the daemon or the edge proxy is down: hand it to the operator.

The human-facing dashboard is `https://<factory-domain>/dashboard/`. It sits
behind SSO, so agents use the CLI.

## Reading the factory

| question | command |
|---|---|
| overall state | `status` (repos, claimable chain depth, in-flight, ledger, recent laps and stages) |
| one repo | `status --repo SLUG` (`--format json` for scripts) |
| what happened | `logs --repo SLUG --tail 300` (receipts: every claim, attempt, gate, revive, pause) |
| what the agent is doing | `session SLUG --follow` (live), `--think` for reasoning text, `--issue N` to pin one |
| the truth about code | `gh pr view`, `gh pr checks`, `gh issue view` |

Things that look wrong but aren't:
- **Session lines.** `▶` is a tool call, `⎸` a result, `⋯ thinking (N chars)`
  a turn, `✔ FINAL` a stage end, and `·` a heartbeat. Minutes of `·` with no
  `⋯` means a stalled stage.
- **Silent receipts.** Machine-mode stages write receipts only when they
  finish, so silence mid-stage is normal. Watch `session`, and check GitHub
  for a fresh PR before calling a lap stuck.
- **`chain: unknown (GitHub probe >5s)`** in status means retry, not
  "nothing to do".
- **A `suspended` machine** is the platform's idle auto-suspend. The next
  attempt resumes it.

## Onboarding a repo

Work the stages in order and stop at any failure.

### 0. Precheck (local `gh`, read-only)

1. `gh repo view OWNER/NAME --json name,owner,defaultBranchRef,primaryLanguage`.
   Note the default branch.
2. **Find a PRD.** Look for one in the tree; `.agents/PRDs/PRD.md` is the
   convention. If none exists, offer to draft one, get approval, and commit
   it. No PRD, no backlog.
3. `gh issue list`: is the backlog empty or already sliced?
4. Confirm the `gh` auth can write issues on the repo.

### 1. Preflight

`doctor`, then `status`. If the repo is already onboarded, switch to the ops
playbook.

### 2. Config

`onboard OWNER/NAME` (idempotent):
- It writes `config.json` plus runtime and holdout scenario templates
  server-side.
- It reserves two scenario ports and echoes the slug that every other verb
  takes.
- It sets `merge.required_checks: ["*"]`: every check the PR reports must
  pass, and a repo with no workflows stays ungated.

**Pick the models from `dark-factory models`, never from memory.** The
roster shows each provider, model id, context window, and which thinking
levels a model actually supports.

**Write the config.** Start from `templates/config.example.json`: fill the
models and pick `env.mode`. Show it, get a yes, then:

```bash
dark-factory config SLUG --json "$(cat config.json)"
dark-factory config SLUG            # read back the effective config and check it
```

Config rules (all enforced at write time):
- **Allowed top-level keys:** `models`, `env`, `timeouts`, `merge`,
  `default_branch`, `attempts`, `skip_labels`, `trusted_authors`, `pi`,
  `discoveries`, `limits`, `scheduling`. Anything else is rejected, including `_readme`,
  `repo`, `scenario` and `ui`. `ui.enabled:false` is a server-side edit.
- **Models are objects:** `{"provider", "model", "thinking", "fallback": []}`.
  - `model` is the bare id; the level goes in `thinking`.
  - `fallback` entries are `"provider/model[:thinking]"` strings, the only
    place that form is valid.
  - Stages `plan`, `implement` and `review` inherit from `default`.
- **Roster checks:** an unknown provider is rejected, and so is a thinking
  level the model doesn't support. An unknown model id only warns, and the
  CLI doesn't print the warning, so use ids that appear in `models`.
- **Merging:** the patch deep-merges, but arrays (`fallback`, `pass_env`,
  `trusted_authors`, `required_checks`) replace whole.
  - Last writer wins.
  - A `{}` patch is not a no-op read: it still writes the file and resets
    the revive fuses. Read with `config SLUG` instead.
- Every successful write resets the revive fuses (the inputs epoch).

Decisions to walk with the user:
- **Models.** A strong model for implement and review, a cheaper one or a
  lower thinking level for plan.
  - Provider errors advance down the fallback chain; timeouts don't.
  - A model's provider decides which credit pool it bills: `402
    insufficient_credits` with an untouched quota means the ids are on the
    wrong pool, so ask the operator.
- **`env.mode`.**
  - `instabox` (needs a stack base, see below).
  - `boxd` (needs `env.boxd.repo_dir`; the default snapshot
    `factory-base-boxd-r1` has bun, git, gh and python3, but no node or Chrome).
  - `daytona` (needs `DAYTONA_API_KEY`; bake first — `env.daytona.snapshot`
    is empty until `foreman bake` saves the golden snapshot, which the clone
    and `env.daytona.bake` fill with the repo's deps).
  - `e2b` (needs `E2B_API_KEY`; Hobby caps sandboxes at 1 h continuous and
    10 concurrent, so keep `timeouts.stage_minutes` under ~50; bake is a
    remote template build).
  - `instavm` (needs `INSTAVM_API_KEY` **and a card on file even on Free**;
    young platform — run the gating smoke before trusting it with laps).
  - `compose` (stages run as root in the repo's own `docker-compose.yml`
    worker; until one exists, `env.image` must carry the toolchain, e.g.
    `node:22`).
  - `host` (no isolation; avoid for repos with outside contributors).
- **`trusted_authors`.** Anyone besides the owner who may file work. Issue
  text becomes agent prompt, so keep it short.
- **`limits.daily_attempts`.** The cost ceiling; 0 means none. In parallel
  mode every lane shares it, so a wide repo reaches it sooner.
- **`scheduling`** (docs/parallel-mode.md). Machine modes only.
  - `priority`: `high`, `normal` (default) or `low`, the repo's place in the
    fleet's machine-slot queue. A waiting request moves up one level per 30
    minutes, so `low` is never starved.
  - `parallel: true` with `max_lanes` (default 3, at most 10): independent
    issues of the backlog build at the same time and land one by one through
    a merge queue. Worth it when the backlog is wide (many issues with no
    `Depends on:` between them). Slicing a new PRD with it on adds a
    foundation-issue rule to the slicer, so set it **before** `backlog`.
  - `spill_over: true`: when the repo's own platform pool is full, a lap may
    run on any other machine platform (instabox, boxd, daytona, e2b, instavm
    — own mode first, then the rest in fleet order). Run
    `scenario SLUG --test` on every platform you spill to first: snapshots
    differ in toolchain (instabox bases ship node, boxd/daytona/e2b/instavm
    bases ship bun + node + git + gh + python3), or spilled laps fail in
    verify.
- **`discoveries.auto_file`.** On by default: reviewer findings become
  `[discovery]` issues. Set false for a quiet repo.
- **`pi.web.search` / `pi.web.fetch`.** Web tools for the agent, on by default.
- **`attempts`, `timeouts.stage_minutes`** (60), **`timeouts.readiness_seconds`**
  (120).

**Stack bases.** `env.<platform>.snapshot` names a base alias
(`state/base-snapshot.json` resolves it per platform), and `doctor` prints
what each alias contains. Compare the PRD's runtime needs against that list
before the first lap. A missing toolchain doesn't fail at onboarding; it
fails later as blocked laps. (daytona/e2b/instavm snapshots are empty until
the repo's first `foreman bake`.)
- **Small extras:** install them in the scenario `setup` or the repo's own
  scripts.
- **A real gap:** ask the operator for a new stack base (an operator bake).
- **Never point a repo at a snapshot name that doesn't exist.** Laps and
  `foreman bake` both fail on it.
- **Never re-bake a shared alias for one repo.**

### 3. Scenarios (the acceptance contract)

Two files live server-side, outside the product repo:
- **`runtime.json`:** the positive path.
- **`holdout.json`:** adversarial. Malformed input gets a 4xx and never a 500;
  test unknown resources and boundaries.

Derive every assertion from the PRD; never invent endpoints. **Size the probes
to the issue that is claimable now** and grow them as laps merge. Probes for
the whole PRD on day one only burn attempts on repair churn. Start from
`templates/scenario.runtime.json` and `templates/scenario.holdout.json`, show
both in full, get a yes, then:

```bash
dark-factory scenario SLUG runtime --file runtime.json --lint    # validate, writes nothing
dark-factory scenario SLUG runtime --file runtime.json           # write (resets revive fuses)
dark-factory scenario SLUG runtime --test                         # run vs the default branch, no lap, no tokens
dark-factory scenario SLUG runtime --test --branch factory/issue-7
dark-factory scenario SLUG runtime --dump                         # print what is stored
dark-factory prove-gates SLUG                                     # every probe vs a stub that answers 200 to everything
```

**Schema.**

| field | rule |
|---|---|
| `port` | `"first"` (runtime) or `"second"` (holdout) |
| `start` | one foreground command; the harness owns and kills it |
| `readiness_path` | path the harness polls until the server is up |
| `setup`, `teardown` | optional |
| `probes` | `[{id, description, command, expect, timeout_ms}]` |

**Rules for `$PORT`.**
- `$PORT` is set in every command's environment. Never hardcode a port.
- Never single-quote `$PORT`, and percent-encode `(`/`)` in URLs. Lint
  rejects both.

**Expect tokens** are space-separated, and a value can't contain a space.

| token | passes when |
|---|---|
| `status:N` | the last stdout line equals N; use `curl -s -o /dev/null -w '%{http_code}'` |
| `status_in:200,404` | the last line is any of the codes |
| `json:path=value` | all of stdout is one JSON document; dot path, `[N]` indexes |
| `body_contains:VAL` | VAL appears in stdout |
| `body_matches:REGEX` | a JS RegExp, unanchored; use `\s` for spaces |
| `exit:N` | the exit code (default 0) |
| `max_ms:N` | the command finishes within N ms |

To check status and body in one probe, use `curl -s -w '\n%{http_code}'`.

**Checking scenarios.**
- **`--lint`** catches syntax mistakes.
- **`--test`** catches probes that assert something the product doesn't do,
  in minutes and for free. Use it before the first lap and after every fix.
  - instabox repos test in a throwaway machine.
  - host, compose **and boxd/daytona/e2b/instavm** repos test in a worktree
    on the VPS, so the product's code runs there.
- **`prove-gates`** exits 1 if no probe fails against the stub. Weak probes
  are listed in `survived[]` even when the verdict is `healthy`. It needs the
  repo idle.
- **Use a standard server for `start`** (`node server.js`, `uvicorn …`). A
  hand-written supervisor that binds the port but never accepts connections
  is the classic "ghost server".

### 4. Backlog

```bash
dark-factory backlog SLUG --prd-file PRD.md --max 40           # preview (runs the slicer: spends tokens)
dark-factory backlog SLUG --prd-file PRD.md --max 40 --create  # creates issues wired with "Depends on: #n"
```

- **Show the preview first.** Show titles and dependencies before
  `--create`; the first issue must be a walking skeleton.
- **Re-running is safe.** Titles dedupe against existing issues.
- **The dependency graph is validated.** `--create` refuses self, forward or
  out-of-range references; re-slice when it does. (The preview's
  `graph_problems` field is not printed by the CLI.)
- **Keep operator tasks out of issues.** Secrets, deploys and external
  accounts stay in the PRD as an operator checklist.
- **Slicer failures.** The slicer runs on the repo's plan model. An `empty
  streamed completion` error usually means a broken `models.plan` shape, not
  quota. Fix the config before retrying, and don't cycle through models.

### 5. First lap (spends tokens)

Confirm, then `dark-factory tick SLUG`. A 409 or `tick SKIPPED` means a tick
is already live. Only a `queued: SLUG #N` receipt means a lap started. Follow
with `session SLUG --follow`, check `status --repo SLUG` after a few minutes,
and report.

## Ops playbook

| situation | what to do |
|---|---|
| "is it running?" | `doctor`, then `status`. `logs` shows a `scheduler: started N repo tick(s)` line every 15 min |
| an issue isn't picked up | read the `idle after #N: K open, none claimable — …` receipt. It names each bucket: `untrusted-author` (add the login to `trusted_authors`), `skip-labeled`, `pr-claimed` (a foreign PR says closes #N), `dep-gated` (parents still open), `factory-closed` (ledger says done or blocked) |
| work waits behind `chain budget … spent` or `lap cap (6) reached` | by design; the next tick resumes. `tick SLUG` drains it now |
| `#N` blocked | `status --repo SLUG` (row + `last_error`) → `logs` → match a [failure signature](#failure-signatures). Fix the cause; the config or scenario write that fixes it also resets the revive fuses, so the issue revives on the next tick |
| FAILURE SUMMARY on an issue | revive stopped (daily cap or stagnation). Read the summary's evidence and classification, fix, then write the fix (epoch reset) or `unblock` |
| start an issue over | `unblock SLUG N --prune`: drops the row, closes the PR, deletes the branch, retires `plan.md` and `findings.md`. Without `--prune` only the row drops; the next lap reuses the plan and continues the existing branch |
| good work blocked by a broken verdict | confirm on GitHub (checks green, diff right), squash-merge it yourself, then `unblock SLUG N --prune` |
| `in_progress` but nothing happening | first rule out a live lap: `session SLUG --issue N`, `gh pr view`. A dead lap is reconciled by the next tick automatically. `unblock --force` only once verified dead |
| `factory:needs-info` on an issue | the planner asked a question in a comment. The author edits the answer into the issue body and removes the label; the next tick claims it with fresh attempts |
| repo paused with `billing hold: …` | every model failed on billing. Read which provider in `logs`. The operator tops up or fixes the key, or you switch models with `config`, then `unpause SLUG` |
| `daily attempt ceiling reached` | the chain resumes after 00:00 UTC. To lift it, raise `limits.daily_attempts` with `config` (applies at once) |
| `lap #N DEFERRED — platform unavailable` | the machine platform is down or at its cap. No attempt is spent; it self-heals. `pause SLUG` if you want quiet; report if it lasts > 1 h |
| only `[discovery]` issues running | policy: major discoveries drain first; minor ones wait for the roadmap. `gh issue list -R REPO --label discovery` shows the split. Discovery laps never file new discoveries |
| reviewer findings not filed | `discoveries SLUG` lists them; `discoveries SLUG --file yes` files deduped issues (see CLI quirks) |
| stop a repo | `pause SLUG`; an in-flight lap finishes. `unpause SLUG` to resume. A manual pause overwrites a billing-hold reason |
| remove a repo | there is no remote verb. `pause` it, then hand the operator the offboarding step |
| leftover machines or disk | `cleanup`: deletes orphaned lap machines, kills pi workers older than 2 h, prunes dependency caches in blocked worktrees |
| change models, provider down | `models`, then `config SLUG --json '{"models":{…}}'`; it applies from the next lap |

## Failure signatures

| receipt or error | meaning | action |
|---|---|---|
| `402 … insufficient_balance` / `insufficient_credits` on one model, others fine | that provider is out of credit; the chain fell back | tell the operator; switch the lineup if it persists |
| every model `402`/`401` → `BILLING HOLD`, repo paused | no model can run | operator tops up or fixes keys, then `unpause` |
| `429 … all clinepass keys are cooling` | the ClinePass weekly pool is spent | wait for the reset or have the operator add a key; fallbacks carry on |
| `review verdict unparseable after 5 re-asks — failing closed` | the reviewer model died mid-output; verify already passed | a re-lap usually recovers. If it repeats on good work, merge by hand and `unblock --prune` |
| `[runtime] server never became ready within 120s` | `start` or `readiness_path` wrong, or the app exits or binds wrong | watch one repair round; then `scenario --test` before touching the scenario or `readiness_seconds` |
| readiness fails with `In-box socket state: LISTEN` and a full Recv-Q | ghost server: `start` binds but never accepts | fix `start` (scenario-owned; the implementer can't), `--lint`, `--test`, write |
| verdict classified `INFRASTRUCTURE` | the transport or the host-side poll failed, not the app | retry the lap; don't repair the product |
| `machine … never reached running (state: suspended)` | platform auto-suspend | nothing, unless it repeats every lap |
| `machine unreachable` / ssh exit 255 once | gateway blip | nothing; repeated on every attempt means the machine or snapshot is sick, so report |
| `attempt N died fast to a connection-class error — cooling down` | model API or edge hiccup | nothing; the cooldown is automatic |
| `pi exited 127` | the pi binary is missing where the stage ran (machine snapshot or compose launcher) | report to the operator with the receipt; a server-side fix |
| `skipping SLUG: its config.json does not load` | a hand edit broke the file | operator fixes the file; the rest of the fleet keeps running |
| `machine gate failed (git push …)` | the box couldn't push the branch | `unblock --prune` once; if it recurs, report (token or credentials on the server) |

## CLI reference

Every verb takes `--help`. Exit codes: 0 ok, 1 error or failed verdict, 2 usage.

| verb | effect |
|---|---|
| `setup URL KEY` / `where` | store / show the connection |
| `health` / `doctor [--format json]` | open liveness / auth + readiness sweep |
| `models [--format json]` | live provider roster |
| `status [--repo SLUG] [--raw \| --format json]` | ledger, laps, stages, chain depth |
| `logs [--repo SLUG] [--tail N] [--format json]` | receipts (default 200 lines) |
| `session SLUG [--follow] [--think] [--issue N]` | rendered agent session; follow reconnects every 5 s, server caps a stream at 4 h |
| `onboard OWNER/NAME` | **writes** config + scenario templates + ports |
| `config SLUG [--json PATCH]` | read effective config / **write** a deep-merge patch |
| `scenario SLUG runtime\|holdout --file F [--lint] \| --dump \| --test [--branch B]` | **write** / validate / print / run without a lap |
| `prove-gates SLUG` | plant every probe on a 200-stub; exit 1 if gates are dead |
| `discoveries SLUG [--file yes]` | list harvested findings / **file** issues |
| `backlog SLUG --prd-file F [--max N] [--create]` | **spends tokens** to slice; `--create` files issues |
| `tick SLUG` | **spends tokens**: start a lap now |
| `pause SLUG` / `unpause SLUG` | stop / resume a repo's ticks |
| `unblock SLUG N [--prune] [--force]` | drop the ledger row (± close PR, delete branch) |
| `cleanup` | orphaned machines, stale workers, caches |

CLI quirks (v0.1.2):
- **`-f` does not follow.** Use `--follow`.
- **`--file` takes a value.** On `discoveries`, write `--file yes`.
- **Warnings and graph problems aren't printed.** `config --json` hides
  roster warnings, and `backlog` hides `graph_problems`.

## Server-side operations

Name these to the operator with the exact command. Never improvise them. The
details are in the repo's `docs/operations.md`.

| need | operator command or action |
|---|---|
| deploy new factory code | `cd /home/factory/pi-dark-factory && sudo -u factory git pull --ff-only` (+ `bun install` if `package.json` changed), then `sudo systemctl restart pi-factoryd`. Restarts are safe mid-lap (`KillMode=process`); ticks load fresh code by themselves |
| provider keys, top-ups, new models | edit the factory user's `~/.pi/agent/models.json` / `auth.json`; check with `dark-factory models` |
| GitHub, InstaBox, boxd, Daytona, E2B, InstaVM or TinyFish keys | `/home/factory/factoryd.env` (600), then restart `pi-factoryd`. Daytona keys need the sandbox+snapshot write/delete scopes (a create-only key 403s every delete and the janitor silently can't reap) |
| ClinePass keys | `/home/factory/state/clinepass.keys`, one per line, live-reloaded |
| bake a repo snapshot (machine repos) | `sudo -u factory -H bash -lc 'cd ~/pi-dark-factory && bun src/foreman.ts bake SLUG'`. With `env.<platform>.snapshot` empty it builds the first golden snapshot (instabox: plain template machine; daytona: `node:22-bookworm` sandbox; e2b/instavm: remote builds), clones, runs `env.<platform>.bake`, saves `<slug>-base` and writes the name into the config. With a repo-owned snapshot it re-bakes that one in place. It refuses base aliases |
| upgrade a stack base | fresh-template bake under a new versioned name, then repoint the alias in `state/base-snapshot.json` |
| `ui.enabled:false` or other non-allowlisted config | edit `state/repos/SLUG/config.json` |
| offboard a repo | `pause` it, move `state/repos/SLUG` aside, `cleanup`. Ledger rows stay as history |
| dashboard, backups, restore | `pi-factory-dashboard`, `pi-factory-backup.timer`, `bun bin/backup.ts list \| restore <id> <empty-dir>` |
