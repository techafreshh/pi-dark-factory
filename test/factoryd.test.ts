import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFactoryd } from "../src/factoryd";
import { Ledger } from "../src/ledger";

const dir = mkdtempSync(join(tmpdir(), "pdfd-"));
const srv = startFactoryd({ stateDir: dir, port: 0, key: "test-key" });
const base = `http://127.0.0.1:${srv.port}/`;
afterAll(() => {
  srv.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("factoryd (remote-control API)", () => {
  test("health is open and reports the service", async () => {
    const r = await fetch(base + "health");
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("pi-dark-factory");
  });

  test("health reports the machine-slot pools from the ledger", async () => {
    const { requestSlot, grantPass } = await import("../src/allocator");
    const l = new Ledger(join(dir, "factory.db"));
    requestSlot(l, { repo: "acme/a", slug: "a", lane: 0, pools: ["boxd"], priority: "normal", extraLane: false });
    grantPass(l, Date.now(), { alive: () => true });
    l.db.close();
    const body = (await (await fetch(base + "health")).json()) as any;
    const boxd = body.pools.find((p: any) => p.pool === "boxd");
    expect(boxd).toMatchObject({ cap: 10, used: 1, waiting: 0 });
    expect(body.pools.find((p: any) => p.pool === "instabox").cap).toBe(5);
  });

  test("everything else requires the key", async () => {
    expect((await fetch(base + "status")).status).toBe(401);
    const bad = await fetch(base + "status", { headers: { "x-api-key": "wrong" } });
    expect(bad.status).toBe(401);
  });

  test("the laptop companion key authorizes like the primary (and both stay required)", async () => {
    process.env.DARK_FACTORY_LAPTOP_KEY = "laptop-key-test";
    const s2 = startFactoryd({ stateDir: dir, port: 0, key: "primary-test" });
    const b2 = `http://127.0.0.1:${s2.port}/`;
    try {
      expect((await fetch(b2 + "status", { headers: { "x-api-key": "laptop-key-test" } })).status).toBe(200);
      expect((await fetch(b2 + "status", { headers: { "x-api-key": "primary-test" } })).status).toBe(200);
      expect((await fetch(b2 + "status", { headers: { "x-api-key": "stranger" } })).status).toBe(401);
      expect((await fetch(b2 + "status")).status).toBe(401);
      const h = (await (await fetch(b2 + "health")).json()) as any;
      expect(h.laptop_key_set).toBe(true);
    } finally {
      s2.stop(true);
      delete process.env.DARK_FACTORY_LAPTOP_KEY;
    }
  });

  test("status echoes the ledger through the ops core", async () => {
    const ledger = new Ledger(join(dir, "factory.db"));
    ledger.claim("acme/app", 7);
    const r = await fetch(base + "status", { headers: { "x-api-key": "test-key" } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.issues.some((i: any) => i.issue_number === 7)).toBe(true);
    expect(Array.isArray(body.repos)).toBe(true); // no repos configured, no crash
  });

  test("bad payloads surface as errors, not crashes", async () => {
    const r = await fetch(base + "repos", {
      method: "POST",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      body: JSON.stringify({ repo: "not-a-repo" }),
    });
    expect(r.status).toBe(500);
    const body = (await r.json()) as any;
    expect(body.error).toContain("owner/name");
  });

  test("tick returns queued without blocking on the lap", async () => {
    // no onboarded repo → the tick errors in the background and receipts it;
    // the HTTP contract is still an immediate ack
    const r = await fetch(base + "repos/ghost/tick", {
      method: "POST",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.queued).toBe(true);
  });

  test("tick answers 409 while the repo's tick lock is held by a live factory process", async () => {
    // the test runner works from the checkout, so its own pid reads as a factory holder
    writeFileSync(join(dir, "tick-busy.lock"), `${process.pid}\n`);
    const r = await fetch(base + "repos/busy/tick", { method: "POST", headers: { "x-api-key": "test-key" }, body: "{}" });
    expect(r.status).toBe(409);
    const body = (await r.json()) as any;
    expect(body.queued).toBe(false);
    expect(body.skipped).toContain("already live");
  });

  test("models serves the live provider roster without keys", async () => {
    const r = await fetch(base + "models", { headers: { "x-api-key": "test-key" } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(Array.isArray(body.providers)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("apiKey"); // keys never leave the VPS
  });

  test("pause/unpause write and clear the wheel flag", async () => {
    mkdirSync(join(dir, "repos", "demo"), { recursive: true });
    writeFileSync(
      join(dir, "repos", "demo", "config.json"),
      JSON.stringify({ repo: "acme/demo", slug: "demo", models: { default: { provider: "x", model: "y" } }, scenario: { ports: [] }, env: { mode: "host" } })
    );
    const on = await fetch(base + "repos/demo/pause", {
      method: "POST",
      headers: { "x-api-key": "test-key" },
    });
    expect(on.status).toBe(200);
    expect(((await on.json()) as any).paused).toBe(true);
    expect(existsSync(join(dir, "repos", "demo", "paused"))).toBe(true);
    const off = await fetch(base + "repos/demo/unpause", {
      method: "POST",
      headers: { "x-api-key": "test-key" },
    });
    expect(off.status).toBe(200);
    expect(((await off.json()) as any).paused).toBe(false);
    expect(existsSync(join(dir, "repos", "demo", "paused"))).toBe(false);
    // pause on an unknown repo is a 404, not a 500
    const ghost = await fetch(base + "repos/ghost/pause", {
      method: "POST",
      headers: { "x-api-key": "test-key" },
    });
    expect(ghost.status).toBe(404);
  });
});
