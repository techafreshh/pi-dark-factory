import { describe, test, expect } from "bun:test";
import { daytonaBash, callDaytonaStage, DaytonaLapMachine, openDaytonaLapMachine } from "../src/machine-daytona";
import { repoDirFor, InfraUnavailableError } from "../src/machine";
import { loadRepoConfig } from "../src/config";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const daytonaCfg = (): any => {
  const dir = mkdtempSync(join(tmpdir(), "pdf-daytona-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({
    repo: "techafreshh/factory-smoke-9", slug: "factory-smoke-9", default_branch: "main", attempts: 3,
    models: { default: { provider: "p", model: "p/m", fallback: [] } },
    scenario: { ports: [8100, 8102] },
    env: { mode: "daytona", daytona: { repo_dir: "/home/daytona/repo", snapshot: "factory-base-daytona-r1" } },
  }));
  return loadRepoConfig(p);
};

/** A stub Daytona client. exec (executeCommand) echoes a correctly-framed
 *  result for the wrapper the driver sent — the same discipline the boxd
 *  stub pins: markers, nonce and caps parse identically across transports. */
function stubClient(opts: { stdout?: string; rc?: number; execError?: Error; createError?: Error; quotaFirst?: number; listAfterDelete?: boolean } = {}) {
  const calls: any = { exec: [], create: 0, deleted: [] as string[], stopped: 0, createParams: [] as any[] };
  const sandboxFor = (params: any) => ({
    id: "sbx-1",
    name: params.name,
    labels: params.labels,
    process: {
      executeCommand: async (command: string, _cwd: any, env: any, timeoutSecs: number) => {
        calls.exec.push({ command, env, timeoutSecs });
        if (opts.execError) throw opts.execError;
        const nonce = String(command).match(/PDFO-([a-z0-9]+)-START/)![1];
        const rc = opts.rc ?? 0;
        return {
          exitCode: 0,
          // Daytona 0.231.x: combined output in `result` (no split fields yet)
          result: `PDFRC-${nonce}:${rc}\nPDFO-${nonce}-START\n${opts.stdout ?? "hello"}\nPDFO-${nonce}-END\nPDFE-${nonce}-START\n\nPDFE-${nonce}-END`,
        };
      },
    },
  });
  const client: any = {
    create: async (params: any, o: any) => {
      calls.create++;
      calls.createParams.push({ params, o });
      if (calls.create <= (opts.quotaFirst ?? 0)) {
        const e: any = new Error("org vCPU pool exhausted"); e.status = 429; throw e;
      }
      if (opts.createError) throw opts.createError;
      return sandboxFor(params);
    },
    list: async function* (query: any) {
      calls.listQuery = query;
      if (opts.listAfterDelete) yield { id: "sbx-1", name: "pdf-factory-smoke-9-i11-g3", labels: { factory: "1" } };
    },
    delete: async (sbx: any) => { calls.deleted.push(sbx.id); },
    stop: async () => { calls.stopped++; },
    snapshot: { list: async () => ({ items: [] }), delete: async () => {} },
  };
  return { client, calls };
}

describe("daytonaBash", () => {
  test("maps framed exec output onto the same ShRes the other transports produce", async () => {
    const { client } = stubClient({ stdout: "BOOTSTRAP_OK" });
    const sbx = await client.create({ name: "x", snapshot: "s" }, {});
    const res = await daytonaBash(sbx, "echo BOOTSTRAP_OK", { timeoutMs: 9000 });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("BOOTSTRAP_OK");
    expect(res.stderr).toBe("");
    expect(res.timedOut).toBe(false);
  });

  test("passes a server-side kill deadline SECONDS behind the in-box wrapper's", async () => {
    const { client, calls } = stubClient();
    const sbx = await client.create({ name: "x", snapshot: "s" }, {});
    await daytonaBash(sbx, "true", { timeoutMs: 20_000 });
    // 20s deadline -> 25s server kill: the in-box 124 owns the timeout verdict
    expect(calls.exec[0].timeoutSecs).toBe(25);
  });

  test("rc 124 from the in-box deadline surfaces as timedOut", async () => {
    const { client } = stubClient({ rc: 124, stdout: "partial" });
    const sbx = await client.create({ name: "x", snapshot: "s" }, {});
    const res = await daytonaBash(sbx, "sleep forever", { timeoutMs: 9000 });
    expect(res.timedOut).toBe(true);
    expect(res.code).toBe(124);
    expect(res.stdout).toContain("partial");
  });

  test("a hung transport throws the typed infra error, never a plain attempt burn", async () => {
    const { client } = stubClient({ execError: new Error("toolbox proxy unreachable") });
    const sbx = await client.create({ name: "x", snapshot: "s" }, {});
    expect(daytonaBash(sbx, "true")).rejects.toThrow(InfraUnavailableError);
  });
});

