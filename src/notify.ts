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
    "The factory will **not** retry automatically. Last failure:",
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
