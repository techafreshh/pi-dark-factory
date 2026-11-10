import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onboardedSlugs, schedulePass, spawnRepoTick } from "../src/scheduler";
import { runTick } from "../src/tick";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function stateWith(slugs: string[]): string {
  const st = mkdtempSync(join(tmpdir(), "pdfsched-"));
  dirs.push(st);
  for (const s of slugs) {
    mkdirSync(join(st, "repos", s), { recursive: true });
    writeFileSync(
      join(st, "repos", s, "config.json"),
      JSON.stringify({ repo: `acme/${s}`, models: { default: { provider: "x", model: "y" } }, env: { mode: "host" } })
    );
  }
  return st;
}

// this test process runs from the checkout, so lock.ts takes its pid for a
// live factory process: a lock file holding it is a tick still running
const holdLock = (st: string, slug: string) => writeFileSync(join(st, `tick-${slug}.lock`), `${process.pid}\n`);

describe("schedulePass (one tick process per idle repo)", () => {
  test("starts every idle repo and skips the one whose tick still runs", async () => {
    const st = stateWith(["alpha", "beta", "gamma"]);
    holdLock(st, "beta");
    const spawned: string[] = [];
    const r = await schedulePass(st, { gapMs: 0, spawnTick: (_s, slug) => (spawned.push(slug), 1) });
    expect(spawned).toEqual(["alpha", "gamma"]);
    expect(r.running).toEqual(["beta"]);
    const log = readFileSync(join(st, "laps.log"), "utf8");
    expect(log).toContain("skipping beta: its previous tick is still running");
    expect(log).toContain("scheduler: started 2 repo tick(s), 1 still running");
  });

  test("a stale lock (dead pid) does not block the repo", async () => {
    const st = stateWith(["alpha"]);
    writeFileSync(join(st, "tick-alpha.lock"), "999999999\n");
    const spawned: string[] = [];
    await schedulePass(st, { gapMs: 0, spawnTick: (_s, slug) => (spawned.push(slug), 1) });
    expect(spawned).toEqual(["alpha"]);
  });

  test("the concurrency cap counts the ticks already running", async () => {
    const st = stateWith(["alpha", "beta", "gamma"]);
    holdLock(st, "alpha");
    const spawned: string[] = [];
    await schedulePass(st, { gapMs: 0, concurrency: 2, spawnTick: (_s, slug) => (spawned.push(slug), 1) });
    expect(spawned).toEqual(["beta"]); // alpha running + beta = 2
    expect(readFileSync(join(st, "laps.log"), "utf8")).toContain("skipping gamma: concurrency cap (2) reached");
  });

  test("only directories with a config.json are repos", () => {
    const st = stateWith(["alpha"]);
    mkdirSync(join(st, "repos", "half-onboarded"), { recursive: true });
    writeFileSync(join(st, "repos", "stray.txt"), "x");
    expect(onboardedSlugs(st)).toEqual(["alpha"]);
  });

  test("starts are spaced gapMs apart, so a pass never forks every repo at once", async () => {
    const st = stateWith(["alpha", "beta", "gamma"]);
    const at: number[] = [];
    await schedulePass(st, { gapMs: 150, spawnTick: () => (at.push(Date.now()), 1) });
    expect(at.length).toBe(3);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(140);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(140);
  });
});

describe("machine janitor runs once per pass, not once per repo tick", () => {
  test("a scoped tick skips it; a full tick and a scheduler pass list the machines", async () => {
    const st = stateWith([]);
    let lists = 0;
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.method === "GET" && new URL(req.url).pathname === "/v1/machines") {
          lists++;
          return Response.json({ machines: [] });
        }
        return new Response("nf", { status: 404 });
      },
    });
    const saved = process.env.TEST_SCHED_IB_KEY;
    process.env.TEST_SCHED_IB_KEY = "k";
    try {
      mkdirSync(join(st, "repos", "toy"), { recursive: true });
      writeFileSync(
        join(st, "repos", "toy", "config.json"),
        JSON.stringify({
          repo: "acme/toy",
          models: { default: { provider: "x", model: "y" } },
          env: { mode: "instabox", instabox: { api_base: `http://127.0.0.1:${srv.port}`, api_key_env: "TEST_SCHED_IB_KEY" } },
        })
      );
      writeFileSync(join(st, "repos", "toy", "paused"), "test\n"); // the tick body returns at once
      await runTick({ stateDir: st, repoSlug: "toy" });
      expect(lists).toBe(0);
      await runTick({ stateDir: st });
      expect(lists).toBe(1);
      await schedulePass(st, { gapMs: 0, spawnTick: () => 1 });
      expect(lists).toBe(2);
    } finally {
      srv.stop(true);
      if (saved === undefined) delete process.env.TEST_SCHED_IB_KEY;
      else process.env.TEST_SCHED_IB_KEY = saved;
    }
  }, 30000);
});

describe("spawnRepoTick (real child process)", () => {
  test("runs foreman tick --repo against the given state dir, detached from the caller", async () => {
    const st = stateWith([]); // no config for "ghost": the child receipts its crash and exits
    const pid = spawnRepoTick(st, "ghost");
    expect(typeof pid).toBe("number");
    const log = join(st, "laps.log");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(existsSync(log) && readFileSync(log, "utf8").includes("ghost"))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(readFileSync(log, "utf8")).toContain("tick crashed (ghost)");
  }, 30000);
});
