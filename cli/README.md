# @techafreshh/dark-factory

`dark-factory` — remote control for a [pi-dark-factory](https://github.com/techafreshh/pi-dark-factory)
from any OS with **Node >= 18** (Windows, macOS, Linux — no WSL, no Python).
Zero runtime dependencies; one file.

```bash
npx @techafreshh/dark-factory doctor          # try it without installing
npm i -g @techafreshh/dark-factory            # or install the command once
dark-factory status
```

## Setup (once per machine)

```bash
dark-factory setup https://pi-factory.techa.pro <your-factory-api-key>
dark-factory doctor
```

The config lands in `~/.dark-factory/config.json` (your user profile — on
Windows `%USERPROFILE%\.dark-factory\config.json`). Per-shell overrides:

```bash
DARK_FACTORY_URL=https://pi-factory.techa.pro DARK_FACTORY_API_KEY=<key> dark-factory status
```

`dark-factory where` shows what is in play (key material is always masked).
The key is a factory edge API key — whoever holds it runs the factory; treat
it like a password.

## Verbs (mirror `factory-remote` on the VPS one-to-one)

| read | drive |
|---|---|
| `health`, `doctor`, `models` | `onboard OWNER/NAME`, `tick SLUG`, `pause/unpause SLUG` |
| `status [--repo SLUG] [--raw]` | `config SLUG [--json PATCH]` |
| `logs [--repo SLUG] [--tail N]` | `scenario SLUG runtime\|holdout [--file F] [--lint] [--dump] [--test]` |
| `session SLUG [--follow] [--think] [--issue N]` | `prove-gates SLUG`, `discoveries SLUG [--file]` |
| | `backlog SLUG --prd-file F [--max N] [--create]` |
| | `unblock SLUG ISSUE [--prune] [--force]`, `cleanup` |

`session --follow` streams the live agent session and auto-reconnects (5s
backoff) — Ctrl-C to stop. `scenario --test` and `prove-gates` exit non-zero
on a failed verdict, so they script cleanly.

Exit codes: `0` success · `1` error or failed verdict · `2` usage.

## How it talks

HTTPS to your factory URL (`/health` is open, every other call sends
`X-Api-Key`) — the same endpoint the VPS's own `factory-remote` uses. All
reads are GET; mutations are POST/PUT. Lap and backlog mutations spend real
tokens and are confirmed like the skill teaches (`queued: <slug> #N` in the
logs means a lap truly started).
