<div align="center">

# pi-dark-factory

*An unattended software factory for the Pi coding agent — hand it a PRD, it builds the backlog*

**TypeScript on Bun · zero external dependencies · `bun:sqlite` + the standard library only**

[What it is](#what-it-is) • [Safety model](#safety-model) • [Quickstart](#quickstart) • [Clients](#remote-clients) • [Docs](#docs)

</div>

## What it is

You hand it a PRD; it slices the PRD into a dependency-ordered GitHub backlog, then builds it
with **no human in the loop**: a systemd timer on your VPS fires every 15 minutes, picks each
repo's next claimable issue, and runs one **lap** through

```
intake → plan → implement → verify → review → squash-merge → close
```

Every gate between stages is **deterministic** — git truth, GitHub checks, black-box HTTP
probes — so the LLM is never trusted and an agent can never declare its own work done. One lap
per repo per tick by design (dependency chains want strictly ordered delivery); repos fan out
in parallel.

From your **laptop** everything is remote: the factory exposes an HTTPS API (`factoryd`) —
onboard repos, slice PRDs, watch laps, unblock, clean up — **no SSH after install day**.

## Safety model

The engine is built so that autonomy can only deliver what deterministic checks can prove:

- **No schema-valid JSON is ever demanded from a model.** All structure is tool calls and
  text; verdicts are parsed leniently with up to five re-asks, then fail closed.
- **Acceptance lives outside the repo.** Runtime + holdout scenarios are black-box probes run
  from factory state — the agent can never tune against its own acceptance tests.
- **The agent commits and pushes; the foreman opens the PR** and re-judges the pushed branch
  from its own git truth.
- **Attempt caps and human parks.** A failed lap retries within the cap, then a GitHub
  comment carries the failure receipt and the exact unblock command — never an auto-retry.
  Missing product decisions escape as `factory:needs-info` questions for a human.
- **Web grounding is untrusted data**, never instructions: lap agents verify external
  API/endpoint claims against live docs by default (`web_search` + `web_fetch`, per-repo
  toggleable).

The full list — every failure class of the previous engine answered structurally, with the
evidence that shaped ordering and concurrency rules — is in
[docs/design-decisions.md](docs/design-decisions.md).

## Quickstart

You need a VPS (Ubuntu + systemd is the tested shape), a GitHub account for the product repos,
and LLM provider API keys. Optional: Docker (compose-mode repos), an InstaBox API key
(machine-mode repos), a DNS domain (remote control over HTTPS).

```sh
ssh your-vps
git clone https://github.com/techafreshh/pi-dark-factory.git ~/factory-checkout
cd ~/factory-checkout
pi        # any coding agent session in the checkout works
```

then tell the agent: **"Run the pi-factory-setup skill — set the factory up on this server."**
The skill ships in this repo (`.agents/skills/pi-factory-setup/`) and walks the whole install —
factory user, runtimes, auth, pi provisioning with every model string smoke-tested, systemd
timer + daemon + Caddy — idempotently, with secrets going into 600-mode files and never into
the transcript. The manual alternative is [`DEPLOYMENT.md`](DEPLOYMENT.md).

Then onboard a project (from any machine):

```sh
# any OS with Node >= 18 — Windows-native, no WSL, zero deps:
npx @techafresh/dark-factory setup https://<your-domain> <edge-key>
npx @techafresh/dark-factory doctor
```

and run the sibling **`pi-factory` skill**: it PRD-checks the repo, writes the config and real
runtime/holdout scenarios with you, slices the PRD into the backlog, and fires the first lap.
From then on laps happen every 15 minutes without you.

## Commands

```
bun src/foreman.ts tick   [--repo <slug>] [--concurrency N]   # one lap per repo (next link in its chain)
bun src/foreman.ts status [--repo <slug>]       # ledger, laps, stages, worktrees
bun src/foreman.ts logs   [--repo <slug>] [--tail N]
bun src/foreman.ts onboard <owner/name>         # config + scenario templates + reserved ports
bun src/foreman.ts backlog <slug> --prd <path>  # PRD → ordered GitHub issues (dedup by title)
bun src/foreman.ts bake <slug>                  # instabox: build the repo's golden snapshot
bun src/foreman.ts unblock <slug> <issue>        # [--prune] drop the ledger row (± PR/branch/worktree)
bun src/foreman.ts cleanup                      # dep caches, stale pi workers, orphaned machines, disk
```

## Remote clients

The remote client speaks the same HTTPS endpoint the daemon serves (`X-Api-Key`; `/health`
stays open; per-client edge keys are independently revocable):

| client | platform | install |
|---|---|---|
| **`@techafresh/dark-factory`** (`dark-factory`) | any OS with Node ≥ 18, zero deps | `npm i -g @techafresh/dark-factory` or `npx @techafresh/dark-factory` |

Full verb manuals: [cli/README.md](cli/README.md).

## Repo map

```
src/                 the engine: ledger, tick, stages, gates, instabox + compose drivers, factoryd
pi-skills/           skill content shipped into every lap agent (ui router, agent-browser, …)
cli/                 the @techafresh/dark-factory npm client
bin/factory-remote   the Python client
templates/           repo config + scenario templates
test/                bun test — parsers, ledger, probes, harnesses, full machine-mode laps (300 tests)
docs/                deep dives (below)
```

## Docs

| doc | contents |
|---|---|
| [Design decisions](docs/design-decisions.md) | every failure class of the previous engine, answered structurally |
| [Lap lifecycle](docs/lap-lifecycle.md) | the six stages of one lap, in detail |
| [Execution modes](docs/execution-modes.md) | host · compose · instabox (Firecracker machines) |
| [Operations](docs/operations.md) | guided install, remote clients, commands, state layout, models, safe deploys |
| [Scenarios](docs/scenarios.md) | the black-box probe contract and its grammar |
| [Web & skills](docs/web-and-skills.md) | TinyFish grounding and the factory skill channel |
| [Discoveries](docs/discoveries.md) | severity, deferral, and the recursion gate |
| [Key router](docs/keyrouter.md) | multi-key provider failover |
| [Development](docs/development.md) | tests, and why boundary stubs must use recorded real shapes |

## Limitations

- The tested deployment shape is one VPS (Ubuntu + systemd); the engine, ledger and gates are
  Bun-only.
- GitHub-centric by design: issues, PRs, checks and labels are the protocol.
- Runtime verification assumes products that can serve HTTP on reserved local ports (the
  scenario contract).
- Machine mode is bounded by your InstaBox account (entry tier ≈ 5 concurrent machines).
- Lap and backlog mutations spend real provider tokens; budgets are per-stage timeouts and
  attempt caps, not dollar meters.