describe("DaytonaLapMachine", () => {
  test("ensure boots from the golden snapshot once, with auto-stop disabled and labels", async () => {
    const { client, calls } = stubClient();
    const m = new DaytonaLapMachine(daytonaCfg(), 11, () => {}, 3, undefined, client);
    await m.bash("true");
    await m.bash("true");
    expect(calls.create).toBe(1);
    expect(calls.createParams[0].params.snapshot).toBe("factory-base-daytona-r1");
    expect(calls.createParams[0].params.autoStopInterval).toBe(0); // inactivity auto-stop would kill a writing agent
    expect(calls.createParams[0].params.labels).toMatchObject({ factory: "1", repo: "techafreshh/factory-smoke-9", issue: "11" });
    expect(calls.exec.length).toBe(2);
  });

  test("the org pool cap queues with the attempt budget preserved", async () => {
    const logs: string[] = [];
    const { client, calls } = stubClient({ quotaFirst: 2 });
    const m = new DaytonaLapMachine(daytonaCfg(), 11, (s) => logs.push(s), 3, undefined, client);
    process.env.PDF_SLOT_QUEUE_DEADLINE_MS = "1500";
    process.env.PDF_SLOT_QUEUE_DELAY_MS = "500";
    try {
      await m.bash("true").catch(() => {});
    } finally {
      delete process.env.PDF_SLOT_QUEUE_DEADLINE_MS;
      delete process.env.PDF_SLOT_QUEUE_DELAY_MS;
    }
    expect(logs.join("\n")).toContain("machine-slot queue");
    expect(calls.create).toBe(3); // 2 quota rejects + the boot
  });

  test("a missing snapshot is a config error, not infra — it fails the lap loudly", async () => {
    const { client } = stubClient({ createError: new Error("snapshot nope not found") });
    const m = new DaytonaLapMachine(daytonaCfg(), 11, () => {}, 3, undefined, client);
    await expect(m.bash("true")).rejects.toThrow(/snapshot nope not found/);
    try {
      await m.bash("true");
    } catch (e) {
      expect(e).not.toBeInstanceOf(InfraUnavailableError);
    }
  });

  test("an infra create failure is the typed defer, attempt budget preserved", async () => {
    const { client } = stubClient({ createError: new Error("connection reset by peer") });
    const m = new DaytonaLapMachine(daytonaCfg(), 11, () => {}, 3, undefined, client);
    await expect(m.bash("true")).rejects.toThrow(InfraUnavailableError);
  });

  test("destroy deletes by object and receipts platform delete lag like the other drivers", async () => {
    const logs: string[] = [];
    const { client, calls } = stubClient({ listAfterDelete: true });
    const m = new DaytonaLapMachine(daytonaCfg(), 11, (s) => logs.push(s), 3, undefined, client);
    await m.bash("true");
    await m.destroy();
    expect(calls.deleted).toEqual(["sbx-1"]);
    expect(logs.join("\n")).toContain("delete not yet visible (platform lag)");
  });

  test("bootstrap resolves the daytona repo_dir, not instabox's", async () => {
    const cfg = daytonaCfg();
    const { bootstrapScriptFor } = await import("../src/machine");
    const script = bootstrapScriptFor(cfg, "factory/issue-11");
    expect(script).toContain("/home/daytona/repo");
    expect(script).not.toContain("/data/repo");
  });
});

