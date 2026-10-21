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

The pi-dark-factory is an unattended loop on the VPS: a systemd timer fires
`foreman tick`, one lap per repo takes the oldest claimable GitHub issue
through intake → plan → implement → verify (CI + black-box runtime/holdout
scenarios) → review → squash-merge → close. The **claim ledger** (SQLite on
the VPS) is the source of truth — a delivered issue is never re-claimed; the
lap advances the dependency chain one link per tick.

**This skill never SSHes into the VPS.** Everything runs through the remote
client (`bin/factory-remote` in this checkout, python stdlib) against the
HTTPS API. For code-level truth (diffs, CI checks, files, issue bodies) query
GitHub directly with a local `gh` — the PR is the truth, the factory's claim
about it is a claim.

## Connect

```bash
export FACTORY_URL=https://pi-factory.techa.pro
export FACTORY_API_KEY=<key>     # stored for the user at ~/.config/factory-remote/key
python3 bin/factory-remote doctor
```

If FACTORY_URL/KEY are unset, read them from `~/.config/factory-remote/` (url +
key files). If absent, the factory is not provisioned — tell the user: clone
pi-dark-factory on the VPS and run the in-repo `pi-factory-setup` skill in an
agent session there (it is the guided installer; the old one-shot
`bootstrap.sh` was retired). Never improvise an SSH workaround.

## Onboarding a new project (the wizard — gate every write)

Work the stages in order; **show what will be written and get an explicit yes
before every mutating step**. Never skip a failed preflight: report and stop.

### Stage 0 — precheck (local `gh`, read-only)

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
  `docker-compose.yml` (install freedom in a root container; the compose file
  must publish the scenario ports on `127.0.0.1`).

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

Server-side validation fails fast (rejections name the problem) — a bad
scenario can never burn a lap. Probe contract: `status:N` (curl -s -o /dev/null
-w '%{http_code}'), `json:path=value`, `body_contains:`, `body_matches:^reg$`,
`exit:N` (implicit), `max_ms:`; values must be space-free; unknown tokens fail
closed.

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

### Stage 5 — first lap (spends real tokens)

Confirm explicitly: "fire the first lap now? It will plan, implement, verify,
review, and merge — unattended." Then:

```bash
factory-remote tick <slug>
```

It returns immediately (queued). Check `factory-remote status --repo <slug>`
once after a few minutes, then report and wait for the user's next ask — no
busy-polling. A full lap is tens of minutes.

## Ops mode (daily driving)

| User says… | Do |
|---|---|
| "is the factory running" | `doctor` + `status` — report repos, chain depth, ledger states |
| "why is #N blocked" | `status` (row + last_error) → `logs --tail 300` for the receipt trail → read the failing gate from `last_error`; propose a fix, then `unblock <slug> <n>` (confirm first) |
| "run a lap now" | confirm (tokens), `tick <slug>` |
| "add repo X to the factory" | run the wizard from Stage 0 |
| "cleanup" | confirm, `cleanup` (prunes blocked worktree caches, kills stale pi) |
| "add this PRD" | Stage 4 on an onboarded repo — `status` first, dedup makes re-runs safe |
| "clinepass is capped / rotating keys" | mention the router: `curl $FACTORY_HOST:8099/pool` is VPS-side; keys live in `/home/factory/state/clinepass.keys` (one per line, live-reloaded). Distinguish the two walls before advising: upstream `402 insufficient_credits` = Cline **Credits** drained (wrong model-id surface — switch to `cline-pass/…` ids); a `429` from the router = the **weekly** pool's reset window (cooling until the parsed reset) — ask the user to add a key or wait. Provider errors now surface as `provider_error` in receipts with the upstream message — read it before proposing unblock. |

Reading results honestly: `terminal ≠ good` — a lap showing `merged` in the
ledger is confirmed by the merged PR on GitHub (`gh pr view`); a failed lap's
story is in `status`'s `last_error` plus `logs`. When a provider hit
`provider_error`, note which models were tried before proposing unblock.

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
