# Plan: Docker install for laptops (and VPSes)

## Summary

Ship a `docker/` directory that runs the factory as a Docker Compose stack, so anyone with Docker
can run it on a laptop with no VPS, no systemd and no Caddy. One image (Node 22 + Bun + pi + gh +
git + ssh) runs two services: `factoryd` (API + built-in scheduler, host mode inside the container,
plus the cloud lanes `instabox` and `boxd`) and `dashboard`. Both publish only on `127.0.0.1`.
The existing `@techafresh/dark-factory` CLI drives it at `http://localhost:8077`. The
`dark-factory-setup` skill gets a first question ("Docker or bare-metal systemd?") and a new Docker
path. The systemd path stays as is, marked legacy once the Docker stack has run real laps.
Four small engine changes support this: a tick on startup, a dashboard env fallback for machine-panel
keys, and CLI wording and warning changes. Compose mode is out of scope.

## User Story

As someone without a VPS
I want to clone the repo, answer a few setup questions and have the factory running in Docker
So that I can onboard repos and let it build them from my own computer

## Metadata

| Field | Value |
|-------|-------|
| Type | NEW_CAPABILITY |
| Complexity | MEDIUM |
| Systems Affected | docker/ (new), src/scheduler.ts, src/factoryd.ts, bin/dashboard.ts, cli/, .agents/skills/dark-factory-setup, docs, README, DEPLOYMENT.md |
| Jira Issue | N/A |

## Decisions already made with the user

- Execution: `host` mode inside the container, plus `instabox` and `boxd`. No `compose` mode.
- Image: built locally with `docker compose up --build` in v1 (no GHCR yet). Base toolchain: Node,
  Python, common build tools. A per-repo `env.image` override is NOT usable in host mode (it is a
  compose-mode field), so a repo needing more tools uses a cloud lane or a custom `FACTORY_IMAGE_EXTRA`
  build arg (see Task 4).
- Auth: tokens and model keys through `.env` AND one-time OAuth login persisted to a volume.
- Install: user clones the repo and runs the setup skill, which asks "installing locally or on a VPS?".
- Laptop sleep: run a tick on startup, plus a docs note. No catch-up logic beyond that.
- Platforms: anywhere Docker runs (Linux, macOS incl. Apple Silicon, Windows). Named volumes, no bind
  mounts for state.
- Limits: conservative defaults, adjustable through `.env`.
- Dashboard: a second compose service from the same image, on its own port.
- Trust model (token scope): out of scope; docs may mention a fine-grained token in one line.
- Location: `docker/`. VPS runbook unchanged.

## Findings from the code that shape the design