describe("stage protocol over exec env", () => {
  test("callDaytonaStage passes PDFENV/PDFARGS/PDFPROMPT through exec env and parses markers", async () => {
    const canned = `PDFRC=0\n${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "PI_OK" }] } })}\n`;
    const { client, calls } = stubClient({ stdout: canned });
    const sbx = await client.create({ name: "x", snapshot: "s" }, {});
    const r = await callDaytonaStage(sbx, {
      models: { base: { provider: "p", model: "p/m" }, fallback: [] },
      gates: true, branch: "factory/issue-11", base: "main",
      envFile: "export PDF_GATES=1",
      prompt: "do the thing", systemPrompt: "sys",
      timeoutMs: 9000,
    });
    expect(r.outcome.kind).toBe("ok");
    expect(r.raw).toContain("PI_OK");
    expect(calls.exec[0].env.PDF_L_ENV).toMatch(/^PDFENV /);
    expect(calls.exec[0].env.PDF_L_ARGS).toMatch(/^PDFARGS /);
    expect(calls.exec[0].env.PDF_L_PROMPT).toMatch(/^PDFPROMPT /);
  });
});

describe("DaytonaLapMachine.callStage per stage", () => {
  const canned = `BOOTSTRAP_OK\nPDFRC=0\n${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "PI_OK" }] } })}\n`;
  const stageEnv = (exec: any) => Buffer.from(String(exec.env.PDF_L_ENV).replace(/^PDFENV /, ""), "base64").toString("utf8");
  const run = async (stage: "plan" | "implement" | "review") => {
    const { client, calls } = stubClient({ stdout: canned });
    const m = new DaytonaLapMachine(daytonaCfg(), 11, () => {}, 3, undefined, client);
    const r = await m.callStage(stage, { models: { base: { provider: "p", model: "p/m" }, fallback: [] }, prompt: "x", systemPrompt: "sys", timeoutMs: 9000 });
    expect(r.outcome.kind).toBe("ok");
    return calls.exec as any[];
  };

  test("plan bootstraps the clone (the lap's first stage), runs without gates, and is reset after", async () => {
    const execs = await run("plan");
    expect(execs.length).toBe(2); // bootstrap, then the stage
    expect(execs[0].env).toBeUndefined();
    const env = stageEnv(execs[1]);
    expect(env).toContain("export PDF_GATES=0\n");
    expect(env).toContain("export PDF_RESTORE=1\n");
  });

  test("implement bootstraps and gates, and keeps its work", async () => {
    const execs = await run("implement");
    expect(execs.length).toBe(2);
    const env = stageEnv(execs[1]);
    expect(env).toContain("export PDF_GATES=1\n");
    expect(env).toContain("export PDF_RESTORE=0\n");
  });

  test("review reuses the clone as it stands and is reset after", async () => {
    const execs = await run("review");
    expect(execs.length).toBe(1);
    const env = stageEnv(execs[0]);
    expect(env).toContain("export PDF_GATES=0\n");
    expect(env).toContain("export PDF_RESTORE=1\n");
  });
});

describe("config + dispatch", () => {
  test("repoDirFor resolves per mode; daytona keeps instabox's path untouched", () => {
    const c: any = daytonaCfg();
    expect(repoDirFor(c)).toBe("/home/daytona/repo");
    c.env.mode = "instabox";
    expect(repoDirFor(c)).toBe("/data/repo");
    c.env.mode = "e2b";
    expect(repoDirFor(c)).toBe("/home/user/repo");
    c.env.mode = "instavm";
    expect(repoDirFor(c)).toBe("/app/repo");
  });

  test("openDaytonaLapMachine names sandboxes with the fleet convention", () => {
    const m = openDaytonaLapMachine(daytonaCfg(), 11, undefined, 3, undefined, stubClient().client);
    expect(m.name).toBe("pdf-factory-smoke-9-i11-g3");
  });
});
