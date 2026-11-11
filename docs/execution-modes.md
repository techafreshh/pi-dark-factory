# Execution modes — where the work runs

Each repo picks one via `env.mode` in its config: host, compose, instabox (disposable Firecracker machines) or boxd (disposable microVMs over the boxd SDK).

## Where the work runs — four execution modes

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
  the foreman fetches the pushed branch and re-judges it from its own git truth. Every
  agent stage runs in the machine, plan included: the planner keeps bash, and the stage
  driver resets the clone after plan and review, so nothing they change carries into the
  next stage. A lap that ends at the plan (`NO_ACTION`, a needs-info question) still
  boots a machine. Merge and receipts stay host-side.
- **Scenarios stay black-box**: setup, the foreground server, readiness, probes and teardown
  all run inside the machine over its exec channel, against the machine's own `127.0.0.1`
  (`ssh -L` forwards black-holed readiness polls in October 2026, so nothing is forwarded any
  more). The scenario files stay in factory state; only their commands travel, per run.
- **Lifetimes**: one machine per lap, kept across that lap's repair rounds and destroyed when
  the lap ends (a reclaimed lap boots a fresh `-g<lapId>` machine). The janitor (every tick's
  tail and `foreman cleanup`) reaps any `pdf-*` machine whose issue has no live lap.
- **Env**: `INSTABOX_API_KEY` (or your `api_key_env`) in the service unit; model keys and
  `GITHUB_TOKEN` ride into each stage via `pass_env`. Concurrency is capped by your
  account (5 machines on the entry tier ≈ 5 concurrent laps). Docker is **not** needed
  on the VPS for machine-mode repos. The ClinePass router is a host-local service —
  machines cannot reach it, so machine-mode stages point their provider directly.

### `"boxd"` — disposable microVMs over the boxd SDK

[boxd](https://boxd.sh) machines run the same lap shape as instabox (plan, implement,
review and scenarios all in a per-lap box), driven differently:

- **Lifecycle** rides the official SDK (`@boxd-sh/sdk`): create from a snapshot, wait until
  ready, delete. Config: `env.boxd.repo_dir` (the in-box clone, default `/home/boxd/repo`)
  and `env.boxd.snapshot` (default `factory-base-boxd-r1`; aliases in
  `state/base-snapshot.json` resolve as they do for instabox). The only secret is
  `BOXD_API_KEY` in `factoryd.env`.
- **Everything in-box rides one exec wrapper**, with no ssh and no tunnels. The payload runs
  in its own `setsid` process group, the wrapper enforces the deadline inside the box (TERM,
  then KILL) and frames stdout/stderr with a per-call nonce, because the SDK's server-side
  exec timeout never surfaces under Bun. A hung transport throws a typed infra error.
- **Platform failures defer the lap** (transport down, or the org machine cap still full after
  the slot queue's 10-minute wait): the claim drops with the attempt budget intact and the
  next tick re-claims. Same rule as instabox.
- **Lifetimes**: as instabox, one box per lap, destroyed when the lap ends. The janitor
  (every tick's tail and `foreman cleanup`) deletes `factory=1`-labelled boxes whose issue
  has no live lap.
- **No post-merge regression pass**: as with instabox, each lap's in-box verify is the
  contract check, so a merge never runs product code on the VPS. (`scenario --test` still
  benches boxd repos on the host; there is no boxd bench machine yet.)
