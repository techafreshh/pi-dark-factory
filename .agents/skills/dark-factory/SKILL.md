---
name: dark-factory
description: >-
  Operate the pi-dark-factory (unattended build loop on the VPS) remotely —
  onboard a new project end-to-end (PRD check → config → scenarios → backlog
  slice → first lap), check status/logs, fire ticks, unblock or clean up. Use
  whenever the user mentions the factory, onboarding a project to it, slicing
  a PRD into issues, firing a lap, factory status/receipts, blocked issues, key
  rotation, or says things like "add this repo to the factory", "is the factory
  running", "why is issue #N blocked" — even casually ("get X built by the factory").
  Talks to the factory over HTTPS via the dark-factory CLI (npm: @techafresh/dark-factory);
  server-side operations are named for the operator, never improvised.
---

# dark-factory (remote operator)

> Source of truth lives in the factory repo (`.agents/skills/dark-factory/`);
> installed copies are re-synced from it. Deep dives: the repo's `docs/`.

The factory is an unattended loop on the VPS: a systemd **timer fires a tick
every 15 minutes**, and each tick **chains laps down the dependency chain** —
after a merge or block it re-intakes and runs the next claimable issue
(bounded at 6 laps/repo/tick), auto-revives blocked issues (fresh attempt
budget; fuses: max 3 revive rounds/issue/day, plus a stagnation breaker when
the identical failure signature repeats), and waits out one 10-min in-tick
cooldown to retry its own recovery. Every lap takes the oldest claimable
GitHub issue through intake → plan → implement → verify (CI + black-box
runtime/holdout scenarios) → review → squash-merge → close. The **claim
ledger** is the source of truth — a delivered issue is never re-claimed.
Manual `tick` is always safe: the pidfile no-ops it while the timer's tick
is live.

**This skill's entire factory interface is the remote client + GitHub.** For
code-level truth (diffs, checks, files, issue bodies) query GitHub directly
with a local `gh` — the PR is the truth; the factory's claim about it is a
claim. Operations that only exist server-side (systemd edits, VPS files,
`foreman bake`, a small set of infra fixes) are NEVER improvised here: name
the exact command and hand it to the operator — the how-to lives in the
repo's `docs/operations.md`.

## Hard rules (they gate everything below)

- **Never spend the user's tokens without a yes** — `tick`, `backlog --create`,
  `onboard`, scenario writes: show the exact payload/file first.
- **Never approve what you can't see**: before reporting a lap succeeded,
  cross-check GitHub (PR merged, issue closed).
- **Secrets are never echoed** — the API key lives in env or the 600-mode
  config file; provider keys live server-side. Print names, never values.
- **Never edit factory state files by hand** — the ledger and receipts are
  the factory's memory; mutations go through the verbs only.
- **Scenario files are the verifier**: their contents never travel to the
  implementer's context and never move into the product repo.
- **One repo, one slug.** `unblock <slug>` takes the slug — never touch
  another repo's rows.
- A `git pull` on the server is not enough for tick-behavior changes: the
  daemon runs its start-time code until restarted, and a restart kills
  in-flight laps. This discipline is the operator's; when tick behavior
  changed, TELL the operator that a restart at idle is required
  (details: repo `docs/operations.md`).

## Connect

One-time, from the machine you drive from (any OS with Node ≥ 18; zero deps):

```bash
npx @techafresh/dark-factory setup https://pi-factory.techa.pro <KEY>
dark-factory doctor
```

`<KEY>` = the `FACTORY_API_KEY` value from `/home/factory/factoryd.env` on the
server (the operator reads it there once; never echo it into chat). Config
lands in `~/.dark-factory/config.json`; `DARK_FACTORY_URL` /
`DARK_FACTORY_API_KEY` env vars override it; inline `--url`/`--key` override
everything. `dark-factory where` shows what's active (key masked), and every
verb takes `dark-factory <verb> --help`.

If `doctor` cannot reach the factory at all (connection refused/timeout —
not a 401), the factory is not provisioned: the operator clones this repo on
the server and runs the in-repo `dark-factory-setup` skill there. Never
improvise around a missing factory.

## Onboarding a new project (the wizard — gate every write)

Work the stages in order; **show what will be written and get an explicit yes
before every mutating step**. Never skip a failed preflight: report and stop.

### Stage 0 — precheck (local `gh`, read-only)

1. `gh repo view <owner>/<name> --json name,owner,defaultBranchRef,primaryLanguage`
   — repo exists; capture the default branch (never assume `main`).
