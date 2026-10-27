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

**Discover the model lineup FIRST — never assume one.** The factory's
provider catalog is its `~/.pi/agent/models.json` (the same file every lap
routes through — it cannot drift from reality), and the roster is one
command:

```bash
factory-remote models
```

That prints every live provider, each model id, reasoning, context window,
and — the trap column — **which thinking levels each model actually
supports** (`NOT: …` lists levels the model's map sends to null; a config
at such a level rejects at write time with the supported list, because the
lap would otherwise run with no reasoning). Pick the lineup with the user
from THAT output, not from memory or from this skill's examples. The
**config write validates against the same roster**: unknown providers
reject, unsupported thinking levels reject, model ids the factory has never
run warn.

**The canonical config skeletons ship in `templates/` in this skill's
folder** — `config.skeleton.json` and `config.skeleton.instabox.json`
(`env.mode: "instabox"` with the `factory-base-r2` snapshot). They are
SHAPE references (field nesting, per-stage thinking, fallback strings) with
one example lineup — swap the provider/model entries for whatever
`factory-remote models` showed and the user approved. Fill the
provider/model + env fields, then:

```bash
factory-remote config <slug> --json "$(cat .agents/skills/pi-factory/templates/config.skeleton.json | python3 -c 'import json,sys;d=json.load(sys.stdin);d.pop("_readme",None);print(json.dumps(d))')"
```

**For an instabox project, prefer the COMPLETE worked example over the
minimal skeleton**: `templates/config.example.instabox.full.json` is
every allowlisted field of the exact config tic-tac-toe ran its whole
17-issue backlog on (2026-10-24/25, machine-lane throughout) — models per
stage, attempts, timeouts, merge, pi toolsets, `env` with the snapshot.
Pushing it verbatim is known-good; adjust the decision points it marks in
`_readme` (required_checks, thinking levels, stage_minutes). The minimal
skeleton is for when you deliberately want a delta. (This exists because
the magpie onboarding copied tic-tac-toe's config by hand to be sure
nothing was missing — the skill now ships that certainty.) Prerequisite
either way: `foreman bake <slug>` VPS-side BEFORE the first lap.

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
  run in `env.image` — a bare `ubuntu:24.04` has no Node. (The factory
  mounts its own launcher at `/usr/local/bin/pi` in every container: it
  prefers the image's own `node` and falls back to the factory-mounted
  Node 22 — so musl images like `node:22-alpine` work, as do images with
  no Node at all.)

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
- **`instabox`**: each issue's lap gets its own disposable InstaBox microVM
  (`pdf-<slug>-i<issue>`; own kernel — the ssh-gateway login is `user`,
  with passwordless sudo inside factory-baked snapshots). Stages run over
  the ssh gateway (token-as-username, no exec-API wall-clock cap); the
  machine is created lazily at the first implement attempt, kept across
  repair rounds (its clone at `/data/repo` IS the worktree), and deleted
  when the lap books out. The platform auto-suspends idle boxes and the
  factory resumes them automatically — a `suspended` machine in a
  status readout is normal, not an outage. **Prerequisites**:
  `INSTABOX_API_KEY` in the service env, `ssh` on the VPS, and a golden
  snapshot baked VPS-side (`foreman bake <slug>`; free plans boot only
  the `agent-browser` template or snapshots — the bake starts from
  agent-browser and snapshots the result). No credentials live in the
  snapshot: the factory ships its own pi auth/models plus the GitHub
  token into the box over ssh on every stage, so clone AND push are
  authed. The ClinePass router is host-local, so in-box fallback chains
  effectively run river → deepseek. Best for parallel-heavy workloads
  or products whose builds want a whole machine.
- **Every agent, every mode, receives a generated "Where you are running"
  brief** — `.factory-context.md` in the working tree plus the same facts
  prepended to the stage prompt (mode identity, toolchain, working dir,
  branch/base, gate list, boundaries incl. commit discipline). The agent
  never spends turns discovering its environment.

#### The factory-base-r2 snapshot — what's in the box (instabox mode)

