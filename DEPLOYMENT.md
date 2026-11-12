# VPS deployment runbook

> **Docker is the other way to install.** To run the factory on a laptop, or on a VPS without
> hand-built systemd units, use the Compose stack in [`docker/`](docker/README.md)
> ([guide](docs/docker.md)). This runbook is the systemd path, the tested shape, and the one
> compose-mode repos need (the Docker image has no Docker daemon inside).

Tested shape: an Ubuntu VPS with systemd and a dedicated `factory` user. Laps run strictly
one at a time per repo (a tick chains up to 6 of them inside a 12-minute budget), and repos
run in parallel with each other. Where agent stages run is chosen per repo (`env.mode`, see
[docs/execution-modes.md](docs/execution-modes.md)):
- `instabox` and `boxd` run them in a disposable machine per lap;
- `compose` runs them as root inside the product's own Docker environment;
- `host` runs them as plain processes.

**Install**: clone this repo on the server and run the in-repo `dark-factory-setup` skill in an
agent session there. It walks this runbook in order, skips what exists and verifies each step.
The sections below are the manual reference for what it does.

## 1. Factory user

```sh
sudo adduser --disabled-password --gecos "pi dark factory" factory
sudo loginctl enable-linger factory
```

Everything below runs as `factory` (`sudo -u factory -H bash -l`) unless noted.

The factory user is not in the `docker` group. Membership is root-equivalent, and host- and
compose-mode agents run as this user. Add it only for compose-mode repos (§7).

## 2. Runtimes

Pi needs **Node >= 22**. The distro Node (Ubuntu 24.04 ships 18) fails at startup with
`SyntaxError: The requested module 'node:module' does not provide an export named
'enableCompileCache'`. Give the factory user its own Node 22 and put it first on PATH for login
shells and the systemd units (the units in §4 already carry `/home/factory/.local/node/bin`):

```sh
# Node 22 for the factory user (self-contained, no sudo)
sudo -u factory -H bash -c 'mkdir -p ~/.local/node && curl -fsSL https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz | tar -xJ -C ~/.local/node --strip-components=1'
grep -q ".local/node/bin" ~factory/.profile || sed -i '1i export PATH="$HOME/.local/node/bin:$PATH"' ~factory/.profile

# Bun (official installer, needs unzip)
curl -fsSL https://bun.sh/install | bash

# Pi
npm install -g @earendil-works/pi-coding-agent
pi --version

# git + gh + curl (+ ssh for instabox repos)
sudo apt-get install -y git gh curl openssh-client
gh auth login        # or GH_TOKEN + GITHUB_TOKEN in factoryd.env (§4)
```

## 3. Factory code, state and pi

```sh
git clone https://github.com/<you>/pi-dark-factory.git ~/pi-dark-factory
cd ~/pi-dark-factory && bun install --frozen-lockfile
mkdir -p ~/state     # state lives OUTSIDE the checkout so `git pull` never touches it
```

**Model providers.** Authenticate pi as the `factory` user:
- **OAuth:** run `pi`, then `/login` and pick the provider, once per provider.
- **API keys:** put them in `~/.pi/agent/auth.json`.
- **Custom providers:** add them to `~/.pi/agent/models.json`.

A model's `thinkingLevelMap` in `models.json` decides which thinking levels work (`xhigh` and
`max` need an entry). Remote config writes validate against the same file. Smoke-test every
exact `provider/model:thinking` string a repo config will use:

```sh
pi --mode json --no-tools --provider <provider> --model <model> --thinking <level> "say OK" </dev/null
```

