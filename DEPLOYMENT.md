# VPS deployment runbook

Tested shape: Ubuntu VPS, dedicated `factory` user, host-side git worktrees (no per-lap Docker),
serialized laps. Deployment assumes ~11GB RAM shared with other services — keep the factory
serialized (it is by design: one lap at a time, one tick at a time).

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
TimeoutStartSec=4h
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
- **Memory doctrine** (from the old factory's postmortems): keep laps serialized (default),
  don't run parallel `tick`s across repos on a saturated host, and if streams stall check
  `free -h` / swap before blaming the provider — the old "silent streams" was host OOM, always.

## 7. Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `tick skipped: another tick is live` | pidfile held by a live foreman | wait, or verify the pid and clear the stale lock |
| laps.log shows `idle: no claimable issue` | backlog empty / all claimed / deps open | `gh issue list`, `foreman status` |
| `port … is busy` in a scenario result | leftover server or port collision | check reserved ports in every config; `ss -ltnp`; fix the holder |
| provider_error on every lap | bad model string / expired key / quota | smoke `pi --mode json --provider … --model …` as the factory user |
| worktree exists but no lap runs | blocked issue's forensics | `foreman unblock <slug> <n> --prune` when done investigating |
| merged PR but issue stayed open | squash message lacked "Closes #n" | the merge stage closes it deterministically; if it also failed, `gh issue close` — the next tick's reconcile pass books it as merged |
