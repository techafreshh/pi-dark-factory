import type { RepoConfig } from "./types";

export function noActionComment(reason: string): string {
  return [
    "🤖 **pi-dark-factory** triaged this issue as **NO_ACTION** — it does not need a code change.",
    "",
    `Reason: ${reason || "not specified"}`,
    "",
    "The factory will not pick it up again. Reopen the conversation here if that's wrong.",
  ].join("\n");
}

export function needsContextComment(cfg: RepoConfig, issue: number, question: string, assumptions: string): string {
  return [
    "🤖 **pi-dark-factory** paused on this issue — the planner needs a product decision before it can plan this without guessing.",
    "",
    `**Open question: ${question || "the issue is missing a decision only you can make."}**`,
    assumptions
      ? ["", "Left to itself, the planner would have assumed:", "", assumptions.trim().slice(0, 800)].join("\n")
      : "",
    "",
    "Nothing is broken and the factory is not stuck — it is deliberately not guessing its way past this question. The issue is parked under the `factory:needs-info` label and will not be retried while that label is set.",
    "",
    "To release it:",
    "1. Put the decision into the issue body (edit the text — the planner reads the body, not comments).",
    `2. Remove the \`factory:needs-info\` label. The next tick picks the issue up fresh.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function mergedComment(cfg: RepoConfig, pr: number, issue: number): string {
  return [
    "🤖 **pi-dark-factory** delivered this issue.",
    "",
    `- Squash-merged PR #${pr} into \`${cfg.default_branch}\` after: required checks green, runtime scenario green${cfg.scenario.holdout ? ", holdout scenario green" : ""}, independent review APPROVE.`,
    "- Claim ledger closed: this issue can never be auto-re-claimed.",
  ].join("\n");
}

