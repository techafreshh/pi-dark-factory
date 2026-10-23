---
name: pi-factory
description: >-
  Operate the pi-dark-factory (unattended Pi build loop on the VPS) remotely —
  onboard a new project end-to-end (PRD check → config → scenarios → backlog
  slice → first lap), check status/logs, fire ticks, unblock or clean up. Use
  whenever the user mentions the factory, onboarding a project to it, slicing
  a PRD into issues, firing a lap, factory status/receipts, blocked issues, ClinePass
  key rotation, or says things like "add this repo to the factory", "is the factory
  running", "why is issue #N blocked" — even casually ("get X built by the factory").
  Talks to the VPS over HTTPS via bin/factory-remote; NEVER SSH.
---

# pi-factory (remote operator)

> Installed copy lives in the user's second-brain (`~/.agents/skills/pi-factory/`).
> Edit THIS file (in the factory repo) and re-copy: it is the source of truth.

The pi-dark-factory is an unattended loop on the VPS: a systemd **timer fires
`foreman tick` every 15 minutes** (armed 2026-10-23 at the user's request —
"full dark factory"; `Persistent=true` catches up after reboots), and each
tick **chains laps down the dependency chain**: after a merge or block the
same tick re-intakes and runs the next claimable issue (bounded at 6
laps/repo/tick), auto-revives blocked issues (fresh attempt budget; fuses:
max 3 revive rounds/issue/day and a stagnation breaker when the identical
failure signature repeats), and waits out one 10-min in-tick cooldown to
retry its own recovery. Every lap takes the oldest claimable GitHub issue
through intake → plan → implement → verify (CI + black-box runtime/holdout
scenarios) → review → squash-merge → close. The **claim ledger** (SQLite on
the VPS) is the source of truth — a delivered issue is never re-claimed.
Manual `tick` is always safe: the pidfile no-ops it while the timer's tick
is live. To PAUSE the factory: `sudo systemctl disable --now pi-factory.timer`
(VPS-side, user only).

**This skill never SSHes into the VPS.** Everything runs through the remote
client (`bin/factory-remote` in this checkout, python stdlib) against the
HTTPS API. For code-level truth (diffs, CI checks, files, issue bodies) query
GitHub directly with a local `gh` — the PR is the truth, the factory's claim
about it is a claim.

## Connect

One-time setup on the machine you drive from (laptop or anywhere). Fastest —
the repo's own script (install + store + verify in one shot):

```bash
curl -fsSL https://raw.githubusercontent.com/techafreshh/pi-dark-factory/main/laptop-setup.sh \
  | bash -s -- https://pi-factory.techa.pro
```

…or the same steps by hand (from any factory checkout):

```bash
install -m 755 <factory-checkout>/bin/factory-remote ~/.local/bin/factory-remote
mkdir -p ~/.config/factory-remote && chmod 700 ~/.config/factory-remote
printf %s https://pi-factory.techa.pro > ~/.config/factory-remote/url
printf %s <KEY> > ~/.config/factory-remote/key && chmod 600 ~/.config/factory-remote/*
```

`<KEY>` = the `FACTORY_API_KEY` value from `/home/factory/factoryd.env` on
the VPS (read it there once; never echo it into chat). After this the
client carries its own URL + key — **it runs from any directory**, the
pilot project's included; `--prd-file` / `--file` arguments resolve against
the current directory, which is exactly what you want when onboarding from
the project's own checkout:

```bash
cd ~/code/mdrender
factory-remote doctor
```

`FACTORY_URL` / `FACTORY_API_KEY` env vars still override the stored files.
If `doctor` cannot reach the factory at all (connection refused/timeout —
not a 401), the factory is not provisioned: tell the user to clone
pi-dark-factory on the VPS and run the in-repo `pi-factory-setup` skill in
an agent session there (the guided installer; the old one-shot
`bootstrap.sh` was retired). Never improvise an SSH workaround.

## Onboarding a new project (the wizard — gate every write)

