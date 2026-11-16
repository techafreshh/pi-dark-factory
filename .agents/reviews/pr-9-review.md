# Code Review: PR #9 feat: Docker Compose install for laptops and VPSes

## Metadata

| Field | Value |
|-------|-------|
| **Scope** | PR #9 (25 files, about 1,365 diff lines) |
| **PR Number** | 9 |
| **Branch** | feat/docker-local-install (6fba4b6) |
| **Base** | main |
| **Author** | techafreshh |
| **Date** | 2026-11-12 |
| **Gate** | high |
| **Recommendation** | NEEDS WORK |

## Summary

The PR adds a Compose stack (`factoryd` plus `dashboard`, loopback-only), a startup scheduler pass, a dashboard env fallback, CLI wording and a cleartext warning, docs, and a Docker path in the setup skill. The engine changes are small, well tested and default-off for the VPS. One high-severity bug sits in the entrypoint's GitHub credential setup: a normal token can leave git without credentials, and the warning blames the wrong cause. The PR itself lists this branch as untested.

## Issues Found

### Critical
None.

### High Priority

**H1. `gh auth setup-git` only runs if `gh auth login --with-token` succeeds** (`docker/entrypoint.sh:41-48`)

`gh auth login --with-token` validates the token online and, per the gh manual, requires the scopes `repo`, `read:org` (and lists `gist`) for classic tokens. The manual also says to favour `GH_TOKEN` for fine-grained tokens rather than `--with-token`. A classic token with only `repo` (the scope set `.env.example` and `docs/docker.md` imply: "read issues, push branches, open and merge PRs") fails the login. The `else` branch then:
- prints "gh rejected GH_TOKEN (expired, revoked or mistyped)", which is wrong for a valid token;
- skips `gh auth setup-git`, so git has no credential helper. The host-side `git clone` in `src/gitws.ts:58` and agent pushes then fail with `could not read Username`, and the troubleshooting table points the user at the token, not the scope.

I checked that `GH_TOKEN=<anything> gh auth setup-git --hostname github.com` exits 0 and writes the helper without any login (gh 2.45.0 here). The gh helper reads the token from the environment. I did not test against the live GitHub API, so the `read:org` enforcement rests on the gh manual.

Fix:
- Run `gh auth setup-git --hostname github.com` whenever a token is set, independent of the login result.
- On login failure, probe with `gh api user` and choose the message from that: "token invalid" versus "token works, but lacks the scopes `gh auth login` wants (read:org); using GH_TOKEN directly".
- Add `read:org` to the scope guidance in `.env.example`, `docs/docker.md` and the skill's D2, or say fine-grained tokens skip the check.
- Add a test (or at least an entrypoint run in the smoke notes) that covers the failed-login path still configuring git.

### Medium Priority

**M1. The first `doctor` run on a fresh local install shows red failures** (`cli/bin/dark-factory.js:194`, `:212`; `docs/docker.md` Quickstart)

`laptop key: NOT provisioned` and `shared base: UNMAPPED` print as `✘`. The PR documents them and the skill tells the agent to explain them, but a user running the documented quickstart sees failures right after installing. Make `formatDoctor` treat both as informational when the daemon says it has no laptop key, or when the URL is loopback, or add a field to `/health` such as `deployment: "docker"`. Otherwise the new install path starts with false alarms.

**M2. The security notes overstate what the env allowlist protects** (`docs/docker.md` "Security notes")

The text says host-mode agents get an allowlisted environment and not `FACTORY_API_KEY`. That is true of their environment, but they run as the same uid as the daemon in the same container. They can read `/proc/<daemon pid>/environ` (every key in `.env`), `~/.config/gh/hosts.yml` (which this PR now writes with the token), and `~/.pi/agent/auth.json` (OAuth logins). `src/agentenv.ts` already calls the allowlist "defense in depth only". Say so in the doc, in one sentence, and keep the existing advice to prefer a cloud lane for untrusted work.

### Suggestions

- **S1. Stale `pi auth login`** (`.agents/skills/dark-factory-setup/SKILL.md` Phase 4b, `DEPLOYMENT.md:65`). `pi --help` has no `auth` subcommand (checked with pi 0.80.2), and the PR's own D3 says to use `/login`. The skill now contradicts itself within one file. Fix both lines in this PR; it is a two-line change.
- **S2. `.dockerignore` only excludes `**/.env` and `docker/.env`** (`.dockerignore`). The skill's `setenvf` helper writes `docker/.env.new` before `mv`; if `awk` fails or the session is interrupted, that file holds secrets and `COPY . .` puts it in the image. Use `**/.env*` with `!**/.env.example`, and extend `test/docker.test.ts`.
- **S3. Service-name DNS on a shared network** (`docker/compose.caddy.yml`). `reverse_proxy factoryd:8077` resolves by service name on `web_gateway`, which other stacks on that network share. Add a unique alias (for example `pi-dark-factory-factoryd`) and use it in the Caddy block.
- **S4. The CLI wrapper in `docs/docker.md`** uses `docker compose exec` without `-T` (a TTY breaks piping and `--format json | jq`) and is bash-only. Add `-T` and a one-line note for PowerShell users, or tell Windows users to install Node.
- **S5. `gh api user` in the entrypoint has no timeout** (`docker/entrypoint.sh:20`). A network black hole at start-up delays the container before the health check even begins. Wrap it with `timeout 15`.

## Issue Count

| Severity | Count | Blocks Merge? |
|----------|-------|---------------|
| Critical | 0 | No |
| High | 1 | Yes |
| Medium | 2 | No |
| Suggestions | 5 | No |

## Validation Results

| Check | Status |
|-------|--------|
| Type Check (`tsc --noEmit`, via `bun run check`) | PASS |
| Lint | N/A (the repo has no lint script) |
| Tests (`bun run check`: 469 pass, 0 fail, 40 files) | PASS |
| `docker compose config` (base and with `compose.caddy.yml`) | PASS |
| Compose refuses an empty `FACTORY_API_KEY` with the intended message | PASS |
| Image build, container run, arm64, a real lap | NOT RUN by me (the PR reports the amd64 smoke; arm64, macOS, Windows and the gh login success path are listed as untested in the PR) |

## What's Good

- The engine changes are minimal and safe by default. `PDF_TICK_ON_START` is off unless set, so a VPS restart behaves as before. `startScheduler` keeps its old signature, and the five new tests cover run, cap pass-through, off-by-default, failure receipt and stop-before-delay.
- The sharp edge from the plan (`src/lock.ts` matching `/pi-dark-factory/` in the cwd) is handled and pinned by a test.
- Ports are loopback-only, `.env` stays out of the image and git, the dashboard gets only the two machine keys, and the entrypoint avoids tracing and echoing secrets. Each is covered by a static test.
- `FACTORY_API_KEY` is required by compose with a clear message; the empty-key drop in the entrypoint avoids passing empty strings to agents as "set".
- The PR description lists its deviations and what was not tested honestly. Pins for Bun (1.3.14) and pi (0.80.2) match what runs here.
- The VPS phases of the skill stay unchanged, and the compose-mode limitation is stated in the docs.

## Recommendation

Fix H1 before merge, ideally with the M2 wording and S1 and S2, which are small. M1 can be a follow-up if you prefer, but it will be the first thing a new user sees. After the fix, run the failed-login smoke once with a real classic token that has only `repo`, and once with a fine-grained token, and record both.

## Audit Trail

| Artifact | Path |
|----------|------|
| Plan | `.agents/plans/docker-local-install.plan.md` |
| Implementation Report | not found |
| This Review | `.agents/reviews/pr-9-review.md` |
