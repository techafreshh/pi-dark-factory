# Development — tests and the boundary rule

`bun install && bun test` covers parsers, ledger, probes, the spawner (fake pi binary), the scenario harness (real python3 server), the instabox client (fake API), machine stages through a fake ssh gateway, the boxd lane through a stubbed SDK client, and full tick integration.

## Development

```
bun install
bun test          # 322 tests: lenient parsers, ledger, probes, spawner (fake pi binary),
                  # scenario harness (real python3 server), instabox client (fake API),
                  # machine stages through a fake ssh gateway (real git), full machine-mode lap,
                  # boxd exec wrapper + lap machine (stubbed SDK client),
                  # tick integration (real git, fake gh), parallel dispatcher,
                  # TinyFish web-tools client (stubbed API) + stage-tool wiring
```

### Boundary tests use recorded real shapes, never invented ones

Every stub/fake of an external system (gh, the InstaBox API, pi output, ssh gateways) must be
built from **captured real output**, not from what the TypeScript type suggests. Bun does not
typecheck, so a stub that satisfies the interface but lies about the wire shape ships silently
and only fails in production. Incidents that make the rule:

- `fileDiscoveries` called `gh.issueListOpen`, which no `GhApi` implementation had — the verb
  500ed on every use (stub-only methods survive because bun never checks).
- `gh --json labels` returns label **objects** (`[{name, id, color}]`), `IssueLite` promised
  `string[]` — every string comparison (skip_labels, needs-info, discovery prioritization)
  silently never matched; FakeGh's strings made the tests green (2026-11-01, sigkill + jetpack
  claimed in number order despite the promotion).
- the InstaBox create-machine field is `templateId`; the client shipped `template` and every
  boot path 400ed (found live during a bake).

Practice: when touching a boundary, paste the actual CLI/HTTP response into the test (see
`test/gh.test.ts` for the label-object shape) or run the real binary in the harness (real git,
real python3). When a production failure contradicts a stub, the recorded shape gets fixed
FIRST — the stub was the lie.

One runtime dependency: `@boxd-sh/sdk` (boxd mode's machine lifecycle). `src/tick.ts` imports
it statically, so every factory process needs it installed: a deploy that changes
`package.json` runs `bun install`. Everything else is `bun:sqlite` and the Bun standard
library. The only subprocesses the factory expects on its host: `git`, `gh`, `ssh` (instabox mode), optional
`docker` (compose mode), and `pi` itself. Web grounding uses the TinyFish HTTP APIs from
the bundled pi extension (network calls from stage agents only).