Work the stages in order; **show what will be written and get an explicit yes
before every mutating step**. Never skip a failed preflight: report and stop.

### Stage 0 — precheck (local `gh`, read-only)

BOUNDARY (from a real session, 2026-10-23): the skill + `factory-remote` are
the ENTIRE factory interface — never read a local `pi-dark-factory` checkout
for config shapes, templates, or "grounding" (the user forbids it and the
skill is the source of truth); never push to or configure the user's GitHub
repo content beyond what the staged verbs do, without explicit consent.

1. `gh repo view <owner>/<name> --json name,owner,defaultBranchRef,primaryLanguage`
   — repo exists, capture default branch (never assume `main`).
2. **PRD check**: look for the product document —
   `gh api repos/<o>/<r>/git/trees/HEAD?recursive=1` then search paths for
   `PRD`, `prd`, `product`, `spec` (`.agents/PRDs/PRD.md` is the convention,
   required for repos sliced by the factory). **If none exists: stop and
   offer to draft one from the conversation** — show the draft, get approval,
   commit it to the repo (a PR or direct commit). No PRD, no backlog.
3. Backlog sanity: `gh issue list` — is the repo empty of work, or already
   sliced? (Slices are deduped by title, so re-running is safe but pointless.)
4. gh auth has issue-write scope on this repo.

### Stage 1 — remote preflight

`factory-remote doctor` (factory alive + auth + version), then
`factory-remote status` — the repo must NOT already be onboarded; if it is,
skip to ops mode. Report the factory's version and current repos.

### Stage 2 — config gate

`factory-remote onboard <owner>/<name>` — the API discovers the branch,
reserves two scenario ports, writes `config.json` + scenario templates on the
VPS. Before firing, tell the user what will be written. Then surface the
decisions they must confirm (the API returns `next_steps`):

**⚠ Config is WRITE-ONLY and the schema is strict — these shape rules come
from a real onboarding (kvstore, 2026-10-23) where wrong shapes were silently
stored broken or rejected one field at a time, costing ~6 attempts:**

- `models` entries are OBJECTS: `{ "provider": "...", "model": "...",
  "thinking": "low|medium|high|max" }` plus optional
  `"fallback": ["provider/model:thinking", …]` — fallbacks are the ONLY place
  the `provider/model:thinking` string form is valid.
- **Never** write a dotted string as a stage value (`"models": {"default":
  "acme/glm:high"}` is silently stored broken and breaks every stage and the
  backlog slicer that uses it — the server does not validate at write time).
- **Never** put the thinking suffix inside `model` — `"model": "acme/glm:high"`
  sends an invalid model id to the provider (slicer symptom: deterministic
  `empty streamed completion`).
- `config` is write-only: the only "read" is the POST response echo showing
  the merged result — **always re-read the echo after every push** and verify
  every `models.*` renders as an object with a `provider`.
- A `{}` patch **silently writes and echoes defaults**; don't use it to probe.

**The canonical config skeleton ships as `templates/config.skeleton.json` in
this skill's folder** (river → clinepass → deepseek tiers, per-stage thinking,
compose mode) — read it, fill the provider/model + `env.mode`, then:

```bash
factory-remote config <slug> --json "$(cat .agents/skills/pi-factory/templates/config.skeleton.json | python3 -c 'import json,sys;d=json.load(sys.stdin);d.pop("_readme",None);print(json.dumps(d))')"
```

