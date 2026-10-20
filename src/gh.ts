import { sh, shOk } from "./sh";
import type { IssueLite, PrLite } from "./types";

export interface CheckState {
  name: string;
  state: string; // SUCCESS | FAILURE | PENDING | ...
}

/** The surface tick needs from GitHub — real Gh or a test fake. */
export interface GhApi {
  issueList(state: "open" | "all", limit?: number): Promise<IssueLite[]>;
  issueView(n: number): Promise<IssueLite & { state: string }>;
  issueComment(n: number, body: string): Promise<void>;
  issueClose(n: number): Promise<void>;
  issueCreate(title: string, body: string): Promise<number>;
  issueAddLabels(n: number, labels: string[]): Promise<void>;
  prListOpen(): Promise<PrLite[]>;
  prListMerged(limit?: number): Promise<PrLite[]>;
  prCreate(head: string, base: string, title: string, body: string): Promise<number>;
  prClose(n: number): Promise<void>;
  prChecks(n: number): Promise<CheckState[]>;
  prMerge(n: number, method: "squash" | "merge" | "rebase", deleteBranch: boolean): Promise<void>;
}

async function ghJson<T>(repo: string, args: string[]): Promise<T> {
  const res = await sh(["gh", ...args, "--repo", repo]);
  const parsed = JSON.parse(shOk(res, `gh ${args[0]}`));
  return parsed as T;
}

export class Gh implements GhApi {
  constructor(public repo: string) {}

  issueList(state: "open" | "all", limit = 100): Promise<IssueLite[]> {
    return ghJson(this.repo, [
      "issue", "list", "--state", state, "--limit", String(limit),
      "--json", "number,title,body,labels,createdAt,state",
    ]);
  }

  async issueView(n: number): Promise<IssueLite & { state: string }> {
    const r = await ghJson<IssueLite & { state: string }>(this.repo, [
      "issue", "view", String(n), "--json", "number,title,body,labels,state",
    ]);
    return r;
  }

  async issueComment(n: number, body: string): Promise<void> {
    await shOk(await sh(["gh", "issue", "comment", String(n), "--repo", this.repo, "--body", body]), "gh issue comment");
  }

  async issueClose(n: number): Promise<void> {
    await shOk(await sh(["gh", "issue", "close", String(n), "--repo", this.repo]), "gh issue close");
  }

  async issueCreate(title: string, body: string): Promise<number> {
    const res = await sh(["gh", "issue", "create", "--repo", this.repo, "--title", title, "--body", body]);
    const out = shOk(res, "gh issue create").trim();
    const m = out.match(/issues\/(\d+)/);
    if (!m) throw new Error(`could not parse issue number from: ${out.slice(0, 200)}`);
    return Number(m[1]);
  }

  /**
   * Label gate for parked issues. The factory's own label may not exist on a
   * fresh repo — create it and retry once before failing.
   */
  async issueAddLabels(n: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    const addArgs = () => [
      "gh", "issue", "edit", String(n), "--repo", this.repo,
      ...labels.flatMap((l) => ["--add-label", l]),
    ];
    if ((await sh(addArgs())).code === 0) return;
    for (const l of labels) {
      await shOk(
        await sh(["gh", "label", "create", l, "--repo", this.repo, "--force", "--color", "5319e5"]),
        "gh label create"
      );
    }
    shOk(await sh(addArgs()), "gh issue edit --add-label");
  }

  prListOpen(): Promise<PrLite[]> {
    return ghJson(this.repo, [
      "pr", "list", "--state", "open", "--limit", "100",
      "--json", "number,title,body,headRefName",
    ]);
  }

  prListMerged(limit = 50): Promise<PrLite[]> {
    return ghJson(this.repo, [
      "pr", "list", "--state", "merged", "--limit", String(limit),
      "--json", "number,title,body,headRefName",
    ]);
  }

  async prCreate(head: string, base: string, title: string, body: string): Promise<number> {
    // adopt an open PR for this branch instead of failing: a prior lap can
    // have opened it and then blocked/erroring — the reclaimed issue reuses it
    const open = await ghJson<any[]>(this.repo, [
      "pr", "list", "--state", "open", "--head", head, "--json", "number",
    ]);
    if (Array.isArray(open) && open.length > 0) return Number(open[0].number);
    const res = await sh([
      "gh", "pr", "create", "--repo", this.repo, "--head", head, "--base", base,
      "--title", title, "--body", body,
    ]);
    const out = shOk(res, "gh pr create").trim();
    const m = out.match(/pull\/(\d+)/);
    if (!m) throw new Error(`could not parse PR number from: ${out.slice(0, 200)}`);
    return Number(m[1]);
  }

  async prClose(n: number): Promise<void> {
    await shOk(await sh(["gh", "pr", "close", String(n), "--repo", this.repo]), "gh pr close");
  }

  async prChecks(n: number): Promise<CheckState[]> {
    const raw = await ghJson<any>(this.repo, [
      "pr", "view", String(n), "--json", "statusCheckRollup",
    ]);
    const rollup = raw.statusCheckRollup ?? [];
    return rollup
      .filter((c: any) => c && c.state)
      .map((c: any) => ({ name: c.name ?? c.workflowName ?? c.context ?? "check", state: String(c.state) }));
  }

  async prMerge(n: number, method: "squash" | "merge" | "rebase", deleteBranch: boolean): Promise<void> {
    const args = ["gh", "pr", "merge", String(n), "--repo", this.repo, `--${method}`];
    if (deleteBranch) args.push("--delete-branch");
    await shOk(await sh(args), "gh pr merge");
  }
}

export async function repoDefaultBranch(repo: string): Promise<string> {
  // `gh repo view` takes the repository positionally — it has no --repo flag.
  const res = await sh(["gh", "repo", "view", repo, "--json", "defaultBranchRef"]);
  const raw = JSON.parse(shOk(res, "gh repo view")) as any;
  const name = raw.defaultBranchRef?.name;
  if (!name) throw new Error(`could not read default branch of ${repo}`);
  return name;
}

/**
 * CI gate: poll the PR's checks until every required check is present and
 * non-PENDING. Any required FAILURE fails fast. A required check that never
 * reports fails after the timeout — fail closed.
 */
export async function waitChecks(
  gh: GhApi,
  pr: number,
  required: string[],
  timeoutMs: number
): Promise<{ pass: boolean; detail: string }> {
  if (required.length === 0) return { pass: true, detail: "no required checks configured" };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const checks = await gh.prChecks(pr);
    const states = new Map(checks.map((c) => [c.name, c.state]));
    const missing = required.filter((r) => !states.has(r));
    const failed = required.filter((r) => /FAIL|ERROR|CANCEL/i.test(states.get(r) ?? ""));
    if (failed.length > 0) {
      return { pass: false, detail: `required checks failed: ${failed.join(", ")}` };
    }
    if (missing.length === 0) return { pass: true, detail: "required checks green" };
    if (Date.now() >= deadline) {
      return {
        pass: false,
        detail: `required checks never reported within ${Math.round(timeoutMs / 60000)}m: ${missing.join(", ")}`,
      };
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
}
