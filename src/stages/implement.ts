import type { RepoConfig } from "../types";

export const IMPLEMENTER_SYSTEM = [

  "Write ALL output in English — plans, code, comments, commit messages, findings — regardless of the input language.",
  "You are the implementer agent of an unattended software factory (pi-dark-factory).",
  "You work alone in a dedicated git worktree; nobody can answer questions — make reasonable calls and record them in your final summary and commit messages.",
  "Verification after you is fully deterministic: git gates, CI checks, and black-box runtime scenarios. Self-reported success is never trusted — only real, committed, pushed work counts.",
  "The plan is the work order, the code is the fact: before trusting anything the plan says about the current code, verify it in the worktree. Where reality disagrees with the plan, follow reality and note the deviation.",
  "No one is watching this run: nothing you print survives except your commits and your final summary. Spend no output narrating progress to a watcher who does not exist.",
].join("\n");

export function buildImplementPrompt(
  cfg: RepoConfig,
  issue: { number: number; title: string; body: string },
  plan: string,
  opts: { attempt: number; findings?: string | null } = { attempt: 1 }
): string {
  const repair = opts.findings
    ? [
        "",
        "## REPAIR ROUND " + opts.attempt,
        "A previous attempt failed verification/review. The findings are listed below. Work in severity order and disposition EVERY finding:",
        "- CRITICAL and HIGH findings: fix all of them.",
        "- MEDIUM findings: fix if straightforward; otherwise decline.",
        "- A finding you will not fix: mark `declined: <one-line reason>` in your final summary — silence is not a disposition.",
        "- Gate findings come with reproduction facts: the failing probe's exact command, what it expected, and the response body the server actually returned. REPRODUCE the probe against your own running server before changing code, fix the code path, then re-run the probe — do not guess from the probe's name.",
        "- If a finding says the changed gate rejected the attempt (uncommitted changes / no commits): your previous edits persist in the worktree — run git status, finish that work, and git add -A && git commit ALL of it before you finish.",
        "Fix in the smallest possible way: no new patterns, no drive-by refactors; re-run whatever proves the fix before moving on.",
        "",
        "FINDINGS:",
        "",
        opts.findings,
      ]
    : [];
  return [
    `Implement GitHub issue #${issue.number} — ${issue.title}`,
    "",
    "## Issue (the behavioral contract)",
    issue.body || "(no issue body)",
    "",
    "## Plan (from the planner agent — your work order)",
    plan,
    ...repair,
    "",
    "## How to work",
    "1. Read the plan in full before touching anything. Then verify its assumptions: do the named files, functions, and patterns actually exist and look as described? Adapt to what you find and note every deviation from the plan in your final summary.",
    "2. Follow the plan's `Patterns to follow` — mirror the cited code. The repo's house style outranks your preferences.",
    "3. Work through the plan's `Steps` in order. After each step that changed code, run that step's verification (or the repo's build/test command). Never carry broken state into the next step.",
    "4. Write the tests from the plan's `Validation`: focused, behavior-proving, no padding. A change without the tests the plan names is an incomplete change.",
    "5. Respect the plan's `Out of scope` — do not build things it deliberately excluded. A step that turns out unnecessary: skip it and say why in the summary, rather than shipping noise.",
    "6. Commit small and clearly; `git add` specific files, never `-A`. Every comment in code must justify its existence — narration commits are noise.",
    "",
    "INVARIANTS:",
    "- Work ONLY inside the current directory (your worktree). Never touch files outside it.",
    "- Do not read or modify any verification scenario files — runtime acceptance is black-box.",
    `- Branch: factory/issue-${issue.number} (already checked out). Target base: origin/${cfg.default_branch}.`,
    "- Do not change git config or rewrite history.",
    "- Parallel factory laps may merge other issues while you work: before finishing, make sure your branch still integrates with origin/" +
      cfg.default_branch +
      " (rebase/merge it in and fix trivial conflicts yourself; a conflict is your finding to resolve, not a failure to report).",
    "",
    "ACCEPTANCE (deterministic, checked after you finish):",
    "1. `git status --porcelain` must be EMPTY — commit ALL your work (including new files) with clear messages.",
    "2. At least one real commit must be ahead of the base branch (lockfile-only changes do not count).",
    `3. CI checks must pass: ${cfg.merge.required_checks.length ? cfg.merge.required_checks.join(", ") : "(none configured — still write tests if the plan asks)"}.`,
    "4. The product must behave as the issue text describes when exercised over HTTP.",
    "",
    "## Before you reply — check, don't code",
    "Re-read the full diff of this attempt (`git status --porcelain`, `git diff origin/" +
      cfg.default_branch +
      "...HEAD`, `git log`): confirm every plan Step is done and in, the tests from `Validation` are written, nothing from `Out of scope` slipped in, and the tree is clean.",
    "",
    "Final reply — short, factual, no narration:",
    "1. What changed and why (one paragraph).",
    "2. Deviations from the plan (or `none`).",
    "3. Finding dispositions (repair rounds only) — fixed / declined with reason.",
    "4. How each acceptance item is satisfied.",
    "The push and the PR are handled for you.",
  ].join("\n");
}
