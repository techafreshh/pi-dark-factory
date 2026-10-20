import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhApi, CheckState } from "../src/gh";
import type { CallStageFn } from "../src/tick";
import { runWithConcurrency, tickRepo } from "../src/tick";
import { issueDir } from "../src/gitws";
import { Ledger } from "../src/ledger";
import type { IssueLite, PrLite, RepoConfig, StageModels } from "../src/types";

const GIT_ID = "-c user.email=t@t.io -c user.name=Test";

class FakeGh implements GhApi {
  issues: IssueLite[] = [];
  prs: PrLite[] = [];
  mergedPrs: PrLite[] = [];
  states: Record<number, string> = {};
  comments: string[] = [];
  labelsAdded: Record<number, string[]> = {};
  nextPr = 101;
  merged: number[] = [];

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
  issueAddLabels(n: number, labels: string[]): Promise<void> {
    this.labelsAdded[n] = [...(this.labelsAdded[n] ?? []), ...labels];
    const i = this.issues.find((x) => x.number === n);
    if (i) i.labels = [...(i.labels ?? []), ...labels];
    return Promise.resolve();
  }
  prListOpen(): Promise<PrLite[]> {
    return Promise.resolve(this.prs);
  }
  prListMerged(limit?: number): Promise<PrLite[]> {
    return Promise.resolve(this.mergedPrs);
  }
  prCreate(head: string, base: string, title: string, body: string): Promise<number> {
    const n = this.nextPr++;
    this.prs.push({ number: n, title, body, headRefName: head });
    return Promise.resolve(n);
  }
  prClose(n: number): Promise<void> {
    return Promise.resolve();
  }
  prChecks(n: number): Promise<CheckState[]> {
    return Promise.resolve([]);
  }
  prMerge(n: number, method: "squash" | "merge" | "rebase", deleteBranch: boolean): Promise<void> {
    this.merged.push(n);
    return Promise.resolve();
  }
}

function okPi(text: string) {
  return {
    outcome: { kind: "ok" as const, text, usage: { input_tokens: 10, output_tokens: 5 } },
    modelsTried: [{ spec: { provider: "x", model: "y" }, outcome: "ok" as const }],
  };
}
function failPi(error: string) {
  return {
    outcome: { kind: "provider_error" as const, error },
    modelsTried: [{ spec: { provider: "x", model: "y" }, outcome: "provider_error" as const, error }],
  };
}

interface World {
  stateDir: string;
  origin: string;
  cfg: RepoConfig;
  ledger: Ledger;
  gh: FakeGh;
  calls: { stage: string; prompt: string; cwd: string }[];
}

const worlds: World[] = [];
afterAll(() => {
  for (const w of worlds) rmSync(w.stateDir, { recursive: true, force: true });
});

function makeWorld(opts: { attempts?: number } = {}): World {
  const stateDir = mkdtempSync(join(tmpdir(), "pdftick-"));
  const origin = join(stateDir, "origin.git");
  execSync(`git init --bare ${origin}`);
  execSync(`git --git-dir=${origin} symbolic-ref HEAD refs/heads/main`);
  const seed = join(stateDir, "seed");
  execSync(`git clone ${origin} ${seed}`);
  execSync(`git -C ${seed} checkout -b main`);
  writeFileSync(join(seed, "README.md"), "# toy product\n");
  execSync(`git -C ${seed} ${GIT_ID} add -A`);
  execSync(`git -C ${seed} ${GIT_ID} commit -m init`);
  execSync(`git -C ${seed} push origin main`);
  rmSync(seed, { recursive: true, force: true });

  const cfgDir = join(stateDir, "repos", "toy");
  mkdirSync(cfgDir, { recursive: true });
  const cfg: RepoConfig = {
    repo: "acme/toy",
    slug: "toy",
    default_branch: "main",
    origin_url: origin,
    attempts: opts.attempts ?? 3,
    merge: { method: "squash", required_checks: [], delete_branch: true },
    models: { default: { provider: "x", model: "y" } },
    timeouts: { stage_minutes: 5, checks_minutes: 1, readiness_seconds: 10, probe_ms: 3000 },
    scenario: { ports: [] },
    skip_labels: [],
    pi: { binary: "pi", tools: ["read", "bash"], plan_tools: ["read"], extra_args: [] },
  };
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify(cfg));

  const gh = new FakeGh();
  gh.issues = [{ number: 1, title: "Add hello file", body: "create hello.txt containing 'hello'", labels: [] }];
  const world: World = { stateDir, origin, cfg, ledger: new Ledger(join(stateDir, "factory.db")), gh, calls: [] };
  worlds.push(world);
  return world;
}

function realImplement(cwd: string) {
  const file = join(cwd, "hello.txt");
  const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, prev + "hello\n"); // each repair round changes something real
  execSync(`git -C ${cwd} ${GIT_ID} add -A`);
  execSync(`git -C ${cwd} ${GIT_ID} commit -m "add hello.txt" --allow-empty`);
}

