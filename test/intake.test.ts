import { describe, expect, test } from "bun:test";
import type { GhApi, CheckState } from "../src/gh";
import { listClaimable, pickClaimable } from "../src/stages/intake";
import { Ledger } from "../src/ledger";
import type { IssueLite, PrLite, RepoConfig } from "../src/types";

class FakeGh implements GhApi {
  issues: IssueLite[] = [];
  prs: PrLite[] = [];
  states: Record<number, string> = {}; // issue states by number (default "open")
  comments: string[] = [];

  issueList(state: "open" | "all", limit?: number): Promise<IssueLite[]> {
    return Promise.resolve(
      this.issues.filter((i) => state === "all" || (this.states[i.number] ?? "open") === "open").slice(0, limit)
    );
  }
  issueView(n: number): Promise<IssueLite & { state: string }> {
    const i = this.issues.find((x) => x.number === n);
    if (!i) return Promise.reject(new Error("not found"));
    return Promise.resolve({ ...i, state: this.states[n] ?? "open" });
  }
  issueComment(n: number, body: string): Promise<void> {
    this.comments.push(`#${n}: ${body}`);
    return Promise.resolve();
  }
  issueClose(n: number): Promise<void> {
    this.states[n] = "closed";
    return Promise.resolve();
  }
  issueCreate(title: string, body: string): Promise<number> {
    return Promise.resolve(this.issues.length + 1);
  }
  prListOpen(): Promise<PrLite[]> {
    return Promise.resolve(this.prs);
  }
  prListMerged(limit?: number): Promise<PrLite[]> {
    return Promise.resolve([]);
  }
  prCreate(head: string, base: string, title: string, body: string): Promise<number> {
    return Promise.resolve(1);
  }
  prClose(n: number): Promise<void> {
    return Promise.resolve();
  }
  prChecks(n: number): Promise<CheckState[]> {
    return Promise.resolve([{ name: "test", state: "SUCCESS" }]);
  }
  prMerge(n: number, method: "squash" | "merge" | "rebase", deleteBranch: boolean): Promise<void> {
    return Promise.resolve();
  }
}

const cfg: RepoConfig = {
  repo: "acme/app",
  slug: "app",
  default_branch: "main",
  attempts: 3,
  merge: { method: "squash", required_checks: [], delete_branch: true },
  models: { default: { provider: "x", model: "y" } },
  timeouts: { stage_minutes: 30, checks_minutes: 30, readiness_seconds: 120, probe_ms: 10000 },
  scenario: { ports: [] },
  skip_labels: ["factory:manual"],
  pi: { binary: "pi", tools: [], plan_tools: [], extra_args: [] },
};

const issue = (n: number, title: string, body = "", labels: string[] = []): IssueLite => ({
  number: n,
  title,
  body,
  labels,
});

describe("pickClaimable (deterministic intake)", () => {
  test("picks the oldest unclaimed issue", async () => {
    const gh = new FakeGh();
    gh.issues = [issue(3, "Third"), issue(1, "First"), issue(2, "Second")];
    const pick = await pickClaimable(cfg, new Ledger(":memory:"), gh);
    expect(pick.issue?.number).toBe(1);
  });

  test("never re-claims a row in a terminal state", async () => {
    const gh = new FakeGh();
    gh.issues = [issue(1, "Only one")];
    const ledger = new Ledger(":memory:");
    ledger.claim(cfg.repo, 1);
    ledger.setIssue(cfg.repo, 1, { state: "merged" });
    const pick = await pickClaimable(cfg, ledger, gh);
    expect(pick.issue).toBeNull();
  });

  test("an interrupted lap (in_progress below cap) is reclaimable; at cap it is not", async () => {
    const gh = new FakeGh();
    gh.issues = [issue(1, "Crashed lap")];
    const ledger = new Ledger(":memory:");
    ledger.claim(cfg.repo, 1);
    ledger.setIssue(cfg.repo, 1, { attempts: 1 });
    expect((await pickClaimable(cfg, ledger, gh)).issue?.number).toBe(1);
    ledger.setIssue(cfg.repo, 1, { attempts: 3 });
    expect((await pickClaimable(cfg, ledger, gh)).issue).toBeNull();
  });

  test("skips skip_labels", async () => {
    const gh = new FakeGh();
    gh.issues = [issue(1, "Manual", "", ["factory:manual"]), issue(2, "Fine")];
    expect((await pickClaimable(cfg, new Ledger(":memory:"), gh)).issue?.number).toBe(2);
  });

  test("a foreign PR claiming the issue blocks the claim; our own factory PR does not", async () => {
    const gh = new FakeGh();
    gh.issues = [issue(1, "One"), issue(2, "Two")];
    gh.prs = [
      { number: 10, title: "human PR", body: "This closes #1", headRefName: "feat/human" },
      { number: 11, title: "our resumed PR", body: "Closes #2", headRefName: "factory/issue-2" },
    ];
    const pick = await pickClaimable(cfg, new Ledger(":memory:"), gh);
    expect(pick.issue?.number).toBe(2);
  });

  test("open dependencies block the claim; closed ones do not", async () => {
    const gh = new FakeGh();
    gh.issues = [
      issue(1, "Base"),
      issue(2, "Dependent", "Depends on: #1, #9"),
      issue(9, "Already done long ago"),
    ];
    gh.states[9] = "closed";
    const pick = await pickClaimable(cfg, new Ledger(":memory:"), gh);
    // #1 is claimable; #2 waits on #1 (open). Pick must be #1.
    expect(pick.issue?.number).toBe(1);
    gh.states[1] = "closed";
    const pick2 = await pickClaimable(cfg, new Ledger(":memory:"), gh);
    expect(pick2.issue?.number).toBe(2);
  });

  test("unreadable dependency is treated as unmet (fail closed)", async () => {
    const gh = new FakeGh();
    gh.issues = [issue(1, "Dependent", "Depends on: #999")];
    const pick = await pickClaimable(cfg, new Ledger(":memory:"), gh);
    expect(pick.issue).toBeNull();
  });

  test("listClaimable returns EVERY claimable issue, oldest first (parallel dispatch)", async () => {
    const gh = new FakeGh();
    gh.issues = [
      issue(4, "Fourth"),
      issue(1, "First"),
      issue(2, "Second", "", ["factory:manual"]),
      issue(3, "Third", "Depends on: #1"),
    ];
    const all = await listClaimable(cfg, new Ledger(":memory:"), gh);
    expect(all.map((i) => i.number)).toEqual([1, 4]); // #2 skipped by label, #3 waits on #1
  });
});
