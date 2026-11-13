# Execution modes — where the work runs

Each repo picks one via `env.mode` in its config: host, compose, or one of the four machine platforms — instabox (disposable Firecracker machines), boxd (microVMs over the boxd SDK), daytona (Daytona cloud sandboxes), e2b (E2B Firecracker sandboxes) or instavm (InstaVM microVMs over raw REST).

## Where the work runs — the execution modes

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
burst-style (running time + storage; a paused machine costs storage only). In this mode
every agent stage (plan, implement, review) runs inside a **disposable machine per lap**
booted from the repo's snapshot — the compose-mode bargain (install anything, host stays clean) with
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
  the lap ends (a reclaimed lap boots a fresh `-g<lapId>` machine). The janitor (once per
  scheduler pass, at the end of a full fleet tick, and in `foreman cleanup`) reaps any
  `pdf-*` machine whose issue has no live lap.
- **Env**: `INSTABOX_API_KEY` (or your `api_key_env`) in the service unit; model keys ride
  into each stage via `pass_env`; `GITHUB_TOKEN` and `TINYFISH_API_KEY` always do, and the
  factory's pi `auth.json`/`models.json` ship with every stage. Concurrency is capped by your
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
  (once per scheduler pass, at the end of a full fleet tick, and in `foreman cleanup`)
  deletes `factory=1`-labelled boxes whose issue
  has no live lap.
- **Machine slots** (all machine modes): every lap leases a slot from the fleet's
  allocator before it claims an issue — pools of `PDF_POOL_INSTABOX` (5), `PDF_POOL_BOXD`
  (10), `PDF_POOL_DAYTONA` (5), `PDF_POOL_E2B` (10) and `PDF_POOL_INSTAVM` (5), ordered by
  priority with aging. The platform's own cap-reject wait above stays as a fallback for
  machines the allocator does not count. With `scheduling.spill_over`, a lap whose own
  pool is full runs on any other machine platform with `env.mode` swapped for that lap
  only (every platform block carries defaults; point the target's snapshot at a baked
  base). See [parallel-mode.md](parallel-mode.md).
- **No post-merge regression pass**: as with instabox, each lap's in-box verify is the
  contract check, so a merge never runs product code on the VPS. (`scenario --test` still
  benches boxd repos on the host; there is no boxd bench machine yet.)

### `"daytona"` — disposable sandboxes over the Daytona SDK

[Daytona](https://daytona.io) sandboxes run the same lap shape (plan, implement, review and
scenarios all in a per-lap box), driven by the official TypeScript SDK (`@daytona/sdk`,
officially Bun-supported):

- **Lifecycle** rides the SDK: create from a named snapshot, exec, delete. Config:
  `env.daytona.repo_dir` (default `/home/daytona/repo` — the sandbox user's home, so the
  bootstrap needs no sudo) and `env.daytona.snapshot` (empty until the first
  `foreman bake`; a `shared-base` alias resolves via `state/base-snapshot.json`). The only
  secret is `DAYTONA_API_KEY` in `factoryd.env`.
- **Bake**: `foreman bake <slug>` boots a sandbox (from the current snapshot — an
  enrichment — or `ubuntu:24.04` for the first bake), clones, runs `env.daytona.bake`,
  stops the sandbox and snapshots it back under the same name.
- **Deadlines are enforced in-box** by the same hardened exec wrapper boxd proved; the
  platform's own exec kill rides a few seconds behind as the margin. Daytona 0.231.x
  returns combined exec output in `result` (split stdout/stderr fields are not in a stable
  release yet), so the framed markers are parsed from `result`.
- **Auto-stop is inactivity-based and internal processes do NOT reset it** — creation pins
  `autoStopInterval: 0`, and `PDF_DAYTONA_TTL_MINUTES` (default 180) is the wall-clock
  runaway cap.