- **models**: default tier for everything + per-stage overrides. Suggest the
  tier lesson from the runbooks: disciplined model for implement/review,
  cheaper for plan; fallback chains as `provider/model[:thinking]`.
  - **ClinePass multi-key**: the key router runs on the VPS at
    `host.docker.internal:8099`; keys live in
    `/home/factory/state/clinepass.keys` (one per line, 600, live-reloaded —
    never echo them). Model strings use provider `clinepass-rotator`
    (see `templates/pi-models.clinepass-router.json`); nothing else changes —
    the router fails over keys inside the same call.
    **Billing surfaces — do not mix them (learned the hard way 2026-10-20):**
    the model id's first segment picks the billing program. Ids like
    `cline-pass/glm-5.3-flash` bill the ClinePass **weekly limit**; bare
    vendor ids from the catalog (`z-ai/…`, `deepseek/…`) silently bill
    pay-as-you-go **Cline Credits** and die with `402 insufficient_credits`
    once the balance drains — while the weekly limit looks untouched. Always
    hand the rotator pool `cline-pass/…` ids. (Also: reasoning models need a
    sane `max_tokens`, and big non-streaming prompts hang the pool — the
    slicer already streams; don't add bare non-streaming HTTP callers.)
- **required_checks**: `["*"]` is the onboard default and means autodetect —
  every check the PR reports must pass, a repo with no workflows stays
  ungated; empty list disables the CI gate; explicit names (e.g.
  `["test"]`) pin exact checks when you want a subset. The factory
  bootstraps CI itself: a PRD line "ship a CI workflow…" makes lap 1
  deliver `.github/workflows/ci.yml` and the gate engages from the next
  lap — no operator ever names checks by hand.
- **env.mode**: default `host`; offer `compose` if the product repo has a
  `docker-compose.yml` **or the PRD mandates shipping one as an issue
  deliverable** (install freedom in a root container; the compose file must
  publish the scenario ports on `127.0.0.1`). For a compose-mode Node
  project, set the **fallback image** `env.image` to a Node-bearing image
  (use a **full** node image like `node:22` — `node:22-slim` has no git, and the implementer cannot commit its work): until lap 1's PR lands the compose file, stages
  run in `env.image` — a bare `ubuntu:24.04` has no Node. (Last-resort
  safety net: the factory mounts its own Node 22 into every container at
  `/root/.pi/host-runtimes/node/bin/node`.)

Apply all decisions with the config verb (deep-merges, allowlisted keys:
models, env, timeouts, merge, default_branch, attempts, skip_labels, pi —
show the patch and confirm before firing):

```bash
factory-remote config <slug> --json '{"env":{"mode":"compose","image":"node:22"},"merge":{"required_checks":["*"]},"models":{"default":{"provider":"clinepass-rotator","model":"cline-pass/glm-5.3-flash","fallback":["clinepass-rotator/cline-pass/deepseek-v4.1-flash"]}}}'
```

The response echoes the merged config (env.mode, required_checks, per-stage
models) — read it back to the user before Stage 3.

NOTE: config pushes deep-merge — two writers (this skill and a VPS-side
session) can interleave; the LAST write wins per key. After any config
disagreement, re-echo the effective config once before proceeding.

### Choosing env.mode (per project — ask the user at Stage 2)

- **`compose`** (considered default for services): stages run in the
  product's own docker compose `worker` service (fallback `env.image` until
  lap 1 ships the compose file). Strong reproducibility; ports reserved per
  repo; git auto-provided by the factory.
- **`host`**: plain processes on the VPS. Zero overhead; no isolation.
- **`instabox`**: each lap gets its own ephemeral InstaBox cloud machine
  (own kernel + root + Docker; snapshot with the toolchain and a signed-in
  `gh`). Gates and scenarios execute inside the box over the machine exec
  API; the box suspends at lap end. **Prerequisites**: the `instabox` CLI
  installed and `INSTABOX_API_KEY` set for the factory systemd units, a
  snapshot with node/git/gh signed in (`env.instabox.snapshot`), and the
  repo's model-API keys presentable to in-box pi. Best for parallel-heavy
  workloads or products whose builds want a whole machine.
- **Every agent, every mode, receives a generated "Where you are running"
  brief** — `.factory-context.md` in the working tree plus the same facts
  prepended to the stage prompt (mode identity, toolchain, working dir,
  branch/base, gate list, boundaries incl. commit discipline). The agent
  never spends turns discovering its environment.

### Stage 3 — scenario gate (the acceptance contract)

