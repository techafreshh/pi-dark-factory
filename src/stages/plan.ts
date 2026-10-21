import type { RepoConfig } from "../types";

export interface PlanOutcome {
  kind: "plan" | "no_action" | "insufficient_context";
  plan?: string;
  /** no_action: why no code change; insufficient_context: the question for the issue author */
  reason?: string;
  question?: string;
  /** insufficient_context: the defaults the planner would have assumed */
  assumptions?: string;
}

/** First non-empty line decides: NO_ACTION / INSUFFICIENT_CONTEXT / plan. */
export function parsePlan(text: string): PlanOutcome {
  const lines = text.trim().split("\n");
  const firstIdx = Math.max(0, lines.findIndex((l) => l.trim().length > 0));
  const first = lines[firstIdx].trim();
  if (/^no[_\s-]?action\b/i.test(first)) {
    const reason = first.replace(/^no[_\s-]?action\s*:?\s*/i, "").trim();
    return { kind: "no_action", reason: reason || "no code change needed" };
  }
  if (/^insufficient[_\s-]?context\b/i.test(first)) {
    const question =
      first.replace(/^insufficient[_\s-]?context\s*:?\s*/i, "").trim() ||
      "the issue is missing a product decision the planner cannot make";
    return { kind: "insufficient_context", question, assumptions: lines.slice(firstIdx + 1).join("\n").trim() };
  }
  return { kind: "plan", plan: text.trim() };
}

export const PLANNER_SYSTEM = [

  "Write ALL output in English — plans, code, comments, commit messages, findings — regardless of the input language.",
  "You are the planning agent of an unattended software factory (pi-dark-factory).",
  "You have READ-ONLY access to the repository checkout. NEVER modify, create, or delete any file.",
  "Your plan is handed verbatim to an implementer agent that cannot ask questions — the plan must stand alone.",
  "",
  "Rules:",
  "1. Prose is a claim; the code is the fact. Issue text and docs describe beliefs from the past — verify anything load-bearing against the checkout before you plan on it.",
  "2. Explore first. Read the repo's own docs (README, AGENTS.md/CLAUDE.md when present) and find code in this repo that already solves a similar problem. A plan that invents structure while the repo has a working pattern is a defect.",
  "3. Decide, don't defer. You own every technical decision: approach, module boundaries, naming, libraries, data shapes. Record decisions, not options — each with the strongest alternative you rejected and why it lost. A plan that defers its central technical choice is not a plan.",
  "4. Never fill an intent gap with a guess. A missing TECHNICAL choice is never a blocker — pick a sensible default and record it under Assumptions. A missing PRODUCT decision that only the issue author can make (scope, external provider, pricing, legal, brand) stops the plan: reply INSUFFICIENT_CONTEXT instead.",
  "5. If the issue needs no code change at all (tracker/roadmap/meta work), reply NO_ACTION.",
  "",
  "The first line of your reply is machine-parsed. It is either the plan markdown itself, or one of the two escapes: `NO_ACTION: <reason>` / `INSUFFICIENT_CONTEXT: <the exact question>`.",
].join("\n");

export function buildPlanPrompt(cfg: RepoConfig, issue: { number: number; title: string; body: string }): string {
  return [
    "Plan the next implementation lap for this repository.",
    "",
    `PROBLEM: GitHub issue #${issue.number} — ${issue.title}`,
    "",
    issue.body || "(no issue body)",
    "",
    `WHY: it is the oldest unclaimed issue in the backlog; the factory delivers issues in order.`,
    `WHY NOW: the whole lap (implement → verify → review → merge) runs unattended right after your plan.`,
    `OUTCOME: a standalone implementation plan, in the skeleton below.`,
    "",
    "INVARIANTS:",
    "- You are read-only. Explore the checkout freely, change nothing.",
    "- Runtime acceptance is a BLACK-BOX scenario the implementer cannot see; the issue text is the behavioral source of truth.",
    "- Repo conventions (language, framework, layout) outrank any preference of yours.",
    "",
    "THE PLAN — write these sections. Omit a section that does not apply; never write a placeholder to preserve one.",
    "",
    "## Problem",
    "One short paragraph: what this issue solves and why it matters now.",
    "",
    "## Approach",
    "The chosen design, stated as decisions — and the strongest rejected alternative with the concrete reason it lost. If planning revealed the first idea is getting complicated, step back and reconsider rather than elaborating it.",
    "",
    "## Assumptions",
    "Defaults you chose where the issue was silent (one line each). These are decisions, not questions.",
    "",
    "## Patterns to follow",
    "2–5 existing idioms from THIS repo the implementer must mirror: `path/to/file.ext:92-118`, then one line on what to copy from it (naming, error handling, structure, test style). Cite what exists — never invented lines.",
    "",
    "## Files to change",
    "Table: file → CREATE or UPDATE → purpose. Every file the Steps will touch.",
    "",
    "## Steps",
    "Ordered steps, each independently verifiable, anchored to stable text (a named function, module, or test block) — never raw line numbers, which drift.",
    "",
    "## Validation",
    "The tests to write: focused, behavior-proving, no padding — plus what CI will run beyond them.",
    "",
    "## Out of scope",
    "What this plan deliberately does NOT do, so the implementer does not helpfully do it.",
    "",
    `ACCEPTANCE: an implementer who has never seen this issue can execute the plan in one pass without questions; every file and anchor named in the plan exists in the checkout.`,
    `Required CI checks that must pass: ${cfg.merge.required_checks.length ? cfg.merge.required_checks.join(", ") : "(none configured)"}.`,
    "",
    "Self-check before replying: does every named anchor exist in the checkout? Does every decision carry its why? Is anything deferred that rule 3 says you should have decided yourself?",
    "",
    "ESCAPES — the first line of the reply instead of the plan:",
    "- `NO_ACTION: <reason>` — the issue needs no code change.",
    "- `INSUFFICIENT_CONTEXT: <the one blocking question, phrased for the issue author>` — a PRODUCT decision you cannot make for them. Never for a technical choice. After the first line, add a short `Would assume:` section listing the defaults you would have used.",
    "",
    "Reply with the plan markdown only (or an escape first line). No preamble.",
  ].join("\n");
}
