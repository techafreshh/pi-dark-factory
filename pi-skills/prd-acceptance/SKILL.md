---
name: prd-acceptance
description: How the dark factory judges whether a built product delivered its PRD — the acceptance agent's walk method (agent-browser against the live app), the e2e suite it runs and authors, and the exact GAPS/VERDICT output contract the parser reads. Use when you are the acceptance stage of a lap, when authoring or extending a repo's browser e2e suite, or when an acceptance walk filed [prd-gap] issues you need to understand.
---

# The PRD acceptance walk

The factory built this product from a PRD, issue by issue. Every issue had
its own scenario gates; the acceptance walk judges the WHOLE contract: the
running product against the stored PRD (`state/repos/<slug>/prd.md` on the
factory host — factory state, never in the clone).

You are the judge. The product is already running at the URL in your prompt,
started by the same deterministic machinery verify uses. Do not start, stop
or reconfigure it, and do not fix code — you file the gaps, the normal lap
loop builds the fixes.

## The walk

1. Read the PRD in your prompt. List its deliverables in your head — every
   must-behavior, endpoint, page, rule, and constraint it states.
2. Attempt each one against the live app **like a user would**, with the
   **agent-browser** CLI (its skill documents every command: snapshot, click,
   fill, screenshot). API-only claims may use `curl` against the same URL.
   Judge from what the app DOES, never from the source code.
3. A stored e2e suite result is given when one exists — weigh it, but judge
   the PRD yourself. Green suite ≠ delivered feature; red suite ≠ missing
   feature (the suite itself may be stale).

## Authoring / extending the suite

If the prompt asks you to author or extend tests, write them into the output
directory it names (`e2e` framework shape):

- `package.json` with `{"type":"module"}` (authoring only — the stored suite
  has one);
- an `e2e.config.ts` whose target reads `process.env.APP_URL`
  (`app: { url: process.env.APP_URL ?? "http://127.0.0.1:3000" }`);
- test files ending `.e2e.ts` using `test` from `@e2e-dev/web` and `expect`
  from `e2e`.

Symlink the installed toolchain so imports resolve:
`ln -sfn <toolchain>/node_modules node_modules` (the prompt names the
toolchain path). Encode ONLY behavior you actually saw work or fail;
deterministic Playwright-style assertions first, `agent.act` steps only where
a flow truly needs judgment. Never delete a test to make a run pass.

The suite lives OUTSIDE the repo (factory state) on purpose: it is acceptance,
and the implementing agent can never tune against its own gate.

## The output contract

Your final message must end EXACTLY with:

```
GAPS:
- <requirement from the PRD> :: <what is missing or wrong> :: major|minor :: <how you reproduced it>
...
VERDICT: DELIVERED   (only when the live product delivers every PRD requirement)
```

- `major` = a PRD deliverable the build lacks or breaks; `minor` = polish or
  edge behavior. When in doubt, major — a mislabeled minor silently defers.
- No gaps: omit the GAPS section entirely, keep the VERDICT line.
- No VERDICT/GAPS structure at all = the walk fails closed (recorded as a
  failed run, nothing filed) — so always end with the VERDICT line, no prose
  after it.

## What happens to your gaps

Each GAPS line becomes a deduped `[prd-gap]` issue the factory's own account
opens; intake claims it like any backlog item, a lap plans and builds the
fix, and the walk re-runs when the backlog drains again. A full walk with no
gaps records DELIVERED against the current main — the project is done.
