import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueDir } from "../src/gitws";
import { MergeQueue, pickForLane, runParallel, type InFlight } from "../src/parallel";
import { prepareRepo } from "../src/tick";
import { Ledger } from "../src/ledger";
import { cleanupWorlds, GIT_ID, issue, machineDeps, makeMachineWorld, type MachineBehavior, type World } from "./world";

afterAll(cleanupWorlds);
beforeEach(() => {
  process.env.PDF_POOL_INSTABOX = "3";
  process.env.PDF_SLOT_POLL_MS = "5";
  process.env.PDF_PR_HEAD_POLL_MS = "10";
});
afterEach(() => {
  for (const k of ["PDF_POOL_INSTABOX", "PDF_POOL_BOXD", "PDF_SLOT_POLL_MS", "PDF_PR_HEAD_POLL_MS", "PDF_SLOT_WAIT_MS"]) delete process.env[k];
});

const log = (w: World) => (existsSync(join(w.stateDir, "laps.log")) ? readFileSync(join(w.stateDir, "laps.log"), "utf8") : "");
const mainFile = (w: World, f: string) => execSync(`git --git-dir=${w.origin} show main:${f}`).toString();

/** resolves when `n` callers have arrived (or after `ms`, so a broken
 *  scheduler fails the concurrency assertion instead of hanging the suite) */
function barrier(n: number, ms = 8000) {
  let arrived = 0;
  let max = 0;
  let live = 0;
  let open: () => void;
  const gate = new Promise<void>((r) => (open = r));
  setTimeout(() => open(), ms);
  return {
    async arrive() {
      arrived++;
      live++;
      max = Math.max(max, live);
      if (arrived >= n) open();
      await gate;
      live--;
    },
    get max() {
      return max;
    },
  };
}

async function run(w: World, b: MachineBehavior = {}) {
  const deps = machineDeps(w, b);
  await prepareRepo(w.cfg, w.stateDir, deps);
  await runParallel(w.cfg, w.stateDir, deps);
  return deps;
}