**Diff the PRD's runtime needs against this list at Stage 2 and SPEAK UP
before the first lap.** A missing toolchain never surfaces at onboarding —
it surfaces mid-build as blocked laps burning the attempt budget (reproducer,
2026-10-26: PRD needed Python pip+venv, the original factory-base had neither; caught only
by an explicit machine boot, one lap-cycle before laps started hitting it).

Verified contents (a machine booted from the snapshot — r2 last verified
2026-10-26; re-bakes change this, confirm with the user if it is
load-bearing for your project):

| Present | Version / state |
|---|---|
| OS | Debian 13 (trixie) |
| Node + npm | v22.23.3 / 10.9.9 (machines, not the VPS host) |
| Python 3 + pip + venv | 3.13.5 / pip 25.1.1 / venv works (added in r2, 2026-10-26 — the original base lacked pip and venv) |
| git | 2.47.3 |
| pi | `/usr/local/bin/pi` 1.4.0 (installed at bake time) |
| docker | 29.8.2 (present in the snapshot) |
| curl | yes (probes have a node fallback anyway) |
| sudo | passwordless, inside the machine |
| Machine shape | 4 vCPU · 8 GB RAM · ~11 GB free root · 20 GB free `/data` (repo at `/data/repo`) |

**Version expectations count as gaps too** — a PRD that assumes node 24
against the base's node 22 (e.g. `node:sqlite` semantics, `engines` fields)
is a decision point: flag it and let the user pick.

When something is missing, both remedies are VPS-side bakes the OPERATOR
runs (never you — you have no shell on the VPS). Snapshot quota on the app
plan is **5 concurrent** — room for a shared base plus versioned
enrichments, so an existing image never needs to be overridden.

1. **Enrich the shared base** (right for small, additive, standard deps):
   `config <slug> --json '{"env":{"instabox":{"bake":"sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y <pkgs>"}}}'`
   then ask the user to run `foreman bake <slug>` VPS-side. `foreman bake`
   re-saves under the SAME name (deleting the old same-named snapshot
   first) — for a shared-base re-bake, **pause the instabox repos first**
   (`factory-remote pause <slug>`): new machine boots fail in the
   delete→re-save window. The windowless alternative, preferred while the
   wheel is busy: save under a NEW versioned name (`factory-base-r3`, …)
   and repoint configs — and KEEP the old name alive as an alias until
   tick turnover, because **a long-running tick holds configs in memory
   for hours and keeps resolving the OLD snapshot name** (kintsugi,
   2026-10-26: laps burned attempt budgets for 20 minutes resolving a
   deleted name; a same-named alias healed the live tick instantly). Ticks
   reload configs between laps, but the lap already in flight holds what
   it loaded.