| Fact | Source | Consequence |
|------|--------|-------------|
| `factoryd` refuses to start without `FACTORY_API_KEY` | `src/factoryd.ts:324-328` | Setup generates the key into `docker/.env`; no key = container exits |
| Scheduler is opt-in via `PDF_SCHEDULER_MINUTES`, and fires only on wall-clock multiples | `src/factoryd.ts:334-346`, `src/scheduler.ts:112-132` | Compose sets `PDF_SCHEDULER_MINUTES=15`; Task 1 adds the startup tick |
| `lock.ts` recognizes factory processes by cmdline or by a cwd matching `/pi-dark-factory/` | `src/lock.ts:15-30` | The image's code dir MUST contain `pi-dark-factory` (use `/opt/pi-dark-factory`), or live tick locks look dead and get stolen |
| Tick children are `detached` with their own process group | `src/scheduler.ts:38-47` | Run with `init: true` (tini) so exited children are reaped; `docker stop` kills laps (no `KillMode=process` equivalent), but crashed laps are reconciled on the next tick |
| Host-mode agents get an allowlisted env; default `pass_env` already forwards model keys and `GITHUB_TOKEN` | `src/agentenv.ts`, `src/ops.ts:205` | Keys in `.env` reach agents with no engine change |
| Commit identity is read from `~/.gitconfig` | `src/env.ts:11-20` | Entrypoint must write `user.name` / `user.email` |
| Host-side `git clone` of the source checkout uses plain `https://github.com/...` | `src/gitws.ts:49-58` | Entrypoint must give git credentials: `gh auth setup-git` |
| pi state lives in `$HOME/.pi` (`auth.json`, `models.json`, synced `extensions/` and `skills/`) | `src/skills.ts:90`, `src/webtools.ts:51`, `src/ops.ts:913` | Persist `/home/factory/.pi` in a named volume (OAuth logins survive) |
| `ssh` is the instabox transport | `src/machine.ts:70-91` | Image needs `openssh-client` |
| Dashboard reads machine-panel keys only from a file | `bin/dashboard.ts:228-235` | Task 2 adds a `process.env` fallback |
| Dashboard defaults: host `10.0.1.1`, factoryd health `http://127.0.0.1:8077/health` | `bin/dashboard.ts:27-30` | Compose overrides `DASHBOARD_HOST`, `DASHBOARD_FACTORYD_HEALTH`, `DASHBOARD_STATE_DIR` |
| Parallel mode works in machine modes only | `docs/parallel-mode.md` | Local host-mode repos are serial; the adjustable knobs are `PI_FACTORY_CONCURRENCY` (repos at once) and `PDF_POOL_*` |
| The CLI has no HTTPS enforcement | `cli/bin/dark-factory.js:99-107` | Works against `http://localhost:8077` unchanged |
| The CLI needs Node on the host | `cli/package.json` | Laptop users without Node use the CLI inside the container (Task 4 puts it on PATH) |

## Patterns to Follow

### Naming and env-driven config
```ts
// SOURCE: src/factoryd.ts:329-346
const stateDir = process.env.PI_FACTORY_STATE ?? "./state";
const port = Number(process.env.FACTORYD_PORT ?? 8077);
...
const every = Number(process.env.PDF_SCHEDULER_MINUTES ?? 0);
if (Number.isFinite(every) && every > 0) {
  const cap = Number(process.env.PI_FACTORY_CONCURRENCY ?? 0);
  startScheduler(stateDir, every * 60_000, Number.isFinite(cap) ? cap : 0);
```

### Errors in background passes: receipt, never throw
```ts
// SOURCE: src/scheduler.ts:118-124
try {
  await schedulePass(stateDir, { concurrency });
} catch (e: any) {
  receipt(stateDir, `scheduler pass failed: ${String(e?.message ?? e).slice(0, 300)}`);
}
```

### Tests: temp state dir, injected seams, cleanup in afterAll
```ts
// SOURCE: test/scheduler.test.ts:8-30, 36-46
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
...
const r = await schedulePass(st, { gapMs: 0, spawnTick: (_s, slug) => (spawned.push(slug), 1) });
```

### CLI verb test: injected `home`, `out`, `err`
```ts
// SOURCE: test/darkfactory-cli.test.ts:77-80
test("setup writes the config file, where reads it back masked", async () => {
  ...
  expect(await run(["setup", "https://factory.example/", "abcd-secret"], { home, out: (s) => out.push(String(s)) })).toBe(0);
```

### Docs: one topic per file in docs/, linked from the README docs table
```md
// SOURCE: README.md "## Docs" table (| [Parallel mode](docs/parallel-mode.md) | machine-slot allocator, ... |)
```

## Files to Change

