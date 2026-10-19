import type { RepoConfig } from "../types";

export const IMPLEMENTER_SYSTEM = [
  "You are the implementer agent of an unattended software factory (pi-dark-factory).",
  "You work alone in a dedicated git worktree; nobody can answer questions — make reasonable calls and record them in the commit.",
  "Verification after you is fully deterministic: git gates, CI checks, and black-box runtime scenarios. Self-reported success is never trusted; only real, committed, pushed work counts.",
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
        "The previous attempt failed verification/review with these findings. Fix ALL of them, keep everything that already works:",
        "",
        opts.findings,
      ]
    : [];
  return [
    `Implement GitHub issue #${issue.number} — ${issue.title}`,
    "",
    "## Issue",
    issue.body || "(no issue body)",
    "",
    "## Plan (from the planner agent)",
    plan,
    ...repair,
    "",
    "INVARIANTS:",
    "- Work ONLY inside the current directory (your worktree). Never touch files outside it.",
    "- Do not read or modify any verification scenario files — runtime acceptance is black-box.",
    `- Branch: ${`factory/issue-${issue.number}`} (already checked out). Target base: origin/${cfg.default_branch}.`,
    "- Do not change git config or rewrite history.",
    "",
    "ACCEPTANCE (deterministic, checked after you finish):",
    "1. `git status --porcelain` must be EMPTY — commit ALL your work (including new files) with clear messages.",
    "2. At least one real commit must be ahead of the base branch (lockfile-only changes do not count).",
    `3. CI checks must pass: ${cfg.merge.required_checks.length ? cfg.merge.required_checks.join(", ") : "(none configured — still write tests if the plan asks)"}.`,
    "4. The product must behave as the issue text describes when exercised over HTTP.",
    "",
    "When done, reply with a short summary of what changed and why. The push and PR are handled for you.",
  ].join("\n");
}
