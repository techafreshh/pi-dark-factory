---
name: scenario-harness
description: How the dark factory's runtime verification works — the runtime.json scenario contract, the expect-token grammar probes are judged with, and how to read failed-probe reproduction data. Use when a lap's verification fails, when implementing a feature that scenario probes will exercise, or when a probe result seems to contradict the issue.
---

# The scenario harness

Verification runs your product as a real server and judges it with probes.
The contract for a repo lives in `runtime.json` (factory state, not in the
clone). The harness, per scenario:

1. runs `setup` (e.g. build a venv, install deps) — skip it when your change
   cannot have touched deps and the harness reuses a prepared environment;
2. starts `start` in the background with `$PORT` exported to the resolved
   port (repos reserve a port pair; `port: "first"`/`"second"` picks one) and
   waits for `readiness_path` to answer before judging anything;
3. runs each probe's `command` (a shell string, `$PORT` available) and judges
   its stdout + exit code against `expect`;
4. tears the server down; a failed probe returns the exact `command` it ran
   and the (capped) `body` it got back — read those before theorizing, they
   are the reproduction facts, not a summary.

## The expect grammar

Tokens are space-separated; `exit:0` is implicit unless another `exit:` token
appears. One failed token fails the probe.

| token | passes when |
|---|---|
| `status:200` | the LAST line of stdout equals it exactly |
| `status_in:200,404` | the last line is one of the comma-separated values |
| `json:items[0].id=1` | stdout is valid JSON, the dot-path (with `[i]` indexing) deep-equals the value (the value is JSON-parsed when it parses, else treated as a raw string) |
| `body_contains:welcome` | stdout contains the substring |
| `body_matches:^{"items"` | a JS RegExp tests true against the full stdout — without the `m` flag `^`/`$` anchor the whole output, not lines |
| `exit:0` | the command's exit code equals it |
| `max_ms:3000` | always passes here — documentation; the probe's `timeout_ms` is what the runner enforces |

An unknown token fails the probe, so copy the grammar exactly.

## Failure signatures and what actually fixes them

- `status:` compares the last stdout line — a command that prints anything
  extra fails even on HTTP 200. That is why probes use
  `curl -s -o /dev/null -w '%{http_code}'`. If you add an endpoint a probe
  hits, keep the probe's command's output shape in mind.
- `json:` deep-equality is strict: scalars and arrays compare cleanly, but a
  whole-object comparison is key-order-sensitive between the response and the
  literal — a probe on a specific path is the robust shape.
- `body_matches:` regexes anchor the whole stdout: `^{"items"` means the body
  must START with that text — pretty-printed or space-after-colon output
  fails it. Match the compact JSON shape the probe expects.
- Probe failed with a connection refused / empty body: the server died
  between readiness and the probe (or crashed on that request) — reproduce
  locally with the returned command and read the server log.
- The port was busy: a previous server is still listening; the harness
  reclaims stray listeners on the reserved pair, so this usually means your
  own `start` failed and something else holds the port.

## Your position

Probes encode the issue's acceptance contract. Make the product satisfy them;
never weaken or game a probe (e.g. hardcoding a response body a probe
matches). You cannot edit `runtime.json` — it is foreman-managed state — so
if a probe genuinely contradicts the issue text, implement the issue and flag
the contradiction in the PR description for human review.
