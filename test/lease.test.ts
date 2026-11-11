import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SlotRequestRow } from "../src/allocator";
import { tickRepo } from "../src/tick";
import { cleanupWorlds, issue, machineDeps, makeMachineWorld } from "./world";

afterAll(cleanupWorlds);
afterEach(() => {
  for (const k of ["PDF_POOL_INSTABOX", "PDF_POOL_BOXD", "PDF_SLOT_WAIT_MS", "PDF_SLOT_POLL_MS"]) delete process.env[k];
});

const slotRows = (w: ReturnType<typeof makeMachineWorld>) =>
  w.ledger.db.query("SELECT * FROM slot_requests ORDER BY id").all() as SlotRequestRow[];

describe("machine laps lease a slot (src/allocator.ts)", () => {
  test("the lease is granted before the claim, bound to the lap, released after the machine is destroyed", async () => {
    const w = makeMachineWorld();
    w.gh.issues = [issue(1, "Add a file")];
    const deps = machineDeps(w);
    // record the order: the claim must find a granted lease already there
    const claim = w.ledger.claim.bind(w.ledger);
    let leaseAtClaim: string | undefined;
    w.ledger.claim = (repo, n) => {
      leaseAtClaim = slotRows(w)[0]?.state;
      return claim(repo, n);
    };
    const outcome = await tickRepo(w.cfg, w.stateDir, deps);
    expect(outcome).toBe("merged");
    expect(leaseAtClaim).toBe("granted");
    const [lease] = slotRows(w);
    expect(lease).toMatchObject({ repo: "acme/toy", lane: 0, pool: "instabox", issue_number: 1, state: "released" });
    expect(lease.lap_id).toBeGreaterThan(0);
    expect(w.machines[0].destroyed).toBe(true);
    expect(w.machines[0].stages).toEqual(["plan", "implement", "review"]);
  }, 60_000);

  test("a host-mode lap never touches the allocator", async () => {
    const w = makeMachineWorld();
    w.cfg.env.mode = "host";
    w.gh.issues = [issue(1, "Add a file")];
    // host laps run host stages: give it one that commits in the worktree
    const deps = {
      ...machineDeps(w),
      callStage: async (stage: string, a: any) => {
        if (stage === "implement") {
          const { execSync } = await import("node:child_process");
          execSync(`echo hi > ${a.cwd}/h.txt && git -C ${a.cwd} -c user.email=t@t.io -c user.name=T add -A && git -C ${a.cwd} -c user.email=t@t.io -c user.name=T commit -qm h`);
        }
        const text = stage === "review" ? "VERDICT: APPROVE" : "PLAN: x";
        return { outcome: { kind: "ok", text, usage: { input_tokens: 1, output_tokens: 1 } }, modelsTried: [] } as any;
      },
    };
    expect(await tickRepo(w.cfg, w.stateDir, deps)).toBe("merged");
    expect(slotRows(w)).toEqual([]);
  }, 60_000);

  test("full own pool + spill_over: the lap runs on the other platform and says so", async () => {
    const w = makeMachineWorld({ scheduling: { spill_over: true } });
    w.gh.issues = [issue(1, "Add a file")];
    process.env.PDF_POOL_INSTABOX = "0";
    process.env.PDF_POOL_BOXD = "1";
    const modes: string[] = [];
    const deps = machineDeps(w);
    const open = deps.openMachine!;
    deps.openMachine = (cfg, ...rest) => {
      modes.push(cfg.env.mode);
      return open(cfg, ...rest);
    };
    expect(await tickRepo(w.cfg, w.stateDir, deps)).toBe("merged");
    expect(modes).toEqual(["boxd"]);
    expect(w.cfg.env.mode).toBe("instabox"); // the repo's own config is untouched
    expect(slotRows(w)[0].pool).toBe("boxd");
    expect(readFileSync(join(w.stateDir, "laps.log"), "utf8")).toContain("spilled over (instabox pool full)");
  }, 60_000);

  test("full pool, no spill: the request parks after the window and nothing is claimed", async () => {
    const w = makeMachineWorld();
    w.gh.issues = [issue(1, "Add a file")];
    process.env.PDF_POOL_INSTABOX = "0";
    process.env.PDF_SLOT_WAIT_MS = "50";
    process.env.PDF_SLOT_POLL_MS = "5";
    expect(await tickRepo(w.cfg, w.stateDir, machineDeps(w))).toBe("no_slot");
    expect(w.ledger.getIssue("acme/toy", 1)).toBeNull();
    expect(slotRows(w)[0].state).toBe("parked");
    expect(w.machines).toEqual([]);
  }, 60_000);
});