The scenarios live OUTSIDE the product repo so the implementer can never tune
code against its own verifier — never relocate them, never share their
contents with the implementer. Work the assertions out from the PRD and user
answers (endpoints, port, persistence behavior) — **never invent endpoints**.
Set `"port": "first"` (runtime) / `"second"` (holdout) — resolved against the
repo's reserved `config.json scenario.ports` pair at verify time; probes use
`$PORT` and never hardcode numbers. **Size the probes to the currently
claimable issue** — gates covering the PRD's final contract on day one burn
attempt caps on repair churn (2026-10-21 lesson): grow them per issue as
laps merge. Draft `runtime.json` (positive path: setup/start/probes) and
`holdout.json`
(adversarial: malformed input → 4xx never 500, unknown resource, escaping,
boundaries) as local files, show both in full, get a yes, then:

```bash
factory-remote scenario <slug> runtime --file runtime.json
factory-remote scenario <slug> holdout --file holdout.json
```

**Full schema — shipped as files in THIS skill's `templates/` directory** (same
folder as this SKILL.md; the laptop install carries them). Don't rediscover it
by probing the validator — kvstore's agent burned ~8 attempts and big tokens
doing exactly that. Read them, adapt to the PRD:

- `templates/scenario.runtime.json` — positive path: `port: "first"`,
  `start` (single foreground command — the harness owns its life and kills it
  authoritatively), `readiness_path`, optional `setup`/`teardown`,
  `probes[{id, description, command, expect, timeout_ms}]`.
- `templates/scenario.holdout.json` — adversarial shape (4xx-never-500,
  escape-inert, boundary probes at `port: "second"`).
- **`$PORT` is injected into every command's env** (resolved from the repo's
  reserved pair) — never hardcode a port number.
- Probe `expect` = the space-separated token contract below; `values must be
  space-free` means `body_contains:` can't hold a literal space (use
  `body_matches:` with `\s` patterns).

Server-side validation fails fast (rejections name the problem) — a bad
scenario can never burn a lap. Probe contract: `status:N` (curl -s -o /dev/null
-w '%{http_code}'), `json:path=value`, `body_contains:`, `body_matches:^reg$`,
`exit:N` (implicit), `max_ms:`; values must be space-free; unknown tokens fail
closed.

**Full schema** (don't rediscover it by probing the validator — kvstore's
agent burned ~8 attempts and big tokens doing exactly that):

```json
{
  "name": "runtime",
  "port": "first",
  "start": "node server.js",
  "readiness_path": "/",
  "setup": "optional shell run before start (e.g. npm install) — unset = skip",
  "teardown": "optional shell run after probes",
  "probes": [
    {
      "id": "health-200",
      "description": "GET /health answers 200 {ok:true}",
      "command": "curl -s http://127.0.0.1:$PORT/health",
      "expect": "status:200 body_contains:ok",
      "timeout_ms": 10000
    }
  ]
}
```