function makeCallStage(
  world: World,
  opts: { implement?: (cwd: string) => void; reviewPlan?: string[]; planText?: string } = {}
): CallStageFn {
  const implement = opts.implement ?? realImplement;
  const reviewPlan =
    opts.reviewPlan ?? ["VERDICT: APPROVE\n LGTM", "VERDICT: REJECT\nmissing newline handling", "VERDICT: APPROVE\n ok now"];
  const models: StageModels = { base: { provider: "x", model: "y" }, fallback: [] };
  let reviewIdx = 0;
  return async (stage, a) => {
    world.calls.push({ stage, prompt: a.prompt, cwd: a.cwd });
    if (stage === "plan") return okPi(opts.planText ?? "PLAN: create hello.txt with content hello.");
    if (stage === "implement") {
      implement(a.cwd);
      return okPi("implemented hello.txt");
    }
    const verdict = reviewPlan[reviewIdx++ % reviewPlan.length];
    return okPi(verdict);
  };
}

describe("tickRepo (real git, fake GitHub, fake Pi stages)", () => {
  test("happy path: intake → plan → implement → verify → review → merge, ledger closed", async () => {
    const w = makeWorld();
    const outcome = await tickRepo(w.cfg, w.stateDir, {
      ledger: w.ledger,
      gh: w.gh,
      callStage: makeCallStage(w),
    });
    expect(outcome).toBe("merged");
    const row = w.ledger.getIssue(w.cfg.repo, 1)!;
    expect(row.state).toBe("merged");
    expect(row.pr).toBe(101);
    expect(w.gh.merged).toEqual([101]); // squash merge issued
    expect((w.gh.states[1] ?? "open")).toBe("closed"); // issue closed deterministically
    expect(w.gh.comments.join("\n")).toContain("pi-dark-factory");
    // branch was pushed for real (quotes: dash chokes on bare parens)
    const refs = execSync(`git --git-dir=${w.origin} for-each-ref --format='%(refname:short)'`).toString();
    expect(refs).toContain("factory/issue-1");
    // worktree cleaned up, source kept
    expect(existsSync(join(w.stateDir, "worktrees", "toy", "issue-1"))).toBe(false);
    expect(existsSync(join(w.stateDir, "repos", "toy", "source"))).toBe(true);
    // plan persisted for forensics
    expect(existsSync(join(issueDir(w.stateDir, "toy", 1), "plan.md"))).toBe(true);
    // stage runs recorded with tokens
    expect(w.ledger.recentStages(w.cfg.repo, 10).length).toBe(3);
  }, 60000);

  test("blocked path: implement never works → blocked, GitHub comment, never re-claimed", async () => {
    const w = makeWorld();
    const broken: (cwd: string) => void = () => {}; // no real work → changed gate fails
    const outcome = await tickRepo(w.cfg, w.stateDir, {
      ledger: w.ledger,
      gh: w.gh,
      callStage: makeCallStage(w, { implement: broken }),
    });
    expect(outcome).toBe("blocked");
    const row = w.ledger.getIssue(w.cfg.repo, 1)!;
    expect(row.state).toBe("blocked");
    expect(row.attempts).toBe(3);
    const comment = w.gh.comments.join("\n");
    expect(comment).toContain("BLOCKED");
    expect(comment).toContain("foreman unblock toy 1");
    expect(comment).toContain("no commits ahead of base");
    // blocked rows are terminal — a fresh intake finds nothing claimable
    expect((await import("../src/stages/intake")).pickClaimable(w.cfg, w.ledger, w.gh).then((p) => p.issue)).resolves.toBeNull();
  }, 60000);

  test("review re-asks: unparseable verdicts are retried before failing closed as REJECT", async () => {
    const w = makeWorld({ attempts: 1 });
    const outcome = await tickRepo(w.cfg, w.stateDir, {
      ledger: w.ledger,
      gh: w.gh,
      callStage: makeCallStage(w, { reviewPlan: ["I think this looks quite good, ship it"] }),
    });
    expect(outcome).toBe("blocked");
    // 1 initial ask + 5 re-asks, then the unparseable text fails closed as REJECT;
    // attempts=1, so exactly one round of 6 reviewer calls
    expect(w.calls.filter((c) => c.stage === "review").length).toBe(6);
    const comment = w.gh.comments.join("\n");
    expect(comment).toContain("BLOCKED");
    expect(comment).toContain("review rejected");
  }, 60000);

  test("repair loop: review rejects once, attempt 2 fixes and merges", async () => {
    const w = makeWorld();
    const outcome = await tickRepo(w.cfg, w.stateDir, {
      ledger: w.ledger,
      gh: w.gh,
      callStage: makeCallStage(w, {
        reviewPlan: ["VERDICT: REJECT\nhello.txt must end with a newline", "VERDICT: APPROVE\nfixed"],
      }),
    });
    expect(outcome).toBe("merged");
    expect(w.ledger.getIssue(w.cfg.repo, 1)!.attempts).toBe(2);
    const implementCalls = w.calls.filter((c) => c.stage === "implement").length;
    expect(implementCalls).toBe(2); // repair round happened
    const second = w.calls.filter((c) => c.stage === "implement")[1];
    expect(second.prompt).toContain("REPAIR ROUND");
  }, 60000);

  test("needs-context path: planner escapes → question posted, label gate set, claim dropped, label removal re-queues", async () => {
    const w = makeWorld();
    const outcome = await tickRepo(w.cfg, w.stateDir, {
      ledger: w.ledger,
      gh: w.gh,
      callStage: makeCallStage(w, {
        planText: "INSUFFICIENT_CONTEXT: which SSO provider should we use?\n\nWould assume: keycloak, org-only",
      }),
    });
    expect(outcome).toBe("needs_context");
    // the question reached the issue, with release instructions
    const comment = w.gh.comments.join("\n");
    expect(comment).toContain("SSO provider");
    expect(comment).toContain("factory:needs-info");
    expect(comment).toContain("Would assume");
    // the gate label is on the issue and the claim is dropped (fresh attempt count later)
    expect(w.gh.labelsAdded[1]).toEqual(["factory:needs-info"]);
    expect(w.ledger.getIssue(w.cfg.repo, 1)).toBeNull();
    // no plan persisted and no implement stage burned
    expect(existsSync(join(issueDir(w.stateDir, "toy", 1), "plan.md"))).toBe(false);
    expect(w.calls.some((c) => c.stage === "implement")).toBe(false);
    // with the label set, intake skips the issue; a human removing it re-queues it fresh
    const intake = await import("../src/stages/intake");
    expect(((await intake.pickClaimable(w.cfg, w.ledger, w.gh)).issue)).toBeNull();
    w.gh.issues[0].labels = [];
    expect(((await intake.pickClaimable(w.cfg, w.ledger, w.gh)).issue)?.number).toBe(1);
  }, 60000);

  test("reclaim: an interrupted lap (in_progress, attempts<cap) resumes from its persisted plan", async () => {
    const w = makeWorld();
    w.ledger.claim(w.cfg.repo, 1);
    w.ledger.setIssue(w.cfg.repo, 1, { attempts: 1 });
    mkdirSync(issueDir(w.stateDir, "toy", 1), { recursive: true });
    writeFileSync(join(issueDir(w.stateDir, "toy", 1), "plan.md"), "PLAN (persisted): create hello.txt.");
    const outcome = await tickRepo(w.cfg, w.stateDir, {
      ledger: w.ledger,
      gh: w.gh,
      callStage: makeCallStage(w),
    });
    expect(outcome).toBe("merged");
    expect(w.ledger.getIssue(w.cfg.repo, 1)!.attempts).toBe(2); // carried, not reset
    expect(w.calls.some((c) => c.stage === "plan")).toBe(false); // plan reused, not re-planned
  }, 60000);

  test("reconcile: crashed lap whose delivery already merged → books closed, issue closed, no re-work", async () => {
    const w = makeWorld();
    w.ledger.claim(w.cfg.repo, 1);
    w.ledger.setIssue(w.cfg.repo, 1, { state: "in_progress", attempts: 1 });
    w.gh.mergedPrs = [{ number: 99, title: "x", body: "Closes #1", headRefName: "factory/issue-1" }];
    const outcome = await tickRepo(w.cfg, w.stateDir, {
      ledger: w.ledger,
      gh: w.gh,
      callStage: makeCallStage(w),
    });
    expect(outcome).toBe("idle"); // nothing left to claim
    expect(w.ledger.getIssue(w.cfg.repo, 1)!.state).toBe("merged");
    expect(w.gh.states[1]).toBe("closed");
    expect(w.calls.length).toBe(0); // no stages burned on an already-delivered issue
  }, 60000);

  test("reconcile: crashed lap at the attempt cap → marked blocked and notified", async () => {
    const w = makeWorld();
    w.ledger.claim(w.cfg.repo, 1);
    w.ledger.setIssue(w.cfg.repo, 1, { attempts: 3, last_error: "provider outage mid-lap" });
    const outcome = await tickRepo(w.cfg, w.stateDir, {
      ledger: w.ledger,
      gh: w.gh,
      callStage: makeCallStage(w),
    });
    expect(outcome).toBe("idle");
    expect(w.ledger.getIssue(w.cfg.repo, 1)!.state).toBe("blocked");
    expect(w.gh.comments.join("\n")).toContain("BLOCKED");
    expect(w.calls.length).toBe(0);
  }, 60000);
});

describe("runWithConcurrency (unabated-by-default dispatcher)", () => {
  test("caps parallel execution at the limit while completing every item", async () => {
    let active = 0;
    let maxActive = 0;
    const done: number[] = [];
    const items = [1, 2, 3, 4, 5, 6, 7];
    await runWithConcurrency(items, 2, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      done.push(n);
    });
    expect(maxActive).toBe(2);
    expect(done.sort()).toEqual(items);
  });

  test("limit 0 = unlimited: everything in flight at once", async () => {
    let active = 0;
    let maxActive = 0;
    const items = [1, 2, 3, 4, 5];
    await runWithConcurrency(items, 0, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 25));
      active--;
      void n;
    });
    expect(maxActive).toBe(5);
  });
});
