import { describe, test, expect } from "bun:test";
import { e2bBash, callE2bStage, E2bLapMachine, openE2bLapMachine, e2bFromEnv, e2bTtlMs, type E2bLike } from "../src/machine-e2b";
import { InfraUnavailableError } from "../src/machine";
import { loadRepoConfig } from "../src/config";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const e2bCfg = (): any => {
  const dir = mkdtempSync(join(tmpdir(), "pdf-e2b-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({
    repo: "techafreshh/factory-smoke-9", slug: "factory-smoke-9", default_branch: "main", attempts: 3,
    models: { default: { provider: "p", model: "p/m", fallback: [] } },
    scenario: { ports: [8100, 8102] },
    env: { mode: "e2b", e2b: { repo_dir: "/home/user/repo", snapshot: "factory-base-e2b-r1" } },
  }));
  return loadRepoConfig(p);
};

/** A stub E2bLike seam. commands.run echoes a correctly-framed stdout for the
 *  wrapper the driver sent; a non-zero exit is delivered the way the real SDK
 *  delivers it — THROWN as a CommandExitError-shaped object carrying the
 *  result (recorded shape, e2b@2.63.0 source). */
function stubClient(opts: { stdout?: string; rc?: number; runError?: Error; createError?: Error; capacityFirst?: number; listAfterDelete?: boolean } = {}) {
  const calls: any = { run: [], create: 0, killed: [] as string[], timeouts: [] as number[], createParams: [] as any[] };
  const sbxFor = (template: string) => ({
    sandboxId: "sbx-1",
    template,
    commands: {
      run: async (cmd: string, o: any) => {
        calls.run.push({ cmd, o });
        if (opts.runError) throw opts.runError;
        const nonce = String(cmd).match(/PDFO-([a-z0-9]+)-START/)![1];
        const rc = opts.rc ?? 0;
        const stdout = `PDFRC-${nonce}:${rc}\nPDFO-${nonce}-START\n${opts.stdout ?? "hello"}\nPDFO-${nonce}-END\nPDFE-${nonce}-START\n\nPDFE-${nonce}-END`;
        if (rc !== 0) {
          // CommandExitError implements CommandResult and is THROWN on non-zero
          const e: any = new Error(`exited with code ${rc}`);
          e.exitCode = rc; e.stdout = stdout; e.stderr = "";
          throw e;
        }
        return { exitCode: rc, stdout, stderr: "" };
      },
    },
  });
  const client: E2bLike = {
    create: async (template: string, o: any) => {
      calls.create++;
      calls.createParams.push({ template, o });
      if (calls.create <= (opts.capacityFirst ?? 0)) {
        const e: any = new Error("cluster_at_capacity"); e.status = 503; throw e;
      }
      if (opts.createError) throw opts.createError;
      return sbxFor(template);
    },
    list: async () => (opts.listAfterDelete ? [{ sandboxId: "sbx-1", metadata: { factory: "1", name: "pdf-factory-smoke-9-i11-g3" } }] : []),
    kill: async (id: string) => { calls.killed.push(id); return true; },
    setTimeout: async (id: string, ms: number) => { calls.timeouts.push(ms); },
  };
  return { client, calls };
}