2. **Fork a repo-specific base** (heavy/exotic deps): first
   `config <slug> --json '{"env":{"instabox":{"snapshot":"<slug>-base"}}}'`,
   then the bake script + `foreman bake <slug>` — produces `<slug>-base`
   (a fresh name, no conflict) and leaves the shared base untouched.

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
-w '%{http_code}'), `status_in:200,404` (one-of status set — "any of these,
never 5xx"), `json:path=value`, `body_contains:`, `body_matches:^reg$`,
`exit:N` (implicit), `max_ms:`; values must be space-free; unknown tokens fail
closed. Upload runs the same lint as `--lint`: it REJECTS `'$PORT'` in single
quotes (never expands — the probe dies as 000) and bare `(`/`)` in URLs (shell
syntax error — percent-encode as `%28`/`%29`).

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
      "description": "GET /health answers 200",
      "command": "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/health",
      "expect": "status:200",
      "timeout_ms": 10000
    },
    {
      "id": "health-body",
      "description": "GET /health body says ok:true",
      "command": "curl -s http://127.0.0.1:$PORT/health",
      "expect": "json:ok=true",
      "timeout_ms": 10000
    }
  ]
}
```

**Probe-token spec — the matcher, exactly as the runner implements it** (derive
nothing; this IS the contract):

- The matcher sees the probe command's **stdout only** — stderr never reaches
  it; the exit code is a separate token. An empty `expect` means `exit:0`,
  and an implicit `exit:0` is added whenever no explicit `exit:` token
  is present.
- `status:N` — the **last non-empty stdout line must equal `N` exactly**. The
  runner never makes the HTTP call itself: the command must emit the code
  (`curl -s -o /dev/null -w '%{http_code}'`). A plain `curl -s URL` puts the
  BODY on stdout and `status:200` fails as `got "{…}", want "200"` — this
  exact trap cost a blocked lap on kvstore.
- `status_in:N,N,…` — the last non-empty stdout line must equal **one of** the
  comma-separated codes ("200 or 404, never 5xx"). Same emit requirement as
  `status:`. This is the token for optional-resource probes an exact `status:`
  pin couldn't express (magpie's traversal probe had to be weakened before
  this existed).
- The probe command runs through a shell: **never single-quote `$PORT`** —
  `'$PORT'` stays a literal string, the curl hits a bogus address, and every
  attempt dies as 000/exit 6 while the app is up. Double quotes or no quotes
  expand it. Parens in URLs must be percent-encoded (`%28`/`%29`) — a bare `(`
  is a shell syntax error before the command even runs. Both are REJECTED at
  upload and by `--lint` now (magpie, 2026-10-25: lint passed the file that
  burned the laps).
- `json:path=value` — ALL of stdout must be one valid JSON document; the path
  walks objects/arrays with dot segments and optional `[N]` indices
  (`data.items[0].id`); the value parses leniently (JSON literal or raw
  string).
- `body_contains:VAL` — substring test on stdout; VAL cannot contain a
  space (tokens split on whitespace — switch to `body_matches` for those).
- `body_matches:REGEX` — a **JavaScript RegExp** (not ERE, not BRE): `\s`,
  `\d`, `[\s\S]`, lazy quantifiers all work; it is **unanchored by default** —
  write your own `^…$`; an invalid regex fails the probe closed.
- `exit:N` — the command's exit code. `max_ms:N` — the wall-clock budget the
  runner enforces around the command (the token itself always passes).
- Unknown tokens fail closed at run time; `--lint` catches them at authoring
  time instead.

**Lint before every write** — the dry-run verb validates the full shape AND
lints the probes, with nothing written:

```bash
factory-remote scenario <slug> runtime --file runtime.json --lint
```

Deterministic failures (unknown tokens from space-split values, uncompilable
regexes, single-quoted `'$PORT'`, bare parens in URLs) are rejected — by
`--lint` AND by the write itself (the upload path runs the same checks);
likely-trap warnings (a `status:`/`status_in:` probe whose command never emits
the code, hardcoded port numbers instead of `$PORT`) are printed.
`--dump` prints the stored scenario back — the read side of a formerly
write-only verb (todos-api postmortem: these two would have saved every
blocked lap).

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
- **`start` should be a STANDARD server when at all possible** (`node
  server.js`, `uvicorn …`, `python3 -m http.server $PORT`, a compose service).
  A bespoke hand-written supervisor is the known source of **ghost servers**:
  it can bind the socket, truthfully heartbeat "alive", and never accept a
  connection (bi-ai-ui #1, 2026-10-26 — a missing `serve_forever()` cost a
  full day disguised as tunnel infra). If the PRD genuinely needs a custom
  orchestrator as `start`, **always `--test` it before the first lap** — a
  ghost server is otherwise indistinguishable from a dead one until the
  kernel evidence shows up in a failed verdict.

**`--test` — the verifier's own test bench (run it before and during laps):**

```bash
factory-remote scenario <slug> runtime --test                 # stored scenario vs current main
factory-remote scenario <slug> runtime --test --branch factory/issue-7   # vs an open lap's branch
```

Executes the STORED scenario against a branch WITHOUT spending a lap: same
runners the verify gate uses, per-probe pass/fail printed, exit 1 on failure.
Host/compose modes test a temp worktree of the branch; instabox boots a
throwaway `pdf-<slug>-scen-test` machine from the same snapshot, clones the
branch, runs setup+start+probes, and destroys the machine (the janitor reaps
it if the runner dies). Takes minutes (machine boot + setup) — that is still
~10× cheaper than validating a scenario fix by burning a lap. The bi-ai-ui
run (2026-10-25): three hours of blocked cycles, every single one a bug in
the acceptance scenarios, each fix validated only by a full lap — `--lint`
catches token/regex mistakes, `--test` catches semantic ones (probe asserts
what the delivered product doesn't do). Workflow when a lap blocks on a
scenario gate: `--dump` the scenario, fix the probe, `--lint`, `--test` vs
main (or the lap's branch), then write — the write bumps the inputs-epoch
and the blocked issue revives fresh on the next tick.

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

**The preview's dependency graph is validated** (magpie, 2026-10-25: previews
showed `8 → 8` and `13 → 13` self-deps, caught only by hand): `--create`
REFUSES self-references, forward references (deps must point at EARLIER
issues), and out-of-range indices, naming each offending issue; the preview
carries the same list as `graph_problems`. LLM slicing is non-deterministic —
a preview is a draft, not a contract, so audit it: if `--create` refuses,
re-slice (a re-roll usually produces a clean graph) or sharpen the PRD's
build order. Steps that need the operator (secrets, deploys, external
accounts) must NOT become issues — the lap cannot do them; keep them in the
PRD as an operator checklist instead (magpie's seed-insert/deploy issues had
to be re-cut by hand).

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
quiet lap), and auto-reconnects if the transport drops. Machine-mode
(instabox) implement/review sessions stream through the same viewer — a lap
running in a box is as watchable as a host-side one.

## Ops mode (daily driving)

| User says… | Do |
|---|---|
| "is the factory running" | `doctor` + `status` — report repos, chain depth, ledger states |
| "why is #N blocked" | `status` (row + last_error) → `logs --repo <slug> --tail 300` for the receipt trail → read the failing gate from `last_error`; propose a fix, then `unblock <slug> <n>` (confirm first). NOTE: blocked rows don't need an unblock to keep going — every tick AUTO-REVIVES blocked issues (fresh attempt budget, bounded: max 3 revive rounds/issue/day, and a stagnation breaker that refuses when the same failure signature repeats on consecutive blocks — that means the wheel is spinning and a human should look). **Fixing the INPUTS un-blocks for free**: any `scenario` or `config` write bumps an inputs-epoch — every blocked issue of that repo gets a fresh revive budget + clean stagnation history on the next tick, because the world its blocker was measured against no longer exists (tic-tac-toe #11: scenario fixed after the cap was spent; the cap then refused a world that had already changed). `unblock` is for deliberate clearing (`--prune` closes the PR + branch + worktree); it now REFUSES an in_progress row unless `--force`, because dropping a live lap's row mid-flight orphans it — a genuinely crashed lap reconciles on the next tick by itself |
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

### When the factory gives up, it fails loudly (the stuck summary)

The moment auto-revive stops on an issue — same failure signature on
consecutive rounds (the wheel is spinning) or the daily cap — the factory
posts a **FAILURE SUMMARY comment on the GitHub issue itself** (once per
issue per day): the distinct failure signatures, the latest verdict **with
its full evidence** (probe outputs, in-box socket state), forensics pointers
(`status --repo`, `session --issue`, `logs --repo`, `scenario --test`), and
classification hints that separate INFRASTRUCTURE markers from
verifier-owned (`setup`/`readiness`/scenario gates — the implementer cannot
see or fix those) from genuine app failures. A stall discovered from
silence is how a 12-hour debugging saga starts; this comment is the factory
handing you the case file the moment it stops. When you see one: read the
verdict, follow the hint that matches, fix, and let the epoch bump
(scenario/config write) or `unblock` resume it.

### Reading shared surfaces (the factory is multi-tenant)

- **`claimable chain` in status**: N = N issues claimable right now (GitHub
  open, unlabeled, deps met, not ledger-claimed); `none (all
  delivered/blocked)` = nothing claimable; `unknown (GitHub probe >5s)` =
  the live-GitHub probe outran its 5s cap — retry, don't interpret.
- **`chained after #N`** in `queued:` receipts: the same tick, after #N
  merged, immediately re-ran intake and started the next claimable issue
  (strictly one lap at a time per repo — that ordering keeps main
  conflict-free; max 6 laps per repo per tick, the rest resume next tick).
- **Log lines carry `[slug]` tags** — `logs --repo <slug>` shows exactly
  that repo's laps with no neighbor flood. A per-repo tick never waits on a
  neighbor's lock (per-repo pidfiles); the only contention left is the
  15-min timer's own full tick, which skips any repo a manual tick is
  already working.
- **`in flight: N`** = ledger rows in in_progress. Machine-mode implement
  stages emit no receipt lines until they finish — silence there is normal
  (watch `session <slug> --follow`), NOT evidence of a hang. Before ever
  pruning a "silent" lap, cross-check GitHub for a just-opened PR — receipts
  lag the work.

## Failure signatures (2026-10-24 playbook — match the receipt, don't re-derive)

Every signature below was paid for on mdrender/kvstore/todos-api/tic-tac-toe.
Read the `last_error` / receipt, find its row, act.

| Receipt says | What it means | What to do |
|---|---|---|
| `pi exited 127 … node: not found` from a compose service | libc mismatch: the product's service image is musl (alpine) while the mounted Node is glibc. The launcher self-adapts (image's node first), so seeing this means the VPS-side launcher `~/.pi/agent/bin/pi` was altered | report it; restore the libc-agnostic launcher (pi-factory-setup Phase 4f) |
| bare `pi exited 127:` with nothing after the colon | spawn ENOENT — the binary in the argv never existed. Receipts name the actual path since e6b6970; pre-fix receipts were empty | read the named path; if the error is still empty, the daemon predates e6b6970 |
| `machine … never reached running (state: suspended)` | platform auto-suspend of an idle box; the factory resumes it on the next attempt | nothing — self-healing. Flag only if it repeats every single lap |
| `machine gate failed (git push of factory/issue-N failed): non-fast-forward` | FOSSIL BRANCH: the lap was chained after an unmerged sibling whose branch never merged — after the sibling squash-merged elsewhere, the remote `factory/issue-N` diverged and every fresh push was rejected (tic-tac-toe #11, 2026-10-24; three identical failures burned the whole attempt budget) | FIXED at the source: the gate force-pushes `factory/issue-*` (factory-owned branches — the machine clone is the worktree of record), so this signature should not recur. If you ever see it again, `unblock <slug> <n> --prune` kills the fossil branch |
| `machine gate failed (git push …) … could not read from remote` (credentials, not non-FF) | GitHub credentials didn't reach the box (fixed 2026-10-24: the lane resolves `GH_TOKEN`→`GITHUB_TOKEN` and the bootstrap sources the machine env before cloning) | should not recur; if it does, check `factoryd.env` carries the token |
| `channel 0: open failed: connect failed: machine unreachable` (exit 255) during a machine stage or scenario setup | a transient ssh/gateway hiccup — one blip self-heals on the repair ladder's next attempt. Note: machine-mode scenarios no longer use ssh -L forwards AT ALL (readiness and probes run in the box over the exec channel — the bi-ai-ui saga removed that entire failure family) | nothing on a single occurrence; if it repeats every attempt, the machine or snapshot is sick — check the plane via status/cleanup |
| readiness fails with `In-box socket state: LISTEN <Recv-Q> <backlog> …` and a **full Recv-Q** (Recv-Q ≈ backlog limit) | **GHOST SERVER — the start command binds the socket but never accepts a connection.** Classic source: a hand-written supervisor in the scenario's `start` that forgets `serve_forever()` — its heartbeat can truthfully log "alive" while no request is ever accepted (bi-ai-ui #1, 2026-10-26: `LISTEN 6 5` — backlog 5, six pending — for hours; the product behind it was healthy the whole time). The verdict text carries the kernel evidence verbatim | the `start` command is SCENARIO-OWNED — the implementer cannot fix it. Fix the script (add the serve/accept loop), `--lint`, `--test` (zero tokens), write — the epoch bump revives the issue next tick. When authoring any bespoke `start`, ALWAYS `--test` before the first lap |
| `review verdict unparseable after 5 re-asks — failing closed` (REJECT; the reviewer's raw output is embedded in findings, ~1500 chars) | the reviewer's generation dies mid-sentence — payload-correlated truncation on flash-tier models, probabilistic per lap (tic-tac-toe #11/#15/#16, 2026-10-25). It is NOT a product judgement: the verify stage's gates already passed | read the stage row in `status` — tok in/out is recorded even for failed stages now, telling river-death (tokens stop) from output-cap (tokens at a ceiling); inspect the PR + `session <slug> --issue N`. If the work is genuinely good, take the human-review path: verify on GitHub yourself, squash-merge the PR, `unblock <slug> <n> --prune` to tidy (ledger consequence: the row is dropped — GitHub becomes the only record of the merge). A plain re-lap often recovers on its own; only escalate if the same lap fails this way twice |
| `[runtime] server never became ready within 120s` | scenario `start` command / `readiness_path` mismatch, or the implementer's server exits or binds wrong — the repair loop usually chews through real bugs | watch one repair round before touching the scenario or `timeouts.readiness_seconds` |
| `seed-repaired` in `logs` | the mounted Node 22 vanished host-side AGAIN (twice on 2026-10-23, actor never attributed; the sweep re-copies it and receipts the event) | note the timestamp — these mark recurrence windows |
| river `provider_error` bursts (upstream `terminated` etc.) | upstream flakiness; the 3-tier chain advances on its own | watch only; worry when fallbacks also fail |
| `402 insufficient_credits` (clinepass) or router `429` | wrong billing surface vs weekly pool — see the clinepass row above | fix model ids / add a key |

Operator discipline from both postmortems: after a VPS-side infra failure is
fixed, do NOT immediately re-drive `unblock`+`tick` — wait for a positive
canary (the fixed path proven green once) first; kvstore burned two full
attempt cycles against a still-broken mount that way.

### InstaBox machine lifecycle (and why machines linger)

One machine per issue's LAP — named `pdf-<slug>-i<issue>-g<lapId>`, unique
per lap generation: repair rounds within a lap share one machine AND one
name (its `/data/repo` clone IS the worktree — destroying it mid-lap
destroys the work), but every new lap — including auto-revive rounds — gets
a FRESH name. This is load-bearing: platform deletes are eventually
consistent (phantom records were observed ~2h after successful deletes),
and recreating a machine under a reused name raced the zombie — token
routing then intermittently landed on the dead predecessor, serving the
previous attempt's catch-all SPA or black-holing the readiness poll
(bi-ai-ui 2026-10-26: mapping roulette, "foreign" content was always the
issue's own zombie instance, never another repo — ports are reserved
per-repo and never overlap). A unique name cannot collide with a
not-yet-dead predecessor, so a revived lap can never inherit a zombie's
routes or its stale servers. Machines are deleted the moment the lap books
out, and the delete is CONFIRMED — a delete that stays invisible
platform-side receipts "delete not yet visible (platform lag)" and the
janitor reaps the leftover. Idle boxes auto-suspend platform-side — they
still count against quota — and the factory resumes them on the next
attempt. Strays cannot pile up: every tick's tail and `cleanup` both reap
any `pdf-*` machine (any generation) whose issue has no in_progress ledger
row, and neither ever touches a live lap's machine. If a machine looks
"running" long after its lap finished, suspect the platform's stale listing
first — the janitor reaps it next tick regardless. One exception family:
`pdf-<slug>-scen-test` machines (from `scenario --test`) belong to no lap —
their runner protects them via a pid marker while a test is live, and the
janitor reaps any whose runner is gone. When machine-mode verify fails
readiness, the runner classifies honestly: a dead tunnel or a tunnel whose
in-box loopback answers while the host poll starved reports itself as
`INFRASTRUCTURE` (retry the lap, don't repair the product); only
host-poll-AND-loopback both failing is an app failure.

## factory-remote — full CLI reference

All verbs run from any directory (creds are read from env or
`~/.config/factory-remote/{url,key}`). Exit 0 = success, 1 = error.

| Command | What it does | Notes |
|---|---|---|
| `health` | `GET /health` — connectivity + version | open endpoint, no key |
| `doctor` | handshake + auth + list onboarded repos | run this when anything "doesn't work" |
| `models` | **the LIVE provider roster** — every provider, model id, reasoning, context window, supported/unsupported thinking levels (keys never leave the VPS) | model discovery: run this at Stage 2 and pick the lineup with the user; config writes validate against this same roster (unknown providers and unsupported thinking levels reject, never-run model ids warn) |
| `status [--repo SLUG] [--raw]` | ledger rows, laps, recent stages, chain depth, worktrees | `--repo` scopes EVERYTHING to that repo (ledger rows included) — unknown slug answers empty; `--raw` dumps the JSON payload |
| `logs [--repo SLUG] [--tail N]` | last N lines of `laps.log` (the receipt spine: every lap/attempt/gate event with timestamps) | lines carry `[slug]` tags; `--repo` filters on them — no multi-tenant flood; 200 lines default |
| `session SLUG [--follow] [--think] [--issue N]` | human-readable view of the agent's pi session | `--follow` streams live (`▶ tool: cmd`, `⎸ result`, `⋯ thinking (N chars)`, `✔ FINAL`); `--think` adds reasoning text; one-shot without `--follow` plays the whole session back |
| `onboard OWNER/NAME` | register a repo: config template, scenario templates, port pair | idempotent (`already` if done) |
| `config SLUG [--json '{…}']` | deep-merge a config patch; **omit `--json` to READ the complete effective config — nothing filtered, all env/pi/timeouts/merge keys** (a filtered readback once hid `env.instabox.*` and thinking, and diagnosing one typo meant cat-ing another repo's config on the VPS — magpie postmortem incidents 5/7). A successful write bumps the inputs-epoch (blocked issues revive fresh, like scenario writes) | allowed keys: `models`, `env`, `timeouts`, `merge`, `default_branch`, `attempts`, `skip_labels`, `pi`. Loud validation rejects dotted-string models, thinking suffixes inside `model`, malformed fallbacks. Two-writer caveat: last write wins per key — re-echo after a disagreement |
| `scenario SLUG runtime\|holdout [--file F \| --lint \| --dump \| --test]` | write + server-side validate a scenario JSON; **`--lint` = dry-run validation + probe linting, nothing written; `--dump` = print the stored scenario; `--test` = EXECUTE the stored scenario against a branch (default main) without spending a lap — per-probe results, exit 1 on failure** (`--branch B` to target an open lap's branch) | holdout = adversarial layer; ALWAYS `--lint` then `--test` before relying on a scenario; a write bumps the inputs-epoch: every blocked issue of the repo gets a fresh revive budget on the next tick |
| `backlog SLUG --prd-file F [--max N] [--create]` | slice the PRD into issues | **preview by default** (graph problems reported as `graph_problems`); `--create` REFUSES a self/forward/out-of-range dependency graph, naming each offender; `--create` spends repo writes; `--max` caps issues (40) |
| `tick SLUG` | fire a lap now | usually unnecessary — the timer ticks every 15 min and chains laps; manual ticks are safe (pidfile no-ops while one is live) |
| `pause SLUG` / `unpause SLUG` | pull a repo off the tick wheel / put it back | a paused repo is skipped whole on ticks (no claims, no revives — receipts say `skipping <slug>: paused`), and an already-chaining task stops before its NEXT lap (`paused mid-chain` receipt) — the lap in flight always finishes; use it when one repo's churn shouldn't eat the wheel while you work another (magpie starved behind tic-tac-toe's crash-loop with no lever) |
| `unblock SLUG ISSUE [--prune] [--force]` | drop a ledger row so intake can reclaim the issue | usually unnecessary: ticks auto-revive blocked issues (see ops table); REFUSES an in_progress row (a lap may be live — a crashed one reconciles next tick) unless `--force`, which you fire only after verifying the session tail is quiet and no machine is working; `--prune` also closes the PR + deletes the remote branch + removes the worktree (destructive — confirm) |
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
