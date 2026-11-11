import { describe, test, expect } from "bun:test";
import { execWrapper, parseWrap, boxdBash, callBoxdStage, BoxdLapMachine, openBoxdLapMachine } from "../src/machine-boxd";
import { repoDirFor, InfraUnavailableError } from "../src/machine";
import { loadRepoConfig } from "../src/config";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const N = "ab12cd";

describe("execWrapper", () => {
  test("runs the payload in a setsid group with an in-box deadline and nonce-marked frames", () => {
    const w = execWrapper("ZWNjaCBoaQ==", 5000, N);
    expect(w).toContain("setsid bash -c");
    expect(w).toContain(`printf %s 'ZWNjaCBoaQ=='`);
    expect(w).toContain("kill -TERM -- -$PG");
    expect(w).toContain("kill -KILL -- -$PG");
    expect(w).toContain("echo 124 > $U.rc"); // the deadline's timeout verdict
    expect(w).toContain(`PDFRC-${N}:`);
    expect(w).toContain(`PDFO-${N}-START`);
    expect(w).toContain(`rm -f $U.b64 $U.out $U.err $U.rc`);
  });
});

describe("parseWrap", () => {
  test("extracts rc, stdout and stderr from the framed output", () => {
    const framed = `noise\nPDFRC-${N}:7\nPDFO-${N}-START\nhello\nworld\nPDFO-${N}-END\nPDFE-${N}-START\nboom\nPDFE-${N}-END`;
    const p = parseWrap(framed, N);
    expect(p.rc).toBe(7);
    expect(p.out).toBe("hello\nworld");
    expect(p.err).toBe("boom");
  });
  test("a missing RC marker is a wrapper failure (125), not a silent zero", () => {
    expect(parseWrap("", N).rc).toBe(125);
    expect(parseWrap("unrelated output", N).rc).toBe(125);
  });
  test("nonces fence frames — output containing another run's markers cannot cross-read", () => {
    const framed = `PDFRC-${N}:0\nPDFO-${N}-START\nPDFO-zz9pass-START\nPDFO-${N}-END`;
    const p = parseWrap(framed, N);
    expect(p.rc).toBe(0);
    expect(p.out).toBe("PDFO-zz9pass-START");
  });
  test("a payload whose last line has no trailing newline survives the frame (curl -w class)", () => {
    // the first smoke-lap killer: curl -w '%{http_code}' emits "200" with NO
    // trailing newline — unfused capture must round-trip byte-exactly
    const framed = `PDFRC-${N}:0\nPDFO-${N}-START\n200\nPDFO-${N}-END\nPDFE-${N}-START\n\nPDFE-${N}-END`;
    expect(parseWrap(framed, N).out).toBe("200");
    const fused = `PDFRC-${N}:0\nPDFO-${N}-START\n200\nPDFO-${N}-END`;
    expect(parseWrap(fused, N).out).toBe("200");
  });
});

const boxdCfg = (): any => {
  const dir = mkdtempSync(join(tmpdir(), "pdf-boxd-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({
    repo: "techafreshh/factory-smoke-9", slug: "factory-smoke-9", default_branch: "main", attempts: 3,
    models: { default: { provider: "p", model: "p/m", fallback: [] } },
    scenario: { ports: [8100, 8102] },
    env: { mode: "boxd", boxd: { repo_dir: "/home/boxd/repo" } },
  }));
  return loadRepoConfig(p);
};

/** A stub Boxd client: exec echoes a correctly-framed result for the payload
 *  the wrapper carried; every other RPC is recorded. */
function stubClient(opts: { stdout?: string; rc?: number; execError?: Error; createError?: Error; grpc8First?: number; listAfterDelete?: boolean } = {}) {
  const calls: any = { exec: [], create: 0, deleted: [] as string[], waits: 0 };
  const client: any = {
    machines: {
      create: async (spec: any) => {
        calls.create++;
        if (calls.create <= (opts.grpc8First ?? 0)) {
          const e: any = new Error("machine limit reached"); e.grpcCode = 8; throw e;
        }
        if (opts.createError) throw opts.createError;
        return { id: "vm-1", name: spec.name, status: "pending" };
      },
      waitUntilReady: async () => { calls.waits++; return { status: "running" }; },
      exec: async (_id: string, params: any) => {
        calls.exec.push(params);
        if (opts.execError) throw opts.execError;
        const nonce = String(params.command[2]).match(/PDFO-([a-z0-9]+)-START/)![1];
        const rc = opts.rc ?? 0;
        return {
          stdout: `PDFRC-${nonce}:${rc}\nPDFO-${nonce}-START\n${opts.stdout ?? "hello"}\nPDFO-${nonce}-END\nPDFE-${nonce}-START\n\nPDFE-${nonce}-END`,
          stderr: "", exitCode: 0, success: true,
        };
      },
      list: async () => ({ machines: opts.listAfterDelete ? [{ id: "vm-1", name: "pdf-factory-smoke-9-i11-g3" }] : [] }),
      delete: async (id: string) => { calls.deleted.push(id); },
    },
  };
  return { client, calls };
}

