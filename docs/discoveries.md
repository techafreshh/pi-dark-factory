# Discoveries — severity, deferral, and the recursion gate

Reviews harvest future-bug candidates; the autonomy policy around filing them is deliberately strict.

With `discoveries.auto_file: true` in a repo config (flipped on fleet-wide as of
2026-10-31), new discoveries are filed automatically right after each review — labeled
`discovery`, title-deduped, and claimed by the next tick's intake; each issue body carries an
acceptance nudge because a discovery arrives as a claim and the plan stage is what makes it
verifiable. Without the flag, filing stays behind `factory-remote discoveries <slug> --file`.

Two owner policies of 2026-11-02 bound the class (the first 36 hours measured 72–90% of all
harvests filed by discovery-fix laps themselves, which pushed whole roadmaps — jetpack went
~25h with zero product work — behind self-propagating "same class at the sibling call site"
chains):

- **Recursion gate** — a discovery lap never auto-files. Its review's findings still land on
  the PR as the review comment and persist in the `discoveries-<attempt>.json` sidecar; only
  the issue minting is withheld (a `recursion gate` receipt marks it). A fix that did not fix
  rides the reject→repair loop, not a new issue.
- **Severity axis** — the DISCOVERIES bullet is `- title :: claim :: why :: major|minor`.
  Major = a bug the current build's user can hit; minor = consistency/hygiene/docs/perf
  follow-ups. Missing or unparseable severity fails open to major (a reviewer regression must
  never silently defer finds). Minors file with a second `minor` label and defer to the
  roadmap: while any product (non-discovery) issue is claimable they are left out of the
  queue entirely, and they flow only after the PRD backlog drains. Majors keep the 2026-11-01
  drain-first priority.

The starter, `scenario-harness`, teaches agents the runtime-verification
contract: the `expect`-token grammar probes are judged with, what failed-probe
reproduction data means, and why probes are the issue's contract rather than something
to game.