2. **PRD check**: search the tree for a product document
   (`gh api repos/<o>/<r>/git/trees/HEAD?recursive=1`; `.agents/PRDs/PRD.md`
   is the convention). **If none exists: stop and offer to draft one** from
   the conversation — show the draft, get approval, commit it. No PRD, no backlog.
3. Backlog sanity: `gh issue list` — empty of work, or already sliced?
   (Slices are title-deduped: re-running is safe but pointless.)
4. `gh` auth has issue-write scope on this repo.

### Stage 1 — remote preflight

`doctor` (alive + auth + bases), then `status` — the repo must NOT already be
onboarded; if it is, skip to ops mode.

### Stage 2 — config gate

`onboard <owner>/<name>` — the API discovers the branch, reserves two
scenario ports, writes `config.json` + scenario templates server-side; the
slug it echoes is the repo's identity in every other verb. Then
surface the decisions the user must confirm.

**Config writes are LOUDLY validated, and the shape rules came from real
failures — a wrong shape once cost ~6 attempts:**

- `models` entries are OBJECTS: `{ "provider", "model",
  "thinking": "low|medium|high|max" }` plus optional
  `"fallback": ["provider/model:thinking", …]` — fallback arrays are the
  ONLY place the `provider/model:thinking` string form is valid.
- **Never** a dotted string as a stage value, **never** a thinking suffix
  inside `model` — both reject at write time now, and the errors name the rule.
- The POST response echoes the merged config — **always re-read the echo**
  and verify every `models.*` renders as an object with a `provider`.
- A `{}` patch silently writes defaults; don't probe with it. Config writes
  deep-merge — two writers can interleave, LAST write wins per key; after any
  disagreement, re-echo once.

**Discover the model lineup FIRST — never assume one.** `dark-factory models`
prints the factory's LIVE provider roster (the same file every lap routes
through — it cannot drift): every provider, model id, reasoning flag, context
window, and which thinking levels each model actually supports (`NOT: …`).
Pick the lineup with the user from THAT output. Config writes validate against
the same roster: unknown providers reject, unsupported thinking levels reject
(with the supported list), never-run model ids warn.

**Shape references ship in this skill's `templates/`**: `config.skeleton.json`
(minimal) and `config.example.instabox.full.json` — every allowlisted field of
a config that ran a whole 17-issue backlog machine-lane; pushing it verbatim is
known-good, adjust its `_readme` decision markers. Fill provider/model + env
from what `models` showed, then:

```bash
dark-factory config <slug> --json "$(cat .agents/skills/dark-factory/templates/config.skeleton.json)"
```

Decision points to walk with the user:

- **models**: disciplined model for implement/review, cheaper for plan;
  fallback chains as `provider/model[:thinking]` (provider errors fail over;
  timeouts don't — a hung stream is an upstream problem, not the model's).
  Billing surfaces are distinct: a model id's first segment picks the billing
  program (a pooled/routed provider pings a different budget than bare vendor
  ids) — if receipts show `402 insufficient_credits` while a weekly cap looks
  untouched, the ids are on the wrong surface; ask the operator which pool the
  provider fronts.
- **required_checks**: `["*"]` default (autodetect: every check the PR reports
  must pass; a repo with no workflows stays ungated). The factory bootstraps
  CI itself — a PRD line "ship a CI workflow…" makes lap 1 deliver the workflow
  and the gate engages from the next lap.
- **env.mode** (ask at Stage 2): `host` (default; plain processes, no
  isolation), `compose` (stages run root inside the product's own Docker
  environment; offer when the repo has a `docker-compose.yml` or the PRD
  ships one — fallback `env.image` must carry the toolchain, e.g. full
  `node:22`, until lap 1 lands the compose file), `instabox` (disposable
  Firecracker machines; see below).
- **instabox prerequisite**: the golden snapshot is baked SERVER-SIDE before
  the first lap; onboarding reminds you when.

**Instabox snapshot essentials** — diff the PRD's runtime needs against what
`doctor` prints for the base (`contents: …`) and SPEAK UP before the first
lap: a missing toolchain never surfaces at onboarding, it surfaces as blocked
laps burning the attempt budget. Snapshot quota is 5 concurrent — room for a
shared base plus versioned enrichments, so nothing needs overriding. Two
remedies, both server-side bakes the operator runs (you write the config,
never the snapshot):

- *Small additive deps*: deep-merge an `env.instabox.bake` script into the
  repo config, then the operator bakes. For a re-bake of the SHARED base,
  the operator pauses instabox repos first (new boots fail in the
  delete→re-save window).
- *Heavy/exotic deps*: point the repo at its own snapshot name
  (`{"env":{"instabox":{"snapshot":"<slug>-base"}}}`) and bake that — a fresh
  name leaves the shared base untouched.
