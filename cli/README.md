<div align="center">

# @techafresh/dark-factory

*Remote control for a pi-dark-factory — watch and drive your unattended build loop from any OS*

[![npm](https://img.shields.io/npm/v/@techafresh/dark-factory?style=flat-square)](https://www.npmjs.com/package/@techafresh/dark-factory)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-3c873a?style=flat-square)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

[Installation](#installation) • [Setup](#setup) • [Verbs](#verbs) • [Scripting](#scripting)

</div>

**dark-factory** is the command-line client for a [pi-dark-factory](https://github.com/techafreshh/pi-dark-factory) instance — an unattended loop where AI agents pick up GitHub issues, implement them, verify them against running services, and merge. This CLI is how you **watch and drive** that loop from anywhere with Node ≥ 18 (Windows, macOS, Linux — no WSL, no Python, zero runtime dependencies):

- **Observe** — live status per repo (claimable chain depth, laps in flight), ledger and laps, the audit log, cost/token telemetry per stage, and a live stream of what any agent is thinking right now.
- **Drive** — fire a lap on demand, pause/unpause repos, deep-merge config patches, validate and test-run scenarios without spending a lap, slice a PRD into a dependency-ordered backlog, unblock wedged issues, prune caches.

## Installation

```bash
npm install -g @techafresh/dark-factory
```

Or without installing:

```bash
npx @techafresh/dark-factory <verb>
```

## Setup

Once per machine, point it at your factory:

```bash
dark-factory setup <factory-url> <api-key>
dark-factory doctor
```

- `<factory-url>` — the public URL of your factory (its operator, or the factory's own docs, tells you what this is).
- `<api-key>` — a factory edge API key. **Whoever holds a key controls the factory** — treat it like a password.

Config lands in `~/.dark-factory/config.json`. Per-shell overrides and precedence, highest first:

1. Inline flags — `dark-factory status --url <factory-url> --key <api-key>`
2. Environment — `DARK_FACTORY_URL` / `DARK_FACTORY_API_KEY`
3. The stored config file (`dark-factory where` shows what's in play, key always masked)

### Local Docker factory

A factory running in Docker on your own computer listens on loopback, so point the client at it with
plain HTTP: `dark-factory setup http://localhost:8077 <api-key>`. `setup` warns when an `http://` URL
points anywhere other than localhost, because the key would travel in cleartext. The Docker install
is described in the factory repo's [`docs/docker.md`](https://github.com/techafreshh/pi-dark-factory/blob/main/docs/docker.md).

> [!TIP]
> Provision one key per client (e.g. a dedicated key per laptop). They're independently revocable at the factory edge without disturbing other clients.

## Verbs

| watch | drive |
|---|---|
| `setup URL KEY` · `where` | `onboard OWNER/NAME` |
| `health` · `doctor` · `models` | |
| `status [--repo SLUG] [--raw]` | `config SLUG [--json PATCH]` |
| `logs [--repo SLUG] [--tail N]` | `tick SLUG` · `pause SLUG` · `unpause SLUG` |
| `session SLUG [--follow] [--think] [--issue N]` | `scenario SLUG runtime\|holdout [--file F] [--lint] [--test [--branch B]] [--dump]` |
| | `prove-gates SLUG` · `discoveries SLUG [--file]` |
| | `backlog SLUG --prd-file F [--max N] [--create]` |
| | `unblock SLUG ISSUE [--prune] [--force]` · `cleanup` |

Every verb has its own, detailed manual: `dark-factory <verb> --help`.

`session --follow` streams the agent's work as it happens (reasoning included with `--think`) and reconnects automatically after drops — Ctrl-C to stop. `scenario --lint` always validates before a write ever lands; `scenario --test` executes a scenario against a branch **without** spending a lap.

## Scripting

- `--format json` renders `status`, `logs`, `models` and `doctor` as machine-readable JSON.
- Exit codes: `0` success · `1` error or failed verdict · `2` usage — so `scenario --test` and `prove-gates` gate cleanly in CI or shell scripts:

```bash
dark-factory scenario my-app runtime --test && echo "scenario green — fire the lap"
dark-factory --url <factory-url> --key <api-key> tick my-app
```

### Terminal ergonomics

- **Color when it's a terminal, clean when it's a pipe** — human output gets section rules,
  state colors and checkmarks; every piped invocation stays byte-plain for `grep`/`jq`.
  Set `NO_COLOR=1` to force plain even on a TTY.
- Inline `--url`/`--key` outrank the env vars, which outrank the stored config — one shell
  can talk to two factories side by side.
- Every verb documents itself: `dark-factory <verb> --help`.

## How it talks

Plain HTTP(S): `/health` is open, every other call authenticates with `X-Api-Key`. Reads are GET; mutations are POST/PUT. The server arbitrates concurrent ticks, so firing a lap manually can never double-run one.
