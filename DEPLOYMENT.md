# VPS deployment runbook

Tested shape: Ubuntu VPS, dedicated `factory` user, host-side git worktrees, **one lap per repo
per tick** (dependency chains dive issue by issue; repos run concurrently with each other, cap
via `--concurrency N` / `PI_FACTORY_CONCURRENCY`). Optional per-repo container mode gives agent
stages root inside their own Docker environment (`env.mode: "compose"`) — install anything,
host stays clean.

## 1. Factory user

```sh
sudo adduser --disabled-password --gecos "pi dark factory" factory
sudo usermod -aG docker factory   # only if something else needs it; the factory itself does NOT
sudo loginctl enable-linger factory
```

Everything below runs as `factory` (`sudo -u factory -H bash -l`) unless noted.

## 2. Runtimes

```sh
# Bun (official installer — needs unzip; or npm i -g bun)
curl -fsSL https://bun.sh/install | bash

# Pi (upstream: https://pi.dev — e.g. npm global, or the managed installer)
npm install -g @earendil-works/pi-coding-agent   # or per upstream docs
pi --version

# git + gh + curl
sudo apt-get install -y git gh curl
gh auth login        # or export GH_TOKEN in the service unit
```

## 3. Factory code + state

```sh
git clone https://github.com/<you>/pi-dark-factory.git ~/pi-dark-factory
cd ~/pi-dark-factory && bun install

# state lives OUTSIDE the repo so `git pull` updates never touch it
mkdir -p ~/state
# optionally pin a specific provider set in ~/.pi/agent/settings.json / models.json
```

Pi auth as the `factory` user: `pi auth login` per provider (OAuth flows), or put API keys in
`~/.pi/agent/auth.json`, or set provider env vars (e.g. `OPENROUTER_API_KEY`) in the systemd
unit. Model strings in repo configs must match what `pi --provider X --model Y` accepts as this
user — smoke it first:

```sh
pi --mode json --no-tools --provider zai --model glm-5.3 "say OK" </dev/null
```