| File | Action | Purpose |
|------|--------|---------|
| `src/scheduler.ts` | UPDATE | `startScheduler` gains an options bag: `runOnStart`, `startDelayMs`, injectable `pass` |
| `src/factoryd.ts` | UPDATE | Read `PDF_TICK_ON_START` and pass it to `startScheduler`; update stale "systemd timer" comments only where touched |
| `test/scheduler.test.ts` | UPDATE | Startup-tick tests |
| `bin/dashboard.ts` | UPDATE | Machine-panel keys: `process.env` first, then the key file |
| `test/dashboard.test.ts` | UPDATE | Cover the env fallback |
| `cli/bin/dark-factory.js` | UPDATE | "HTTPS" wording becomes "HTTP(S)"; `setup` warns on a non-HTTPS non-local URL |
| `cli/README.md`, `cli/package.json` | UPDATE | Wording; bump to 0.1.3 (publishing stays the owner's call) |
| `test/darkfactory-cli.test.ts` | UPDATE | Warning test |
| `.dockerignore` | CREATE | Keep `.env`, `.git`, `state`, `node_modules` out of the image |
| `docker/Dockerfile` | CREATE | The image |
| `docker/entrypoint.sh` | CREATE | git identity, gh credentials, first-run dirs, exec |
| `docker/compose.yml` | CREATE | `factoryd` + `dashboard`, volumes, loopback ports, limits |
| `docker/compose.caddy.yml` | CREATE | Override for a VPS behind Caddy: join `web_gateway`, publish nothing |
| `docker/.env.example` | CREATE | Documented variables |
| `docker/README.md` | CREATE | Short pointer to `docs/docker.md` plus the five-line quickstart |
| `test/docker.test.ts` | CREATE | Static invariants over the docker files |
| `docs/docker.md` | CREATE | Full guide: install, auth, adjust, update, troubleshoot, VPS-behind-Caddy, limits |
| `README.md`, `DEPLOYMENT.md`, `docs/operations.md`, `docs/development.md` | UPDATE | Link the Docker path; document `PDF_TICK_ON_START`; mark systemd path |
| `.agents/skills/dark-factory-setup/SKILL.md` | UPDATE | New Phase 0 question and the Docker path |

---

## Tasks

Execute in order. Each task is atomic and verifiable.

### Task 1: Startup tick

- **File**: `src/scheduler.ts`, `src/factoryd.ts`, `test/scheduler.test.ts`
- **Action**: UPDATE
- **Implement**:
  - Change `startScheduler(stateDir, everyMs, concurrency = 0)` to
    `startScheduler(stateDir, everyMs, concurrency = 0, opts: { runOnStart?: boolean; startDelayMs?: number; pass?: typeof schedulePass } = {})`.
    Existing callers keep working.
  - When `opts.runOnStart` is true, after `opts.startDelayMs` (default 10_000, so the API is up first)
    run one pass through the same try/catch + receipt path as the timer, and receipt
    `scheduler: startup pass`. Use `opts.pass ?? schedulePass`. `stop()` must clear this timer too.
  - Do not change the quarter-hour arming logic. A startup pass near a quarter hour is harmless:
    per-repo pidfiles stop a double run.
  - In `factoryd.ts`: `runOnStart: process.env.PDF_TICK_ON_START === "1"`, printed in the startup log
    line. Default stays off so a VPS daemon restart (a `git pull`) does not start extra laps.
- **Mirror**: `src/scheduler.ts:112-132` (timer + receipt on failure)
- **Tests** (mirror `test/scheduler.test.ts`):
  - with `runOnStart: true, startDelayMs: 0` and a fake `pass`, the fake is called once without
    waiting for the next quarter hour; `stop()` afterwards
  - without `runOnStart`, the fake is not called within a short wait
  - a throwing fake pass writes `scheduler pass failed:` to `laps.log` and does not throw
  - `stop()` before the delay elapses prevents the startup pass
- **Validate**: `bun test test/scheduler.test.ts`

### Task 2: Dashboard keys from the environment

- **File**: `bin/dashboard.ts`, `test/dashboard.test.ts`
- **Action**: UPDATE
- **Implement**: replace `keyFromFile(name)` with an exported `secret(name)` that returns
  `process.env[name]` when non-empty, otherwise the existing file lookup. The two call sites
  (`INSTABOX_API_KEY`, `BOXD_API_KEY`) use it. No other behavior changes.
- **Mirror**: `bin/dashboard.ts:228-235`
- **Tests**: env var wins over the file; file used when the env var is unset; empty env var falls
  back to the file; neither gives `null`. Use a temp key file through `DASHBOARD_ENV_FILE` the same way
  the existing dashboard test sets up its environment (read `test/dashboard.test.ts` first; if
  `KEY_FILE` is read at import time, pass the path as a parameter with a default instead).
- **Validate**: `bun test test/dashboard.test.ts`

### Task 3: CLI wording and the cleartext warning

- **File**: `cli/bin/dark-factory.js`, `cli/README.md`, `cli/package.json`, `test/darkfactory-cli.test.ts`
- **Action**: UPDATE
- **Implement**:
  - Header comment line 3, `USAGE` (line ~712) and `setup` help (~line 651): "over HTTPS" becomes "over HTTP(S)".
    Add `http://localhost:8077` as a second example next to the HTTPS one.
  - In `cmdSetup`, after storing: parse the URL; if the protocol is `http:` and the hostname is not
    `localhost`, `127.0.0.1`, `[::1]` or `*.localhost`, write one warning line to `ctx.err`
    (the key travels in cleartext). The URL is still stored and the exit code stays 0. An unparsable
    URL gets no warning (the existing behavior).
  - `cli/README.md`: add a short "Local Docker factory" subsection pointing at `docs/docker.md`.
  - `cli/package.json`: version 0.1.3.
- **Mirror**: `cli/bin/dark-factory.js:244-256`
- **Tests**: `http://localhost:8077` and `http://127.0.0.1:8077` produce no warning;
  `http://factory.example` warns; `https://factory.example` does not; the config file is written in
  every case.
- **Validate**: `bun test test/darkfactory-cli.test.ts`

### Task 4: Image, entrypoint, ignore file

- **File**: `docker/Dockerfile`, `docker/entrypoint.sh`, `.dockerignore`
- **Action**: CREATE
- **Implement (Dockerfile)**:
  - Base `node:22-bookworm-slim` (multi-arch; Node >= 22 is a pi requirement, DEPLOYMENT.md §2).
  - apt: `git gh curl unzip ca-certificates openssh-client python3 python3-pip build-essential tini`
    (`gh` from the Debian repo may be old; if so add GitHub's apt repo; verify `gh auth setup-git`
    exists).
  - Install Bun with the official installer pinned by `ARG BUN_VERSION`; install pi with
    `npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}` (ARG, default the version the VPS
    runs; check `pi --version` there). Copy `cli/` and symlink `/usr/local/bin/dark-factory` to
    `cli/bin/dark-factory.js` so laptop users without Node can run the CLI via `docker compose exec`.
  - `ARG FACTORY_IMAGE_EXTRA=""`: an optional shell snippet run in an `apt-get`/`pip` layer for extra
    toolchains; the docs show a one-line example (`--build-arg FACTORY_IMAGE_EXTRA="apt-get install -y golang"`).
  - Create user `factory` (uid 1000; remove the stock `node` user to avoid a uid clash). Pre-create
    `/home/factory/state` and `/home/factory/.pi` owned by `factory`, so named volumes inherit that
    ownership on first mount.
  - `COPY` the repo into `/opt/pi-dark-factory` (the path MUST contain `pi-dark-factory`, see the
    findings table), `chown` it, `WORKDIR /opt/pi-dark-factory`, then
    `bun install --frozen-lockfile --production`. `dashboard-ui/dist` is tracked, so no Vite build.
  - `USER factory`, `ENV PI_FACTORY_STATE=/home/factory/state`, `ENTRYPOINT ["/usr/bin/tini","--","/opt/pi-dark-factory/docker/entrypoint.sh"]`,
    default `CMD ["bun","src/factoryd.ts"]`. `HEALTHCHECK` curls `http://127.0.0.1:8077/health`.
- **Implement (entrypoint.sh)**, `set -eu`, secrets never echoed:
  1. Git identity: `GIT_USER_NAME`/`GIT_USER_EMAIL` if set; else, when a GitHub token is present, derive
     from `gh api user` (`login` and `<id>+<login>@users.noreply.github.com`); else a clearly labelled
     default (`pi-dark-factory` / `factory@localhost`) with a warning line. Write with `git config --global`.
  2. GitHub credentials: when `GH_TOKEN` or `GITHUB_TOKEN` is set, export both (same value; machine
     stages read `GITHUB_TOKEN`), run `env -u GH_TOKEN -u GITHUB_TOKEN gh auth login --with-token`
     then `gh auth setup-git --hostname github.com`, so host-side git and the agents' pushes work.
     Regenerated on every start, so rotating the token needs only a restart. If no token is set, print one
     warning and continue (the user may have mounted a `gh` login).
  3. `mkdir -p` the state dir and pi dirs. Print one line naming each missing optional key
     (`TINYFISH_API_KEY`, `INSTABOX_API_KEY`, `BOXD_API_KEY`) as "off", never the values.
  4. `exec "$@"`.
- **Implement (.dockerignore)**: `.git`, `**/node_modules`, `state`, `.agents`, `**/.env`, `docker/.env`,
  `*.log`. A test (Task 7) asserts `.env` is ignored.
- **Mirror**: `DEPLOYMENT.md` §2-§4 (what the VPS install does, in order)
- **Validate**:
  `docker build -f docker/Dockerfile -t pi-dark-factory:dev .` then
  `docker run --rm pi-dark-factory:dev sh -c 'bun --version && pi --version && gh --version | head -1 && git --version && ssh -V && dark-factory help | head -1'`.
  Repeat with `--platform linux/arm64` if buildx/QEMU is available; otherwise record that arm64 was not
  exercised.

### Task 5: Compose files and env example

- **File**: `docker/compose.yml`, `docker/compose.caddy.yml`, `docker/.env.example`
- **Action**: CREATE
- **Implement (compose.yml)**:
  - `name: pi-dark-factory`. Service `factoryd`: `build: { context: .., dockerfile: docker/Dockerfile }`,
    `image: pi-dark-factory:local`, `init: true`, `restart: unless-stopped`, `env_file: .env`,
    `ports: ["127.0.0.1:${FACTORYD_HOST_PORT:-8077}:8077"]`,
    `environment: PDF_SCHEDULER_MINUTES=${PDF_SCHEDULER_MINUTES:-15}`, `PDF_TICK_ON_START=${PDF_TICK_ON_START:-1}`,
    `PI_FACTORY_CONCURRENCY=${PI_FACTORY_CONCURRENCY:-1}`.
  - Volumes: `factory-state:/home/factory/state`, `factory-pi:/home/factory/.pi`.
  - `stop_grace_period: 30s`. Commented-out `cpus`, `mem_limit` lines with the variables from `.env.example`.
  - Commented-out `ports` entries for scenario ports (so a user can open their product in a browser),
    with a comment that ports are per repo, from `scenario.ports` in the repo's config.
  - Service `dashboard`: same image, `command: ["bun","bin/dashboard.ts"]`,
    `environment: DASHBOARD_HOST=0.0.0.0`, `DASHBOARD_PORT=8787`, `DASHBOARD_STATE_DIR=/home/factory/state`,
    `DASHBOARD_FACTORYD_HEALTH=http://factoryd:8077/health`, plus `INSTABOX_API_KEY` and `BOXD_API_KEY` passed
    through from `.env` (Task 2), `ports: ["127.0.0.1:${DASHBOARD_HOST_PORT:-8787}:8787"]`,
    `depends_on: factoryd`, mounts `factory-state` (read-write: SQLite WAL readers need the `-shm` file).
    No auth on the dashboard, so the loopback bind is its only protection; `docs/docker.md` says so.
  - Top-level `volumes: factory-state, factory-pi`.
- **Implement (compose.caddy.yml)**: override for a VPS: `factoryd` joins external network `web_gateway`,
  `ports: !reset []` (needs Compose >= 2.24; the doc says so). The dashboard gets the same treatment.
  Header comment shows the Caddy block, copied from `DEPLOYMENT.md` §8 with `reverse_proxy factoryd:8077`.
- **Implement (.env.example)**: grouped and commented:
  - **Required**: `FACTORY_API_KEY` (comment: the setup skill generates it, or `openssl rand -hex 32`),
    `GH_TOKEN`.
  - **Model keys**: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `ZAI_API_KEY`, `DEEPSEEK_API_KEY` (the default
    `pass_env` list), with a note that OAuth logins are the alternative (`docker compose run --rm -it factoryd pi auth login`).
  - **Optional**: `TINYFISH_API_KEY`, `INSTABOX_API_KEY`, `BOXD_API_KEY`, `GIT_USER_NAME`, `GIT_USER_EMAIL`.
  - **Limits**: `PI_FACTORY_CONCURRENCY=1`, `PDF_SCHEDULER_MINUTES=15`, `PDF_TICK_ON_START=1`,
    `PDF_POOL_INSTABOX`, `PDF_POOL_BOXD`, host ports, and the commented `FACTORY_CPUS` / `FACTORY_MEMORY`.
  - Never a real value. `docker/.env` is gitignored: add `docker/.env` to `.gitignore` if the existing patterns
    do not already cover it (check first).
- **Mirror**: `DEPLOYMENT.md` §4 (the variable table) and `docs/operations.md:140-175` (scheduler and pool vars)
- **Validate**: `cd docker && cp .env.example .env && FACTORY_API_KEY=x docker compose config >/dev/null && docker compose -f compose.yml -f compose.caddy.yml config >/dev/null; rm -f .env`

### Task 6: Static invariant test

- **File**: `test/docker.test.ts`
- **Action**: CREATE
- **Implement**: read the docker files as text and assert the things that, if broken, fail silently in
  production:
  - Dockerfile `WORKDIR`/`COPY` target path matches `/pi-dark-factory/` (the `lock.ts` cwd rule)
  - compose publishes every port with a `127.0.0.1:` prefix (no bare `"8077:8077"`)
  - compose sets `PDF_SCHEDULER_MINUTES`, `init: true`, and mounts both volumes
  - `.dockerignore` ignores `.env`
  - `.env.example` contains no value after `FACTORY_API_KEY=`/`GH_TOKEN=`/`*_API_KEY=` lines
  - entrypoint contains `set -eu` and does not contain `set -x` (a trace would print secrets)
  Regex over text only: no YAML dependency (the repo has one runtime dependency).
- **Mirror**: `test/scheduler.test.ts` structure
- **Validate**: `bun test test/docker.test.ts`

### Task 7: End-to-end smoke (manual, with real Docker)

- **Action**: run, record the results in the PR description. No file.
- **Steps**:
  1. `cd docker && cp .env.example .env`, set `FACTORY_API_KEY=$(openssl rand -hex 32)` and a throwaway `GH_TOKEN`.
  2. `docker compose up -d --build`; wait for healthy.
  3. `curl -fsS localhost:8077/health` shows `ok:true` and `scheduler_minutes:15`; `localhost:8787/health` answers.
  4. `docker compose exec factoryd sh -c 'DARK_FACTORY_URL=http://127.0.0.1:8077 DARK_FACTORY_API_KEY=$FACTORY_API_KEY dark-factory doctor'` passes.
  5. `npx`/node on the host: `node cli/bin/dark-factory.js setup http://localhost:8077 <key>` then `doctor` passes with no warning.
  6. Startup tick: `docker compose exec factoryd tail -5 /home/factory/state/laps.log` shows `scheduler: startup pass`
     within about 15 s of `up`.
  7. Persistence: `docker compose down && docker compose up -d`; the state and `~/.pi` content survive; a stale
     `tick-*.lock` from a killed container does not block (dead pid reclaimed).
  8. Port exposure: `ss -ltn | grep -E '8077|8787'` shows `127.0.0.1` only.
  9. If a throwaway repo and a real model key are available: onboard it in host mode and run one lap
     (a few cents). If not, state plainly that no lap was run.
  10. `docker compose down -v` to clean up.

### Task 8: Documentation

- **File**: `docs/docker.md`, `docker/README.md`, `README.md`, `DEPLOYMENT.md`, `docs/operations.md`, `docs/development.md`
- **Action**: CREATE / UPDATE
- **Implement**:
  - `docs/docker.md` sections: what you get; requirements (Docker with Compose >= 2.24, a GitHub token, one model
    key or OAuth); quickstart (clone, run the setup skill, or the manual `cp .env.example .env` route);
    auth (keys via `.env`, OAuth with `docker compose run --rm -it factoryd pi auth login`, token rotation = restart);
    using the CLI (host Node vs `docker compose exec`); execution modes supported (host, instabox, boxd; compose
    mode not supported and why); adjusting resources (`PI_FACTORY_CONCURRENCY`, `PDF_POOL_*`, `FACTORY_CPUS`,
    `FACTORY_MEMORY`, schedule interval; parallel mode needs a machine-mode repo); laptop sleep (ticks run only
    while Docker runs; a tick fires on startup; a lap interrupted by stopping the container is reconciled and
    retried by the next tick); toolchains (`FACTORY_IMAGE_EXTRA` or a cloud lane); updating
    (`git pull && docker compose up -d --build`; stop only with laps idle, because `docker stop` ends running laps,
    unlike systemd's `KillMode=process`); running on a VPS behind Caddy (`compose.caddy.yml`); dashboard has no
    auth, loopback only; troubleshooting table (container exits immediately = missing `FACTORY_API_KEY`; push
    denied = token scope; `pi: command not found` in a lap = image build failed at the pi layer; ports busy).
  - `docker/README.md`: five lines and a link.
  - `README.md`: in Quickstart, add "Running it on your own computer? Use Docker" with a link; add the docs table row.
  - `DEPLOYMENT.md`: a note at the top: Docker is the recommended install, this runbook is the systemd path and is
    required for compose-mode repos.
  - `docs/operations.md`: document `PDF_TICK_ON_START` next to `PDF_SCHEDULER_MINUTES` (line ~146).
  - `docs/development.md`: one line on `test/docker.test.ts` and how to smoke the stack.
- **Validate**: every link target exists (`grep -o '](\(docs/\|docker/\)[^)]*' README.md | …` or a manual pass);
  the commands in the docs match `docker/.env.example` variable names exactly.

### Task 9: Setup skill — Docker path

- **File**: `.agents/skills/dark-factory-setup/SKILL.md`
- **Action**: UPDATE
- **Implement**:
  - Frontmatter `description`: cover both installs ("on its server or on a laptop with Docker").
  - Phase 0: first question "Docker or bare-metal systemd?", then (Docker) "localhost only or behind Caddy on a VPS?".
    The rest of Phase 0 is shared. If Docker, skip Phase 1-3 and Phase 5b-c, 5g-h.
  - New section "Docker path (D1-D6)" placed after Phase 0:
    - D1 verify `docker --version`, `docker compose version` (>= 2.24 only if the Caddy override is chosen), daemon reachable.
    - D2 write `docker/.env` (mode 600) from `.env.example`: generate `FACTORY_API_KEY` with `openssl rand -hex 32` (skip if the file
      exists: never regenerate), write the GitHub token and chosen model keys without echoing them (same rule as the VPS
      path: show at most 4 chars and the length).
    - D3 OAuth, if chosen: `docker compose run --rm -it factoryd pi auth login` per provider.
    - D4 `docker compose up -d --build`, wait for healthy, check `/health` (`scheduler_minutes:15`).
    - D5 smoke every model string exactly like VPS Phase 4e, but inside the container
      (`docker compose exec factoryd pi --mode json --no-tools --provider … `). Stop on red.
    - D6 connect the CLI: `dark-factory setup http://localhost:8077 <key>` when Node >= 18 exists on the host, else the in-container
      wrapper; then `dark-factory doctor`. Hand over to the `dark-factory` skill for onboarding.
    - For "behind Caddy": add `-f compose.caddy.yml`, write the Caddy block (Phase 6 rules), verify as Phase 6 does.
  - Keep the rules (idempotent, verify every phase, never echo secrets, ask decisions in one batch) and the VPS phases unchanged.
- **Mirror**: the skill's existing Phase layout and rule wording (`SKILL.md` Phase 0, 4e, 6)
- **Validate**: read the skill top to bottom as a fresh agent would: every command exists in the repo or in Docker, no step
  assumes a `factory` host user in the Docker path, no secret is printed.

---

## Validation

```bash
# Type check + full test suite (must stay at 0 type errors)
bun run check

# Image builds and the toolchain is present
docker build -f docker/Dockerfile -t pi-dark-factory:dev .
docker run --rm pi-dark-factory:dev sh -c 'bun --version && pi --version && gh --version | head -1 && ssh -V'

# Compose files parse
(cd docker && cp .env.example .env && docker compose config >/dev/null && docker compose -f compose.yml -f compose.caddy.yml config >/dev/null; rm -f .env)

# Task 7 smoke steps 2-8
```

## Risks

| Risk | Mitigation |
|------|------------|
| Code dir name drops `pi-dark-factory`, so `lock.ts` mistakes live ticks for dead and steals locks | Path fixed at `/opt/pi-dark-factory`; asserted in `test/docker.test.ts` |
| `docker stop` / restart kills running laps (systemd had `KillMode=process`) | Documented; next tick reconciles crashed laps; `stop_grace_period: 30s`; update guidance says stop with laps idle |
| `gh auth login --with-token` refuses while `GH_TOKEN` is set | Entrypoint clears both vars for that one call; verified in Task 7 step 2 and by a push in step 9 |
| `.env` (tokens) copied into the image | `.dockerignore` rule plus a test; compose reads `.env` at runtime only |
| Dashboard has no auth | Loopback bind only; documented; the Caddy override leaves it off the public network unless the user adds an auth layer |
| Windows line endings break `entrypoint.sh` (`\r`) | Add `docker/*.sh text eol=lf` to `.gitattributes` (create if missing); the Dockerfile `chmod +x`s the script |
| Apple Silicon / arm64: a dependency lacks an arm64 build | Validate with `--platform linux/arm64` when possible; otherwise say plainly it was not tested |
| `@boxd-sh/sdk` or `bun install --production` behaves differently in the image | `bun install --frozen-lockfile --production` is checked in Task 4 and by the smoke lap |
| Upstream pi/Bun versions drift | Pinned by `ARG` with defaults matching the working VPS |
| Laptop sleeps mid-lap | Same reconciliation as a crash; documented |
| Two stacks started (VPS systemd and Docker) against the same repos | Not shared state: each has its own ledger. Docs warn not to onboard the same repo on both |

## Acceptance Criteria

- [ ] `docker compose up -d --build` from a fresh clone with only `FACTORY_API_KEY` and `GH_TOKEN` set gives a healthy stack
- [ ] `/health` shows the scheduler on, and `laps.log` shows a startup pass
- [ ] Both ports are loopback-only; `.env` is not in the image
- [ ] The CLI connects to `http://localhost:8077` from the host and from inside the container
- [ ] Startup tick is opt-in for the daemon (VPS behavior unchanged) and on by default in compose
- [ ] The setup skill asks Docker vs systemd first and its Docker path runs end to end; VPS path text unchanged
- [ ] `bun run check` passes (0 type errors, all tests)
- [ ] Docs link from the README; variable names in docs match `.env.example`
- [ ] The PR states what was and was not tested (arm64, a real lap)
