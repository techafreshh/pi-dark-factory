---
name: pi-factory-setup
description: >-
  Install / provision pi-dark-factory ON ITS DEDICATED SERVER (VPS): the full
  first-time setup — factory user, runtimes (bun, pi, gh, optional docker +
  optional InstaBox machine mode), GitHub + provider auth, pi provisioning
  (models.json provider entries, packages/extensions, thinking levels), code
  clone + state dir, systemd timer + factoryd API (optional ClinePass key
  router), Caddy block, and an optional first smoke lap. Use when the user
  says things like "set up the factory", "bootstrap/provision/install the
  factory on this server", "wire up factoryd", "get the factory running here",
  or is starting an agent session in a fresh clone of pi-dark-factory on a
  server. NOT for day-2 operation from the user's laptop (that is the
  pi-factory skill, which talks over HTTPS and never SSHes) — this skill runs
  direct commands on the box itself.
---

# pi-factory-setup (server installer)

> Runs ON THE FACTORY SERVER, inside the cloned repo checkout. The sibling
> skill `pi-factory` is day-2 remote operation from the user's machine — this
> one produces the state that skill assumes. Replaces the old `bootstrap.sh`
> (retired): the same steps, but per-step verification and judgment instead of
> a one-shot script. `DEPLOYMENT.md` is the reference this skill executes —
> when a step needs the "why", read the section it cites.

**Done means**: `pi-factory.timer` armed (fires every 15 min) with its
`pi-factory.service` green; `pi-factoryd` healthy on :8077 with the API key in
`factoryd.env` (600); optionally `pi-keyrouter` healthy on :8099; pi fully
provisioned for the factory user (provider auth, custom `models.json` entries,
packages/extensions) with every `provider/model:thinking` string smoke-tested;
if InstaBox machine mode was chosen, `INSTABOX_API_KEY` is in the service env
and `/v1/me` + `/v1/usage` prove the account (machines/snapshots/storage
quota); if the TinyFish key was chosen, the 5g web-grounding smoke returned
`COUNT=<n>`; optionally a first smoke lap ran its gates;
the user's laptop can `doctor` in over HTTPS.

## Operating rules

- **One decision batch, up front** (Phase 0), then run the phases without
  further surprises. A one-line "doing X" before each sudo/system mutation,
  no extra ceremony.
- **Verify each phase; fail-stop.** A phase's verify command failing means
  report + diagnose (see `DEPLOYMENT.md` §9 troubleshooting table), not push
  past red.
- **Idempotent.** Detect what already exists before installing (`id`,
  `command -v`, `systemctl status`) and skip completed work — a re-run
  resumes, it never re-does.
- **Secrets never echo into the transcript.** The factoryd API key, GH token,
  ClinePass keys: write them to 600-mode files and show only the first 4
  chars + length, never the value. The Caddy block embeds the API key —
  write it to a 600-mode file and name the path; don't cat it into chat.
- **The factory user ≠ your user.** Everything factory-owned runs as
  `factory` (`sudo -u factory -H bash -lc '…'`); only system bits (user,
  units, `/etc/hosts`) are touched with sudo.
- The agent session's checkout may live anywhere; **the factory's copy of
  the repo lives at `/home/factory/pi-dark-factory`** — that is what the
  systemd units run from, and state lives OUTSIDE it at `/home/factory/state`
  so `git pull` never touches factory memory.

## Phase 0 — orientation + decisions

Read-only ground truth first:

```sh
head -2 /etc/os-release                       # Ubuntu is the tested shape
systemctl --version >/dev/null 2>&1 || echo "NO SYSTEMD — stop, this runbook is Linux+systemd"
grep '"name"' package.json                    # confirm you are in the factory checkout
id factory 2>/dev/null                        # already created?
command -v git gh curl ssh bun pi docker      # what's installed
systemctl status pi-factory.timer pi-factoryd.service 2>&1 | head -5
test -f /home/factory/factoryd.env && echo "factoryd.env exists (key already generated)"
```

Then ask the user, **in one batch** (defaults noted — accept defaults on a
plain "just set it up"):

1. **Factory user name** — default `factory`.
2. **GitHub auth** — interactive `gh auth login` as the factory user (device
   flow), or a `GH_TOKEN` to put in `factoryd.env`?
