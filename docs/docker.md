# Docker install — the factory on your own computer

The `docker/` directory runs the factory as a Docker Compose stack, so you need no VPS, no systemd and no Caddy. One image (Node 22, Bun, pi, gh, git, ssh) runs two services:

- **`factoryd`**: the HTTP API and the built-in scheduler. Repos run in `host` mode inside this container, or on the cloud lanes (`instabox`, `boxd`).
- **`dashboard`**: the read-only telemetry UI, from the same image.

Both ports are published on `127.0.0.1` only. State lives in two named volumes, so it survives `docker compose down` and works the same on Linux, macOS (Apple Silicon included) and Windows.

## Requirements

- Docker with Compose. The Caddy override ([below](#running-on-a-vps-behind-caddy)) needs Compose 2.24 or newer.
- A GitHub token that can read issues, push branches and open and merge PRs on your repos. A fine-grained token limited to those repos is the safer choice. A classic token needs the `repo` scope; adding `read:org` also lets `gh auth login` accept it, but the stack works without it (see the troubleshooting table).
- One model provider key, or a pi OAuth login.
- Optional: a TinyFish key (web grounding), an InstaBox or boxd key (cloud lanes).

## Quickstart

```sh
git clone https://github.com/techafreshh/pi-dark-factory.git
cd pi-dark-factory
pi        # any coding agent session in the checkout works
```

Tell the agent: **"Run the dark-factory-setup skill. Install the factory locally with Docker."** It writes `docker/.env` without echoing secrets, starts the stack, smoke-tests your model strings and connects the CLI.

The manual route:

```sh
cd docker
cp .env.example .env && chmod 600 .env
# edit .env: FACTORY_API_KEY (openssl rand -hex 32), GH_TOKEN, and a model key
docker compose up -d --build
curl -fsS localhost:8077/health        # "ok": true, "scheduler_minutes": 15
```

Open `http://localhost:8787` for the dashboard. Then point the CLI at the factory and onboard a repo with the `dark-factory` skill:

```sh
npx @techafresh/dark-factory setup http://localhost:8077 <FACTORY_API_KEY>
npx @techafresh/dark-factory doctor
```

`doctor` is written for the VPS install. On a local stack it reports "laptop key NOT provisioned" and "shared base UNMAPPED" as failures, and "web tools" as a warning until `TINYFISH_API_KEY` is set. The first two do not matter locally: the laptop key is a second client key, and the shared base is an alias the machine lanes resolve through `state/base-snapshot.json`. Its last line, `auth OK`, is the one that proves the connection.

## Authentication

| What | How |
|---|---|
| GitHub | `GH_TOKEN` in `docker/.env`. The entrypoint logs `gh` in and configures git credentials on every start, so rotating the token is: edit `.env`, `docker compose up -d`. |
| Model keys | `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `ZAI_API_KEY`, `DEEPSEEK_API_KEY` in `docker/.env`. Empty ones are dropped at start. These are the keys the default `env.pass_env` forwards to host-mode agents. |
| Model OAuth | `docker compose run --rm -it factoryd pi`, then type `/login` and pick the provider; repeat per provider. The login is stored in the `factory-pi` volume (`/home/factory/.pi`) and survives restarts. |
| Cloud lanes | `INSTABOX_API_KEY` / `BOXD_API_KEY` / `DAYTONA_API_KEY` / `E2B_API_KEY` / `INSTAVM_API_KEY` in `.env`. The dashboard receives these platform keys and nothing else. |
| Commit identity | `GIT_USER_NAME` / `GIT_USER_EMAIL`, or leave them empty and the entrypoint derives both from the token's GitHub account. |

Smoke every `provider/model:thinking` string a repo config will use before the first lap, inside the container:

```sh
docker compose exec -T factoryd pi --mode json --no-tools --provider <provider> --model <model> --thinking <level> "say OK" </dev/null
```

## Using the CLI

On a host with Node 18 or newer, use `npx @techafresh/dark-factory` or install it globally (`npm i -g @techafresh/dark-factory`). It talks plain HTTP to loopback; `setup` warns only when an `http://` URL points at a non-local host.

Without Node on the host, run the copy inside the container. In bash or zsh a shell function keeps it short (`-T` keeps the output pipeable, for example into `jq`):

```sh
dark-factory() {
  docker compose -f /path/to/pi-dark-factory/docker/compose.yml exec -T factoryd \
    sh -c 'DARK_FACTORY_URL=http://127.0.0.1:8077 DARK_FACTORY_API_KEY=$FACTORY_API_KEY dark-factory "$@"' sh "$@"
}
dark-factory status
```

The function is bash-only. On Windows PowerShell, install Node and use `npx @techafresh/dark-factory` instead.

## Execution modes

| Mode | In Docker | Notes |
|---|---|---|
| `host` | yes | Stages run as the `factory` user inside the `factoryd` container. Serial per repo; `scheduling.parallel` needs a machine mode. |
| `instabox` | yes | Needs `INSTABOX_API_KEY`. The image carries `ssh`, the transport. |
| `boxd` | yes | Needs `BOXD_API_KEY`. |
| `daytona` | yes | Needs `DAYTONA_API_KEY`. Tier 1/2 egress is allowlist-based (GitHub + AI providers whitelisted). |
| `e2b` | yes | Needs `E2B_API_KEY`. Hobby caps sandboxes at 1 h continuous, 10 concurrent. |
| `instavm` | yes | Needs `INSTAVM_API_KEY`. Young platform — run the gating smoke first. |
| `compose` | no | It needs a Docker daemon inside the container, which this image does not provide. Use the [systemd install](../DEPLOYMENT.md) for compose-mode repos. |

Do not onboard the same repo on a Docker stack and on a VPS. Each factory has its own ledger, and they would claim the same issues.

## Adjusting resources

Edit `docker/.env`, then `docker compose up -d`.

| Variable | Default | Effect |
|---|---|---|
| `PI_FACTORY_CONCURRENCY` | 1 | Repos ticking at the same time. Host-mode laps are serial inside a repo. |
| `PDF_SCHEDULER_MINUTES` | 15 | Minutes between scheduler passes, on the wall clock. |
| `PDF_TICK_ON_START` | 1 | Also run one pass about 10 seconds after the stack starts. |
| `PDF_POOL_INSTABOX` / `PDF_POOL_BOXD` | 5 / 10 | Concurrent cloud machines per platform ([parallel mode](parallel-mode.md)). Commented out in `.env.example`. |
| `FACTORYD_HOST_PORT` / `DASHBOARD_HOST_PORT` | 8077 / 8787 | Loopback ports on the host. Change them when something else holds the port. |
| `FACTORY_CPUS` / `FACTORY_MEMORY` | unset | Set them in `.env`, then uncomment `cpus` and `mem_limit` in `compose.yml`. |

To open a product the factory is building in your browser, publish its scenario ports on loopback in `compose.yml` (the commented example under `ports`). The ports are per repo: see `scenario.ports` in the repo's config.

## Laptop sleep and stopping

Ticks run only while Docker runs. The scheduler fires on wall-clock quarter hours, so a laptop that slept through some of them simply misses those passes. `PDF_TICK_ON_START=1` runs one pass shortly after the stack starts, which is the whole catch-up. There is no backlog replay.

Stopping the container ends running laps. There is no equivalent of the VPS unit's `KillMode=process`. The next tick reconciles an interrupted lap (it books it as `interrupted` and resumes it from its saved plan, within the attempt cap). Stop with laps idle when you can: `dark-factory status` shows what is running.

## Toolchains

The image has Node, Python, git and common build tools. A repo that needs more has two options:

- Build extra packages into the image: `docker compose build --build-arg FACTORY_IMAGE_EXTRA="apt-get install -y golang" factoryd`, then `docker compose up -d`. The argument is a shell snippet run as root after `apt-get update`.
- Run the repo in a cloud lane (`instabox` or `boxd`), which brings its own machine.

The per-repo `env.image` field belongs to compose mode and has no effect in host mode.

## Updating

```sh
git pull
cd docker && docker compose up -d --build
```

The image pins Bun and pi through build arguments (`BUN_VERSION`, `PI_VERSION` in `docker/Dockerfile`). Run the update with laps idle, because recreating the container ends running laps.

## Running on a VPS behind Caddy

`docker/compose.caddy.yml` is an override for a VPS where Caddy already fronts your apps on an external `web_gateway` network. `factoryd` joins it and publishes nothing on the host:

```sh
cd docker
docker compose -f compose.yml -f compose.caddy.yml up -d --build
```

The header of the override file has the Caddy block (`reverse_proxy factoryd:8077`, with the edge key check). Clients then use `https://<domain>` as in [DEPLOYMENT.md](../DEPLOYMENT.md#8-remote-control-the-dark-factory-cli--remote-from-here-on).

## Security notes

- **The dashboard has no login.** The loopback bind is its only protection. Do not publish it on `0.0.0.0`. To put it on the web, join it to `web_gateway` and add an auth layer in the Caddyfile.
- **Anything in `docker/.env` is readable by anyone who can run `docker` on the machine.** `.env` stays out of the image (`.dockerignore`) and out of git.
- Host-mode agents run in the same container as the daemon. They get an environment allowlist (`src/agentenv.ts`: runtime basics, `TINYFISH_API_KEY` and the repo's `pass_env`), not the factory's own `FACTORY_API_KEY`. The allowlist is defense in depth only: agents run as the same user in the same container as the daemon, so they can still read `/proc/<pid>/environ` (every key in `docker/.env`), `~/.config/gh/hosts.yml` (the GitHub token) and `~/.pi/agent/auth.json` (OAuth logins). A cloud lane isolates agents far more strongly than `host` does, so prefer it for repos whose issues or dependencies you do not fully trust.
- Intake still claims only issues from trusted authors (the repo owner, the token's account, `trusted_authors`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `docker compose up` stops with "set FACTORY_API_KEY" | the key in `docker/.env` is empty | `openssl rand -hex 32`, paste it, run `up` again |
| Container exits immediately | `FACTORY_API_KEY` missing (outside compose) or a port clash | `docker compose logs factoryd` |
| `entrypoint: WARNING GitHub did not accept GH_TOKEN` | the token is expired, revoked or mistyped, or GitHub was unreachable for 15 s | fix the token or the network, then `docker compose up -d` |
| `entrypoint: gh login skipped (the token lacks a scope it checks …)` | a classic token without `read:org`: `gh auth login` refuses it, but the token works | nothing to fix. Git credentials are set from the token in the environment. Add `read:org` to silence it |
| `git clone failed … could not read Username` in `laps.log` | no GitHub token is set (with a token set, git credentials are configured at every start) | set `GH_TOKEN` in `.env`, `docker compose up -d` |
| Push or PR denied | token scope or repo access too narrow | grant contents, pull requests and issues access to the repo |
| `pi: command not found` in a lap | the image build failed at the pi layer | `docker compose build --no-cache` and read the output |
| Port already in use | another service holds 8077 or 8787 | set `FACTORYD_HOST_PORT` / `DASHBOARD_HOST_PORT` |
| Commits authored as `pi-dark-factory <factory@localhost>` | no identity, and the token could not name an account | set `GIT_USER_NAME` and `GIT_USER_EMAIL` |
| `exec /…/entrypoint.sh: no such file or directory` on Windows | CRLF line endings after checkout | `.gitattributes` forces LF for `docker/*.sh`; re-clone, or `git add --renormalize .` |
| `ports: !reset` is rejected | Compose older than 2.24 | upgrade Compose |

Logs: `docker compose logs -f factoryd`, and `docker compose exec factoryd tail -f /home/factory/state/laps.log` for lap receipts. A full reset, which deletes the ledger, plans and OAuth logins, is `docker compose down -v`.
