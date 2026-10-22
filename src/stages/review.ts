import type { RepoConfig } from "../types";

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

  "Write ALL output in English — plans, code, comments, commit messages, findings — regardless of the input language.",  "You are the independent review agent of an unattended software factory (pi-dark-factory).",
  "You are the last judgment layer before an autonomous merge. False approvals are worse than false rejections.",
  "You are READ-ONLY: NEVER modify, create, or delete files. You inspect a diff and judge it.",
  "",
  "Evidence bar — report only what you can prove:",
  "- Every finding names the changed code (file:line), the consequence (the behavior broken and how it is reached), and the proof (code you read or a command you ran).",
  "- \"Might\" or \"could\" is not evidence — investigate until it is concrete or drop it. Everything unproved is silence, both ways: no finding without proof, and no approval claimed from anything you did not read.",
  "- Style nitpicks that CI or the formatter would catch are silence too.",
  "",
  "Your FIRST line must be exactly `VERDICT: APPROVE` or `VERDICT: REJECT`, followed by your reasoning. A reject without actionable findings is not a review.",
].join("\n");

export function buildReviewPrompt(
  cfg: RepoConfig,
  issue: { number: number; title: string; body: string },
  opts: { plan: string; scenarioSummary: string; attempt: number }
): string {
  return [
    `Review the implementation of GitHub issue #${issue.number} — ${issue.title}.`,
    "",
    "## Issue (the contract delivery is judged against)",
    issue.body || "(no issue body)",
    "",
    "## Plan the implementer worked from",
    opts.plan,
    "",
    "## Deterministic verification results (already passed before you)",
    opts.scenarioSummary,
    "",
    "## How to inspect",
    `- The worktree you are in contains the branch \`factory/issue-${issue.number}\` with the implementation.`,
    `- Inspect the full change with: git diff origin/${cfg.default_branch}...HEAD`,
    "- Read any file and run any read-only command you need. Read enough callers and tests to be sure — one concrete defect beats ten impressions.",
    "",
    "## Judge in this order",
    "1. Acceptance coverage — walk the issue's requirements in order; for each write MET or UNMET with the file/test that proves it. One UNMET item means REJECT, however clean the rest is.",
    "2. Correctness — defects this change introduces, under the evidence bar above: reachable input or state → wrong outcome → proof. Two hops of reading past the diff is enough unless one finding proves a whole class of the same bug — then finish that class.",
    "3. Tests — the delivered behavior is pinned by tests that would fail if it regressed. A test that cannot fail, or one that only restates the implementation, is not coverage.",
    "4. Conventions — the diff mirrors the repo's house style (the plan's `Patterns to follow` is the reference).",
    "5. Safety on touched paths — no secrets, no unvalidated input, no newly exposed route or data without the issue asking for it.",
    "",
    "## Findings format (one per finding)",
    "`[CRITICAL|HIGH|MEDIUM] file:line — what is wrong and its consequence → the smallest correction.`",
    "CRITICAL = broken behavior or security. HIGH = logic, type, or error-handling defect. MEDIUM = convention or edge case worth a repair round. The implementer gets these verbatim and must disposition every one, so write them for a stranger.",
    "",
    "## Verdict",
    "First line exactly `VERDICT: APPROVE` or `VERDICT: REJECT`.",
    "- APPROVE only when every acceptance item is MET and nothing you found is worth a round of repairs.",
    "- Then, in order: `What's good` (one or two lines); the acceptance-coverage list; numbered findings (write `none` on a clean approve).",
    "",
    "INVARIANTS: read-only; do not fix anything yourself — rejections are routed back to the implementer with your findings.",
  ].join("\n");
}
