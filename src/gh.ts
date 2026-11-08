import { sh, shOk } from "./sh";
import type { IssueLite, PrLite } from "./types";

export interface CheckState {
  name: string;
  state: string; // SUCCESS | FAILURE | PENDING | ... (CheckRuns normalized by checkStates)
}

/**
 * `gh pr view --json statusCheckRollup` mixes two item shapes (recorded
 * 2026-11-08 from cli/cli, microsoft/vscode and kubernetes/kubernetes PRs):
 *  - StatusContext (commit-status API): {__typename: "StatusContext", context,
 *    state: SUCCESS|PENDING|FAILURE|ERROR|EXPECTED}
 *  - CheckRun (GitHub Actions and every Checks-API app): {__typename:
 *    "CheckRun", name, workflowName, status, conclusion} — NO `state` field
 * The old parse kept only items with a `state`, so every Actions check was
 * dropped: ["*"] read an Actions PR as "no CI" and merged after the grace
 * window whatever its checks said. CheckRuns map onto the StatusContext
 * vocabulary waitChecks judges; an item it cannot read waits (fail closed).
 */
export function checkStates(rollup: unknown): CheckState[] {
  if (!Array.isArray(rollup)) return [];
  return rollup
    .filter((c: any) => c && typeof c === "object")
    .map((c: any) => ({
      name: String(c.name ?? c.workflowName ?? c.context ?? "check"),
      state: typeof c.state === "string" && c.state ? c.state : checkRunState(c.status, c.conclusion),
    }));
}

function checkRunState(status: unknown, conclusion: unknown): string {
  // QUEUED / IN_PROGRESS / WAITING / REQUESTED / PENDING: still running
  if (String(status ?? "").toUpperCase() !== "COMPLETED") return "PENDING";
  const c = String(conclusion ?? "").toUpperCase();
  if (c === "SUCCESS" || c === "NEUTRAL" || c === "SKIPPED") return "SUCCESS";
  // waiting on a human (e.g. a deployment approval): waits like a pending check
  if (c === "ACTION_REQUIRED") return "ACTION_REQUIRED";
  // FAILURE, TIMED_OUT, CANCELLED, STARTUP_FAILURE, STALE, or a conclusion
  // GitHub adds later — TIMED_OUT and STALE match no failure word, so map
  // them explicitly instead of letting them read as settled-and-green
  return "FAILURE";
}

const CHECK_FAILED = /FAIL|ERROR|CANCEL/i;
const CHECK_PENDING = /PENDING|QUEUED|IN_PROGRESS|EXPECTED|ACTION_REQUIRED|WAITING/i;

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
  prHeadSha(n: number): Promise<string | null>;
  prMerge(n: number, method: "squash" | "merge" | "rebase", deleteBranch: boolean): Promise<void>;
}

async function ghJson<T>(repo: string, args: string[]): Promise<T> {
  const res = await sh(["gh", ...args, "--repo", repo]);
  const parsed = JSON.parse(shOk(res, `gh ${args[0]}`));
  return parsed as T;
}

/**
 * `gh --json labels` returns label OBJECTS ({name, id, color, …}); IssueLite
 * promises string[]. Every string comparison against a raw entry — skip_labels,
 * the needs-info gate, discovery prioritization — silently never matched the
 * real CLI shape (observed 2026-11-01: every repo claimed issues in number
 * order because the discovery promotion found no "discovery" among objects).
 * Normalize at the boundary so the type tells the truth; tolerate strings for
 * test fakes.
 */
export function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l: any) => (typeof l === "string" ? l : typeof l?.name === "string" ? l.name : ""))
    .filter(Boolean);
}

export class Gh implements GhApi {
  constructor(public repo: string) {}

  issueList(state: "open" | "all", limit = 100): Promise<IssueLite[]> {
    return ghJson<(Omit<IssueLite, "labels"> & { labels: unknown })[]>(this.repo, [
      "issue", "list", "--state", state, "--limit", String(limit),
      "--json", "number,title,body,labels,createdAt,state",
    ]).then((rs) => rs.map((r) => ({ ...r, labels: labelNames(r.labels) })));
  }

