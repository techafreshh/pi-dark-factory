# Operations — setup, clients, commands, state, models, deploys

Everything an operator touches day to day: the guided install, the remote clients, the command surface, on-disk state, model wiring and safe deploys.

## Setting up a factory — the guided way

### What you need

- A **VPS** (Ubuntu + systemd is the tested shape) you can SSH into.
- A **GitHub account** — it hosts the product repos, issues and PRs the factory works on.
- One or more **LLM provider API keys** (the stages' fuel; per-stage models and fallbacks
  are configured per repo).
- Optional: **Docker** on the VPS for compose-mode repos; an **InstaBox** or **boxd API key**
  for machine-mode repos; a **DNS domain** if you want remote control over HTTPS.

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
  live API), factory code + state dir, factoryd with its scheduler + Caddy, optional
  dashboard and backups;
- **idempotent**: a re-run resumes, never re-does; secrets go into 600-mode files and
  never into the transcript.

**Done means**: `pi-factoryd` green with its scheduler on (`/health` shows
`scheduler_minutes: 15`) behind Caddy with its API key in `factoryd.env` (600), every model string proven by a live
smoke call, the laptop able to `doctor` in over HTTPS — and, if you opted in, Docker or
the InstaBox / boxd key wired into the service environment.

### Day 2 — onboarding a project (back on your laptop)

The remote client speaks to the factory's HTTPS endpoint (`X-Api-Key` edge gate —
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

The manual alternative for all of the above is [`DEPLOYMENT.md`](../DEPLOYMENT.md) — the
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
  repos/<slug>/revives.json  # auto-revive bookkeeping (daily count, failure signatures, inputs epoch)
  repos/<slug>/paused        # present = ticks skip the repo; "<iso> <reason>" for a billing hold
  repos/<slug>/source/       # main checkout (fetch + hard reset each tick; agent never works here)
  repos/<slug>/issues/<n>/   # plan.md, findings.md, stage JSONLs, Pi sessions, discoveries
  base-snapshot.json         # stack-base aliases (shared-base, …) → machine snapshots
  backup.json                # last backup result (bin/backup.ts)
  worktrees/<slug>/issue-<n>/ # the only place agents ever work (host + compose modes)
```

Machine-mode lap machines (instabox, boxd) are remote: the only local trace of one is its stage
JSONLs in `issues/<n>/` — clones, sessions and the machine itself live and die on the
platform's side.

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

```sh
cd /home/factory/pi-dark-factory && sudo -u factory git pull --ff-only
sudo -u factory env PATH=/home/factory/.bun/bin:/usr/bin:/bin bun install --frozen-lockfile   # only when package.json changed
sudo systemctl restart pi-factoryd
```

Two code surfaces load differently:

- **Repo ticks** are `foreman tick --repo <slug>` processes the scheduler (or `dark-factory
  tick`) starts, so each one loads the code on disk when it starts. A pull reaches the next
  tick without a restart, and a lap already running keeps the code it started with.
- **The daemon** (pi-factoryd, :8077) keeps its start-time code for the API routes and the
  scheduler loop until it restarts. Restart it after any change to `factoryd.ts`, `ops.ts`,
  `scheduler.ts` or code they import. With `KillMode=process` (below) the restart leaves
  running ticks alone, so it is safe at any time.

### Daemon scheduler

The daemon schedules ticks: on the quarter hour it starts one tick process per idle repo,
spaced `PDF_SCHEDULER_GAP_MS` apart (default 1 s), then runs the machine janitor once. A
repo whose previous tick still runs is skipped, so a long lap delays only its own repo.
`PI_FACTORY_CONCURRENCY` caps how many repo ticks run at once. The scheduler is off unless
`PDF_SCHEDULER_MINUTES` is set. `PDF_TICK_ON_START=1` adds one pass about 10 s after the
daemon starts, for a laptop that slept through quarter hours; it is off by default so a
daemon restart on the VPS (a `git pull`) does not start extra laps, and the
[Docker stack](docker.md) turns it on. This deployment sets the scheduler in a drop-in:

```sh
sudo mkdir -p /etc/systemd/system/pi-factoryd.service.d
sudo tee /etc/systemd/system/pi-factoryd.service.d/scheduler.conf >/dev/null <<'EOF'
[Service]
Environment=PDF_SCHEDULER_MINUTES=15
# a restart stops only the daemon; the tick processes it started run their
# laps to the end (each holds its repo's pidfile, so nothing double-runs)
KillMode=process
EOF
sudo systemctl daemon-reload
sudo systemctl disable --now pi-factory.timer   # one scheduler, not two
sudo systemctl restart pi-factoryd              # switching over: do this one restart with laps idle
curl -s localhost:8077/health | grep scheduler_minutes   # 15
```

#### Machine slots

With the scheduler on, the daemon also runs the slot allocator's heartbeat every 15 s
(sweep dead lease holders, grant waiting requests; laps also decide on their own polls,
so a daemon restart never stalls one). `/health` reports `pools`: cap, granted, waiting
and parked per platform. Settings go in `factoryd.env`; the daemon's tick children
inherit them:

| Variable | Default | Meaning |
|---|---|---|
| `PDF_POOL_INSTABOX` | 5 | concurrent factory machines on InstaBox |
| `PDF_POOL_BOXD` | 10 | concurrent factory machines on boxd (a cost cap; the account allows 100) |
| `PDF_AGING_MINUTES` | 30 | a waiting request moves up one priority level per this many minutes |
| `PDF_SLOT_WAIT_MS` | 840000 | how long a tick waits for a slot before it parks its request and exits |
| `PDF_FLEET_DAILY_ATTEMPTS` | 0 (off) | implement attempts across every repo per UTC day |

Per-repo priority, spill-over and parallel lanes are `scheduling` config keys
([parallel-mode.md](parallel-mode.md)). Set the dashboard's own copies
(`DASHBOARD_POOL_INSTABOX` / `_BOXD`) only if the daemon is unreachable from it; otherwise
it reads the caps from `/health`.

The older alternative is `pi-factory.timer`, a oneshot fleet tick every 15 minutes. systemd
can't start it again while it runs, so one long lap delays every repo (33 of 311 ticks
overran their slot in the week to 2026-11-09). To go back to it: remove the drop-in,
`daemon-reload`, restart the daemon, and enable the timer.

### Telemetry dashboard

`bin/dashboard.ts` (unit `pi-factory-dashboard`, bound to `10.0.1.1:8787`, behind Caddy and
Authelia at `pi-factory.techa.pro/dashboard/`) is a read-only sidecar: it opens `factory.db`
readonly, reads `laps.log`, the paused markers and the per-issue session files, and imports
nothing from `src/`. Pages: overview (needs-you, live laps, outcome and cost charts, model
health, machines with slot usage), projects, a paged/filtered/sorted lap list, a lap view with
its stages and the agent sessions (prompts, thinking, tool calls and results), and Scheduling
(slot pools, leases, the waiting queue in grant order with priority after aging, parallel
lanes, merge queues, spill-over). Needs-you flags a lane waiting over an hour for a slot. Routes are hash routes
(`#/laps/123`) because Caddy strips the `/dashboard` prefix.