If the project-trust prompt appears in headless runs, set default trust in
`~/.pi/agent/settings.json` (or pass `--approve` via the repo config's `pi.extra_args`) so no
unattended run can ever block on a question nothing can answer.

## 4. systemd units

`/etc/systemd/system/pi-factory.service`:

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
ExecStart=/home/factory/.bun/bin/bun src/foreman.ts tick
# unlimited parallel laps can run long — never time out the tick itself; only
# its per-stage watchdogs kill anything
TimeoutStartSec=infinity
# the service cgroup reaps anything a lap leaked — no orphaned workers
KillMode=control-group
```

`/etc/systemd/system/pi-factory.timer`:

```ini
[Unit]
Description=run pi-dark-factory every 15 minutes

[Timer]
OnCalendar=*-*-* *:00/15:00
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pi-factory.timer
systemctl list-timers pi-factory.timer
```

systemd never overlaps the same service, and the foreman's pidfile additionally guards a manual
`tick` against the scheduled one.

## 5. First project (greenfield)

```sh
cd ~/pi-dark-factory
bun src/foreman.ts onboard <owner>/<new-repo>
# 1. edit ~/state/repos/<slug>/config.json — set models.default (+ per-stage tiers)
# 2. edit ~/state/repos/<slug>/runtime.json and holdout.json — real setup/start/probes
bun src/foreman.ts backlog <slug> --prd <path-to-PRD> --dry-run   # review the slice
bun src/foreman.ts backlog <slug> --prd <path-to-PRD>             # create the issues
bun src/foreman.ts tick                                           # first lap (spends tokens)
tail -f ~/state/laps.log                                           # the audit spine
bun src/foreman.ts status
```

Smoke-test order (recommended): a toy repo with a trivial runtime scenario first, then the real
project. The slicer's issue #1 is the end-to-end walking skeleton by prompt contract.

## 6. Operations

- **Blocked issue** (attempt cap hit): the issue gets a comment with the receipt + the unblock
  command. Fix the cause (bad scenario file, provider outage, genuinely hard issue), then:
  `bun src/foreman.ts unblock <slug> <issue> [--prune]`.
- **Weekly hygiene**: `bun src/foreman.ts cleanup` — prunes dep caches in blocked worktrees
  (code kept for forensics), kills stale `pi --mode json` processes (>2h), reports disk.
- **Observability**: `laps.log` + `foreman status` + issue comments + Pi session JSONLs under
  `~/state/repos/<slug>/issues/<n>/sessions/`.
- **Updating the factory**: `git pull && bun install` in `~/pi-dark-factory` — state is external,
  nothing else to do. systemd unit unchanged.
- **Ordering & scale**: one lap per repo per tick — the dependency chain advances one link per
  15-minute tick, never two branches at once on one repo. Onboard more repos to get more
  parallelism (each repo gets its own lap per tick); `--concurrency` caps total simultaneous
  laps if the host needs a breath.

## 7. Container mode (install freedom, per repo)

Give the `factory` user docker access (non-sudo): `sudo usermod -aG docker factory` (re-login).
Then per repo, in `~/state/repos/<slug>/config.json`:

```json
"env": { "mode": "compose", "service": "worker", "compose_file": "docker-compose.yml" }
```

**Worker service contract** (in the product repo): any built service — a copy of your dev/app
service is fine. The factory only overrides the *command*: each stage becomes
`docker compose -f <compose> run --rm --service-ports --workdir <worktree> <service> pi …`, so:

- the worker's image must contain the project's toolchain (or make the agent install it —
  it can, it's root);
- the worker service declares the **scenario port pair published on `127.0.0.1`** — the factory
  passes `--service-ports` because `compose run` publishes nothing by default;
- `depends_on` services (falkordb, postgres…) come up automatically for every stage —
  runtime verification finally exercises real dependencies instead of `-m "not falkordb"`.

A complete factory-ready compose example lives at
`templates/docker-compose.product-example.yml` — copy the shape into the product repo, or
let the implementer ship its own as an issue deliverable.

Stages mount the worktree, the state dir, and the factory user's Pi install at identical
container paths; `safe.directory=*` and `HOME=/root` are pre-set; `env.pass_env` forwards
model keys when they exist on the host.

**Repos without a compose file yet**: the factory falls back to `docker run --rm` from
`env.image` (default `ubuntu:24.04`) with named cache volumes (`pdf-uv`, `pdf-pip`, `pdf-npm`)
and publishes `scenario.ports` itself. The implementer can ship the repo's compose as an
ordinary issue deliverable and you flip nothing — the factory picks the compose file up
automatically once it exists in the worktree.

Smoke check before the first container lap (run as `factory`):

```sh
docker run --rm -v ~/.pi:/root/.pi -v ~/.pi/agent/bin/pi:/usr/local/bin/pi:ro \
  ubuntu:24.04 pi --version       # the mounted launcher works in a bare image
```

If the launcher refuses inside a bare image, pin `env.image` to an image with node, or install
`@earendil-works/pi-coding-agent` in your worker Dockerfile. Cleanup is automatic: every stage
and scenario start carries a unique `--name`, and `docker rm -f` follows it on success, timeout,
or crash.

## 8. Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `tick skipped: another tick is live` | pidfile held by a live foreman | wait, or verify the pid and clear the stale lock |
| laps.log shows `idle: no claimable issue` | backlog empty / all claimed / deps open | `gh issue list`, `foreman status` |
| `port … is busy` in a scenario result | leftover server or port collision | check reserved ports in every config; `ss -ltnp`; fix the holder |
| provider_error on every lap | bad model string / expired key / quota | smoke `pi --mode json --provider … --model …` as the factory user |
| worktree exists but no lap runs | blocked issue's forensics | `foreman unblock <slug> <n> --prune` when done investigating |
| merged PR but issue stayed open | squash message lacked "Closes #n" | the merge stage closes it deterministically; if it also failed, `gh issue close` — the next tick's reconcile pass books it as merged |
