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

  test("everything else requires the key", async () => {
    expect((await fetch(base + "status")).status).toBe(401);
    const bad = await fetch(base + "status", { headers: { "x-api-key": "wrong" } });
    expect(bad.status).toBe(401);
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