- Preferred fleet upgrade path: bake under a NEW versioned name and flip the
  `shared-base` token VPS-side; keep the old name alive as an alias until
  tick turnover, because a long-running tick holds its loaded config (and
  snapshot name) for the whole lap.

A `suspended` machine in status is the platform auto-suspending an idle box —
the factory resumes it on the next attempt; normal, not an outage.

### Stage 3 — scenario gate (the acceptance contract)

Scenarios live OUTSIDE the product repo so the implementer can never tune code
against its own verifier — never relocate them, never share contents with the
implementer. Derive assertions from the PRD and user answers — **never invent
endpoints**. `"port": "first"` (runtime) / `"second"` (holdout), resolved
against the repo's reserved pair; probes use `$PORT`, never numbers. **Size
probes to the currently claimable issue** — day-one probes covering the PRD's
final contract burn attempt caps on repair churn; grow them per issue as laps
merge.

Walk the user through drafting `runtime.json` (positive path) and
`holdout.json` (adversarial: malformed input → 4xx never 500, unknown
resource, boundaries) as local files, show both in full, get a yes, then
**lint → test → write**:

```bash
dark-factory scenario <slug> runtime --file runtime.json --lint   # validate, nothing written
dark-factory scenario <slug> runtime --test                        # execute vs main, zero tokens
dark-factory scenario <slug> runtime --file runtime.json           # write (bumps inputs-epoch)
dark-factory scenario <slug> runtime --test --branch factory/issue-7   # vs an open lap's branch
```

Full schemas ship in this skill's `templates/` (`scenario.runtime.json`,
`scenario.holdout.json`) — read and adapt; don't rediscover the shape by
probing the validator (that burned ~8 attempts once). The contract in short:

- Schema: `port` (first|second), `start` (ONE foreground command — the harness
  owns its life and kills it authoritatively), `readiness_path`, optional
  `setup`/`teardown`, `probes[{id, description, command, expect, timeout_ms}]`.
- `$PORT` is injected into every command's env. **Never single-quote it**
  (`'$PORT'` stays literal → probes die as 000) and percent-encode parens in
  URLs — both are REJECTED at lint/write.
- Probe tokens (space-separated): `status:N` (last stdout line equals N — the
  command must emit the code, e.g. `curl -s -o /dev/null -w '%{http_code}'`;
  a bare `curl -s URL` puts the BODY on stdout and fails), `status_in:200,404`
  (one-of; for optional resources), `json:path=value` (all of stdout is one
  JSON doc; dot-walk + `[N]`), `body_contains:VAL` (VAL space-free), 
  `body_matches:REGEX` (JS RegExp, unanchored — write your own `^…$`),
  `exit:N` (implicit 0), `max_ms:N`. Unknown tokens fail closed.