- **`$PORT` is injected into every probe/setup/start/teardown command's env**
  (resolved from the repo's reserved pair) — never hardcode a port number.
- Probe `expect` is the space-separated token string from the probe contract
  above; `values must be space-free` means a `body_contains:` value cannot
  include a literal space (use `body_matches:` with `\s` patterns).
- Every field name matters: `port` / `start` / `readiness_path` / `probes[].id`
  / `probes[].command` / `probes[].expect` — the validator names missing ones
  one at a time. Without `$PORT`, a nod to `127.0.0.1:$PORT` fails closed.
- The harness runs `start` in the foreground and kills it authoritatively
  after probes — write `start` as a single command, never a backgrounded one.

### Stage 4 — backlog gate

Needs the PRD text locally (Stage 0 put it in the repo — `gh api` it down or
use the local checkout):

```bash
factory-remote backlog <slug> --prd-file PRD.md --max 40      # preview (dry run)
```

Show the slice (titles + depends), then `--create` on explicit confirmation
(creates real GitHub issues, wired with `Depends on: #n`, deduped by title).
The first sliced issue is the walking skeleton by contract — verify the
preview starts with one.

**Slicer facts** (learned on kvstore's onboarding, 2026-10-23):
- The slicer runs VPS-side and calls the **plan-stage model** with low
  reasoning — a broken `models.plan` (dotted string, or a thinking suffix
  inside `model`) fails it with the deterministic
  `empty streamed completion (check provider quota/max_tokens)`.
  Fix the config shape first; it is almost never provider quota.
- If it still fails with a valid-looking config, report it to the factory
  owner with the exact config — do NOT keep rotating models/blind-probing
  (six permutations were burned on kvstore before the shape was found).
- `logs --repo <slug>` receipts are FACTORY-GLOBAL rows filtered by repo
  mention — unrelated repos' rows can appear; don't read aliasing into it.

### Stage 5 — first lap (spends real tokens)

Confirm explicitly: "fire the first lap now? It will plan, implement, verify,
review, and merge — unattended." Then:

```bash
factory-remote tick <slug>
```

It returns immediately (queued). Check `factory-remote status --repo <slug>`
once after a few minutes, then report and wait for the user's next ask — no
busy-polling. A full lap is tens of minutes.

### Watching a run live

`factory-remote session <slug> --follow` streams the agent's current pi
session in human-readable form: one `▶ tool: command` line per tool call,
its `⎸ result` beneath, a `⋯ thinking (N chars)` marker per turn (growing N
during a reasoning-heavy turn is normal; *no new lines at all* for many
minutes is a stalled stage), and `✔ FINAL` when the agent finishes a stage.
Add `--think` to see the actual reasoning text, `--issue N` to pin an issue,
run without `--follow` for a one-shot playback of the whole session. The
stream follows the newest session for the repo, streams a `·` heartbeat when
idle (a long silent gap with no heartbeats at all is a dead connection, not a
quiet lap), and auto-reconnects if the transport drops.

## Ops mode (daily driving)

| User says… | Do |
|---|---|
| "is the factory running" | `doctor` + `status` — report repos, chain depth, ledger states |
| "why is #N blocked" | `status` (row + last_error) → `logs --tail 300` for the receipt trail → read the failing gate from `last_error`; propose a fix, then `unblock <slug> <n>` (confirm first). NOTE: blocked rows don't need an unblock to keep going — every tick AUTO-REVIVES blocked issues (fresh attempt budget, bounded: max 3 revive rounds/issue/day, and a stagnation breaker that refuses when the same failure signature repeats on consecutive blocks — that means the wheel is spinning and a human should look). `unblock` is for deliberate clearing (`--prune` closes the PR + branch + worktree) |
| "run a lap now" | confirm (tokens), `tick <slug>` |
| "add repo X to the factory" | run the wizard from Stage 0 |
| "cleanup" | confirm, `cleanup` (prunes blocked worktree caches, kills stale pi) |
| "add this PRD" | Stage 4 on an onboarded repo — `status` first, dedup makes re-runs safe |
| "clinepass is capped / rotating keys" | mention the router: `curl $FACTORY_HOST:8099/pool` is VPS-side; keys live in `/home/factory/state/clinepass.keys` (one per line, live-reloaded). Distinguish the two walls before advising: upstream `402 insufficient_credits` = Cline **Credits** drained (wrong model-id surface — switch to `cline-pass/…` ids); a `429` from the router = the **weekly** pool's reset window (cooling until the parsed reset) — ask the user to add a key or wait. Provider errors now surface as `provider_error` in receipts with the upstream message — read it before proposing unblock. |
| "which provider runs what" | **3-tier chain (since 2026-10-23): River → ClinePass pool → DeepSeek direct.** mdrender's per-stage chains: `river/zai-org/GLM-5.3-Flash` (thinking max — the user's standing choice) primary on every stage; fallbacks `clinepass-rotator/cline-pass/glm-5.3-flash`, then `deepseek/deepseek-flash` (`:max` implement, `:high` review, `:low` plan — DeepSeek supports only low/high/max, NOT medium). River: OpenAI-compatible `https://api.river.ai/v1`, Bearer `rv_…`, prompt-cache honored; DeepSeek: `https://api.deepseek.com/v1`, 1M context, automatic cache discounts. Direct-provider keys live in `~/.pi/agent/models.json` (600, factory-owned) — never echo them; ClinePass pool keys stay in `clinepass.keys` behind the keyrouter. `provider_error` on river (e.g. upstream `terminated`) advances to the next tier automatically; `status`'s stage rows show which provider/model each attempt ran on. |

Reading results honestly: `terminal ≠ good` — a lap showing `merged` in the
ledger is confirmed by the merged PR on GitHub (`gh pr view`); a failed lap's
story is in `status`'s `last_error` plus `logs`. When a provider hit
`provider_error`, note which models were tried before proposing unblock.

## factory-remote — full CLI reference

All verbs run from any directory (creds are read from env or
`~/.config/factory-remote/{url,key}`). Exit 0 = success, 1 = error.

| Command | What it does | Notes |
|---|---|---|
| `health` | `GET /health` — connectivity + version | open endpoint, no key |
| `doctor` | handshake + auth + list onboarded repos | run this when anything "doesn't work" |
| `status [--repo SLUG] [--raw]` | ledger rows, laps, recent stages, chain depth, worktrees | `--raw` dumps the JSON payload |
| `logs [--repo SLUG] [--tail N]` | last N lines of `laps.log` (the receipt spine: every lap/attempt/gate event with timestamps) | 200 lines default |
| `session SLUG [--follow] [--think] [--issue N]` | human-readable view of the agent's pi session | `--follow` streams live (`▶ tool: cmd`, `⎸ result`, `⋯ thinking (N chars)`, `✔ FINAL`); `--think` adds reasoning text; one-shot without `--follow` plays the whole session back |
| `onboard OWNER/NAME` | register a repo: config template, scenario templates, port pair | idempotent (`already` if done) |
| `config SLUG --json '{…}'` | deep-merge a config patch | allowed keys: `models`, `env`, `timeouts`, `merge`, `default_branch`, `attempts`, `skip_labels`, `pi`. Two-writer caveat: last write wins per key — re-echo after a disagreement |
| `scenario SLUG runtime\|holdout --file F` | write + server-side validate a scenario JSON | holdout = adversarial layer; see Stage 3 probe language |
| `backlog SLUG --prd-file F [--max N] [--create]` | slice the PRD into issues | **preview by default**; `--create` spends repo writes; `--max` caps issues (40) |
| `tick SLUG` | fire a lap now | usually unnecessary — the timer ticks every 15 min and chains laps; manual ticks are safe (pidfile no-ops while one is live) |
| `unblock SLUG ISSUE [--prune]` | drop a ledger row so intake can reclaim the issue | usually unnecessary: ticks auto-revive blocked issues (see ops table); `--prune` also closes the PR + deletes the remote branch + removes the worktree (destructive — confirm) |
| `cleanup` | prune blocked worktree caches, kill stale pi workers | safe; requires key |

## Hard rules

- **Never SSH.** Everything through the client + GitHub. If an operation truly
  cannot happen remotely (editing `clinepass.keys`, systemd edits), say so and
  hand the user the exact one-liner instead of reaching for ssh.
- **Never spend the user's tokens without a yes** — `tick`, `backlog --create`,
  `onboard` writes, scenario writes: show the exact payload/file first.
- **Never approve what you can't see**: before telling the user a lap
  succeeded, cross-check GitHub (PR merged, issue closed).
- The API key is a secret: never print it, never commit it, keep it in env or
  the 600-mode config file. Same for ClinePass keys (600-mode keys file on the
  VPS; never echo them into receipts).
- Never edit factory state files by hand — the ledger and receipts are the
  factory's memory; mutations go through the verbs only.
- Scenario files are the verifier: their contents never travel to the
  implementer's context, and they never move into the product repo.
- One repo, one slug. Never touch another repo's rows in unblock (the ledger
  is repo-scoped — `unblock <slug>` takes the slug, respect it).