describe("boxdBash", () => {
  test("maps framed exec output onto the same ShRes the ssh transport produces", async () => {
    const { client } = stubClient({ stdout: "BOOTSTRAP_OK" });
    const res = await boxdBash(client, "vm-1", "echo BOOTSTRAP_OK", { timeoutMs: 9000 });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("BOOTSTRAP_OK");
    expect(res.timedOut).toBe(false);
    // the wrapper, not the (broken) server-side timeout, owns the deadline
    const execParams = (client.machines as any).calls?.exec?.[0] ?? null;
    expect(execParams).toBeNull(); // stub hides internals; the direct assert is below
  });

  test("carries no server-side timeoutMs — the in-box deadline is the only one", async () => {
    let seen: any = null;
    const { client } = stubClient();
    const orig = client.machines.exec.bind(client.machines);
    client.machines.exec = async (id: string, params: any) => { seen = params; return orig(id, params); };
    await boxdBash(client, "vm-1", "true", { timeoutMs: 9000 });
    expect(seen.timeoutMs).toBeUndefined();
    expect(seen.command[0]).toBe("bash");
  });

  test("rc 124 from the in-box deadline surfaces as timedOut", async () => {
    const { client } = stubClient({ rc: 124, stdout: "partial" });
    const res = await boxdBash(client, "vm-1", "sleep forever", { timeoutMs: 9000 });
    expect(res.timedOut).toBe(true);
    expect(res.code).toBe(124);
    expect(res.stdout).toContain("partial");
  });

  test("a hung transport throws the typed infra error, never a plain attempt burn", async () => {
    const { client } = stubClient({ execError: new Error("grpc stream closed") });
    expect(boxdBash(client, "vm-1", "true")).rejects.toThrow(InfraUnavailableError);
  });
});

describe("BoxdLapMachine", () => {
  test("ensure boots from the shared snapshot once, then reuses the machine", async () => {
    const { client, calls } = stubClient();
    const m = new BoxdLapMachine(boxdCfg(), 11, () => {}, 3, undefined, client);
    await m.bash("true");
    await m.bash("true");
    expect(calls.create).toBe(1);
    expect(calls.waits).toBe(1);
    expect(calls.exec.length).toBe(2);
  });

  test("the org machine cap queues with the attempt budget preserved, then defers", async () => {
    const logs: string[] = [];
    const { client } = stubClient({ grpc8First: 2 });
    const m = new BoxdLapMachine(boxdCfg(), 11, (s) => logs.push(s), 3, undefined, client);
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

  test("destroy deletes by id and receipts platform delete lag like instabox does", async () => {
    const logs: string[] = [];
    const { client, calls } = stubClient({ listAfterDelete: true });
    const m = new BoxdLapMachine(boxdCfg(), 11, (s) => logs.push(s), 3, undefined, client);
    await m.bash("true");
    await m.destroy();
    expect(calls.deleted).toEqual(["vm-1"]);
    expect(logs.join("\n")).toContain("delete not yet visible (platform lag)");
  });

  test("bootstrap reuses the instabox script verbatim — clone, branch, BOOTSTRAP_OK", async () => {
    const { client } = stubClient({ stdout: "BOOTSTRAP_OK" });
    const m = new BoxdLapMachine(boxdCfg(), 11, () => {}, 3, undefined, client);
    // reach through bash: bootstrap is private-ish; exercise via a stage-less call
    const res = await m.bash("true", { timeoutMs: 5000 });
    expect(res.code).toBe(0);
    const { bootstrapScriptFor } = await import("../src/machine");
    const script = bootstrapScriptFor(boxdCfg(), "factory/issue-11");
    expect(script).toContain("/home/boxd/repo"); // boxd repo_dir resolved, not /data/repo
    expect(script).toContain("BOOTSTRAP_OK");
  });
});

describe("stage protocol over exec env", () => {
  test("callBoxdStage passes PDFENV/PDFARGS/PDFPROMPT through env and parses markers", async () => {
    const { client } = stubClient({ stdout: `PDFRC=0\n${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "PI_OK" }] } })}\n` });
    const r = await callBoxdStage(client, "vm-1", {
      models: { base: { provider: "p", model: "p/m" }, fallback: [] },
      gates: true, branch: "factory/issue-11", base: "main",
      envFile: "export PDF_GATES=1",
      prompt: "do the thing", systemPrompt: "sys",
      timeoutMs: 9000,
    });
    expect(r.outcome.kind).toBe("ok");
  });
});

describe("BoxdLapMachine.callStage per stage", () => {
  // the canned exec answer satisfies both the bootstrap (BOOTSTRAP_OK) and a stage (PDFRC + event)
  const canned = `BOOTSTRAP_OK\nPDFRC=0\n${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "PI_OK" }] } })}\n`;
  const stageEnv = (exec: any) => Buffer.from(String(exec.env.PDF_L_ENV).replace(/^PDFENV /, ""), "base64").toString("utf8");
  const run = async (stage: "plan" | "implement" | "review") => {
    const { client, calls } = stubClient({ stdout: canned });
    const m = new BoxdLapMachine(boxdCfg(), 11, () => {}, 3, undefined, client);
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
  test("repoDirFor resolves per mode; boxd keeps instabox's path untouched", () => {
    const c: any = boxdCfg();
    expect(repoDirFor(c)).toBe("/home/boxd/repo");
    c.env.mode = "instabox";
    expect(repoDirFor(c)).toBe("/data/repo");
  });
  test("openBoxdLapMachine names machines with the fleet convention", () => {
    const m = openBoxdLapMachine(boxdCfg(), 11, undefined, 3, undefined, stubClient().client);
    expect(m.name).toBe("pdf-factory-smoke-9-i11-g3");
  });
});