describe("parallel lanes", () => {
  test("independent issues build at once; later ones rebase onto the moved main, re-verify and merge", async () => {
    const w = makeMachineWorld({ scheduling: { parallel: true, max_lanes: 3 } });
    w.gh.issues = [issue(1, "Add a"), issue(2, "Add b"), issue(3, "Add c")];
    const b = barrier(3);
    await run(w, {
      implement: async (clone, n) => {
        writeFileSync(join(clone, `f${n}.txt`), `${n}\n`);
        await b.arrive();
      },
    });
    expect(b.max).toBe(3); // all three implement rounds were live at once
    expect(w.gh.merged.length).toBe(3);
    for (const n of [1, 2, 3]) {
      expect(mainFile(w, `f${n}.txt`)).toBe(`${n}\n`);
      expect(w.ledger.getIssue("acme/toy", n)!.state).toBe("merged");
    }
    // the second and third lap found main moved and rebased in the box
    expect(log(w).match(/rebasing it in the machine/g)?.length).toBe(2);
    const q = w.ledger.mergeQueueRows("acme/toy");
    expect(q.map((r) => r.state)).toEqual(["merged", "merged", "merged"]);
    // every lease released, every box destroyed
    const open = w.ledger.db.query("SELECT COUNT(*) c FROM slot_requests WHERE state != 'released'").get() as any;
    expect(open.c).toBe(0);
    expect(w.machines.every((m) => m.destroyed)).toBe(true);
    // sibling-aware plans: a plan prompt named the other in-flight issues
    expect(w.machines.some((m) => m.prompts[0].includes("IN FLIGHT IN PARALLEL LANES"))).toBe(true);
  }, 90_000);

  test("a dependent issue starts only after its dependency merged; nothing runs twice", async () => {
    const w = makeMachineWorld({ scheduling: { parallel: true, max_lanes: 3 } });
    w.gh.issues = [issue(1, "Base"), issue(2, "On top", "Depends on: #1")];
    const plannedWhen: Record<number, boolean> = {};
    await run(w, {
      plan: (n) => {
        plannedWhen[n] = w.gh.states[1] === "closed";
        return `PLAN: issue ${n}`;
      },
    });
    expect(w.gh.merged.length).toBe(2);
    expect(plannedWhen[2]).toBe(true); // #2 planned only once #1 was closed by its merge
    expect(w.machines.map((m) => m.issue).sort()).toEqual([1, 2]);
  }, 90_000);

  test("a blocked lane does not stop its siblings", async () => {
    const w = makeMachineWorld({ attempts: 1, scheduling: { parallel: true, max_lanes: 2 } });
    w.gh.issues = [issue(1, "Bad"), issue(2, "Good")];
    await run(w, { review: (n) => (n === 1 ? "VERDICT: REJECT\nthe change is wrong" : "VERDICT: APPROVE\nok") });
    expect(w.ledger.getIssue("acme/toy", 1)!.state).toBe("blocked");
    expect(w.ledger.getIssue("acme/toy", 2)!.state).toBe("merged");
  }, 90_000);

  test("a pause stops every lane before its next lap; the in-flight lap finishes", async () => {
    const w = makeMachineWorld({ scheduling: { parallel: true, max_lanes: 1 } });
    w.gh.issues = [issue(1, "One"), issue(2, "Two")];
    await run(w, {
      implement: (clone, n) => {
        writeFileSync(join(clone, `f${n}.txt`), "x\n");
        writeFileSync(join(w.stateDir, "repos", "toy", "paused"), new Date().toISOString() + "\n");
      },
    });
    expect(w.gh.merged.length).toBe(1);
    expect(w.machines.length).toBe(1);
    expect(log(w)).toContain("paused — no new lap starts on toy");
  }, 90_000);

  test("first rebase conflict: one free repair round (cap +1), then it merges with both changes", async () => {
    const w = makeMachineWorld({ attempts: 1, files: { "shared.txt": "base\n" }, scheduling: { parallel: true, max_lanes: 2 } });
    w.gh.issues = [issue(1, "Edit shared one way"), issue(2, "Edit shared another way")];
    const b = barrier(2);
    await run(w, {
      implement: async (clone, n, round) => {
        if (round === 1) {
          writeFileSync(join(clone, "shared.txt"), `issue ${n}\n`);
          await b.arrive();
          return;
        }
        // the repair round does what the findings ask: rebase, keep both
        execSync(`git -C ${clone} fetch -q origin`);
        try {
          execSync(`git -C ${clone} ${GIT_ID} rebase -q origin/main`, { stdio: "pipe" });
        } catch {
          const theirs = execSync(`git -C ${clone} show origin/main:shared.txt`).toString();
          writeFileSync(join(clone, "shared.txt"), theirs + `issue ${n}\n`);
          execSync(`git -C ${clone} add shared.txt`);
          execSync(`git -C ${clone} ${GIT_ID} -c core.editor=true rebase --continue`, { stdio: "pipe" });
        }
      },
    });
    expect(w.gh.merged.length).toBe(2);
    const shared = mainFile(w, "shared.txt");
    expect(shared).toContain("issue 1");
    expect(shared).toContain("issue 2");
    expect(log(w)).toContain("one free repair round");
    // the loser spent its one attempt plus the free round
    const second = [1, 2].map((n) => w.ledger.getIssue("acme/toy", n)!).find((r) => r.attempts === 2);
    expect(second?.state).toBe("merged");
  }, 90_000);

  test("second rebase conflict: the plan is retired and the issue re-plans on fresh main", async () => {
    const w = makeMachineWorld({ attempts: 2, files: { "shared.txt": "base\n" }, scheduling: { parallel: true, max_lanes: 2 } });
    w.gh.issues = [issue(1, "Edit shared one way"), issue(2, "Edit shared another way")];
    const b = barrier(2);
    let loser = 0;
    await run(w, {
      implement: async (clone, n, round) => {
        if (round === 1) {
          writeFileSync(join(clone, "shared.txt"), `issue ${n}\n`);
          await b.arrive();
          return;
        }
        loser = n;
        // round 2 ignores the findings and conflicts again; round 3 starts
        // from fresh main (the box was reset) and appends
        const prev = readFileSync(join(clone, "shared.txt"), "utf8");
        writeFileSync(join(clone, "shared.txt"), round === 2 ? `issue ${n} again\n` : prev + `issue ${n}\n`);
      },
    });
    expect(w.gh.merged.length).toBe(2);
    expect(log(w)).toContain("second rebase conflict");
    const dir = issueDir(w.stateDir, "toy", loser);
    expect(readdirSync(dir).some((f) => /^plan\.superseded-/.test(f))).toBe(true);
    const box = w.machines.find((m) => m.issue === loser)!;
    expect(box.stages.filter((s) => s === "plan").length).toBe(2);
    expect(mainFile(w, "shared.txt")).toContain(`issue ${loser}`);
  }, 90_000);

  test("parallel reviews reporting the same bug in different words file it once", async () => {
    const w = makeMachineWorld({ scheduling: { parallel: true, max_lanes: 2 } });
    w.cfg.skip_labels = ["discovery"]; // keep the filed discovery out of this tick's lanes
    writeFileSync(join(w.stateDir, "repos", "toy", "config.json"), JSON.stringify(w.cfg));
    w.gh.issues = [issue(1, "One"), issue(2, "Two")];
    const titles: Record<number, string> = { 1: "Missing input validation on POST /items", 2: "missing input validation for POST /items" };
    const b = barrier(2);
    await run(w, {
      implement: async (clone, n) => {
        writeFileSync(join(clone, `f${n}.txt`), "x\n");
        await b.arrive();
      },
      review: (n) => `VERDICT: APPROVE\nok\n\n## DISCOVERIES\n- ${titles[n]} :: empty bodies are accepted :: users can create blank items :: major\n`,
    });
    expect(w.gh.merged.length).toBe(2);
    expect(w.gh.created.filter((c) => c.title.startsWith("[discovery]")).length).toBe(1);
  }, 90_000);
});

