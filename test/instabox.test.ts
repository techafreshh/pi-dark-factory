import { afterAll, describe, expect, test } from "bun:test";
import { InstaBox, machineNameFor, sanitizeMachinePart, type InstaMachine, type InstaOperation } from "../src/instabox";

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(routes: (rec: Recorded, url: string) => { status: number; body: any } | undefined) {
  const calls: Recorded[] = [];
  const impl = (async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v as string]));
    const rec: Recorded = { method: init.method ?? "GET", path: u.pathname + u.search, headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(rec);
    const r = routes(rec, String(url)) ?? { status: 404, body: "not found" };
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const op = (id: string, state: string, machine?: any): InstaOperation => ({ id, machineId: "m1", type: "create", state, machine } as any);

describe("InstaBox client", () => {
  test("machineByName: 404 → null, 200 → machine", async () => {
    const { impl, calls } = fakeFetch((rec) => {
      if (rec.method === "GET" && rec.path === "/v1/machines/pdf-toy-i1")
        return { status: 200, body: { id: "m1", name: "pdf-toy-i1", state: "running" } satisfies InstaMachine };
      return undefined; // 404
    });
    const ib = new InstaBox("https://api.instabox.sh/", "KEY", { fetchImpl: impl, pollMs: 1 });
    expect(await ib.machineByName("pdf-toy-i1")).toMatchObject({ name: "pdf-toy-i1" });
    expect(await ib.machineByName("nope")).toBeNull();
    expect(calls[0].headers["x-api-key"]).toBe("KEY");
    // trailing slash on base must not double up
    expect(calls[0].path).toBe("/v1/machines/pdf-toy-i1");
  });

  test("createMachine sends X-API-Key + Idempotency-Key and returns the operation", async () => {
    const { impl, calls } = fakeFetch((rec) =>
      rec.method === "POST" && rec.path === "/v1/machines" ? { status: 202, body: op("op1", "pending") } : undefined
    );
    const ib = new InstaBox("https://api.instabox.sh", "KEY", { fetchImpl: impl });
    const res = await ib.createMachine({ name: "pdf-toy-i1", templateId: "basic" });
    expect(res.id).toBe("op1");
    expect(calls[0].headers["idempotency-key"]).toBeString();
    expect(calls[0].body).toEqual({ name: "pdf-toy-i1", templateId: "basic" });
  });

  test("waitOperation polls until succeeded, throws on failed", async () => {
    let n = 0;
    const { impl } = fakeFetch((rec) => {
      if (rec.path.startsWith("/v1/operations/")) {
        n++;
        return { status: 200, body: op("op1", n < 2 ? "pending" : "succeeded") };
      }
      return undefined;
    });
    const ib = new InstaBox("https://api.instabox.sh", "KEY", { fetchImpl: impl, pollMs: 1 });
    expect((await ib.waitOperation("op1")).state).toBe("succeeded");

    const fail = new InstaBox("https://api.instabox.sh", "KEY", {
      fetchImpl: fakeFetch(() => ({ status: 200, body: op("op1", "failed", undefined) })).impl,
      pollMs: 1,
    });
    await expect(fail.waitOperation("op1")).rejects.toThrow(/failed/);
  });

  test("ensureRunning: creates when missing, resumes when paused", async () => {
    const machines: Record<string, InstaMachine> = {};
    let created = false;
    let resumed = 0;
    const { impl } = fakeFetch((rec) => {
      if (rec.method === "GET" && rec.path === "/v1/machines/pdf-toy-i1") {
        return machines["pdf-toy-i1"] ? { status: 200, body: machines["pdf-toy-i1"] } : { status: 404, body: "none" };
      }
      if (rec.method === "POST" && rec.path === "/v1/machines") {
        created = true;
        machines[rec.body.name] = { id: "m1", name: rec.body.name, state: "running" };
        return { status: 202, body: op("op1", "succeeded", machines[rec.body.name]) };
      }
      if (rec.method === "GET" && rec.path.startsWith("/v1/operations/")) {
        return { status: 200, body: op("opX", "succeeded", machines[rec.body?.name ?? "pdf-toy-i1"]) };
      }
      if (rec.method === "POST" && rec.path.endsWith("/resume")) {
        resumed++;
        machines["pdf-toy-i1"].state = "running";
        return { status: 202, body: op("op2", "succeeded") };
      }
      return undefined;
    });
    const ib = new InstaBox("https://api.instabox.sh", "KEY", { fetchImpl: impl, pollMs: 1 });

    await ib.ensureRunning({ name: "pdf-toy-i1", templateId: "basic" });
    expect(created).toBe(true);

    machines["pdf-toy-i1"].state = "paused";
    await ib.ensureRunning({ name: "pdf-toy-i1", templateId: "basic" });
    expect(resumed).toBe(1);
    expect(created).toBe(true); // no second create
    void resumed;
  });

  test("listMachines follows pages; usage parses limits", async () => {
    let page = 0;
    const { impl } = fakeFetch((rec) => {
      if (rec.path.startsWith("/v1/machines")) {
        page++;
        return page === 1
          ? { status: 200, body: { machines: [{ id: "a", name: "a", state: "running" }], nextCursor: "c2" } }
          : { status: 200, body: { machines: [{ id: "b", name: "b", state: "stopped" }], nextCursor: null } };
      }
      if (rec.path === "/v1/usage") {
        return { status: 200, body: { machines: 2, snapshots: 1, storedBytes: 1, limits: { maxMachines: 5 } } };
      }
      return undefined;
    });
    const ib = new InstaBox("https://api.instabox.sh", "KEY", { fetchImpl: impl, pollMs: 1 });
    expect((await ib.listMachines()).map((m) => m.id)).toEqual(["a", "b"]);
    expect((await ib.usage()).limits?.maxMachines).toBe(5);
  });
});

describe("naming", () => {
  test("machineNameFor sanitizes slugs", () => {
    expect(machineNameFor("Toy Product", 3)).toBe("pdf-toy-product-i3");
    expect(machineNameFor("", 1)).toBe("pdf-repo-i1");
  });
  test("machineNameFor generation suffix — every lap gets a unique name (bi-ai-ui mapping roulette, 2026-10-26)", () => {
    expect(machineNameFor("bi-ai-ui", 1, 317)).toBe("pdf-bi-ai-ui-i1-g317");
    expect(machineNameFor("bi-ai-ui", 1, 318)).not.toBe(machineNameFor("bi-ai-ui", 1, 317));
  });
  test("sanitizeMachinePart caps and cleans", () => {
    expect(sanitizeMachinePart("Weird_Slug!!")).toBe("weird-slug");
  });
});
