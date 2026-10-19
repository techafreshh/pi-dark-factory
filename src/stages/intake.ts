import type { GhApi } from "../gh";
import type { Ledger } from "../ledger";
import type { IssueLite, RepoConfig } from "../types";

export function branchName(n: number) {
  return `factory/issue-${n}`;
}

/** every `Depends on: #1, #2` mention in an issue body */
export function parseDepends(body: string): number[] {
  const out: number[] = [];
  const re = /depends\s+on\s*:\s*([^*\n-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    for (const num of m[1].match(/\d+/g) ?? []) out.push(Number(num));
  }
  return [...new Set(out)];
}

function prClaimsIssue(prBody: string, head: string, n: number): boolean {
  // our own factory branch PR is OUR work-in-progress — resumable, not a conflict;
  // only a foreign PR (any branch) claiming the issue blocks the claim
  if (head === branchName(n)) return false;
  const re = new RegExp(`(?:closes?|fixes?|resolves?|implements?)\\s+(?:https?://\\S*?/issues/)?#?${n}\\b`, "i");
  return re.test(prBody);
}

export interface PickResult {
  issue: IssueLite | null;
  reason: string;
}

/**
 * Deterministic intake — no LLM judgment, no GitHub label state machine.
 * The claim ledger is the source of truth: only an issue with NO row (or an
 * interrupted lap below the attempt cap) is claimable, so a delivered issue
 * can never be re-claimed, no matter what a crashed lap left behind.
 * Returns ALL claimable issues, oldest first — the tick dispatches them in parallel.
 */
export async function listClaimable(
  cfg: RepoConfig,
  ledger: Ledger,
  gh: GhApi,
  dependsCache: Map<number, boolean> = new Map()
): Promise<IssueLite[]> {
  const issues = (await gh.issueList("open", 100)).slice().sort((a, b) => a.number - b.number);
  const prs = await gh.prListOpen();
  const out: IssueLite[] = [];

  for (const issue of issues) {
    const labels = issue.labels ?? [];
    if (labels.some((l) => cfg.skip_labels.includes(l))) continue;
    // No row = never touched. in_progress + attempts < cap = a lap that was
    // interrupted (crash/restart) — reclaimable with attempts carried over.
    // Anything else (merged / no_action / blocked / cap-reached) is closed.
    const row = ledger.getIssue(cfg.repo, issue.number);
    if (row && (row.state !== "in_progress" || row.attempts >= cfg.attempts)) continue;
    if (prs.some((p) => prClaimsIssue(p.body ?? "", p.headRefName, issue.number))) continue;

    const deps = parseDepends(issue.body ?? "");
    const openDeps: number[] = [];
    for (const dep of deps) {
      if (!dependsCache.has(dep)) {
        let isOpen = true;
        try {
          const viewed = await gh.issueView(dep);
          isOpen = viewed.state === "OPEN" || viewed.state === "open";
        } catch {
          isOpen = true; // unreadable dependency = treat as unmet (fail closed)
        }
        dependsCache.set(dep, isOpen);
      }
      if (dependsCache.get(dep)) openDeps.push(dep);
    }
    if (openDeps.length > 0) continue;

    out.push(issue);
  }
  return out;
}

export async function pickClaimable(
  cfg: RepoConfig,
  ledger: Ledger,
  gh: GhApi,
  dependsCache: Map<number, boolean> = new Map()
): Promise<PickResult> {
  const all = await listClaimable(cfg, ledger, gh, dependsCache);
  if (all.length > 0) return { issue: all[0], reason: `claimed #${all[0].number}` };
  const open = await gh.issueList("open", 100);
  if (open.length === 0) return { issue: null, reason: "no open issues" };
  return { issue: null, reason: "no claimable issue (all claimed, labeled, PR'd, or dependency-blocked)" };
}