If a project-trust prompt appears in headless runs, set default trust in
`~/.pi/agent/settings.json` (or pass `--approve` via a repo's `pi.extra_args`). No unattended
run may block on a question.

**Machine lanes.**
- **InstaBox:** needs `INSTABOX_API_KEY` in `factoryd.env`. Repos boot from a stack-base alias
  in `state/base-snapshot.json` (`{"shared-base": {"snapshot": "<name>", "contents": "…"}}`),
  or from a repo snapshot built with `foreman bake <slug>`.
- **boxd:** needs `BOXD_API_KEY` and a `factory-base-boxd-r1` snapshot in the boxd org.
- Neither lane needs Docker on the VPS.

**Web grounding** (on by default for every repo) needs `TINYFISH_API_KEY` in `factoryd.env`.
- **What it does:** the bundled `pi-extensions/pdf-tinyfish.ts` extension gives agents
  `web_search` and `web_fetch`.
- **Without the key:** the tools are left out.
- **Delivery:** the key reaches every stage (host, compose, machines) whatever a repo's
  `pass_env` says.

Verify:

```sh
sudo -u factory -H env TINYFISH_API_KEY=<key> pi --mode json --no-session \
  --tools read,web_search,web_fetch --extension /home/factory/pi-dark-factory/pi-extensions/pdf-tinyfish.ts \
  -p 'Call web_search with query "pi dark factory" and reply COUNT=<n> only.'
```

**ClinePass key router** (optional, `docs/keyrouter.md`):
- **Unit:** `pi-keyrouter.service` on port 8099, with keys in `/home/factory/state/clinepass.keys`
  (one per line, mode 600, live-reloaded).
- **Provider entry:** merge `templates/pi-models.clinepass-router.json` into
  `~/.pi/agent/models.json`.
- **Access token:** set `CRPASS_ROUTER_TOKEN` on the unit (an `EnvironmentFile`, mode 600)
  and the same value as the `clinepass-rotator` `apiKey`.
- **Reach:** machine lanes can't reach the router.

## 4. The daemon (API + scheduler)

`/home/factory/factoryd.env` (mode 600, owned by factory):

```sh
PI_FACTORY_STATE=/home/factory/state
FACTORYD_PORT=8077
FACTORY_API_KEY=<openssl rand -hex 32>
DARK_FACTORY_LAPTOP_KEY=<optional second key, revocable on its own>
GH_TOKEN=<token>          # if not using gh auth login
GITHUB_TOKEN=<same token> # machine stages read this name
INSTABOX_API_KEY=…        # instabox repos
BOXD_API_KEY=…            # boxd repos
TINYFISH_API_KEY=…        # web grounding
# machine-slot pools (optional; defaults shown) — docs/parallel-mode.md
# PDF_POOL_INSTABOX=5
# PDF_POOL_BOXD=10
# PDF_AGING_MINUTES=30
# PDF_FLEET_DAILY_ATTEMPTS=0
```

`/etc/systemd/system/pi-factoryd.service`:

```ini
[Unit]
Description=pi-dark-factory remote API + scheduler
After=network-online.target
Wants=network-online.target

[Service]
User=factory
WorkingDirectory=/home/factory/pi-dark-factory
EnvironmentFile=/home/factory/factoryd.env
Environment=PATH=/home/factory/.local/node/bin:/home/factory/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# every 15 minutes, start one `foreman tick --repo <slug>` process per idle repo
Environment=PDF_SCHEDULER_MINUTES=15
# a restart stops only the daemon; running ticks finish their laps
KillMode=process
ExecStart=/home/factory/.bun/bin/bun src/factoryd.ts
Restart=always

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pi-factoryd
curl -fsS http://127.0.0.1:8077/health     # ok:true, scheduler_minutes:15, pools: instabox 5, boxd 10
```

How scheduling behaves:
- **Per-repo pidfiles.** Each repo tick holds its repo's pidfile. The scheduler skips a repo
  whose previous tick still runs, and a manual `tick` can't double-run a lap.
- **Concurrency.** `PI_FACTORY_CONCURRENCY=N` caps how many repo ticks run at once. On machine
  lanes the platform's machine quota is the real cap.
- **Janitor.** After each pass it deletes lap machines whose issue has no live lap.

Older installs ran a `pi-factory.timer` fleet tick instead. Disable it
(`systemctl disable --now pi-factory.timer`) when the scheduler is on: one scheduler, not two.
The migration steps are in `docs/operations.md`.

## 5. First project

From a laptop, use the `dark-factory` skill (§8). The same steps on the server:

```sh
cd ~/pi-dark-factory
bun src/foreman.ts onboard <owner>/<repo>
# 1. edit ~/state/repos/<slug>/config.json: models, env.mode (+ env.instabox / env.boxd)
# 2. edit ~/state/repos/<slug>/runtime.json and holdout.json: real setup/start/probes
bun src/foreman.ts backlog <slug> --prd <path-to-PRD> --dry-run   # review the slice (runs the slicer)
bun src/foreman.ts backlog <slug> --prd <path-to-PRD>             # create the issues
bun src/foreman.ts tick --repo <slug>                             # first lap (spends tokens)
tail -f ~/state/laps.log                                          # receipts
bun src/foreman.ts status
```

Start with a toy repo and a trivial runtime scenario, then the real project. The slicer's
first issue is the end-to-end walking skeleton.

## 6. Operations

- **Blocked issue.** When the attempt cap is hit, the issue gets a comment with the last
  error and the unblock command.
  - Later ticks revive it with a fresh attempt budget: at most 3 times a day, and never once
    the same failure repeats. A config or scenario write resets both limits.
  - To clear it by hand: `bun src/foreman.ts unblock <slug> <issue> [--prune]`.
- **Billing hold.** When every model a stage tries answers `402` or `401`, the attempt is
  refunded and the repo pauses itself with the reason in `state/repos/<slug>/paused`. Fix the
  provider, then `unpause` (remote) or delete the marker.
- **Daily ceiling.** `limits.daily_attempts` (default 60 implement attempts per repo per UTC
  day) stops a runaway chain until 00:00 UTC.
- **Hygiene.** `bun src/foreman.ts cleanup` does three things:
  - prunes dependency caches in blocked worktrees;
  - kills `pi --mode json` processes older than 2 h;
  - deletes orphaned lap machines.
- **Observability.** Look at four places:
  - `laps.log`;
  - `foreman status`;
  - issue and PR comments;
  - the session files under `~/state/repos/<slug>/issues/<n>/`.

  The read-only dashboard and hourly state backups are covered in `docs/operations.md`.
- **Updating the factory.**
  - Run `git pull --ff-only` in `~/pi-dark-factory`, plus `bun install` when `package.json`
    changed.
  - Then `sudo systemctl restart pi-factoryd`. With `KillMode=process` this is safe while
    laps run.
  - Repo ticks load fresh code by themselves.
- **Ordering and scale.**
  - Inside a repo, laps run one at a time in dependency order. A merge re-intakes at once,
    up to 6 laps or 12 minutes per tick, and the next tick continues.
  - When the chain stalls on a block, the tick waits 10 minutes once and tries one revive.
  - Onboard more repos for more parallelism.

## 7. Container mode (install freedom, per repo)

Compose-mode stages need docker: `sudo usermod -aG docker factory` (then log in again). This
gives the factory user, and so every host- and compose-mode agent, root-equivalent access to the
host. Then per repo, in `~/state/repos/<slug>/config.json`:

```json
"env": { "mode": "compose", "service": "worker", "compose_file": "docker-compose.yml" }
```

**Worker service contract** (in the product repo). Any built service works; a copy of your dev
or app service is fine. The factory only overrides the command: each stage becomes
`docker compose -f <compose> run --rm --service-ports --workdir <worktree> <service> pi …`, so:

- the worker's image must contain the project's toolchain, or the agent installs it (it is
  root);
- the worker service publishes the **scenario port pair on `127.0.0.1`**. The factory passes
  `--service-ports` because `compose run` publishes nothing by default;
- `depends_on` services (databases, queues) come up for every stage, so runtime verification
  exercises real dependencies.

A complete example lives at `templates/docker-compose.product-example.yml`. Copy its shape into
the product repo, or let the implementer ship one as an issue deliverable.

**What the factory sets up in each stage container.**
- **Mounts:** the worktree, the state dir and the factory user's pi install, at identical
  container paths.
- **Preset:** `safe.directory=*` and `HOME=/root`.
- **Keys:** `env.pass_env` forwards model keys that exist on the host.
- **The `pi` launcher:** `/usr/local/bin/pi` is mounted from `~/.pi/agent/bin/pi`, a launcher
  that must work in both glibc and musl images (the setup skill writes it, Phase 4f).

**Repos without a compose file yet.** The factory falls back to `docker run --rm` from
`env.image` (default `ubuntu:24.04`). It uses named cache volumes (`pdf-uv`, `pdf-pip`,
`pdf-npm`) and publishes `scenario.ports` itself. Once the compose file lands in the repo, the
factory uses it automatically.

Smoke-check before the first container lap (as `factory`):

```sh
for IMG in node:22-alpine node:22; do
  docker run --rm -v ~/.pi:/root/.pi -v ~/.pi/agent/bin/pi:/usr/local/bin/pi:ro $IMG /usr/local/bin/pi --version
done
```

Every stage and scenario container gets a unique `--name` and is removed on success, timeout
or crash.

**Network prerequisite.** Stage containers reach the key router via `host.docker.internal`
(the docker gateway). If the host firewall blocks it, every model call times out and laps die
at plan in seconds. With ufw and docker pools in 10.0.0.0/8, run
`ufw allow from 10.0.0.0/8 to any port 8099 proto tcp`. Verify from a container:

```sh
docker run --rm --add-host host.docker.internal:host-gateway node:22 \
  sh -c 'wget -qO- http://host.docker.internal:8099/health'
```

## 8. Remote control (the dark-factory CLI) — remote from here on

Caddy fronts the daemon with an edge key check, and the daemon checks the key again on every
route except `/health`. Write the block with the real keys into a 600-mode file. Never paste
the keys into a chat or a log.

```
<domain> {
  @health path /health
  handle @health { reverse_proxy 127.0.0.1:8077 }
  @unauthorized {
    not header X-Api-Key <FACTORY_API_KEY>
    not header X-Api-Key <DARK_FACTORY_LAPTOP_KEY>
  }
  handle @unauthorized { respond 401 }
  reverse_proxy 127.0.0.1:8077
}
```

- **Dockerized Caddy.** The deployment this repo runs on puts `caddy-gateway` on the
  `web_gateway` network. Proxy to the bridge gateway (`reverse_proxy 10.0.1.1:8077`) and open
  the port to that subnet only: `ufw allow from 10.0.1.0/24 to any port 8077`.
- **Dashboard.** Add a `handle /dashboard/*` block behind SSO in the same site, before the
  `@unauthorized` handler (see `docs/operations.md`).

On any machine with Node ≥ 18:

```sh
npx @techafresh/dark-factory setup https://<domain> <key>   # stored in ~/.dark-factory/config.json (600)
dark-factory doctor
```

`<key>` is `DARK_FACTORY_LAPTOP_KEY` or `FACTORY_API_KEY` from `factoryd.env`; read it once on
the server. `DARK_FACTORY_URL` / `DARK_FACTORY_API_KEY` override the stored config, and
`--url` / `--key` override both. The full verb manual is in [cli/README.md](cli/README.md);
day-2 operation is the `dark-factory` skill. After setup, nothing needs SSH. For code-level
truth (diffs, checks, files), query GitHub with a local `gh`.

Route map. `GET /health` is open; everything else needs `X-Api-Key`.

| route | purpose |
|---|---|
| `GET /status?slug=` · `GET /logs?slug=&tail=` · `GET /models` | read state, receipts, provider roster |
| `GET /session/<slug>?issue=&think=1&follow=1` | rendered agent session, optionally streamed |
| `POST /repos` `{repo}` | onboard |
| `GET` / `POST /repos/<slug>/config` | read the effective config / deep-merge an allowlisted patch (`models`, `env`, `timeouts`, `merge`, `default_branch`, `attempts`, `skip_labels`, `trusted_authors`, `pi`, `discoveries`, `limits`), validated before it is written |
| `GET /repos/<slug>/scenario?kind=` · `PUT /repos/<slug>/scenario` `{kind, content, lint?}` | read / validate and write a scenario |
| `POST /repos/<slug>/scenario/test` `{kind, branch?}` | run the stored scenario without a lap |
| `POST /repos/<slug>/prove-gates` · `POST /repos/<slug>/discoveries` `{file}` | gate audit / harvested findings |
| `POST /repos/<slug>/backlog` `{prd_text, dry_run, max}` | slice a PRD (the dry run still runs the slicer) |
| `POST /repos/<slug>/tick` | start a repo tick now; 409 if one is live |
| `POST /repos/<slug>/pause` · `/unpause` · `/unblock` `{issue, prune?, force?}` | drive the repo |
| `POST /cleanup` | caches, stale workers, orphaned machines |

## 9. Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `tick skipped: a tick for <slug> is already live` | that repo's pidfile is held by a live tick | wait; a dead holder's lock is reclaimed automatically |
| `idle after #N: K open, none claimable — …` | the receipt names why: untrusted author, skip label, foreign PR, open `Depends on:` parents, or closed in the ledger | act on the bucket it names (e.g. add the author to `trusted_authors`) |
| `skipping <slug>: paused — billing hold: …` | every model failed on billing | top up or fix the key, then `unpause` |
| `daily attempt ceiling reached` | `limits.daily_attempts` hit | wait for 00:00 UTC or raise the limit |
| `skipping <slug>: its config.json does not load` | a hand edit broke the file | fix the file; the rest of the fleet keeps running |
| `port … is busy` in a scenario result | a leftover server or a port collision | check reserved ports across configs; `ss -ltnp`; fix the holder |
| `provider_error` on every lap | bad model string, expired key or quota | smoke `pi --mode json --provider … --model …` as the factory user |
| laps die at plan in seconds in compose mode | stage containers can't reach the key router | the §7 network prerequisite |
| `pi exited 127` | pi is missing where the stage ran | compose: the §7 launcher; instabox: the snapshot lacks pi |
| lap machines pile up | a killed tick left them | `foreman cleanup` (the scheduler's janitor also reaps them each pass) |
| merged PR but the issue stayed open | the squash message lacked `Closes #n` | the merge stage closes it; if that failed too, `gh issue close`, and the next tick's reconcile books it as merged |
