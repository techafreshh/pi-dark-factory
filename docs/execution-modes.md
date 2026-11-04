# Execution modes — where the work runs

Each repo picks one via `env.mode` in its config: host, compose, or instabox (disposable Firecracker machines).

## Where the work runs — three execution modes

Each repo picks one via `env.mode` in its config:

### `"host"` — plain processes (the default)

Stages run as ordinary factory-user processes on the VPS. Zero extra machinery; right for
repos whose runtime deps already live on the host.

### `"compose"` — root inside the product's own Docker environment

`env.mode: "compose"` runs **every agent stage as root inside the product's own Docker
environment** — `docker compose -f <compose in the worktree> run --rm <service> pi …` — so
`pip install`, `apt-get`, compilers, anything: ordinary work, and its mess dies with the
container (`docker rm -f` follows every stage, timeout or crash included). The host stays clean.

- **The product repo owns its compose file and Dockerfiles.** A stage joins the compose network,
  so `falkordb`, `postgres`, caches and friends are simply *there*. Contract: the compose file
  must publish the two scenario ports on `127.0.0.1`.
- **No compose file yet?** The factory falls back to a generic `docker run` per stage from
  `env.image` (default `ubuntu:24.04`) with named cache volumes (`pdf-uv`, `pdf-pip`, `pdf-npm`)
  so installs replay cheap, and publishes `scenario.ports` itself. Switch the moment the repo
  ships its compose.
- **Host↔container mirroring**: worktree, state dir, and the factory user's Pi install are
  bind-mounted at identical container paths — prompts, cwds, session dirs and git forensics
  need no translation. `safe.directory=*` is pre-set; `pass_env` forwards selected host env
  vars (model keys) when present.

### `"instabox"` — disposable Firecracker machines from a golden snapshot

[InstaBox](https://instabox.sh) rents microVMs purpose-built for coding agents: a full Linux
machine with its own kernel, Docker inside, and **snapshot boot in seconds**, billed
burst-style (running time + storage; a paused machine costs storage only). In this mode the
implement and review stages run inside a **disposable machine per issue** booted from the
repo's golden snapshot — the compose-mode bargain (install anything, host stays clean) with
perfect reproducibility instead of shared caches:

- **One-time bake**: `foreman bake <slug>` boots a machine from the template (default
  `basic`: docker, node, go, git, gh preinstalled), clones the repo, runs the repo's
  `env.instabox.bake` shell (install deps, warm caches), and snapshots it — every future
  stage boots from that snapshot, warm, byte-identical every lap. The snapshot name is
  written back into the repo config.
- **The machine's clone IS the worktree.** The stage driver runs the same deterministic
  gates the host runs (clean tree, ≥1 real commit vs base) and pushes the branch itself;
  the foreman fetches the pushed branch and re-judges it from its own git truth. Plan stays
  host-side (read-only — no machine spend on `NO_ACTION`/failed-plan laps); merge and
  receipts stay host-side.
- **Scenarios stay black-box**: setup and the foreground server run inside the machine;
  probes run from the VPS against `ssh -L`-forwarded `127.0.0.1` ports. The scenario files
  never exist inside the machine.
- **Lifetimes**: one machine per issue's lap, reused across repair rounds and reclaimed
  laps, destroyed when the lap books out; `foreman cleanup` reaps leftovers.
- **Env**: `INSTABOX_API_KEY` (or your `api_key_env`) in the service unit; model keys and
  `GITHUB_TOKEN` ride into each stage via `pass_env`. Concurrency is capped by your
  account (5 machines on the entry tier ≈ 5 concurrent laps). Docker is **not** needed
  on the VPS for machine-mode repos. The ClinePass router is a host-local service —
  machines cannot reach it, so machine-mode stages point their provider directly.
