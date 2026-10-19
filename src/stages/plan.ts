export interface PlanOutcome {
  kind: "plan" | "no_action";
  plan?: string;
  reason?: string;
}

/** First non-empty line starting with NO_ACTION (with or without a colon). */
export function parsePlan(text: string): PlanOutcome {
  const first = text.trim().split("\n").find((l) => l.trim().length > 0) ?? "";
  if (/^no[_\s-]?action\b/i.test(first.trim())) {
    const reason = first.replace(/^no[_\s-]?action\s*:?\s*/i, "").trim();
    return { kind: "no_action", reason: reason || "no code change needed" };
  }
  return { kind: "plan", plan: text.trim() };
}

export const PLANNER_SYSTEM = [
  "You are the planning agent of an unattended software factory (pi-dark-factory).",
  "You have read-only access to the repository checkout. NEVER modify, create, or delete any file — you only produce a plan.",
  "Your plan is handed verbatim to an implementer agent that cannot ask questions, so the plan must stand alone.",
  "If the issue needs no code change (tracker/roadmap/meta work), reply with a first line 'NO_ACTION: <reason>' and nothing else.",
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
    `OUTCOME: a standalone implementation plan.`,
    "INVARIANTS:",
    "- You are read-only. Explore the checkout freely, change nothing.",
    "- Runtime acceptance is a BLACK-BOX scenario the implementer cannot see; the issue text is the behavioral source of truth.",
    `- Repo conventions (language, framework, layout) must be followed.`,
    "",
    `ACCEPTANCE: the plan must name concrete files/modules, the approach, edge cases, and what tests to write.`,
    `Required CI checks that must pass: ${cfg.merge.required_checks.length ? cfg.merge.required_checks.join(", ") : "(none configured)"}.`,
    "Reply with the plan markdown only (or NO_ACTION first-line). No preamble.",
  ].join("\n");
}
