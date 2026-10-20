---
name: pi-factory-setup
description: >-
  Install / provision pi-dark-factory ON ITS DEDICATED SERVER (VPS): the full
  first-time setup — factory user, runtimes (bun, pi, gh), GitHub + provider
  auth, code clone + state dir, systemd timer + factoryd API (optional ClinePass
  key router), Caddy block, and an optional first smoke lap. Use when the user
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
`factoryd.env` (600); optionally `pi-keyrouter` healthy on :8099; a `pi` smoke
call works as the factory user; optionally a first smoke lap ran its gates;
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
command -v git gh curl bun pi docker          # what's installed
systemctl status pi-factory.timer pi-factoryd.service 2>&1 | head -5
test -f /home/factory/factoryd.env && echo "factoryd.env exists (key already generated)"
```

Then ask the user, **in one batch** (defaults noted — accept defaults on a
plain "just set it up"):

1. **Factory user name** — default `factory`.
2. **GitHub auth** — interactive `gh auth login` as the factory user (device
   flow), or a `GH_TOKEN` to put in `factoryd.env`?
3. **Remote control** (default: yes) — generate the API key and run factoryd
   on :8077. If yes: which **domain** serves it (Caddy block)?
4. **ClinePass key router** — only if they have ClinePass API keys (how many?).
   Otherwise skip Phase 5c entirely.
5. **Container-mode repos planned?** (default: not now) — if yes, add the
   factory user to the `docker` group in Phase 1.
6. **Smoke lap after install?** (recommended; spends a few cents of tokens on
   a toy repo) — vs. going straight to a real project via the `pi-factory`
   wizard.

## Phase 1 — factory user

```sh
id factory &>/dev/null || sudo useradd -m -s /bin/bash -c "pi dark factory" factory
sudo loginctl enable-linger factory            # user services survive logout
# only if container mode is planned:
id -nG factory | grep -qw docker || sudo usermod -aG docker factory
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

## Phase 4 — auth (the token-burning prereq — everything else gates on this)

**GitHub** — either have the user complete
`sudo -u factory -H gh auth login` (device flow: relay the code), or append
`GH_TOKEN=<token>` to `/home/factory/factoryd.env` (600). Verify:
`sudo -u factory -H gh api user -q .login`.

**Pi providers** — for each provider the user's repo configs will use
(`zai`, `openrouter`, `anthropic`, `clinepass-rotator`, …):
`sudo -u factory -H bash -lc 'pi auth login'` (OAuth device flows — hand the
user the URLs/codes), or keys into `~/.pi/agent/auth.json` / env vars that go
into the systemd env file. Then the smoke call — **this is the gate for
Phase 5**; if it fails, no timer gets armed.

```sh
sudo -u factory -H bash -lc \
  'pi --mode json --no-tools --provider <provider> --model <model> "say OK" </dev/null'
```

If a project-trust prompt ever appears here, set default trust in
`~/.pi/agent/settings.json` — no unattended run may ever block on a question
nothing can answer. Note which provider/model strings succeeded: they are
what goes into each repo config's `models`.

## Phase 5 — systemd (units, env file, enable)

**5a. factoryd.env** — skip key generation if it exists (a re-run keeps the
old key); otherwise generate and assemble in one sudo heredoc, never echoing
the value: `PI_FACTORY_STATE=/home/factory/state`, `FACTORYD_PORT=8077`,
`FACTORY_API_KEY=$(openssl rand -hex 32)`, and `GH_TOKEN=…` if Phase 4 used
the token form. `chown factory: /home/factory/factoryd.env`, `chmod 600`.

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
`/home/factory/state/repos/<slug>/config.json` (models — prefer a disciplined
model for implement/review, cheaper for plan; see also the ClinePass router
entry `templates/pi-models.clinepass-router.json` for `clinepass-rotator`
wiring), write real `runtime.json` + `holdout.json` probes with the user,
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