3. **Model lineup** — pi ships empty (no auth, no custom providers, no
   packages/extension). Which **providers + models** will repo configs use,
   per stage (plan/implement/review), with which **thinking levels** and
   fallback chains (`"provider/model[:level]"`)? Phase 4 auths every named
   provider and smoke-tests every exact `provider/model:thinking` string —
   a level like `max` only works if the provider's model entry maps it.
4. **Pi packages/extensions** — anything the stages must have loaded
   (extra tools, MCP bridges...)? A missing one never fails loudly — the
   stage just runs bare without it.
5. **Remote control** (default: yes) — generate the API key and run factoryd
   on :8077. If yes: which **domain** serves it (Caddy block)?
6. **ClinePass key router** — only if they have ClinePass API keys (how many?).
   Otherwise skip step 5c only; if yes, the `clinepass-rotator` provider
   entry goes into `models.json` in Phase 4.
7. **Container-mode repos planned?** (default: not now) — if yes, Phase 1
   installs docker (fresh VPSes have none) and adds the factory user to its
   group.
8. **InstaBox machine-mode repos planned?** (default: not now) — repos whose
   implement+review stages run in disposable InstaBox microVMs
   (https://instabox.sh, snapshot-booted, not your VPS's problem). If yes:
   the `INSTABOX_API_KEY` goes into `factoryd.env` (Phase 5a), `ssh` presence
   is ensured (Phase 1), and Phase 5f proves the account + quota live via the
   API. Per-repo golden snapshots are built later at first-project time
   (`foreman bake <slug>` — Phase 7). Docker is NOT needed for instabox-only
   repos.
9. **TinyFish web grounding** (default: on) — lap agents get `web_search` +
   `web_fetch` tools (read-only, from the repo's bundled
   `pi-extensions/pdf-tinyfish.ts` extension). Needs a `TINYFISH_API_KEY`
   (agent.tinyfish.ai/api-keys) in `factoryd.env` (Phase 5a) and a live
   `web_search` smoke call (Phase 4 smoke step). If the user skips the key,
   the factory still works — stages just run without web grounding.
9. **Smoke lap after install?** (recommended; spends a few cents of tokens on
   a toy repo) — vs. going straight to a real project via the `pi-factory`
   wizard.

## Phase 1 — factory user

```sh
id factory &>/dev/null || sudo useradd -m -s /bin/bash -c "pi dark factory" factory
sudo loginctl enable-linger factory            # user services survive logout
# container mode planned? fresh VPSes have no docker — install it, then group:
command -v docker &>/dev/null || sudo apt-get update -qq
command -v docker &>/dev/null || sudo apt-get install -y docker.io
sudo systemctl enable --now docker
id -nG factory | grep -qw docker || sudo usermod -aG docker factory
# instabox machine mode planned? every machine stage + scenario server runs
# through InstaBox's ssh gateway, so the host needs an ssh client:
command -v ssh &>/dev/null || sudo apt-get install -y openssh-client
```

Verify: `id factory` and `loginctl show-user factory -p Linger`.

## Phase 2 — runtimes (as the factory user)

Install only what's missing (`command -v` guards). Host needs `git gh curl`
(`sudo apt-get update && sudo apt-get install -y git gh curl`), then as
factory:

```sh
# bun (official installer; needs unzip)
sudo -u factory -H bash -lc 'command -v bun || (curl -fsSL https://bun.sh/install | bash)'
# pi coding agent (npm -g if node is present, else bun -g)
sudo -u factory -H bash -lc 'command -v pi || npm i -g @earendil-works/pi-coding-agent'
sudo -u factory -H bash -lc 'command -v pi || ~/.bun/bin/bun add -g @earendil-works/pi-coding-agent'
```

If `pi` ended up in `/home/factory/.bun/bin`, the systemd units must carry
that on PATH — the unit templates in Phase 5 already do (`Environment=PATH=…`,
first entry `/home/factory/.bun/bin`). Verify:

```sh
sudo -u factory -H bash -lc 'bun --version && pi --version && gh --version | head -1'
```

## Phase 3 — code + state

```sh
sudo -u factory -H test -d /home/factory/pi-dark-factory/.git \
  && sudo -u factory -H bash -lc 'cd ~/pi-dark-factory && git pull --ff-only' \
  || sudo -u factory -H git clone <REPO_URL> /home/factory/pi-dark-factory
sudo -u factory -H bash -lc 'cd ~/pi-dark-factory && ~/.bun/bin/bun install || bun install'
sudo mkdir -p /home/factory/state && sudo chown -R factory: /home/factory/state
```

Verify: `sudo -u factory -H bash -lc 'cd ~/pi-dark-factory && ls node_modules | wc -l'` > 0,
`sudo -u factory -H bash -lc 'bun src/foreman.ts help'` prints usage.
Fetch `<REPO_URL>` from the current checkout's `git remote get-url origin`.

## Phase 4 — pi provisioning (it ships empty: auth, providers, packages)

pi installs bare: no credentials, no custom providers, no packages. This
phase provisions the factory user's entire `~/.pi/agent/` surface and is
**the gate for Phase 5** — nothing gets enabled until every step passes.

**4a. GitHub** — either have the user complete
`sudo -u factory -H gh auth login` (device flow: relay the code), or append
`GH_TOKEN=<token>` to `/home/factory/factoryd.env` (600). Verify:
`sudo -u factory -H gh api user -q .login`.

**4b. Provider auth** — for every provider in the Phase 0 lineup
(`zai`, `openrouter`, `anthropic`, `clinepass-rotator`, …):
`sudo -u factory -H bash -lc 'pi auth login'` (OAuth device flows — hand the
user the URLs/codes), or keys into `~/.pi/agent/auth.json`, or env vars
(models.json `apiKey` interpolates `"$ENV_VAR"`).

**4c. Custom providers (`models.json`)** — non-builtin providers (the
`clinepass-rotator` router, self-hosted gateways) live in the factory user's
`~/.pi/agent/models.json` — pi installs **without one**, so create it.
Structure: `{"providers": {"<id>": {"name", "baseUrl", "apiKey", "api",
"models": [...]}}}` (`api` is e.g. `"openai-completions"`; model entries
need `id`, optionally `reasoning: true`, `contextWindow`, `maxTokens`,
`cost`). When the key router was chosen in Phase 0, merge the shipped
template's `providers` object into that file — preserving any existing
entries — and trim its model ids to what the provider actually serves.

**4d. Packages & extensions** — pi's distributed extensions are *packages*,
installed as the factory user:

```sh
sudo -u factory -H bash -lc 'pi install npm:<scope>/<pkg>@<ver>'   # or git:org/repo@ref
sudo -u factory -H bash -lc 'pi list'   # every promised package must appear
```

Personal installs are declared in `~/.pi/agent/settings.json` and load into
_every_ session (including container-mode stages — the `~/.pi` bind mount
carries it all). Loose extensions can also be dropped as `.ts` files into
`~/.pi/agent/extensions/` (auto-loaded, no compile step). A missing package
or extension never fails loudly — stages just run bare — so confirm each one
in `pi list` (or its own verify step) before moving on.

**4e. Smoke every model:thinking string** — the exact strings Phase 7 will
write into repo configs, thinking level included (`--thinking` level: the
default ladder maps through `high`; `xhigh`/`max` only work when the
provider's model entry defines a `thinkingLevelMap` for them):

```sh
sudo -u factory -H bash -lc \
  'pi --mode json --no-tools --provider <provider> --model <model> --thinking <level> "say OK" </dev/null'
```

If a project-trust prompt ever appears here or on stage runs, set default
trust in `~/.pi/agent/settings.json` (or pass flags via repo configs'
`pi.extra_args`) — no unattended run may ever block on a question nothing
can answer. A lineup entry is not "done" until its smoke returned assistant
text: the winners are exactly what config.json `models` gets.

**4f. Container launcher wrapper** (skip if no container-mode repos are
planned). Compose stages exec `/usr/local/bin/pi`, bind-mounted from
`~/.pi/agent/bin/pi` — a fresh install has NO such file and every
container stage dies instantly without it. It must also be
libc-agnostic: product compose services may be musl-based
(`node:22-alpine`), where the factory's glibc Node cannot exec
("not found"). Discover the pi cli.js path, then write the launcher:

```sh
# pi's self-managed runtime layout first, npm/bun global installs second:
CLI=$(sudo -u factory -H bash -lc 'ls ~/.pi/host-runtimes/pi-coding-agent/dist/bundle/cli.js 2>/dev/null || find ~/.local/node ~/.bun /usr/lib/node_modules -path "*pi-coding-agent/dist/bundle/cli.js" 2>/dev/null | head -1')
test -n "$CLI" || echo "NO cli.js FOUND — stop, resolve the pi install"
sudo -u factory -H mkdir -p /home/factory/.pi/agent/bin
sudo -u factory -H bash -c 'cat > /home/factory/.pi/agent/bin/pi <<WRAP
#!/bin/sh
# libc-agnostic launcher: stage containers may be musl-based (e.g. a product
# compose worker on node:22-alpine) where the mounted host node — a glibc
# build — cannot exec ("not found"). Prefer the container'"'"'s own node when it
# ships one; fall back to the mounted host runtime for node-less images.
if command -v node >/dev/null 2>&1; then
  exec node '"$CLI"' "\$@"
fi
exec /root/.pi/host-runtimes/node/bin/node '"$CLI"' "\$@"
WRAP'
sudo -u factory -H chmod 775 /home/factory/.pi/agent/bin/pi
# the fallback leg needs the factory node binary inside .pi (the pre-stage
# sweep re-copies it if it ever goes missing; ensure it exists once here):
SEED=/home/factory/.pi/host-runtimes/node/bin/node
sudo -u factory -H mkdir -p "$(dirname $SEED)"
sudo -u factory -H test -x "$SEED" || sudo -u factory -H bash -lc "cp \$(command -v node) $SEED"
```

Verify BOTH libcs — alpine proves the launcher's image-node leg, plain
node:22 proves the mounted-runtime fallback leg:

```sh
for IMG in node:22-alpine node:22; do
  sudo -u factory -H docker run --rm -v /home/factory/.pi:/root/.pi \
    -v /home/factory/.pi/agent/bin/pi:/usr/local/bin/pi:ro $IMG \
    /usr/local/bin/pi --version || echo "FAILED on $IMG"
done
```

## Phase 5 — systemd (units, env file, enable)

**5a. factoryd.env** — skip key generation if it exists (a re-run keeps the
old key); otherwise generate and assemble in one sudo heredoc, never echoing
the value: `PI_FACTORY_STATE=/home/factory/state`, `FACTORYD_PORT=8077`,
`FACTORY_API_KEY=$(openssl rand -hex 32)`, `GH_TOKEN=…` if Phase 4 used the
token form — **also write `GITHUB_TOKEN=` with the same value**: machine-mode
stages and `pass_env` use that name (the code resolves either, but carrying
both removes the whole mismatch class; it cost todos-api a full day,
2026-10-23→24) — and `INSTABOX_API_KEY=…` if Phase 0 machine mode was chosen
(secrets never echo into the transcript — pass them straight into the
heredoc from the place the user handed them over).
`chown factory: /home/factory/factoryd.env`, `chmod 600`. If Phase 0
web-grounding was chosen, **also write `TINYFISH_API_KEY=…`** here (same
no-echo rule).

**5b. Units** — write `/etc/systemd/system/pi-factory.service`:

```ini
[Unit]
Description=pi-dark-factory lap
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=factory
WorkingDirectory=/home/factory/pi-dark-factory
Environment=PI_FACTORY_STATE=/home/factory/state
# .bun/bin first so a bun-installed `pi` resolves from systemd's default PATH
Environment=PATH=/home/factory/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/home/factory/.bun/bin/bun src/foreman.ts tick
# unlimited parallel laps can run long — never time out the tick itself;
# only the per-stage watchdogs kill anything. The cgroup reaps leaks.
TimeoutStartSec=infinity
KillMode=control-group
```

`pi-factory.timer`:

```ini
[Unit]
Description=run pi-dark-factory every 15 minutes

[Timer]
OnCalendar=*-*-* *:00/15:00
Persistent=true

[Install]
WantedBy=timers.target
```

**5c. pi-keyrouter.service** (only if chosen in Phase 0):

```ini
[Unit]
Description=clinepass key router (multi-key failover)
After=network-online.target
Wants=network-online.target

[Service]
User=factory
WorkingDirectory=/home/factory/pi-dark-factory
Environment=CRPASS_KEYS_FILE=/home/factory/state/clinepass.keys
Environment=CRPASS_PORT=8099
Environment=CRPASS_STATE_FILE=/home/factory/state/clinepass.keys.state.json
Environment=PATH=/home/factory/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/home/factory/.bun/bin/bun src/keyrouter.ts
Restart=always
```

```sh
sudo touch /home/factory/state/clinepass.keys   # one key per line, live-reloaded
sudo chmod 600 /home/factory/state/clinepass.keys && sudo chown factory: /home/factory/state/clinepass.keys
grep -q host.docker.internal /etc/hosts || echo "127.0.0.1 host.docker.internal" | sudo tee -a /etc/hosts
```

**5d. pi-factoryd.service** (only if remote control chosen):

```ini
[Unit]
Description=pi-dark-factory remote API
After=network-online.target
Wants=network-online.target

[Service]
User=factory
WorkingDirectory=/home/factory/pi-dark-factory
EnvironmentFile=/home/factory/factoryd.env
Environment=PATH=/home/factory/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/home/factory/.bun/bin/bun src/factoryd.ts
Restart=always
```

**5e. Enable** — service unit + timer only after Phase 4's smoke passed
(no timer may fire against an unauthed install; idle ticks before repos exist
are harmless):

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pi-factory.service pi-factory.timer
sudo systemctl enable --now pi-factoryd.service      # if remote control
sudo systemctl enable --now pi-keyrouter.service     # if key router
```

Verify:

```sh
systemctl list-timers pi-factory.timer --no-pager              # armed, next in ≤15 min
curl -fsS http://127.0.0.1:8077/health                         # {"ok":true,service:…}
curl -fsS http://127.0.0.1:8099/health && curl -s :8099/pool   # key router: keys present
tail -5 /home/factory/state/laps.log                           # timer already ticked? expect idle receipts
```

**5f. InstaBox account check** (only if machine mode was chosen in Phase 0).
The key lives in `factoryd.env` (600 — same no-echo rule as every other
secret); source it without printing and prove both identity and quota:

```sh
sudo -u factory -H bash -lc 'set -a; . /home/factory/factoryd.env; set +a; \
  curl -fsS https://api.instabox.sh/v1/me -H "X-API-Key: $INSTABOX_API_KEY"' \
  | head -c 300    # an identity object — never echo the key itself
sudo -u factory -H bash -lc 'set -a; . /home/factory/factoryd.env; set +a; \
  curl -fsS https://api.instabox.sh/v1/usage -H "X-API-Key: $INSTABOX_API_KEY"'
```

`usage.limits` shows the account's ceilings (entry tier: 5 machines,
10 snapshots, 200 GiB) — that machine quota is the instabox-mode counterpart
of `--concurrency`, worth telling the user verbatim. A 401/failed curl here
fails the phase: fix the key before any machine-mode repo is onboarded.

**5g. Web-grounding smoke** (only if the Phase 0 TinyFish key was set). One
live `web_search` through the bundled extension proves key + extension +
tool routing together:

```sh
sudo -u factory -H bash -lc 'set -a; . /home/factory/factoryd.env; set +a; \
  cd /home/factory/pi-dark-factory && \
  pi --mode json --no-session --tools read,web_search,web_fetch \
     --extension pi-extensions/pdf-tinyfish.ts \
     -p "Call web_search with query \"tinyfish api\" and reply COUNT=<n> only."' \
  | grep -o 'COUNT=[0-9]*'
```

`COUNT=<n>` with n ≥ 1 passes the phase; a missing tools section or
`isError` on the tool result fails it — check the key first, then that
`pi-extensions/pdf-tinyfish.ts` is readable as the factory user.

## Phase 6 — Caddy block (if remote control + domain)

Write it to a 600-mode file and give the user the path — do not print the
API key into the transcript:

```sh
# generate with the key from /home/factory/factoryd.env substituted, then:
sudo tee /home/factory/caddy-snippet.txt   # chmod 600, chown factory
```

```
<domain> {
  @health path /health
  handle @health { reverse_proxy 127.0.0.1:8077 }
  @unauthorized not header X-Api-Key <KEY>
  handle @unauthorized { respond 401 }
  reverse_proxy 127.0.0.1:8077
}
```

The user adds it to their Caddyfile and reloads. If the laptop-side
`doctor` (Phase 8) fails with non-401 auth errors, the block/reload is the
first suspect.

## Phase 7 — first smoke lap (optional; small token spend)

Follow `DEPLOYMENT.md` §5: `onboard <owner/name>` (auto-writes config +
scenario templates + reserves two scenario ports), edit
`/home/factory/state/repos/<slug>/config.json`:

- **models** gets the Phase 4 lineup — per-stage provider/model with
  `"thinking"` levels and `"provider/model[:level]"` fallback strings
  (disciplined model for implement/review, cheaper for plan).
- **Container mode** (if Phase 0 planned it): a repo with a
  `docker-compose.yml` gets `env.mode: "compose"` + `env.service` per the §7
  worker contract (the compose must publish the scenario ports on
  `127.0.0.1`); repos without one stay on the fallback `env.image` and pick
  compose up automatically once it lands as an issue deliverable. First
  container repo: run the in-container smoke before the first lap — BOTH
  libcs (`node:22` and `node:22-alpine`), proving the launcher's fallback
  leg and its image-node leg (Phase 4f's verify does exactly this).
- **InstaBox machine mode** (if Phase 0 planned it): the repo's config gets
  `env.mode: "instabox"` + an `env.instabox.bake` shell (what to install
  after the clone: deps, caches — write it with the user). Then bake the
  golden snapshot once and watch the ceiling:

  ```sh
  sudo -u factory -H bash -lc 'cd ~/pi-dark-factory && bun src/foreman.ts bake <slug>'
  # → snapshot <slug>-base ready (root GiB reported; budget it against /v1/usage)
  ```

  During instabox laps machines appear and disappear
  (name `pdf-<slug>-i<issue>`); the platform auto-suspends idle boxes and
  the factory resumes them — a suspended machine in a status readout is
  normal, not an outage. Credentials never live in the snapshot: the
  factory ships its own pi auth/models and the GitHub token into the box
  over ssh on every stage (clone AND push authed; requires `GITHUB_TOKEN`
  or `GH_TOKEN` in the service env). The ClinePass rotator is host-local,
  so in-box fallback chains effectively run river → deepseek.
  `foreman cleanup` reaps any machine a crashed lap left parked.

Then write real `runtime.json` + `holdout.json` probes with the user,
then:

```sh
sudo -u factory -H bash -lc 'cd ~/pi-dark-factory && bun src/foreman.ts backlog <slug> --prd <path> --dry-run'  # review the slice
sudo -u factory -H bash -lc 'cd ~/pi-dark-factory && bun src/foreman.ts backlog <slug> --prd <path>'
sudo -u factory -H bash -lc 'cd ~/pi-dark-factory && bun src/foreman.ts tick --repo <slug>'
tail -f /home/factory/state/laps.log
sudo -u factory -H bash -lc 'cd ~/pi-dark-factory && bun src/foreman.ts status'
```

Read the result honestly: `merged` in the ledger is confirmed by the merged
PR on GitHub (`gh pr view` — the PR closes the issue). A blocked issue gets a
GitHub comment with the receipt + its unblock command; never auto-retried.
A full lap takes tens of minutes — report and stop polling after the first
few status checks.

## Phase 8 — handoff (day-2 = the pi-factory skill)

Tell the user exactly this, in their own terminal (the agent never prints
the key):

- On the **server**, read the key once: `sudo cat /home/factory/factoryd.env`
- On the **laptop**:
  ```sh
  export FACTORY_URL=https://<domain>
  export FACTORY_API_KEY=<key from factoryd.env>
  python3 bin/factory-remote doctor     # from any checkout of the factory repo
  ```
- Stored config: `~/.config/factory-remote/` (url + key files), used by the
  `pi-factory` skill automatically.

From now on everything (onboarding, backlog, laps, unblock, cleanup) is
remote over HTTPS — **zero SSH**. Updating the factory later:
`git pull && bun install` in `/home/factory/pi-dark-factory` — state is
external, nothing else changes. If the user mirrors repo skills into their
global skills dir, re-copy after updates (the in-repo copies are the source
of truth).

## Hard rules

- **Never echo a secret** (API key, GH token, ClinePass keys) — 600 files,
  fingerprints only. Never commit any of them.
- **Never arm the timer before Phase 4's smoke call passed** — a timer
  against an unauthed install burns provider errors on a loop.
- **Never run laps as root or as the session user** — laps belong to the
  `factory` user and its cgroup.
- **Never re-do existing work** — re-runs resume; installing twice is a bug.
- Report skipped/failed phases honestly in the final "definition of done"
  summary — a half-verified install must never be called done.