describe("e2bBash", () => {
  test("maps framed exec output onto the same ShRes the other transports produce", async () => {
    const { client } = stubClient({ stdout: "BOOTSTRAP_OK" });
    const sbx = await client.create("t", { timeoutMs: 1000, metadata: {} });
    const res = await e2bBash(sbx, "echo BOOTSTRAP_OK", { timeoutMs: 9000 });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("BOOTSTRAP_OK");
    expect(res.timedOut).toBe(false);
  });

  test("passes a server-side kill deadline 30s behind the in-box wrapper's", async () => {
    const { client, calls } = stubClient();
    const sbx = await client.create("t", { timeoutMs: 1000, metadata: {} });
    await e2bBash(sbx, "true", { timeoutMs: 20_000 });
    expect(calls.run[0].o.timeoutMs).toBe(50_000); // 20s deadline + 30s margin
  });

  test("a thrown CommandExitError still parses the framed markers (rc, not infra)", async () => {
    const { client } = stubClient({ rc: 3, stdout: "partial work" });
    const sbx = await client.create("t", { timeoutMs: 1000, metadata: {} });
    const res = await e2bBash(sbx, "false", { timeoutMs: 9000 });
    expect(res.code).toBe(3);
    expect(res.stdout).toContain("partial work");
    expect(res.timedOut).toBe(false);
  });

  test("rc 124 from the in-box deadline surfaces as timedOut", async () => {
    const { client } = stubClient({ rc: 124, stdout: "partial" });
    const sbx = await client.create("t", { timeoutMs: 1000, metadata: {} });
    const res = await e2bBash(sbx, "sleep forever", { timeoutMs: 9000 });
    expect(res.timedOut).toBe(true);
    expect(res.code).toBe(124);
  });

  test("a hung transport throws the typed infra error, never a plain attempt burn", async () => {
    const { client } = stubClient({ runError: new Error("websocket closed") });
    const sbx = await client.create("t", { timeoutMs: 1000, metadata: {} });
    expect(e2bBash(sbx, "true")).rejects.toThrow(InfraUnavailableError);
  });
});

describe("E2bLapMachine", () => {
  test("ensure boots from the golden template once, with an explicit create TTL and metadata", async () => {
    const { client, calls } = stubClient();
    const m = new E2bLapMachine(e2bCfg(), 11, () => {}, 3, undefined, client);
    await m.bash("true");
    await m.bash("true");
    expect(calls.create).toBe(1);
    expect(calls.createParams[0].template).toBe("factory-base-e2b-r1");
    expect(calls.createParams[0].o.timeoutMs).toBe(e2bTtlMs()); // the API default is 300s — a silent kill
    expect(calls.createParams[0].o.metadata).toMatchObject({ factory: "1", repo: "techafreshh/factory-smoke-9", issue: "11", name: "pdf-factory-smoke-9-i11-g3" });
    expect(calls.run.length).toBe(2);
  });

  test("the plan concurrency cap queues with the attempt budget preserved", async () => {
    const logs: string[] = [];
    const { client } = stubClient({ capacityFirst: 2 });
    const m = new E2bLapMachine(e2bCfg(), 11, (s) => logs.push(s), 3, undefined, client);
    process.env.PDF_SLOT_QUEUE_DEADLINE_MS = "1500";
    process.env.PDF_SLOT_QUEUE_DELAY_MS = "500";
    try {
      await m.bash("true").catch(() => {});
    } finally {
      delete process.env.PDF_SLOT_QUEUE_DEADLINE_MS;
      delete process.env.PDF_SLOT_QUEUE_DELAY_MS;
    }
    expect(logs.join("\n")).toContain("machine-slot queue");
  });

  test("callStage refreshes the sandbox TTL before every stage (the default expiry is a silent kill)", async () => {
    const canned = `BOOTSTRAP_OK\nPDFRC=0\n${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "PI_OK" }] } })}\n`;
    const { client, calls } = stubClient({ stdout: canned });
    const m = new E2bLapMachine(e2bCfg(), 11, () => {}, 3, undefined, client);
    await m.callStage("plan", { models: { base: { provider: "p", model: "p/m" }, fallback: [] }, prompt: "x", systemPrompt: "sys", timeoutMs: 9000 });
    expect(calls.timeouts).toEqual([e2bTtlMs()]);
  });

  test("a missing template is a config error, not infra", async () => {
    const { client } = stubClient({ createError: new Error("template nope not found") });
    const m = new E2bLapMachine(e2bCfg(), 11, () => {}, 3, undefined, client);
    try {
      await m.bash("true");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).not.toBeInstanceOf(InfraUnavailableError);
      expect(String(e)).toContain("template nope not found");
    }
  });

  test("destroy kills by sandboxId and resolves orphans by metadata name", async () => {
    const logs: string[] = [];
    const { client, calls } = stubClient({ listAfterDelete: true });
    const m = new E2bLapMachine(e2bCfg(), 11, (s) => logs.push(s), 3, undefined, client);
    await m.destroy(); // no live handle — falls back to the list
    expect(calls.killed).toEqual(["sbx-1"]);
  });
});

