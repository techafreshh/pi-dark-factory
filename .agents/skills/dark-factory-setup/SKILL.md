---
name: dark-factory-setup
description: >-
  Install or repair pi-dark-factory ON ITS SERVER: factory user, runtimes (bun,
  pi, gh), GitHub and model-provider auth, pi provisioning (models.json,
  packages, thinking levels), code + state dirs, the factoryd API with its
  built-in scheduler, optional machine lanes (InstaBox, boxd), container mode,
  ClinePass key router, web grounding, dashboard, backups, the Caddy block, and
  a smoke lap. Use when the user says "set up the factory", "install /
  provision / bootstrap the factory on this server", "wire up factoryd", or
  starts an agent session in a fresh clone of pi-dark-factory on a server. Not
  for day-2 operation from a laptop; that is the dark-factory skill.
---

# dark-factory-setup (server installer)

Runs on the factory server, from a checkout of this repo. It produces
everything the `dark-factory` skill assumes. The factory's own copy of the
code lives at `/home/factory/pi-dark-factory`, and its state at
`/home/factory/state`, outside the checkout, so `git pull` never touches it.
Reference docs: `DEPLOYMENT.md` (troubleshooting in §9) and
`docs/operations.md`.

**Done means:**
- `pi-factoryd` is healthy on :8077 and its scheduler starts repo ticks every
  15 minutes (`scheduler_minutes: 15` in `/health`).
- The API key is in `/home/factory/factoryd.env` (600).
- pi is provisioned for the factory user, and every model string a repo
  config will use returned text in a smoke call.
- Each optional piece the user chose passed its own check.
- A laptop can run `dark-factory doctor` over HTTPS.

## Rules

- **Ask all decisions in one batch up front** (Phase 0), then run the phases.
  Say one line before each sudo or system change.
- **Verify every phase, and stop on red.** Diagnose with DEPLOYMENT.md §9
  instead of pushing on.
- **Idempotent.** Detect what exists (`id`, `command -v`, `systemctl
  status`, file checks) and skip it. A re-run resumes; it never reinstalls
  or regenerates a key.
- **Never echo a secret** (API keys, GH token, provider keys). Write them
  into 600-mode files owned by `factory`, and show at most the first 4 chars
  and the length.
- **Factory-owned work runs as `factory`:** `sudo -u factory -H bash -lc '…'`.
  Only system pieces (user, units, `/etc/hosts`) use plain sudo.
- **Never enable the scheduler before Phase 4 passes.** An unauthed factory
  burns provider errors on a loop.

## Phase 0 — orientation and decisions

```sh
head -2 /etc/os-release                      # Ubuntu + systemd is the tested shape
systemctl --version >/dev/null || echo "NO SYSTEMD: stop"
grep '"name"' package.json                   # inside the factory checkout?
id factory 2>/dev/null
command -v git gh curl bun pi docker ssh
systemctl status pi-factoryd pi-keyrouter pi-factory-dashboard 2>&1 | grep -E "●|Active"
sudo test -f /home/factory/factoryd.env && echo "factoryd.env exists: keep its key"
```

Ask in one batch. The defaults hold on "just set it up".

1. **GitHub auth:** `gh auth login` as factory (device flow), or a token for
   `factoryd.env`.
2. **Model lineup:** which providers and models per stage (plan, implement,
   review), the thinking levels, and the fallback chains. pi ships with no
   providers, so Phase 4 auths and smoke-tests every exact
   `provider/model:thinking` string.
