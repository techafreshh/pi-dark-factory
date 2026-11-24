# PRD-delivery acceptance — the verify-stage e2e gate, the drain-time walk, and the security audit

Status: implemented 2026-11-13, opt-in per repo. The per-issue contract (the
scenario gates) already proves each lap did its own job; this layer proves the
**product as a whole delivered the PRD**, and that the code does not carry
known security problems. Every finding loops back through the normal lap
machinery — the factory files the issue, a lap builds the fix, the gates re-run.

Three capabilities, one config block (`docs/acceptance.md` config keys live in
the repo config's `acceptance` block; the three capabilities default OFF, while
the `security_public` sub-flag defaults ON):

```jsonc
"acceptance": {
  "e2e": false,             // verify gate: run the authored browser suite on every lap
  "prd_check": false,       // drain-time: walk the whole PRD against the live product
  "security": false,        // per-merge: penthera scan of merged main
  "security_public": true,  // file/show findings on PUBLIC repos; false = sensitive tracker
  "severity_floor": "medium",
  "e2e_minutes": 10,
  "prd_minutes": 25
}
```

## The tools and the split

| tool | role |
|---|---|
| [e2e](https://e2e.com) (Apache-2.0, `e2e` on npm) | the authored test suite: Playwright-style deterministic assertions + `agent.act` natural-language steps (recorded to a replay cache, so per-merge runs mostly replay without model calls) |
| [agent-browser](https://agent-browser.dev) (Chrome/CDP CLI) | the drain-time PRD walk: the acceptance agent drives the live app like a user |
| [penthera](https://penthera.org) (MIT, `npx penthera`) | the static security scan: secrets, risky routes, dependency behaviour, AI-setup rules — offline, no product code executes |

## Where things live (acceptance is outside the repo, always)

- `state/repos/<slug>/prd.md` — the delivery contract. Written by `backlog`
  slicing (the slice bumps the **acceptance generation**; a new backlog is a
  new contract, so a stale PASS never outlives its generation). Replaceable
  without re-slicing via `POST /repos/<slug>/prd` (`dark-factory prd`).
- `state/repos/<slug>/e2e/` — the authored suite (`e2e.config.ts` +
  `*.e2e.ts`). Authored by the acceptance agent during the first walk; runs
  are deterministic afterwards. The implementing agent can never tune against
  this gate — same rule as `runtime.json`/`holdout.json`.
- `state/repos/<slug>/acceptance.json` — the verdicts: `{gen, last
  (PRD walk), last_security (penthera), runs (daily counters)}`.

## 1. The verify gate carries the e2e suite

The authored browser suite is a **verify-stage gate**, not a post-merge
hook: `runVerify` (src/stages/verify.ts) runs it in the same product-up
window the scenario probes use — host/compose host-side, machine modes on
the lap's OWN box (no machine boot per merge; the merge queue's re-verify
after a rebase re-runs it in the still-alive lap box, which is exactly the
"branch content = what main is about to become" moment). A failing suite
is a **gate failure** like a failed probe: it blocks the merge and routes
into the repair loop with the failing tests as findings — the agent fixes
it before anything lands, and nothing files issues at merge time.
Fail-fast: a product that failed its probes skips the browser. The gate
skips while no suite exists (the drain-time walk authors one) or the flag
is off; `acceptance.e2e_minutes` caps a run. The runner exports `CI=1`,
which gives failed tests one automatic retry — a flaky test gets a second
chance before it blocks a merge, but the contract is still deterministic
suites: the prd-acceptance skill's authoring rules say so, and a suite that
needs retries to stay green is a bug in the suite. Machine repos need the
browser in their golden snapshot — a re-`bake` with the flag on (the bake
smoke fails loudly when a platform cannot carry one).

**The PR sees the evidence.** After every verify, the factory posts one
report-only comment on the PR: the e2e verdict (✅/❌ with the failing
tests, ⏭️ infra-skip with its reason) and — when `acceptance.security` is
on — a **branch penthera scan** (static, host-side, token-free, `ref` =
the lap branch). The branch scan never gates and never files: inherited
findings are the post-merge scan on merged main's job, and the comment
follows the same disclosure rule as issue filing — on a public repo it
carries counts, never file/line/sink. A comment failure is a receipt;
it never touches the lap.

## 2. The post-merge audit

After every squash-merge (serial post-merge block and the parallel merge
queue's landing alike), `runPostMergeExtras` (src/postmerge.ts) runs, each
step individually caught — a hook failure is a receipt, never a lap error:

1. **penthera** (`acceptance.security`) — a detached worktree of merged main,
   scanned host-side for EVERY execution mode (it is static: no product code
   runs on the VPS). The JSON report (`-o`) is parsed against the captured
   fixture shape; unparsable output files NOTHING (fail closed). Findings at
   or above `severity_floor` become deduped `[security]` issues (fid-stable
   titles; ≤10 per scan, overflow summarized in the last issue's body).
   Penthera's own fix diffs are deliberately NOT applied — a fix goes through
   plan/implement/verify/review like every other change.

   **Visibility (operator call, 2026-11-16): findings are public by
   default.** `acceptance.security_public` defaults to true — findings file
   and show in the PR evidence comment on public repos exactly as they do on
   private ones. A repo that treats its tracker as sensitive opts OUT with
   an explicit `security_public: false`: the scan still runs and receipts
   there, it just does not publish, and an unreadable visibility (gh failed)
   fails closed for that repo — the opt-out's whole point is preventing a
   one-way disclosure, so its failure mode must not publish.

   **Sticky closes need the `wontfix` label.** The factory closes an issue
   itself when it merges the fix, so a bare close suppresses nothing: a
   finding that survives its own fix (or a regression) re-files on the next
   scan, exactly as it should. A human who decides NOT to fix a finding
   adds the `wontfix` label and closes it — the scan then never re-files
   that finding (gh 2.45 cannot read a close's `stateReason`, so the label
   is the signal). GitHub's default label set includes `wontfix`; if a repo
   removed it, create it again (`gh label create wontfix --repo R --color
   F9D0C4`) or the suppression signal has nowhere to live.
2. The pre-existing scenario regression (`runPostMergeRegression`) is
   unchanged and runs alongside. The browser e2e suite is NOT here — it is a
   verify-stage gate (§1): its failures block the merge through the repair
   loop instead of filing issues after the fact.

`status` shows the security verdict per repo (`dark-factory acceptance SLUG
--status`); the e2e gate's outcome lives in the verify evidence sidecar and
the review prompt.

## 3. The drain-time PRD acceptance walk

When a tick finds nothing claimable and every open issue is a deferred
factory class (discovery/security/minor — `openIssuesAllDeferred`), the
repo's backlog is **drained** and `maybeDrainAcceptance` runs the walk
(src/stages/acceptance.ts `runPrdAcceptance`):

1. Serve the product the deterministic way (the runtime scenario's
   setup → start → readiness via the scenario runners' `onReady` seam — the
   acceptance never trusts an agent to start what it judges). Machine modes
   use the `pdf-<slug>-i0` machine; the janitor spares it while the walk's
   marker (`acceptance.running`, live pid) says otherwise.
2. Run the authored suite (results feed the agent's judgment).
3. Run the **acceptance agent stage** (recorded in `stage_runs` as
   `stage="acceptance"` with the lap_id-0 sentinel; it burns no implement
   attempt from the daily ceiling): the PRD text + suite results + the live
   URL; the agent walks every deliverable with agent-browser and ends with
   the parseable contract:
   ```
   GAPS:
   - <requirement> :: <what is missing/wrong> :: major|minor :: <repro>
   VERDICT: DELIVERED
   ```
   Lenient parse, fail closed: no VERDICT/GAPS structure → the walk records
   FAIL and files nothing.
4. Each gap → a deduped `[prd-gap]` issue (major = a PRD deliverable the
   build lacks; minor = polish, labeled `minor` and deferred by intake until
   the roadmap drains). A walk with no gaps records
   `last = {status: "pass", main_head, gen}`.

**The loop:** gaps filed → laps build them → merges re-run the scenario
regression (`runPostMergeRegression`) → drain again → the walk re-runs (a
PASS is only skipped while main is exactly the sha it was recorded on and
the generation is unchanged). A walk that
fails WITHOUT filing anything (unparsable verdict, broken product) is capped
at 2 automatic runs per UTC day so the loop cannot burn tokens forever;
manual runs (`dark-factory acceptance SLUG`, `POST /repos/<slug>/acceptance/run`)
bypass the cap.

## 4. Provisioning the toolchain

Browser e2e needs Chromium + node 22+ + the `e2e` package + agent-browser.
One canonical script per lane (src/browserbake.ts) so every lane installs the
same thing:

- **host/compose repos** — `foreman host-tools` (or `POST /host-tools`)
  installs under `~/.pdf/e2e-toolchain` (+ browsers beside it) and ends with
  a headless Chromium launch smoke. Once per VPS.
- **machine repos** — `foreman bake <slug>` appends the toolchain to the
  platform bake when either `e2e` or `prd_check` is on, then smokes an
  in-box browser launch before snapshotting. **A bake whose browser cannot
  launch fails loudly (exit 31)** — the egress caveat: instabox/boxd are
  unrestricted, but Daytona Tier 1/2 and InstaVM Free run allowlists that may
  block apt/browser CDNs. Run the bake per platform and trust the smoke.

The agents get the `prd-acceptance` skill (pi-skills/) with the walk method
and the output contract; agent-browser's own skill ships alongside.

## Priority and labels

`prioritizeDiscoveries` (src/stages/intake.ts) orders the factory classes:

- `[security]` findings join discovery majors at the FRONT (a vulnerable main
  must not accumulate merges);
- `[prd-gap]` majors are product work — they ARE the roadmap;
- every minor-labeled factory issue defers behind the roadmap, exactly like
  minor discoveries.

All three classes file through `fileFactoryIssues` (src/fileissues.ts) —
title-deduped against open issues, labels created on demand, one failed
create never loses the batch.

## Deliberate trade-offs (review 2026-11-14)

- **Acceptance machines are not counted in the fleet slot pools** — the same
  standing rule as bake and `scen-test` machines (docs/parallel-mode.md,
  "Not in scope"). Only the drain walk boots one (the e2e gate rides the
  lap's own box), so the over-subscription risk is one acceptance machine
  per draining repo; the platform's own cap-reject and the 10-minute
  slot-queue deadline stay as the fallback. On a fleet at the edge of its
  caps, keep one pool slot of headroom.
- **The e2e gate adds `e2e_minutes` to every lap's verify** (plus the
  merge queue's re-verify after a rebase — the same box, no extra boot).
  The post-merge extras still add a scan (≤10 min) inside the chain budget;
  in parallel mode a landing lane holds the merge queue through its
  penthera scan. Every step is individually try/caught, so the chain never
  enters the error path. If the lap latency bites, the knobs are
  `acceptance.e2e_minutes`, `PDF_SECURITY_SCAN_MINUTES`, or turning off
  `acceptance.e2e` per repo (the drain walk still runs the suite at the
  end — you lose only the per-merge attribution).

## Cost model

- The per-merge penthera scan is token-free (static tool).
- Per-merge e2e runs mostly replay cached `agent.act` steps; the suite's
  model calls ride the repo's `pass_env` provider keys (OpenRouter etc.).
- The drain walk is one agent stage per run (`acceptance.prd_minutes`, 25
  default) + the suite. Acceptance stage rows do NOT count toward
  `limits.daily_attempts` (that ceiling counts implement stages only) — the
  walk's bound is its timeout, the daily cap, and the due-ness rules.

## Rollout checklist (per repo)

1. Patch the config: `dark-factory config SLUG --json '{"acceptance":{"e2e":true,"prd_check":true,"security":true}}'`
2. Provision: `dark-factory host-tools` (host/compose) or re-`bake` (machine
   repos — the verify gate's in-box suite and the walk's machine both need
   the browser in the golden snapshot).
3. Store/refresh the contract: slicing a backlog does it; otherwise
   `dark-factory prd SLUG --prd-file PRD.md`.
4. Walk once by hand: `dark-factory acceptance SLUG` — expect either a PASS
   or the first `[prd-gap]` issues. Both manual verbs take the repo lock for
   the whole run (the walk can hold it for `prd_minutes` plus machine boot),
   so ticks for that repo answer "a tick is live" until it finishes — run
   them when the repo is idle.
5. Watch `laps.log` for the per-merge `post-merge extras:` receipts.