The machine panel reads its API keys from `/home/factory/dashboard.env` (mode 600, factory
owned): `INSTABOX_API_KEY=` and `BOXD_API_KEY=`, never the whole `factoryd.env`. A missing
key shows that provider as "no key".

The UI is built into the committed `dashboard-ui/dist`: after a UI change run
`cd dashboard-ui && bun run build` and commit `dist`. A deploy is `git pull` and
`sudo systemctl restart pi-factory-dashboard`.

### State backups

`bin/backup.ts` copies the ledger (`VACUUM INTO`, integrity-checked) and the small state the
factory can't rebuild from GitHub (`laps.log`, each repo's `config.json`, `runtime.json`,
`holdout.json`, `revives.json`, `paused`) to the `pi-factory-backups` bucket on the VPS's MinIO
(the Langfuse stack's). Session files, clones, worktrees and key files are not included.
`pi-factory-backup.timer` runs it hourly at :07 as `factory`. Retention: every snapshot from
the last 48 hours, then the first of each UTC day for 30 days. Each run writes
`state/backup.json`; the dashboard's "Needs you" panel flags a failing backup or one older than
3 hours.

Credentials live in `/home/factory/backup.env` (mode 600): `S3_ENDPOINT`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. The MinIO user `pi-factory-backup` can only read and
write that bucket. `S3_ENDPOINT` is MinIO's address on the `web_gateway` bridge
(`http://10.0.1.21:9000`); if the container is recreated with a new IP, update it there
(`docker inspect langfuse-vps-setup-minio-1`).

```sh
sudo -u factory bash -c 'set -a; . /home/factory/backup.env; set +a; cd /home/factory/pi-dark-factory
  bun bin/backup.ts list                         # snapshot ids
  bun bin/backup.ts restore <id> /tmp/restore    # into an EMPTY dir, never over live state'
```

To put a restored ledger back: stop the daemon and wait for running ticks to finish, move
`state/factory.db*` aside, copy the restored `factory.db` in, start the daemon.

This MinIO runs on the same disk as the factory, so it covers a corrupted ledger, a bad
migration or a deleted file, not the loss of the VPS. Pointing `S3_ENDPOINT` at an off-site
bucket (any S3-compatible store) covers that too.