export function blockedComment(
  cfg: RepoConfig,
  issue: number,
  attempts: number,
  error: string,
  modelsTried: string[]
): string {
  return [
    "🤖 **pi-dark-factory** is BLOCKED on this issue after " + attempts + " attempts.",
    "",
    "Later ticks auto-revive it with a fresh attempt budget and a fresh plan (the new planner sees the last failure), at most 3 times a day, and stop for a human once the same failure repeats 3 rounds in a row. Last failure:",
    "",
    "```",
    error.slice(0, 1500),
    "```",
    "",
    modelsTried.length > 0 ? `Models tried: ${modelsTried.join(" → ")}` : "",
    "",
    "To resume: inspect the failure, then run on the VPS:",
    "",
    "```",
    `foreman unblock ${cfg.slug} ${issue}          # back to claimable`,
    `foreman unblock ${cfg.slug} ${issue} --prune  # also close PR + delete branch + worktree`,
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The LOUD stuck summary — posted on the issue the moment auto-revive stops
 * (stagnation or daily cap), so a human gets one consolidated diagnostic
 * bundle instead of discovering a stall from silence. Everything a debugging
 * session needs: the distinct failure signatures, the latest full verdict,
 * forensics pointers, and the classification hints that separate infra /
 * verifier / app failures (bi-ai-ui 2026-10-25/26: ~12h of cascading
 * ambiguity, ended by evidence-in-the-message).
 */
export function stuckSummaryComment(
  cfg: RepoConfig,
  issue: number,
  reason: "stagnation" | "daily-cap",
  sigs: string[],
  lastError: string,
  roundsToday: number
): string {
  const sigLines = sigs
    .slice(-4)
    .reverse()
    .map((s, i) => `${i + 1}. \`${s.slice(0, 160)}\``)
    .join("\n");
  const infraHint = /INFRASTRUCTURE|machine unreachable|channel 0|no stage marker/i.test(lastError);
  const verifierHint = /setup failed|\[runtime\]|\[holdout\]|never became ready|scenario/i.test(lastError);
  return [
    "🤖⚠️ **pi-dark-factory FAILURE SUMMARY — this issue is stuck and auto-revive has stopped**",
    "",
    `Reason: **${reason === "stagnation" ? "same failure signature on consecutive rounds — the wheel is spinning" : `auto-revive daily cap reached (${roundsToday} rounds today)`}**.`,
    "",
    "**Distinct failure signatures, most recent first:**",
    "",
    sigLines || "(none recorded)",
    "",
    "**Latest full verdict (the evidence, uncut):**",
    "",
    "```",
    lastError.slice(0, 1500) || "(no last_error recorded)",
    "```",
    "",
    "**Fastest debug paths, in order:**",
    "",
    "1. Read the verdict above. Classification hints:",
    infraHint
      ? "   - it contains **INFRASTRUCTURE / transport markers** — factory or platform side; retry usually clears it, do NOT repair the product for it."
      : "",
    verifierHint
      ? "   - it names **setup / readiness / scenario gates** — the acceptance SCENARIO is operator-owned (the implementer cannot see or fix it): `factory-remote scenario <slug> runtime --lint`, then `--test` (zero tokens) before any lap."
      : "",
    "   - anything else is app-side evidence — treat it as the product's own failure, with the gates' reproduction data above.",
    `2. \`factory-remote status --repo ${cfg.slug}\` — ledger + stage rows (token usage is recorded even on failed stages).`,
    `3. \`factory-remote session ${cfg.slug} --issue ${issue}\` — one-shot playback of the agent's stages.`,
    `4. \`factory-remote logs --repo ${cfg.slug} --tail 300\` — the receipt trail (every line slug-tagged).`,
    "",
    `**To resume after a fix:** a \`scenario\` or \`config\` write automatically resets the revive budget (inputs-epoch) — the next tick retries with your fix in effect. For anything else: \`factory-remote unblock ${cfg.slug} ${issue}\`. A genuinely crashed in-progress lap reconciles on the next tick by itself.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The verify-time acceptance evidence, posted on the PR (report-only):
 *  the authored browser suite's gate verdict + the branch penthera scan.
 *  Finding details follow the same disclosure rule as issue filing — on a
 *  public repo the comment carries counts, never file/line/sink. */
export function evidenceComment(o: {
  attempt?: number;
  floor: string;
  /** private/internal or acceptance.security_public — else details withhold */
  mayDetailSecurity: boolean;
  e2e?: { pass: boolean; summary: string; failures?: { file: string; testId: string; status: string }[] } | null;
  security?: { pass: boolean; summary: string; note?: string } | null;
}): string {
  const lines: string[] = [`## Acceptance evidence — verify${o.attempt ? ` (attempt ${o.attempt})` : ""}`, ""];
  const e = o.e2e;
  if (!e) {
    lines.push("🧪 **e2e gate**: _did not run_ — no authored suite yet; the drain-time PRD walk authors one");
  } else if (e.pass) {
    lines.push(`🧪 **e2e gate**: ✅ ${e.summary}`);
  } else if (e.failures && e.failures.length > 0) {
    lines.push(`🧪 **e2e gate**: ❌ ${e.summary}`, "");
    for (const f of e.failures.slice(0, 5)) lines.push(`- ✗ \`${f.file} :: ${f.testId}\` (${f.status})`);
    if (e.failures.length > 5) lines.push(`- … and ${e.failures.length - 5} more`);
  } else {
    lines.push(`🧪 **e2e gate**: ⏭️ ${e.summary} — the next lap retries`);
  }
  const s = o.security;
  if (!s) {
    lines.push("🔒 **penthera** (branch): _did not run_ (acceptance.security off)");
  } else if (s.pass) {
    lines.push(`🔒 **penthera** (branch): ✅ ${s.summary}`);
  } else if (s.note && !s.summary) {
    lines.push(`🔒 **penthera** (branch): ⚠️ ${s.note}`);
  } else if (o.mayDetailSecurity) {
    lines.push(`🔒 **penthera** (branch): ⚠️ ${s.summary}`, "", "_The post-merge audit on merged main files the findings as issues._");
  } else {
    lines.push(`🔒 **penthera** (branch): ⚠️ ${s.summary} — details withheld on this repo (public; a comment here would disclose the finding live)`);
  }
  lines.push("", "_Report-only evidence posted at verify time by pi-dark-factory. The post-merge audit on merged main files issue(s); nothing here gates the merge._");
  return lines.join("\n");
}
