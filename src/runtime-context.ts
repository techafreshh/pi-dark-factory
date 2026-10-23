import type { RepoConfig, StageName } from "./types";

/**
 * Runtime context — the "where am I and what are the rules" brief every
 * agent gets at stage start. Mined from the mdrender postmortem: fresh
 * attempts spent real turns rediscovering their environment (probing node,
 * hunting git, guessing at boundaries) on every attempt. One deterministic
 * file + a prompt preamble ends that.
 *
 * The same content is (a) written into the working directory as
 * `.factory-context.md` where a working directory exists and (b) prepended
 * to the stage prompt, so the facts are read without any tool call.
 */

export interface RuntimeContextInfo {
  repo: string;
  slug: string;
  issue: number;
  issueTitle: string;
  stage: StageName;
  attempt: number;
  attemptsMax: number;
  branch: string;
  base: string;
  mode: "host" | "compose" | "instabox";
  /** mode-specific identity: worktree path / image+service / machine+template */
  where: string;
  /** where the agent's file edits must happen */
  cwd: string;
  /** facts about the toolchain and preinstalled environment */
  toolchain: string;
}

export function buildRuntimeContext(cfg: RepoConfig, info: RuntimeContextInfo): string {
  const gates: string[] = ["changed (uncommitted work or zero commits behind base is discarded)"];
  if (cfg.merge.required_checks.length > 0) {
    gates.push(`CI checks on GitHub (${cfg.merge.required_checks.join(", ")})`);
  }
  gates.push("runtime + holdout: black-box scenario probes against the RUNNING service");
  gates.push("review: an independent agent audits the diff against the issue contract");

  const boundaries = [
    "Make ALL edits inside the working directory only — nothing outside it is yours.",
    "Never edit git config; the factory has already set the identity and safe.directory.",
    "The acceptance scenarios live OUTSIDE this repo on purpose — never assume their contents, implement the issue contract instead.",
    "Commit EVERYTHING before you finish (git add -A && git commit): work left uncommitted is discarded as if it never happened.",
    "Write your final summary in the stage's required format — it is parsed, not read conversationally.",
    "English only, in code, comments, commit messages and summaries.",
  ];

  return [
    "## Where you are running",
    "",
    `- Repo: ${info.repo} — issue #${info.issue} "${info.issueTitle}"`,
    `- Stage: ${info.stage} (attempt ${info.attempt}/${info.attemptsMax}; earlier attempts' committed work may already be in the tree — check before redoing it)`,
    `- Branch: ${info.branch} (base: ${info.base}) — the factory opens the PR, you only commit`,
    `- Execution mode: ${info.mode}`,
    `- ${info.where}`,
    `- Working directory: ${info.cwd} — every edit happens here`,
    `- Toolchain: ${info.toolchain}`,
    "",
    "### The gates your work must pass",
    "",
    ...gates.map((g) => `- ${g}`),
    "",
    "### Boundaries",
    "",
    ...boundaries.map((b) => `- ${b}`),
  ].join("\n");
}
