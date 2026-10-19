import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sh, shOk } from "./sh";
import type { RepoConfig } from "./types";

export const repoDir = (stateDir: string, slug: string) => join(stateDir, "repos", slug);
export const sourceDir = (stateDir: string, slug: string) => join(repoDir(stateDir, slug), "source");
export const issueDir = (stateDir: string, slug: string, n: number) =>
  join(repoDir(stateDir, slug), "issues", String(n));
export const sessionDir = (stateDir: string, slug: string, n: number) =>
  join(issueDir(stateDir, slug, n), "sessions");
export const worktreeDir = (stateDir: string, slug: string, n: number) =>
  join(stateDir, "worktrees", slug, `issue-${n}`);
export const branchName = (n: number) => `factory/issue-${n}`;

export async function gitIn(dir: string, args: string[]): Promise<string> {
  return shOk(await sh(["git", "-C", dir, ...args], { timeoutMs: 120000 }), `git ${args.join(" ")}`);
}

const LOCKFILE_RE =
  /(^|\/)(package-lock\.json|bun\.lockb|bun\.lock|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum)$/;

/** Only lockfiles changed → the implementer shipped nothing of substance. */
export function lockfileOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every((p) => LOCKFILE_RE.test(p));
}

/**
 * The main checkout: cloned once, fetched + hard-reset every lap so the
 * planner always sees true main. Agent work never happens here (it happens
 * in per-issue worktrees), so the hard reset is safe.
 */
export async function ensureSource(stateDir: string, cfg: RepoConfig): Promise<string> {
  const src = sourceDir(stateDir, cfg.slug);
  const origin = cfg.origin_url ?? `https://github.com/${cfg.repo}.git`;
  if (!existsSync(src)) {
    mkdirSync(repoDir(stateDir, cfg.slug), { recursive: true });
    await shOk(await sh(["git", "clone", origin, "source"], { cwd: repoDir(stateDir, cfg.slug), timeoutMs: 600000 }), "git clone");
  } else {
    await shOk(await sh(["git", "fetch", "origin", "--prune"], { cwd: src, timeoutMs: 300000 }), "git fetch");
    await shOk(
      await sh(["git", "reset", "--hard", `origin/${cfg.default_branch}`], { cwd: src }),
      "git reset"
    );
    await shOk(await sh(["git", "clean", "-fdq"], { cwd: src, timeoutMs: 120000 }), "git clean");
  }
  return src;
}

/**
 * Fresh-or-reused worktree for an issue: created on first implement attempt,
 * reused across the repair loop of the SAME issue (the agent iterates on
 * its own branch), never shared across issues.
 */
export async function addWorktree(stateDir: string, cfg: RepoConfig, n: number): Promise<string> {
  const wt = worktreeDir(stateDir, cfg.slug, n);
  if (existsSync(wt)) return wt;
  const src = sourceDir(stateDir, cfg.slug);
  mkdirSync(join(stateDir, "worktrees", cfg.slug), { recursive: true });
  const branch = branchName(n);
  const branchExists = await sh(["git", "show-ref", "--verify", `refs/heads/${branch}`], { cwd: src });
  if (branchExists.code === 0) {
    await shOk(await sh(["git", "worktree", "add", wt, branch], { cwd: src }), "git worktree add");
  } else {
    await shOk(
      await sh(["git", "worktree", "add", "-b", branch, wt, `origin/${cfg.default_branch}`], { cwd: src }),
      "git worktree add"
    );
  }
  return wt;
}

export async function removeWorktree(
  stateDir: string,
  cfg: RepoConfig,
  n: number,
  opts: { deleteBranch?: boolean } = {}
): Promise<void> {
  const wt = worktreeDir(stateDir, cfg.slug, n);
  const src = sourceDir(stateDir, cfg.slug);
  if (existsSync(wt)) {
    const res = await sh(["git", "worktree", "remove", "--force", wt], { cwd: src, timeoutMs: 120000 });
    if (res.code !== 0) rmSync(wt, { recursive: true, force: true }); // last resort; branch + PR survive for forensics
  }
  if (opts.deleteBranch) {
    await sh(["git", "branch", "-D", branchName(n)], { cwd: src }); // best-effort
  }
}

export async function uncommitted(worktree: string): Promise<string[]> {
  const out = await gitIn(worktree, ["status", "--porcelain"]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

export async function commitsAhead(worktree: string, baseBranch: string): Promise<number> {
  const out = await gitIn(worktree, ["rev-list", "--count", `origin/${baseBranch}..HEAD`]);
  return Number(out.trim());
}

export async function changedPaths(worktree: string, baseBranch: string): Promise<string[]> {
  const out = await gitIn(worktree, ["diff", "--name-only", `origin/${baseBranch}...HEAD`]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

export async function pushBranch(worktree: string, n: number): Promise<void> {
  await shOk(
    await sh(["git", "push", "-u", "origin", branchName(n)], { cwd: worktree, timeoutMs: 300000 }),
    "git push"
  );
}