- `--lint` catches token/regex/quoting mistakes; **`--test` catches semantic
  ones** (the probe asserts something the product doesn't do) by executing the
  stored scenario vs a branch — minutes, ~10× cheaper than validating a
  scenario fix by burning a lap. Three hours of blocked laps were once all
  scenario bugs, each tested only by full laps.
- `start` should be a STANDARD server (`node server.js`, `uvicorn …`). A
  hand-written supervisor is the known source of **ghost servers** — binds the
  socket, "alive", never accepts. If the PRD truly needs one: `--test` before
  the first lap, always.
- A write (and a config write) bumps the inputs-epoch — every blocked issue of
  the repo revives fresh on the next tick.

### Stage 4 — backlog gate

```bash
dark-factory backlog <slug> --prd-file PRD.md --max 40      # preview (dry run)
dark-factory backlog <slug> --prd-file PRD.md --create      # on explicit yes
```

Show the slice (titles + depends) before `--create` (real GitHub issues wired
with `Depends on: #n`). The first sliced issue is the walking skeleton — the
preview must start with one. The graph is VALIDATED: `--create` refuses
self/forward/out-of-range references naming each offender
(`graph_problems` in previews) — LLM slicing is non-deterministic, so audit
the preview; a refusal usually means re-slice. Steps needing the operator
(secrets, deploys, external accounts) must NOT become issues — keep them in
the PRD as an operator checklist.

Slicer facts: it runs server-side on the **plan-stage model** with low
reasoning — a broken `models.plan` shape fails it with the deterministic
`empty streamed completion (check provider quota/max_tokens)`; fix the config
shape first, it is almost never quota. Still failing with a valid config?
Report to the operator with the exact config — don't blind-probe model
permutations (six were burned on one onboarding).

### Stage 5 — first lap (spends real tokens)

Confirm: "fire the first lap now? plan → implement → verify → review → merge,
unattended." Then `dark-factory tick <slug>` — returns immediately (queued).
Check `status --repo <slug>` once after a few minutes, report, wait — no
busy-polling (a full lap is tens of minutes).

Watching live: `dark-factory session <slug> --follow` streams the agent's pi
session (`▶ tool: cmd` / `⎸ result`, `⋯ thinking (N chars)` per turn — growing
N is normal, many minutes of NO lines is a stalled stage — and `✔ FINAL` per
stage). Add `--think` for reasoning text, `--issue N` to pin an issue; one-shot
playback without `--follow`. The stream updates to the newest session for the
repo and auto-reconnects on transport drops.

## Ops mode (daily driving)

| User says… | Do |
|---|---|
| "is the factory running" | `doctor` + `status` — repos, chain depth, ledger states |
| "why is #N blocked" | `status` (row + `last_error`) → `logs --repo <slug> --tail 300` → match [failure signatures](#failure-signatures) → propose the fix. Blocked rows auto-revive each tick (fresh budget, fused) — usually the FIX unblocks for free: any `scenario` or `config` write bumps the inputs-epoch, giving every blocked issue of that repo fresh revive budget + clean stagnation history. `unblock <slug> <n>` is for deliberate clearing (`--prune` closes PR + branch + worktree; it refuses an in_progress row without `--force` because a live lap would be orphaned — a crashed lap reconciles on the next tick by itself) |
| "why only [discovery] issues" | The discovery policy working as set: majors drain-first; **minor**-labeled discoveries defer until the PRD backlog drains; a discovery lap NEVER auto-files (recursion gate — findings stay on the PR comment + sidecar). If the queue looks starved: `gh issue list -R <repo> --label discovery --state open --json number,title,labels` splits minor (waiting by design) vs major (outranking the roadmap on purpose) |
| "run a lap now" | confirm (tokens), `tick <slug>` |
| "add repo X" / "add this PRD" | the wizard from Stage 0 / Stage 4 (`status` first; dedup makes re-runs safe) |
| "cleanup" | confirm, `cleanup` (worktree caches, stale workers) |
| "remove repo X from the factory" | There is no remote delete verb, on purpose. Soft off-switch: `pause <slug>` (history and ledger stay; ticks skip it). Full removal is operator-side (server state `repos/<slug>/` + any leftover machines) — name the step, hand it over; never hand-delete ledger rows |
| provider capped / rotating keys | keys live server-side (the operator manages them). Read the receipt: `402 insufficient_credits` = wrong billing surface (switch model ids) vs router `429` = the weekly pool's reset window (wait or add a key — operator). `provider_error` receipts carry the upstream message — read it before proposing unblock |
| "which provider runs what" | `dark-factory models` is the live roster; stage rows in `status` show which provider/model each attempt ran on |

Reading results honestly: `terminal ≠ good` — a `merged` ledger row is
confirmed by the merged PR on GitHub; a failed lap's story is `status`'s
`last_error` + `logs`. Machine-mode implement stages emit no receipts until
they finish — silence there is normal (watch `session`), NOT a hang; before
pruning a "silent" lap, cross-check GitHub for a just-opened PR — receipts lag
the work. `claimable chain: unknown (GitHub probe >5s)` = retry, don't
interpret. When auto-revive stops (stagnation breaker / daily cap), the
factory posts a FAILURE SUMMARY on the GitHub issue — the case file: failure
signatures, verdict evidence, and classification hints (INFRASTRUCTURE vs
verifier-owned vs app failure). Read it, fix, epoch-bump or unblock.

## Failure signatures

Every row was paid for in real laps. Match the receipt, don't re-derive.

| Receipt says | Meaning | What to do |
|---|---|---|
| `pi exited 127 … node: not found` from a compose service | libc mismatch (musl image vs glibc launcher) — the launcher self-adapts, so seeing it means the server-side launcher was altered | report; operator restores the libc-agnostic launcher (factory-setup phase 4f) |
| bare `pi exited 127:` with nothing after the colon | spawn ENOENT — the binary in the argv never existed; receipts name the actual path | read the named path; still empty → the daemon predates the path-naming fix, restart at idle |
| `machine … never reached running (state: suspended)` | platform auto-suspend of an idle box; self-resumed next attempt | nothing; flag only if it repeats every lap |
| `machine gate failed (git push of factory/issue-N failed): non-fast-forward` | fossil branch from an unmerged chained sibling (fixed: the gate force-pushes factory-owned branches) | should not recur; `unblock <slug> <n> --prune` kills the fossil |
| `machine gate failed (git push …) could not read from remote` | GitHub credentials never reached the box (fixed via the token aliasing + machine env) | should not recur; check `factoryd.env` carries the token |
| `channel 0: open failed: connect failed: machine unreachable` (exit 255) | transient gateway hiccup during a machine stage; a blip self-heals on the next attempt | nothing once; repeats every attempt → the machine or snapshot is sick |
| readiness fails with `In-box socket state: LISTEN …` and a FULL Recv-Q | **GHOST SERVER** — start binds the socket, never accepts (classic: hand-written supervisor without its serve/accept loop). The verdict carries the kernel evidence | the `start` command is scenario-owned (the implementer cannot fix it): fix the script, `--lint`, `--test`, write — epoch bump revives it. When authoring any bespoke `start`: `--test` first, always |
| `review verdict unparseable after 5 re-asks — failing closed` (REJECT, raw output embedded) | generation death mid-sentence on flash-tier models — probabilistic, NOT a product verdict (the verify gates already passed) | `status` stage row shows tokens even for failed stages (river-death = tokens stop; output-cap = ceiling). If the work is genuinely good: verify on GitHub, squash-merge, `unblock <slug> <n> --prune` (ledger row drops; GitHub becomes the record). A plain re-lap often recovers; escalate after the same lap fails this way twice |
| `[runtime] server never became ready within 120s` | `start`/`readiness_path` mismatch, or the implementer's server exits/binds wrong | watch one repair round before touching the scenario or `timeouts.readiness_seconds` |
| river/connector `provider_error` bursts | upstream flakiness; the fallback chain advances on its own | watch; worry when fallbacks also fail |

Operator discipline paid for twice: after a server-side infra fix, wait for a
positive canary (the fixed path proven green once) before re-driving laps —
two full attempt cycles were once burned against a still-broken mount.

### Machines and strays (instabox mode)

One machine per issue's LAP, named `pdf-<slug>-i<issue>-g<lapId>` — unique per
lap generation ON PURPOSE: platform deletes are eventually consistent (phantom
listings observed ~2h late), and a reused name races the zombie — a unique
name can never inherit a dead lap's routes or stale servers. The machine's
clone IS the worktree; it survives repair rounds and dies when the lap books
out (confirmed delete; platform lag receipts "delete not yet visible" and the
janitor reaps it). Every tick's tail and `cleanup` reap any `pdf-*` machine
whose issue has no in_progress row — a "running" machine long after its lap is
the platform's stale listing until the janitor gets to it. `scenario --test`
machines (`pdf-<slug>-scen-test`) are pid-marker-protected while live. When
machine-mode verify fails readiness, the runner self-classifies: a transport
or host-poll starvation reports `INFRASTRUCTURE` (retry the lap, don't repair
the product); only host-poll AND in-box loopback both failing is an app
failure.

## Verb map (details in `dark-factory <verb> --help`)

| verb | one line |
|---|---|
| `health` / `doctor` | connectivity (open) / auth + readiness sweep incl. base snapshot contents |
| `models` | the LIVE provider roster — model discovery, and what config writes validate against |
| `status [--repo SLUG] [--raw \| --format json]` | ledger, laps, stages, chain depth, worktrees |
| `logs [--repo SLUG] [--tail N]` | the receipt spine (`[slug]`-tagged lines) |
| `session SLUG [-f] [--think] [--issue N]` | live or replayed agent-session view |
| `onboard OWNER/NAME` | register a repo (idempotent) |
| `config SLUG [--json PATCH]` | read the complete effective config / deep-merge a patch |
| `scenario SLUG runtime\|holdout …` | `--lint` (dry-run) / `--dump` / `--test` (execute w/o a lap) / write `--file F` |
| `backlog SLUG --prd-file F [--max N] [--create]` | slice the PRD (preview default) |
| `tick` / `pause` / `unpause` / `unblock` / `cleanup` | drive the wheel |
| `prove-gates SLUG` | plant every probe; gates must trip (exit 1 unless healthy) |
| `discoveries SLUG [--file]` | list harvested findings / open deduped issues |

Config allowlisted keys: `models`, `env`, `timeouts`, `merge`,
`default_branch`, `attempts`, `skip_labels`, `pi` (incl. `pi.web` search/fetch
toggles), `discoveries` (`auto_file` defaults TRUE), `ui` (`enabled` defaults
TRUE — voids the `ui` skill for non-frontend repos). Validation is loud:
dotted-string models, thinking suffixes inside `model`, malformed fallbacks,
and roster mismatches all reject at write time (client errors, not 500s).
