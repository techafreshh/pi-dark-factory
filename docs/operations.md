# Operations — setup, clients, commands, state, models, deploys

Everything an operator touches day to day: the guided install, the remote clients, the command surface, on-disk state, model wiring and safe deploys.

## Setting up a factory — the guided way

### What you need

- A **VPS** (Ubuntu + systemd is the tested shape) you can SSH into.
- A **GitHub account** — it hosts the product repos, issues and PRs the factory works on.
- One or more **LLM provider API keys** (the stages' fuel; per-stage models and fallbacks
  are configured per repo).
- Optional: **Docker** on the VPS for compose-mode repos; an **InstaBox API key** for
  machine-mode repos; a **DNS domain** if you want remote control over HTTPS.

### The guided install (on the server)

```sh
ssh your-vps
git clone https://github.com/you/pi-dark-factory.git ~/factory-checkout && cd ~/factory-checkout
pi        # any coding agent session in the checkout works
```

then tell the agent: **"Run the dark-factory-setup skill — set the factory up on this
server."** The skill ships in this repo (`.agents/skills/dark-factory-setup/`) and turns the
install into an agent walk-through instead of a script:

- one **decision batch up front** (factory user name; GitHub auth style; the model lineup
  per stage with thinking levels and fallback chains; pi packages/extensions; remote
  control + domain; optional ClinePass key router; container mode; InstaBox machine mode;
  a first smoke lap), then no more surprises;
- `DEPLOYMENT.md` executed **phase by phase with a verify after each** — factory user,
  runtimes, `gh` + provider auth, full `~/.pi` provisioning (custom `models.json`
  providers, packages, every `provider/model:thinking` string smoke-tested against the
  live API), factory code + state dir, systemd timer + factoryd + Caddy;
- **idempotent**: a re-run resumes, never re-does; secrets go into 600-mode files and
  never into the transcript.

**Done means**: `pi-factory.timer` armed (fires every 15 minutes), `pi-factoryd` green
behind Caddy with its API key in `factoryd.env` (600), every model string proven by a live
smoke call, the laptop able to `doctor` in over HTTPS — and, if you opted in, Docker or
the InstaBox key wired into the service environment.

### Day 2 — onboarding a project (back on your laptop)

Two remote clients speak to the same HTTPS endpoint (`X-Api-Key` edge gate —
the daemon additionally rejects keys it does not hold; Caddy OR-matches the
revocable per-client edge keys; `/health` stays open):

```sh
npx @techafresh/dark-factory setup https://<your-domain> <edge-key>
npx @techafresh/dark-factory doctor
```

(The deprecated Python client `bin/factory-remote` still speaks the same API
as an offline fallback, but the CLI above is the documented surface.)

Then run the sibling **`dark-factory` skill** and say "onboard <owner/name>": it PRD-checks
the repo, writes the repo config (mode included) and real runtime/holdout scenarios with
you, slices the PRD into the dependency-ordered backlog, and fires the first lap. From
then on laps happen every 15 minutes without you; you read receipts in `laps.log` or on
GitHub, and the only manual moment is answering a `factory:needs-info` question.
InstaBox repos bake their golden snapshot once on the server (`foreman bake <slug>`) —
onboarding reminds you when.

The manual alternative for all of the above is [`DEPLOYMENT.md`](DEPLOYMENT.md) — the
runbook the setup skill executes.

## Commands

```
bun src/foreman.ts tick   [--repo <slug>] [--concurrency N]   # one lap per repo (next link in its chain)
bun src/foreman.ts status [--repo <slug>]       # ledger, laps, stages, worktrees
bun src/foreman.ts logs   [--repo <slug>] [--tail N]
bun src/foreman.ts onboard <owner/name>         # config + scenario templates + reserved ports
bun src/foreman.ts backlog <slug> --prd <path>  # PRD → ordered GitHub issues (dedup by title)
                                                 #   [--max N] [--dry-run]
bun src/foreman.ts bake <slug>                  # instabox: build the repo's golden snapshot
bun src/foreman.ts unblock <slug> <issue>        # [--prune] drop the ledger row (± PR/branch/worktree)
bun src/foreman.ts cleanup                      # dep caches, stale pi workers, orphaned machines, disk
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
  repos/<slug>/issues/<n>/   # plan.md + stage JSONLs + Pi session forensics
  worktrees/<slug>/issue-<n>/ # the only place agents ever work (host + compose modes)
```

instabox machines are remote: the only local trace of a lap machine is its stage JSONLs in
`issues/<n>/` — clones, sessions and the machine itself live and die on InstaBox's side.

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

## Deploying changes to the factory

Two code surfaces load differently — a `git pull` reaches only one of them:

- **Timer ticks** (pi-factory.service, every 15 min) spawn a fresh process from the checkout
  per firing — a pull lands at the next tick, safe mid-lap.
- **The daemon** (pi-factoryd, :8077) dispatches slug-scoped ticks (`dark-factory tick SLUG`)
  **in-process** (`factoryd.ts` → `beginTick`), so it runs its START-TIME code forever. A pull
  without a restart leaves every daemon-dispatched tick on the old behavior — observed
  2026-11-01: the discovery drain-first policy was on disk but scoped ticks kept alternating
  until the restart. Any change to tick behavior (intake, stages, gates, merge) therefore ends
  with `sudo systemctl restart pi-factoryd` — safe anytime EXCEPT while laps are in flight
  (they run inside the daemon; restarting kills them mid-stage). Wait for the per-repo tick
  locks to release first, restart, then resume.