  async issueView(n: number): Promise<IssueLite & { state: string }> {
    const r = await ghJson<Omit<IssueLite, "labels"> & { labels: unknown; state: string }>(this.repo, [
      "issue", "view", String(n), "--json", "number,title,body,labels,state",
    ]);
    return { ...r, labels: labelNames(r.labels) };
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
    return checkStates(raw.statusCheckRollup);
  }

  /** The PR's head commit sha — the provenance anchor: what verify probed and
   *  what merge must still see (a moved head between the two is a refused merge). */
  async prHeadSha(n: number): Promise<string | null> {
    const raw = await ghJson<any>(this.repo, ["pr", "view", String(n), "--json", "headRefOid"]);
    return typeof raw?.headRefOid === "string" && raw.headRefOid ? raw.headRefOid : null;
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
 * reports or never settles fails after the timeout — fail closed.
 */
export const CI_AUTODETECT = "*";
const CI_GRACE_MS = 240_000; // window for Actions to report at least one check before "no CI" is concluded

export async function waitChecks(
  gh: GhApi,
  pr: number,
  required: string[],
  timeoutMs: number
): Promise<{ pass: boolean; detail: string }> {
  if (required.length === 0) return { pass: true, detail: "no required checks configured" };
  const auto = required.includes(CI_AUTODETECT);
  const names = required.filter((r) => r !== CI_AUTODETECT);
  const deadline = Date.now() + timeoutMs;
  const grace = Date.now() + CI_GRACE_MS;
  for (;;) {
    const checks = await gh.prChecks(pr);
    if (auto) {
      // ["*"]: whatever CI the product ships gates the merge — and a repo
      // with no workflows stays ungated. The grace window absorbs Actions'
      // startup lag (a fresh PR reports nothing for the first minute or so).
      if (checks.length === 0) {
        if (Date.now() < grace) {
          await new Promise((r) => setTimeout(r, 15000));
          continue;
        }
        return { pass: true, detail: "no CI on the PR — nothing to gate on" };
      }
      const failed = checks.filter((c) => CHECK_FAILED.test(c.state));
      if (failed.length > 0) {
        return { pass: false, detail: `CI checks failed: ${failed.map((c) => c.name).join(", ")}` };
      }
      const done = checks.filter((c) => !CHECK_PENDING.test(c.state));
      if (done.length === checks.length) return { pass: true, detail: "CI checks green" };
      if (Date.now() >= deadline) {
        return {
          pass: false,
          detail: `CI checks never settled within ${Math.round(timeoutMs / 60000)}m: ${checks.filter((c) => !done.includes(c)).map((c) => c.name).join(", ")}`,
        };
      }
      await new Promise((r) => setTimeout(r, 15000));
      continue;
    }
    // one name can carry several runs (the rollup listed three "VS Code PR
    // Check" runs on one vscode PR): judge them all, like the ["*"] path does
    const runs = (r: string) => checks.filter((c) => c.name === r);
    const missing = names.filter((r) => runs(r).length === 0);
    const failed = names.filter((r) => runs(r).some((c) => CHECK_FAILED.test(c.state)));
    if (failed.length > 0) {
      return { pass: false, detail: `required checks failed: ${failed.join(", ")}` };
    }
    // present is not finished: a queued or running required check used to
    // pass here the moment it appeared (harmless only while the rollup
    // parse dropped every Actions check, so named checks never appeared)
    const pending = names.filter((r) => runs(r).some((c) => CHECK_PENDING.test(c.state)));
    if (missing.length === 0 && pending.length === 0) return { pass: true, detail: "required checks green" };
    if (Date.now() >= deadline) {
      const why = [
        missing.length ? `never reported: ${missing.join(", ")}` : "",
        pending.length ? `never settled: ${pending.join(", ")}` : "",
      ].filter(Boolean).join("; ");
      return {
        pass: false,
        detail: `required checks not green within ${Math.round(timeoutMs / 60000)}m — ${why}`,
      };
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
}
