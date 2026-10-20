import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPool, parseResetLine, startKeyrouter } from "../src/keyrouter";

const dir = mkdtempSync(join(tmpdir(), "pdfrtr-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseResetLine (ClinePass 429 text)", () => {
  const now = Date.now();
  test("reads 'resets in 4d 5h'", () => {
    const until = parseResetLine("Error 429: You have reached your weekly Clinepass limit. The limit resets in 4d 5h, please try again later.", now)!;
    expect(Math.round((until - now) / 3600000)).toBe(24 * 4 + 5);
  });
  test("reads hours-only and days-only", () => {
    expect(Math.round((parseResetLine("resets in 3h", now)! - now) / 3600000)).toBe(3);
    expect(Math.round((parseResetLine("resets in 2d", now)! - now) / 86400000)).toBe(2);
  });
  test("no parseable window → null (caller applies default)", () => {
    expect(parseResetLine("rate limited", now)).toBeNull();
  });
});

describe("KeyPool", () => {
  test("priority order: hot key repeats; cooling removes it until expiry", () => {
    const pool = new KeyPool(["A", "B", "C"]);
    expect(pool.next()).toBe("A");
    expect(pool.next()).toBe("A"); // priority: the first hot key keeps serving
    pool.cool("A", Date.now() + 60000, "capped");
    expect(pool.next()).toBe("B");
    pool.cool("B", Date.now() + 60000, "capped");
    expect(pool.next()).toBe("C");
    expect(pool.stats()).toEqual({ keys: 3, hot: 1, cooling: 2 });
    pool.cool("A", Date.now() - 1, "expired");
    expect(pool.coolUntil("A")).toBeNull();
    expect(pool.next()).toBe("A"); // back to the front of the line
  });

  test("all keys cooling → null", () => {
    const pool = new KeyPool(["A", "B"]);
    pool.cool("A", Date.now() + 60000, "x");
    pool.cool("B", Date.now() + 60000, "x");
    expect(pool.next()).toBeNull();
  });

  test("cooldowns survive a restart via the state file", () => {
    const stateFile = join(dir, "pool-state.json");
    const p1 = new KeyPool(["A", "B"], { stateFile });
    p1.cool("A", Date.now() + 3600000, "capped");
    const p2 = new KeyPool(["A", "B"], { stateFile });
    expect(p2.coolUntil("A") !== null).toBe(true);
    expect(p2.next()).toBe("B");
  });
});

describe("keyrouter HTTP (mock upstream)", () => {
  let upstreamCalls: string[] = [];
  let upstreamSrv: ReturnType<typeof Bun.serve> | null = null;
  let routerSrv: ReturnType<typeof Bun.serve> | null = null;
  let keysFile: string;

  // Mock clinepass: each key caps on its own body — KEY1 caps on "CAP1"
  // (with a parseable weekly reset), KEY2 caps on "CAP2" (unparseable window),
  // so failover paths are deterministic.
  const startWith = (keys: string[]) => {
    keysFile = join(dir, "router-keys");
    writeFileSync(keysFile, keys.join("\n") + "\n");
    upstreamSrv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const auth = req.headers.get("authorization") ?? "";
        const body = await req.text();
        upstreamCalls.push(auth);
        if (body.includes("CAP1") && auth === "Bearer KEY1") {
          return new Response("Error 429: weekly limit. The limit resets in 4d 2h.", { status: 429 });
        }
        if (body.includes("CAP2") && auth === "Bearer KEY2") {
          return new Response("Error 429: rate limited.", { status: 429 });
        }
        return Response.json({ choice: `served by ${auth}` });
      },
    });
    routerSrv = startKeyrouter({
      port: 0,
      keysFile,
      upstream: `http://127.0.0.1:${upstreamSrv.port}`,
      stateFile: join(dir, "router-state.json"),
      defaultCoolMs: 3600000,
    });
  };

  test("first key serves; a weekly 429 parses the reset window and transparently fails over", async () => {
    startWith(["KEY1", "KEY2"]);
    const base = `http://127.0.0.1:${routerSrv!.port}/v1/chat/completions`;
    const r1 = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as any).choice).toContain("Bearer KEY1");

    // KEY1 hits its weekly cap → cooled exactly 4d2h → KEY2 serves the retry
    const r2 = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "CAP1",
    });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as any).choice).toContain("Bearer KEY2");
    expect(upstreamCalls).toEqual(["Bearer KEY1", "Bearer KEY1", "Bearer KEY2"]);
  }, 20000);

  test("exhausted pool returns 429; /pool shows the damage; new keys are picked up live", async () => {
    // KEY1 already cooling (4d2h); KEY2 caps without a parseable window →
    // default cooldown → pool empty → client gets a plain 429
    const r = await fetch(`http://127.0.0.1:${routerSrv!.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "CAP2",
    });
    expect(r.status).toBe(429);

    const pool = (await (await fetch(`http://127.0.0.1:${routerSrv!.port}/pool`)).json()) as any;
    expect(pool.keys).toBe(2);
    expect(pool.hot).toBe(0);
    expect(pool.cooling).toBe(2);

    writeFileSync(keysFile, ["KEY1", "KEY2", "KEY3"].join("\n") + "\n");
    const r2 = await fetch(`http://127.0.0.1:${routerSrv!.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "again" }] }),
    });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as any).choice).toContain("Bearer KEY3");
  }, 20000);

  afterAll(() => {
    upstreamSrv?.stop(true);
    routerSrv?.stop(true);
  });
});
