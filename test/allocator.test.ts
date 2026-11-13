import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSlot,
  configForPool,
  effectivePriority,
  grantPass,
  lanePools,
  poolStatus,
  queuePosition,
  releaseSlot,
  requestSlot,
  type SlotRequest,
  type SlotRequestRow,
} from "../src/allocator";
import { parseRepoConfig } from "../src/config";
import { Ledger } from "../src/ledger";

const T0 = Date.parse("2026-11-11T12:00:00.000Z");
const min = (m: number) => T0 + m * 60_000;
const alive = () => true;
const caps = (instabox: number, boxd: number) => ({ instabox, boxd, daytona: 0, e2b: 0, instavm: 0 });

const req = (repo: string, o: Partial<SlotRequest> = {}): SlotRequest => ({
  repo,
  slug: repo.split("/")[1],
  lane: 0,
  pools: ["instabox"],
  priority: "normal",
  extraLane: false,
  ...o,
});
const row = (l: Ledger, id: number) => l.db.query("SELECT * FROM slot_requests WHERE id = ?").get(id) as SlotRequestRow;

afterEach(() => {
  delete process.env.PDF_POOL_INSTABOX;
  delete process.env.PDF_POOL_BOXD;
  delete process.env.PDF_AGING_MINUTES;
});

describe("effectivePriority", () => {
  test("one level per aging window, capped at high", () => {
    const at = new Date(T0).toISOString();
    expect(effectivePriority("low", at, min(0), 30)).toBe(0);
    expect(effectivePriority("low", at, min(29), 30)).toBe(0);
    expect(effectivePriority("low", at, min(30), 30)).toBe(1);
    expect(effectivePriority("low", at, min(61), 30)).toBe(2);
    expect(effectivePriority("normal", at, min(500), 30)).toBe(2);
    expect(effectivePriority("high", at, min(0), 30)).toBe(2);
  });
});

describe("grantPass ordering", () => {
  test("high beats normal beats low; FIFO inside a level; caps hold", () => {
    const l = new Ledger(":memory:");
    const low = requestSlot(l, req("o/a", { priority: "low" }), min(0));
    const n1 = requestSlot(l, req("o/b"), min(1));
    const n2 = requestSlot(l, req("o/c"), min(2));
    const hi = requestSlot(l, req("o/d", { priority: "high" }), min(3));
    const granted = grantPass(l, min(4), { alive, caps: caps(2, 0) }).map((r) => r.id);
    expect(granted).toEqual([hi, n1]);
    expect(row(l, n2).state).toBe("waiting");
    expect(row(l, low).state).toBe("waiting");
    // a release frees exactly one slot for the next in order
    releaseSlot(l, hi);
    expect(grantPass(l, min(5), { alive, caps: caps(2, 0) }).map((r) => r.id)).toEqual([n2]);
  });

  test("aging lifts a long-waiting low request above a fresh normal one", () => {
    const l = new Ledger(":memory:");
    const low = requestSlot(l, req("o/a", { priority: "low" }), min(0));
    const fresh = requestSlot(l, req("o/b"), min(70));
    process.env.PDF_AGING_MINUTES = "30";
    expect(grantPass(l, min(71), { alive, caps: caps(1, 0) }).map((r) => r.id)).toEqual([low]);
    expect(row(l, fresh).state).toBe("waiting");
  });

  test("every first lane is served before any extra lane, whatever its priority", () => {
    const l = new Ledger(":memory:");
    const extraHigh = requestSlot(l, req("o/wide", { lane: 1, extraLane: true, priority: "high" }), min(0));
    const firstLow = requestSlot(l, req("o/narrow", { priority: "low" }), min(5));
    expect(grantPass(l, min(6), { alive, caps: caps(1, 0) }).map((r) => r.id)).toEqual([firstLow]);
    expect(row(l, extraHigh).state).toBe("waiting");
  });

  test("spill-over takes the second pool only when the first is full", () => {
    const l = new Ledger(":memory:");
    const a = requestSlot(l, req("o/a", { pools: ["instabox", "boxd"] }), min(0));
    const b = requestSlot(l, req("o/b", { pools: ["instabox", "boxd"] }), min(1));
    const c = requestSlot(l, req("o/c", { pools: ["instabox"] }), min(2));
    grantPass(l, min(3), { alive, caps: caps(1, 5) });
    expect(row(l, a).pool).toBe("instabox");
    expect(row(l, b).pool).toBe("boxd");
    // no spill-over: it waits for instabox even though boxd has room
    expect(row(l, c).state).toBe("waiting");
  });

  test("a blocked request does not stop a later one that fits another pool", () => {
    const l = new Ledger(":memory:");
    const ib = requestSlot(l, req("o/a", { pools: ["instabox"] }), min(0));
    const bx = requestSlot(l, req("o/b", { pools: ["boxd"], priority: "low" }), min(1));
    grantPass(l, min(2), { alive, caps: caps(0, 1) });
    expect(row(l, ib).state).toBe("waiting");
    expect(row(l, bx).state).toBe("granted");
  });

  test("caps come from PDF_POOL_* (defaults 5 and 10)", () => {
    const l = new Ledger(":memory:");
    for (let i = 0; i < 12; i++) requestSlot(l, req(`o/r${i}`, { pools: ["boxd"] }), min(i));
    expect(grantPass(l, min(20), { alive }).length).toBe(10);
    process.env.PDF_POOL_BOXD = "11";
    expect(grantPass(l, min(21), { alive }).length).toBe(1);
    expect(poolStatus(l).find((p) => p.pool === "boxd")).toEqual({ pool: "boxd", cap: 11, used: 11, waiting: 1, parked: 0 });
  });

  test("queuePosition follows grant order", () => {
    const l = new Ledger(":memory:");
    const a = requestSlot(l, req("o/a"), min(0));
    const b = requestSlot(l, req("o/b", { priority: "high" }), min(1));
    expect(queuePosition(l, b, min(2))).toBe(1);
    expect(queuePosition(l, a, min(2))).toBe(2);
  });
});

