export type Verdict = "approve" | "reject" | "unparseable";

/** Lenient verdict parse — never a schema; a missing verdict is unparseable, not a crash. */
export function parseVerdict(text: string): { verdict: Verdict; findings: string } {
  const m = text.match(/verdict\s*:\s*(approve|reject)/i);
  let verdict: Verdict | null = m ? m[1].toLowerCase() as Verdict : null;
  if (!verdict) {
    const first = (text.trim().split("\n").find((l) => l.trim()) ?? "").trim();
    if (/^(approve|reject)\b/i.test(first)) verdict = first.toLowerCase() as Verdict;
  }
  if (!verdict) return { verdict: "unparseable", findings: text };
  // findings = everything except the verdict line
  const findings = text
    .split("\n")
    .filter((l) => !/verdict\s*:\s*(approve|reject)/i.test(l))
    .join("\n")
    .trim();
  return { verdict, findings: findings || "(reviewer gave no findings)" };
}

export const REVIEWER_SYSTEM = [
  "You are the independent review agent of an unattended software factory (pi-dark-factory).",
  "You are read-only: NEVER modify, create, or delete files. You inspect a diff and judge it.",
  "You are the last judgment layer before an autonomous merge; false approvals are worse than false rejections.",
  "Your FIRST line must be exactly `VERDICT: APPROVE` or `VERDICT: REJECT`, followed by your reasoning.",
].join("\n");

export function buildReviewPrompt(
  cfg: RepoConfig,
  issue: { number: number; title: string; body: string },
  opts: { plan: string; scenarioSummary: string; attempt: number }
): string {
  return [
    `Review the implementation of GitHub issue #${issue.number} — ${issue.title}.`,
    "",
    "## Issue",
    issue.body || "(no issue body)",
    "",
    "## Plan the implementer worked from",
    opts.plan,
    "",
    "## Deterministic verification results (already passed)",
    opts.scenarioSummary,
    "",
    "## How to inspect",
    `- The worktree you are in contains the branch \`factory/issue-${issue.number}\` with the implementation.`,
    `- Inspect the full change with: git diff origin/${cfg.default_branch}...HEAD`,
    "- Inspect any file or run any read-only command you need.",
    "",
    "INVARIANTS: read-only; do not fix anything yourself — rejections are routed back to the implementer with your findings.",
    "",
    "ACCEPTANCE: judge (1) does the change actually deliver the issue, (2) is it correct and safe,",
    "(3) does it follow repo conventions, (4) are there unhandled edge cases worth a repair round.",
    "Reject for real defects, not style nitpicks the CI would catch.",
    "",
    "First line: `VERDICT: APPROVE` or `VERDICT: REJECT`, then numbered findings (rejects must give actionable findings).",
  ].join("\n");
}
