<div align="center">

# pi-dark-factory

*An unattended software factory for the Pi coding agent — hand it a PRD, it builds the backlog*

**TypeScript on Bun · `bun:sqlite` + the standard library, plus one SDK for boxd mode**

[What it is](#what-it-is) • [Safety model](#safety-model) • [Quickstart](#quickstart) • [Clients](#remote-clients) • [Docs](#docs)

</div>

## What it is

You hand it a PRD; it slices the PRD into a dependency-ordered GitHub backlog, then builds it
with **no human in the loop**: every 15 minutes the factory daemon on your VPS starts a tick
for each repo, which picks the repo's next claimable issue and runs one **lap** through

```
intake → plan → implement → verify → review → squash-merge → close
```

Every gate between stages is **deterministic** — git truth, GitHub checks, black-box HTTP
probes — so the LLM is never trusted and an agent can never declare its own work done. By
default laps run strictly one at a time per repo, in dependency order: a merge re-intakes at once, so a
tick chains up to 6 laps per repo inside a 12-minute budget and the next tick takes the rest.
Repos fan out in parallel, and a repo can opt into parallel lanes: independent issues
build at once and land one by one through a rebase-and-re-verify merge queue. Machine slots
are shared across the fleet by priority ([parallel mode](docs/parallel-mode.md)).

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
- **Attempt caps and human parks.** A failed lap retries within the cap, then blocks with a
  GitHub comment carrying the failure receipt and the exact unblock command. Later ticks
  auto-revive a blocked issue with a fresh plan that sees the last failure, at most 3 times a
  day, and stop for a human once the same failure repeats 3 rounds in a row. Missing product decisions escape as `factory:needs-info`
  questions for a human.
- **Only trusted authors hand the factory work.** Issue text becomes agent prompts, and anyone
  can open an issue on a public repo, so intake claims only issues opened by the repo owner,
  the factory's own gh account, or a login in the repo's `trusted_authors`.
- **Agents run away from the factory's own keys.** Machine-mode repos run every agent stage
  (plan, implement, review) in the lap's disposable machine, which gets only the GitHub
  token, the model keys and the web-tools key; the factory's API keys and platform keys
  stay on the VPS. On the VPS, host-mode stages and scenario commands run under an
  environment allowlist (runtime basics plus the repo's `pass_env`), not the service
  environment that holds the API keys.
- **Web grounding is untrusted data**, never instructions: lap agents verify external
  API/endpoint claims against live docs by default (`web_search` + `web_fetch`, per-repo
  toggleable).

The full list — every failure class of the previous engine answered structurally, with the
evidence that shaped ordering and concurrency rules — is in
[docs/design-decisions.md](docs/design-decisions.md).

## Quickstart

You need a VPS (Ubuntu + systemd is the tested shape), a GitHub account for the product repos,
and LLM provider API keys. Optional: Docker (compose-mode repos), an InstaBox or boxd API key
(machine-mode repos), a DNS domain (remote control over HTTPS).

```sh
ssh your-vps
git clone https://github.com/techafreshh/pi-dark-factory.git ~/factory-checkout
cd ~/factory-checkout
pi        # any coding agent session in the checkout works
```

then tell the agent: **"Run the dark-factory-setup skill — set the factory up on this server."**
The skill ships in this repo (`.agents/skills/dark-factory-setup/`) and walks the whole install —
factory user, runtimes, auth, pi provisioning with every model string smoke-tested, the
daemon with its scheduler, Caddy, and optionally the dashboard and backups — idempotently, with secrets going into 600-mode files and never into
the transcript. The manual alternative is [`DEPLOYMENT.md`](DEPLOYMENT.md).

Then onboard a project (from any machine):

```sh
# any OS with Node >= 18 — Windows-native, no WSL, zero deps:
npx @techafresh/dark-factory setup https://<your-domain> <edge-key>
npx @techafresh/dark-factory doctor
```

and run the sibling **`dark-factory` skill**: it PRD-checks the repo, writes the config and real
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
src/                 the engine: ledger, tick, stages, gates, instabox + boxd + compose drivers, factoryd
pi-skills/           skill content shipped into every lap agent (ui router, agent-browser, …)
cli/                 the @techafresh/dark-factory npm client
bin/dashboard.ts     read-only telemetry dashboard server (UI in dashboard-ui/)
bin/backup.ts        hourly ledger + state backups to S3-compatible storage
bin/factory-remote   the Python client (deprecated)
templates/           repo config + scenario templates
test/                bun test — parsers, ledger, probes, harnesses, full machine-mode laps
docs/                deep dives (below)
```

## Docs

| doc | contents |
|---|---|
| [Design decisions](docs/design-decisions.md) | every failure class of the previous engine, answered structurally |
| [Lap lifecycle](docs/lap-lifecycle.md) | the six stages of one lap, in detail |
| [Execution modes](docs/execution-modes.md) | host · compose · instabox · boxd (disposable microVMs) |
| [Operations](docs/operations.md) | guided install, remote clients, commands, state layout, models, safe deploys |
| [Scenarios](docs/scenarios.md) | the black-box probe contract and its grammar |
| [Web & skills](docs/web-and-skills.md) | TinyFish grounding and the factory skill channel |
| [Discoveries](docs/discoveries.md) | severity, deferral, and the recursion gate |
| [Key router](docs/keyrouter.md) | multi-key provider failover |
| [Parallel mode](docs/parallel-mode.md) | machine-slot allocator, parallel lanes, merge queue |
| [Development](docs/development.md) | tests, and why boundary stubs must use recorded real shapes |

## Limitations

- The tested deployment shape is one VPS (Ubuntu + systemd); the engine, ledger and gates are
  Bun-only.
- GitHub-centric by design: issues, PRs, checks and labels are the protocol.
- Runtime verification assumes products that can serve HTTP on reserved local ports (the
  scenario contract).
- Machine modes are bounded by your platform's machine cap (InstaBox entry tier ≈ 5
  concurrent machines; boxd: your org's limit).
- Lap and backlog mutations spend real provider tokens. Spend is bounded by per-stage timeouts,
  attempt caps and a per-repo daily ceiling (`limits.daily_attempts`, default 60 implement
  attempts per UTC day), not by a dollar meter. When every model a stage tries answers `402`
  (out of credit) or `401` (bad key), the attempt is refunded and the repo pauses until someone
  runs `unpause`.