describe("sweep and parking", () => {
  test("a dead holder's lease is marked lost and frees its slot", () => {
    const l = new Ledger(":memory:");
    const a = requestSlot(l, req("o/a"), min(0));
    grantPass(l, min(1), { alive, caps: caps(1, 0) });
    const b = requestSlot(l, req("o/b"), min(2));
    expect(grantPass(l, min(3), { alive, caps: caps(1, 0) })).toEqual([]);
    // a's process died
    l.db.query("UPDATE slot_requests SET pid = 999999999 WHERE id = ?").run(a);
    const deadAware = (pid: number) => pid !== 999999999;
    expect(grantPass(l, min(4), { alive: deadAware, caps: caps(1, 0) }).map((r) => r.id)).toEqual([b]);
    expect(row(l, a).state).toBe("lost");
  });

  test("the real liveness check sees an exited process as dead", async () => {
    const l = new Ledger(":memory:");
    const child = Bun.spawn([process.execPath, "-e", "0"]);
    await child.exited;
    const a = requestSlot(l, req("o/a"), min(0));
    l.db.query("UPDATE slot_requests SET pid = ? WHERE id = ?").run(child.pid, a);
    grantPass(l, min(1), { caps: caps(1, 0) });
    expect(row(l, a).state).toBe("lost");
  });

  test("park → adopt keeps requested_at; an unadopted park expires after an hour", () => {
    const l = new Ledger(":memory:");
    const id = requestSlot(l, req("o/a"), min(0));
    l.db.query("UPDATE slot_requests SET state = 'parked', pid = NULL, parked_at = ? WHERE id = ?").run(new Date(min(14)).toISOString(), id);
    // parked rows are never granted (no live holder)
    expect(grantPass(l, min(15), { alive, caps: caps(5, 5) })).toEqual([]);
    const again = requestSlot(l, req("o/a"), min(20));
    expect(again).toBe(id);
    expect(row(l, id).requested_at).toBe(new Date(min(0)).toISOString());
    expect(row(l, id).state).toBe("waiting");
    // another lane does not adopt it
    l.db.query("UPDATE slot_requests SET state = 'parked', pid = NULL, parked_at = ? WHERE id = ?").run(new Date(min(20)).toISOString(), id);
    expect(requestSlot(l, req("o/a", { lane: 1 }), min(21))).not.toBe(id);
    grantPass(l, min(90), { alive, caps: caps(0, 0) });
    expect(row(l, id).state).toBe("released");
  });
});