describe("stage protocol over exec env", () => {
  const canned = `BOOTSTRAP_OK\nPDFRC=0\n${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "PI_OK" }] } })}\n`;
  const stageEnv = (run: any) => Buffer.from(String(run.o.envs.PDF_L_ENV).replace(/^PDFENV /, ""), "base64").toString("utf8");
  const run = async (stage: "plan" | "implement" | "review") => {
    const { client, calls } = stubClient({ stdout: canned });
    const m = new E2bLapMachine(e2bCfg(), 11, () => {}, 3, undefined, client);
    const r = await m.callStage(stage, { models: { base: { provider: "p", model: "p/m" }, fallback: [] }, prompt: "x", systemPrompt: "sys", timeoutMs: 9000 });
    expect(r.outcome.kind).toBe("ok");
    return calls.run as any[];
  };

  test("plan bootstraps the clone (the lap's first stage), runs without gates, and is reset after", async () => {
    const runs = await run("plan");
    expect(runs.length).toBe(2); // bootstrap, then the stage
    expect(runs[0].o.envs).toBeUndefined();
    const env = stageEnv(runs[1]);
    expect(env).toContain("export PDF_GATES=0\n");
    expect(env).toContain("export PDF_RESTORE=1\n");
  });

  test("implement bootstraps and gates, and keeps its work", async () => {
    const runs = await run("implement");
    expect(runs.length).toBe(2);
    const env = stageEnv(runs[1]);
    expect(env).toContain("export PDF_GATES=1\n");
    expect(env).toContain("export PDF_RESTORE=0\n");
  });

  test("review reuses the clone as it stands and is reset after", async () => {
    const runs = await run("review");
    expect(runs.length).toBe(1);
    const env = stageEnv(runs[0]);
    expect(env).toContain("export PDF_GATES=0\n");
    expect(env).toContain("export PDF_RESTORE=1\n");
  });

  test("callE2bStage advances the model chain on provider errors and stops on gates", async () => {
    const fail = (m: string) => `PDFRC=1\n${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: m }] } })}\n`;
    const { client, calls } = stubClient({ stdout: fail("bad") });
    const sbx = await client.create("t", { timeoutMs: 1000, metadata: {} });
    const r = await callE2bStage(sbx, {
      models: { base: { provider: "p", model: "p/a" }, fallback: [{ provider: "p", model: "p/b" }] },
      gates: false, branch: "factory/issue-11", base: "main",
      envFile: "export PDF_GATES=0",
      prompt: "x", systemPrompt: "sys", timeoutMs: 9000,
    });
    expect(r.outcome.kind).toBe("provider_error");
    expect(r.modelsTried.map((t) => t.spec.model)).toEqual(["p/a", "p/b"]);
    expect(calls.run.length).toBe(2);
  });
});

describe("e2bFromEnv + dispatch", () => {
  test("e2bFromEnv refuses to build without a key", () => {
    const had = process.env.E2B_API_KEY;
    delete process.env.E2B_API_KEY;
    try {
      expect(() => e2bFromEnv()).toThrow(/E2B_API_KEY is not set/);
    } finally {
      if (had) process.env.E2B_API_KEY = had;
    }
  });

  test("openE2bLapMachine names sandboxes with the fleet convention", () => {
    const m = openE2bLapMachine(e2bCfg(), 11, undefined, 3, undefined, stubClient().client);
    expect(m.name).toBe("pdf-factory-smoke-9-i11-g3");
  });
});