- **Network is tier-gated**: Tier 1/2 egress is restricted to an essential-services
  allowlist (GitHub, npm/bun/pypi registries, AI providers — TLS re-signed with a Daytona
  CA the box's env already trusts). Verify your exact provider endpoints before relying on
  it. Concurrency: the org's tier resource pool (Tier 1 ≈ five 2-vCPU sandboxes) —
  `PDF_POOL_DAYTONA` (default 5) counts slots for the allocator.

### `"e2b"` — disposable Firecracker sandboxes over the E2B SDK

[E2B](https://e2b.dev) sandboxes run the same lap shape, driven by the official SDK
(`e2b` — Bun is handled in-source, though Node is the only documented runtime):

- **Lifecycle** rides the SDK's statics through a narrow seam: create from a template,
  exec, kill. Config: `env.e2b.repo_dir` (default `/home/user/repo`) and `env.e2b.snapshot`
  (empty until baked). The only secret is `E2B_API_KEY`.
- **Bake is a definition build** (Build System 2.0 — E2B has no runtime
  mutate-and-commit): `foreman bake <slug>` builds a template from `node:22-bookworm`
  (bun + git + gh + python3 installed), clones the repo and runs `env.e2b.bake` inside the
  remote build; an enrichment re-bake layers `fromTemplate` on the current template.
- **The create TTL is the trap**: the API default is 300 seconds and the default expiry
  action is a silent KILL. Every create passes an explicit `PDF_E2B_TTL_MS` (default
  55 min) and every stage refreshes it. **Hobby plans cap continuous runtime at 1 hour** —
  keep `timeouts.stage_minutes` comfortably under it, or run Pro. The command kill
  (default 60 s!) is always passed explicitly, 30 s behind the in-box wrapper.
- **Concurrency**: 10 sandboxes on Hobby (`PDF_POOL_E2B`, default 10).

### `"instavm"` — disposable microVMs over the InstaVM REST API

[InstaVM](https://instavm.io) microVMs run the same lap shape over the documented REST API
(raw fetch — no SDK dependency):

- **Lifecycle**: create a VM from a snapshot id (resolved by name via `GET /v1/snapshots`)
  with an explicit `vm_lifetime_seconds` (`PDF_INSTAVM_TTL_S`, default 7200) and factory
  metadata; delete when the lap ends. Config: `env.instavm.repo_dir` (default `/app/repo`
  — the platform's snapshot builder clones there), `env.instavm.snapshot`, and
  `env.instavm.api_base` (default `https://api.instavm.io/v1`). The only secret is
  `INSTAVM_API_KEY`.
- **Bake is a snapshot build**: `foreman bake <slug>` posts an OCI base + `git_clone_url` +
  `post_build_cmd` (`env.instavm.bake`) to `POST /v1/snapshots` and polls until ready.
- **Exec is async-only**: the sync endpoint's `timeout` is an HTTP wait (max 600 s), not a
  kill, so the driver always submits async and polls; the in-box wrapper owns the deadline.
  The stage env rides embedded exports in the script (the REST exec takes no env param).
- **The platform is young** (public beta 2026-03, 2-person team) — treat it as the fleet's
  spill-over lane until the gating smoke (below) proves egress and lifetimes on your plan.
  Free tier: 5 concurrent VMs (`PDF_POOL_INSTAVM`, default 5); its egress allowlist names
  only "package managers + AI APIs" — `git push` from a Free-tier VM is UNVERIFIED.
  **A card on file is REQUIRED even on Free** (recorded: VM *and* session creates both 403
  `card_required`, 2026-11-13) — until one is added, repos cannot use this mode.

### Gating smoke — before trusting a new platform

`bin/smoke-machine-platforms.ts --platform <name>` runs the six cheap experiments that
de-risk each platform with a real key (set `DAYTONA_API_KEY` / `E2B_API_KEY` /
`INSTAVM_API_KEY`): boot from a snapshot, exec round-trip with framed markers, in-box
deadline (rc 124), **git reachability from inside the box**, a ≥5-min continuous exec, and
destroy. It records every raw response to `state/smoke/<platform>.json` — the boundary
rule's captured shapes for the stub tests. Run it per platform before onboarding a repo
onto that mode.