3. **pi packages or extensions** the stages must load (default none).
4. **Domain** for the API (default: the user's factory subdomain) and how
   Caddy runs (host or container).
5. **Lanes** for the repos planned now (default `instabox`, the fleet's main
   lane):
   - `instabox` needs `INSTABOX_API_KEY` and a stack-base snapshot.
   - `boxd` needs `BOXD_API_KEY` and the `factory-base-boxd-r1` snapshot in
     the boxd org.
   - `compose` needs docker on the host.
   - `host` needs nothing.
6. **TinyFish web grounding** (default on): needs `TINYFISH_API_KEY`.
   Without it, stages simply run without web tools.
7. **ClinePass key router** (default off): only if they have ClinePass keys.
8. **Dashboard** (default on): needs an auth layer in front, such as SSO.
9. **Backups** (default on): needs an S3-compatible bucket and keys.
10. **Smoke lap** after install (recommended; a few cents on a toy repo).

## Phase 1 — factory user

```sh
id factory &>/dev/null || sudo useradd -m -s /bin/bash -c "pi dark factory" factory
sudo loginctl enable-linger factory
# instabox lane: machine stages run over ssh
command -v ssh >/dev/null || sudo apt-get install -y openssh-client
# compose lane only: docker + group membership
command -v docker >/dev/null || sudo apt-get install -y docker.io
sudo systemctl enable --now docker && sudo usermod -aG docker factory
```

Membership in the docker group is root-equivalent, and any agent on a
host-mode or compose-mode repo runs as `factory`. Add it only when a compose
repo is planned, and tell the user so.

Verify with `id factory` and `loginctl show-user factory -p Linger`.

## Phase 2 — runtimes

```sh
sudo apt-get update -qq && sudo apt-get install -y git gh curl unzip
sudo -u factory -H bash -lc 'command -v bun || curl -fsSL https://bun.sh/install | bash'
sudo -u factory -H bash -lc 'command -v pi || ~/.bun/bin/bun add -g @earendil-works/pi-coding-agent'
sudo -u factory -H bash -lc 'bun --version && pi --version && gh --version | head -1'
```

If node is installed for the factory user (`~/.local/node/bin`), that
directory goes first on the units' `PATH`, as in Phase 5.

## Phase 3 — code and state

```sh
URL=$(git remote get-url origin)
sudo -u factory -H test -d /home/factory/pi-dark-factory/.git \
  && sudo -u factory -H bash -lc 'cd ~/pi-dark-factory && git pull --ff-only' \
  || sudo -u factory -H git clone "$URL" /home/factory/pi-dark-factory
sudo -u factory -H bash -lc 'cd ~/pi-dark-factory && ~/.bun/bin/bun install --frozen-lockfile'
sudo install -d -o factory -g factory /home/factory/state
sudo -u factory -H bash -lc 'cd ~/pi-dark-factory && ~/.bun/bin/bun src/foreman.ts help' | head -3
```

## Phase 4 — pi provisioning (the gate for Phase 5)

**4a. GitHub.** Run `sudo -u factory -H gh auth login` (relay the device
code), or put the token in `factoryd.env` in Phase 5. Verify with
`sudo -u factory -H gh api user -q .login`.

**4b. Provider auth.** For each provider in the lineup, run
`sudo -u factory -H bash -lc 'pi auth login'` (an OAuth device flow; relay
the URL and code), or add keys to `~/.pi/agent/auth.json`.
`models.json` `apiKey` fields can also interpolate `"$ENV_VAR"`.

**4c. Custom providers.** Non-built-in providers go in the factory user's
`~/.pi/agent/models.json`. pi installs without one, so create it. The shape
is `{"providers": {"<id>": {"name", "baseUrl", "apiKey", "api", "models":
[{"id", "reasoning", "contextWindow", "maxTokens", "thinkingLevelMap"}]}}}`.

- **Thinking levels.** A model's `thinkingLevelMap` decides which levels
  work: `xhigh` and `max` need an entry, and a level mapped to `null` runs
  with no reasoning. Remote config writes validate against this same file
  (`dark-factory models` shows it).
- **Key router.** If the router was chosen, merge the `providers` object from
  `templates/pi-models.clinepass-router.json` into this file, keeping what is
  already there.

**4d. Packages and extensions.**
`sudo -u factory -H bash -lc 'pi install npm:<pkg>@<ver>'`, then `pi list`.
Loose `.ts` extensions can go into `~/.pi/agent/extensions/`. A missing
package never fails loudly (the stage just runs without it), so confirm every
promised one appears in `pi list`.

**4e. Smoke every exact model string the repo configs will use:**

```sh
sudo -u factory -H bash -lc \
  'pi --mode json --no-tools --provider <provider> --model <model> --thinking <level> "say OK" </dev/null' | tail -c 400
```

- **Pass condition.** A string passes only when the call returns assistant
  text. The passing strings are what repo configs may use.
- **Trust prompts.** If a project-trust prompt appears, set default trust in
  `~/.pi/agent/settings.json`. No unattended run may block on a question.

**4f. Container launcher** (compose lane only). Compose stages run
`/usr/local/bin/pi`, bind-mounted from `~/.pi/agent/bin/pi`. The launcher has
to work in glibc and musl images (for example `node:22-alpine`, where the
host's glibc node can't run):

```sh
CLI=$(sudo -u factory -H bash -lc 'ls ~/.pi/host-runtimes/pi-coding-agent/dist/bundle/cli.js 2>/dev/null || find ~/.local/node ~/.bun /usr/lib/node_modules -path "*pi-coding-agent/dist/bundle/cli.js" 2>/dev/null | head -1')
test -n "$CLI" || echo "NO cli.js FOUND: stop and resolve the pi install"
sudo -u factory -H mkdir -p /home/factory/.pi/agent/bin
sudo -u factory -H bash -c 'cat > /home/factory/.pi/agent/bin/pi <<WRAP
#!/bin/sh
# prefer the container'"'"'s own node (musl images); else the mounted host runtime
if command -v node >/dev/null 2>&1; then
  exec node '"$CLI"' "\$@"
fi
exec /root/.pi/host-runtimes/node/bin/node '"$CLI"' "\$@"
WRAP'
sudo -u factory -H chmod 775 /home/factory/.pi/agent/bin/pi
SEED=/home/factory/.pi/host-runtimes/node/bin/node
sudo -u factory -H mkdir -p "$(dirname $SEED)"
sudo -u factory -H test -x "$SEED" || sudo -u factory -H bash -lc "cp \$(command -v node) $SEED"
for IMG in node:22-alpine node:22; do
  sudo -u factory -H docker run --rm -v /home/factory/.pi:/root/.pi \
    -v /home/factory/.pi/agent/bin/pi:/usr/local/bin/pi:ro $IMG /usr/local/bin/pi --version || echo "FAILED on $IMG"
done
```

## Phase 5 — services

**5a. `/home/factory/factoryd.env`** (600, owned by factory). If it already
exists, keep the key and only add missing lines. Write it in one sudo
heredoc with secrets passed straight in, never printed:

| var | value |
|---|---|
| `PI_FACTORY_STATE` | `/home/factory/state` |
| `FACTORYD_PORT` | `8077` |
| `FACTORY_API_KEY` | `$(openssl rand -hex 32)` |
| `DARK_FACTORY_LAPTOP_KEY` | optional second key, `openssl rand -hex 32`, so the laptop key can be revoked on its own |
| `GH_TOKEN` and `GITHUB_TOKEN` | both, same value, if the token route was chosen (machine stages read `GITHUB_TOKEN`) |
| `INSTABOX_API_KEY` / `BOXD_API_KEY` / `TINYFISH_API_KEY` | per Phase 0 |

**5b. `/etc/systemd/system/pi-factoryd.service`.** The daemon serves the API
and schedules the ticks: every 15 minutes it starts one `foreman tick --repo`
process per idle repo. `KillMode=process` lets a restart leave running laps
alone.

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
Environment=PDF_SCHEDULER_MINUTES=15
KillMode=process
ExecStart=/home/factory/.bun/bin/bun src/factoryd.ts
Restart=always

[Install]
WantedBy=multi-user.target
```

- **Optional cap.** `PI_FACTORY_CONCURRENCY=N` limits how many repo ticks run
  at once. On machine lanes, the platform's machine quota is the real cap.
- **Old timer.** The legacy `pi-factory.timer` fleet tick must not run
  alongside the scheduler: `systemctl disable --now pi-factory.timer` if it
  exists.

**5c. Key router** (optional) — `/etc/systemd/system/pi-keyrouter.service`:

```ini
[Unit]
Description=clinepass key router (multi-key failover)
After=network-online.target
Wants=network-online.target

[Service]
User=factory
WorkingDirectory=/home/factory/pi-dark-factory
Environment=CRPASS_KEYS_FILE=/home/factory/state/clinepass.keys
Environment=CRPASS_STATE_FILE=/home/factory/state/clinepass.keys.state.json
Environment=CRPASS_PORT=8099
Environment=CRPASS_UPSTREAM=https://api.cline.bot/api
EnvironmentFile=/home/factory/keyrouter.env
Environment=PATH=/home/factory/.local/node/bin:/home/factory/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/home/factory/.bun/bin/bun src/keyrouter.ts
Restart=always

[Install]
WantedBy=multi-user.target
```

- **`keyrouter.env`** (600) holds `CRPASS_ROUTER_TOKEN=<random>`. The same
  value is the `clinepass-rotator` `apiKey` in `models.json`; without it the
  router is open to every local container (`docs/keyrouter.md`).
- **Keys** go in `/home/factory/state/clinepass.keys` (600): one per line,
  live-reloaded.
- **Hosts entry.**
  `grep -q host.docker.internal /etc/hosts || echo "127.0.0.1 host.docker.internal" | sudo tee -a /etc/hosts`.
- Machine lanes can't reach this router, so their fallback chains skip it.

**5d. Enable and verify**, only after Phase 4 passed:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pi-factoryd
sudo systemctl enable --now pi-keyrouter                 # if chosen
curl -fsS http://127.0.0.1:8077/health                   # ok:true, scheduler_minutes:15
curl -fsS http://127.0.0.1:8099/health                   # if the router was chosen
```

**5e. Machine lanes.**

*InstaBox:* prove the key and read the quota without printing the key:

```sh
sudo -u factory -H bash -lc 'set -a; . /home/factory/factoryd.env; set +a
  curl -fsS https://api.instabox.sh/v1/me -H "X-API-Key: $INSTABOX_API_KEY" | head -c 200; echo
  curl -fsS https://api.instabox.sh/v1/usage -H "X-API-Key: $INSTABOX_API_KEY"'
```

- **Quota.** Tell the user the machine limit from `usage.limits`; it caps
  concurrent machine laps.
- **Stack base.** Repos boot from an alias in
  `/home/factory/state/base-snapshot.json`:

  ```json
  {"shared-base": {"snapshot": "<snapshot-name>", "contents": "<what is installed>"}}
  ```

  On a fresh install there is no base yet. Bake one from the smoke repo
  (Phase 7):
  1. Set its `env.instabox.snapshot` to `""`.
  2. Set its `env.instabox.bake` to a script that installs what stages need
     on top of the template. pi at least, e.g.
     `sudo npm i -g @earendil-works/pi-coding-agent`.
  3. Run `foreman bake <slug>`. It saves `<slug>-base` and writes that name
     into the config.
  4. Add a `shared-base` entry pointing at that snapshot, so other repos can
     use the alias.

*boxd:* `BOXD_API_KEY` is in `factoryd.env`, and the org must have the
`factory-base-boxd-r1` snapshot (or a repo sets `env.boxd.snapshot`). The
first smoke lap is the check.

**5f. Web grounding** (if `TINYFISH_API_KEY` is set):

```sh
sudo -u factory -H bash -lc 'set -a; . /home/factory/factoryd.env; set +a; cd ~/pi-dark-factory &&
  pi --mode json --no-session --tools read,web_search,web_fetch --extension pi-extensions/pdf-tinyfish.ts \
     -p "Call web_search with query \"tinyfish api\" and reply COUNT=<n> only."' | grep -o 'COUNT=[0-9]*'
```

It passes when the output is `COUNT=n` with n ≥ 1.

**5g. Dashboard** (optional). This is a read-only sidecar, `bin/dashboard.ts`.
It must sit behind an auth layer, because it shows agent sessions.
1. Create `/home/factory/dashboard.env` (600) with `INSTABOX_API_KEY=` and
   `BOXD_API_KEY=` for the machine panel.
2. Create `/etc/systemd/system/pi-factory-dashboard.service` with:
   - `User=factory`;
   - `ExecStart=/home/factory/.bun/bin/bun /home/factory/pi-dark-factory/bin/dashboard.ts`;
   - `Environment=DASHBOARD_STATE_DIR=/home/factory/state`;
   - `DASHBOARD_HOST=<address Caddy reaches, never a public interface>`;
   - `DASHBOARD_PORT=8787`;
   - `Restart=always`;
   - `[Install] WantedBy=multi-user.target`.
3. Enable it, then check with `curl -fsS http://<host>:8787/health`.

**5h. Backups** (optional). `bin/backup.ts` snapshots the ledger and the
small state hourly to an S3 bucket. Use a dedicated bucket and a user scoped
to it.
1. Create `/home/factory/backup.env` (600) with `S3_ENDPOINT`, `S3_BUCKET`,
   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
2. Create the units:
   - `pi-factory-backup.service`: `Type=oneshot`, `User=factory`,
     `EnvironmentFile=/home/factory/backup.env`,
     `Environment=PI_FACTORY_STATE=/home/factory/state`,
     `ExecStart=/home/factory/.bun/bin/bun /home/factory/pi-dark-factory/bin/backup.ts`.
   - `pi-factory-backup.timer`: `OnCalendar=*-*-* *:07:00`, `Persistent=true`,
     `[Install] WantedBy=timers.target`.
3. Enable the timer, run the service once, and check `bun bin/backup.ts list`
   as factory.

A bucket on the same server protects against corruption, not disk loss, so
say so.

## Phase 6 — Caddy

Route the API through Caddy with an edge key check, in addition to the
daemon's own check. Write the block to a 600-mode file and give the user the
path; never print the keys.

```
<domain> {
  @health path /health
  handle @health { reverse_proxy <daemon-addr>:8077 }
  @unauthorized {
    not header X-Api-Key <FACTORY_API_KEY>
    not header X-Api-Key <DARK_FACTORY_LAPTOP_KEY>
  }
  handle @unauthorized { respond 401 }
  reverse_proxy <daemon-addr>:8077
}
```

- **Host vs container Caddy.** With Caddy on the host, `<daemon-addr>` is
  `127.0.0.1`. With Caddy in a container, it is the docker bridge gateway
  (for example `10.0.1.1`). Allow the port from that subnet only, e.g.
  `ufw allow from 10.0.1.0/24 to any port 8077`.
- **Dashboard.** It goes in the same site block under
  `/dashboard/*` (`handle_path`, so the prefix is stripped), behind the SSO
  `forward_auth`. Put it before the `@unauthorized` handler.

Verify from outside:
- `curl -s -o /dev/null -w '%{http_code}' https://<domain>/status` gives
  `401`;
- `/health` gives `200`.

## Phase 7 — smoke lap (optional; small token spend)

Use a toy repo with a tiny PRD. Run it through the `dark-factory` skill from
this server, or with `foreman` directly:

```sh
F='sudo -u factory -H bash -lc'
$F 'cd ~/pi-dark-factory && bun src/foreman.ts onboard <owner>/<name>'
# edit /home/factory/state/repos/<slug>/config.json: models from Phase 4e, env.mode,
# and for instabox: env.instabox.snapshot "shared-base", or "" plus env.instabox.bake to bake one (5e)
$F 'cd ~/pi-dark-factory && bun src/foreman.ts bake <slug>'          # instabox, only when baking its own snapshot
# write real runtime.json + holdout.json probes (dark-factory skill, Stage 3)
$F 'cd ~/pi-dark-factory && bun src/foreman.ts backlog <slug> --prd <path> --dry-run'
$F 'cd ~/pi-dark-factory && bun src/foreman.ts backlog <slug> --prd <path>'
$F 'cd ~/pi-dark-factory && bun src/foreman.ts tick --repo <slug>'
tail -f /home/factory/state/laps.log
```

- **Confirm on GitHub.** A `merged` ledger row is confirmed by the merged PR
  (`gh pr view`).
- **If it blocks.** A blocked issue gets a GitHub comment and revives by
  itself on later ticks (3 times a day at most). Fix the cause rather than
  waiting.
- **Machine names.** Machine laps show up as `pdf-<slug>-i<issue>-g<lapId>`,
  and each machine is deleted when its lap ends.

## Phase 8 — handoff

Tell the user to run these themselves; the agent never prints the key:

- **On the server**, read the key once:
  `sudo grep -E '^(DARK_FACTORY_LAPTOP_KEY|FACTORY_API_KEY)=' /home/factory/factoryd.env`.
- **On the laptop:**
  ```sh
  npx @techafresh/dark-factory setup https://<domain> <key>
  dark-factory doctor
  ```

From then on, everything runs remotely through the `dark-factory` skill.

**Updating the factory later:**
```sh
cd /home/factory/pi-dark-factory && sudo -u factory git pull --ff-only
# plus bun install when package.json changed
sudo systemctl restart pi-factoryd
```
A restart is safe while laps run. Restart `pi-factory-dashboard` after
dashboard changes.

Final report: list every phase as done, skipped (by choice) or failed. A
half-verified install is not "done".