describe("acquireSlot", () => {
  test("grants at once when there is room and records the lease", async () => {
    const l = new Ledger(":memory:");
    process.env.PDF_POOL_INSTABOX = "1";
    const lease = await acquireSlot(l, req("o/a"), { pollMs: 1, alive });
    expect(lease?.pool).toBe("instabox");
    expect(lease?.spilled).toBe(false);
    expect(row(l, lease!.id).state).toBe("granted");
  });

  test("waits, then parks after the window; nothing granted", async () => {
    const l = new Ledger(":memory:");
    process.env.PDF_POOL_INSTABOX = "0";
    const logs: string[] = [];
    const lease = await acquireSlot(l, req("o/a"), { waitMs: 30, pollMs: 5, alive, log: (m) => logs.push(m) });
    expect(lease).toBeNull();
    const r = l.db.query("SELECT * FROM slot_requests").get() as SlotRequestRow;
    expect(r.state).toBe("parked");
    expect(logs.join("\n")).toContain("waiting for a machine slot");
    expect(logs.join("\n")).toContain("request parked");
  });

  test("a pause while waiting releases the request", async () => {
    const l = new Ledger(":memory:");
    process.env.PDF_POOL_INSTABOX = "0";
    let polls = 0;
    const lease = await acquireSlot(l, req("o/a"), { waitMs: 10_000, pollMs: 1, alive, isPaused: () => ++polls > 2 });
    expect(lease).toBeNull();
    expect((l.db.query("SELECT state FROM slot_requests").get() as any).state).toBe("released");
  });

  test("a spill is reported in the lease and the receipt", async () => {
    const l = new Ledger(":memory:");
    process.env.PDF_POOL_INSTABOX = "0";
    process.env.PDF_POOL_BOXD = "1";
    const logs: string[] = [];
    const lease = await acquireSlot(l, req("o/a", { pools: ["instabox", "boxd"] }), { pollMs: 1, alive, log: (m) => logs.push(m) });
    expect(lease).toMatchObject({ pool: "boxd", spilled: true });
    expect(logs.join("\n")).toContain("spilled over (instabox pool full)");
  });
});

describe("config helpers", () => {
  const base = { repo: "acme/app", models: { default: { provider: "zai", model: "glm" } } };
  test("lanePools: own platform first, the rest of the fleet only with spill_over; none for host", () => {
    expect(lanePools(parseRepoConfig({ ...base, env: { mode: "instabox" } }, "t"))).toEqual(["instabox"]);
    // spill order: own mode, then the remaining pools in POOLS order
    expect(lanePools(parseRepoConfig({ ...base, env: { mode: "boxd" }, scheduling: { spill_over: true } }, "t"))).toEqual([
      "boxd", "instabox", "daytona", "e2b", "instavm",
    ]);
    expect(lanePools(parseRepoConfig({ ...base, env: { mode: "e2b" }, scheduling: { spill_over: true } }, "t"))).toEqual([
      "e2b", "instabox", "boxd", "daytona", "instavm",
    ]);
    expect(lanePools(parseRepoConfig(base, "t"))).toEqual([]);
  });
  test("configForPool swaps only env.mode and leaves the original alone", () => {
    const cfg = parseRepoConfig({ ...base, env: { mode: "instabox" }, scheduling: { spill_over: true } }, "t");
    const spilled = configForPool(cfg, "boxd");
    expect(spilled.env.mode).toBe("boxd");
    expect(cfg.env.mode).toBe("instabox");
    expect(spilled.env.boxd).toBe(cfg.env.boxd);
    expect(configForPool(cfg, "instabox")).toBe(cfg);
  });
});

describe("multi-process grant", () => {
  test("concurrent grant passes from several processes never exceed the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfalloc-"));
    const db = join(dir, "factory.db");
    const l = new Ledger(db);
    for (let i = 0; i < 20; i++) requestSlot(l, req(`o/r${i}`, { pools: ["boxd"] }), min(i));
    l.db.close();
    const script = `
      const { Ledger } = await import(${JSON.stringify(join(import.meta.dir, "../src/ledger"))});
      const { grantPass } = await import(${JSON.stringify(join(import.meta.dir, "../src/allocator"))});
      const l = new Ledger(${JSON.stringify(db)});
      for (let i = 0; i < 25; i++) grantPass(l, Date.now(), { alive: () => true, caps: { instabox: 0, boxd: 7 } });
      l.db.close();
    `;
    const kids = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, "-e", script], { stderr: "pipe" }));
    const codes = await Promise.all(kids.map((k) => k.exited));
    expect(codes).toEqual([0, 0, 0, 0]);
    const check = new Ledger(db);
    const n = (check.db.query("SELECT COUNT(*) c FROM slot_requests WHERE state = 'granted'").get() as any).c;
    expect(n).toBe(7);
    check.db.close();
  }, 30_000);
});