describe("pickForLane (the discovery lane rule)", () => {
  const disc = (n: number, minor = false) => issue(n, `[discovery] d${n}`, "", minor ? ["discovery", "minor"] : ["discovery"]);
  const fly = (entries: [number, boolean][]) => new Map<number, InFlight>(entries.map(([n, d]) => [n, { lane: 0, title: "", discovery: d }]));

  test("a major discovery first, but only one discovery in flight", () => {
    const ranked = [issue(1, "p1"), disc(2), disc(3), issue(4, "p4")];
    expect(pickForLane(ranked, fly([]))?.number).toBe(2);
    expect(pickForLane(ranked, fly([[2, true]]))?.number).toBe(1);
    expect(pickForLane(ranked, fly([[2, true], [1, false]]))?.number).toBe(4);
    expect(pickForLane(ranked, fly([[2, true], [1, false], [4, false]]))).toBeUndefined();
  });

  test("minors wait until no product issue is claimable, in flight included", () => {
    const ranked = [issue(1, "p1"), disc(5, true)];
    expect(pickForLane(ranked, fly([]))?.number).toBe(1);
    expect(pickForLane(ranked, fly([[1, false]]))).toBeUndefined();
    expect(pickForLane([disc(5, true)], fly([]))?.number).toBe(5);
  });
});

describe("MergeQueue", () => {
  test("reconcile closes turns a dead process left open", async () => {
    const w = makeMachineWorld();
    const id = w.ledger.mergeQueueEnter("acme/toy", 9, 1);
    w.ledger.mergeQueueSet(id, "reverifying");
    await prepareRepo(w.cfg, w.stateDir, machineDeps(w));
    expect(w.ledger.mergeQueueRows("acme/toy")[0]).toMatchObject({ state: "bounced", detail: "interrupted: the lap's process ended mid-queue" });
  }, 30_000);

  test("turns run one at a time in arrival order; a throwing turn releases the queue", async () => {
    const l = new Ledger(":memory:");
    const q = new MergeQueue(l, "acme/toy");
    const order: string[] = [];
    const slow = q.run(1, 11, async (set) => {
      order.push("1 start");
      await new Promise((r) => setTimeout(r, 30));
      set("merged");
      order.push("1 end");
    });
    const bad = q.run(2, 12, async () => {
      order.push("2");
      throw new Error("boom");
    });
    const last = q.run(3, 13, async (set) => {
      order.push("3");
      set("merged");
    });
    await slow;
    await expect(bad).rejects.toThrow("boom");
    await last;
    expect(order).toEqual(["1 start", "1 end", "2", "3"]);
    expect(l.mergeQueueRows("acme/toy").map((r) => [r.issue_number, r.state])).toEqual([[1, "merged"], [2, "bounced"], [3, "merged"]]);
  });
});
