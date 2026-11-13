import { describe, test, expect } from "bun:test";
import { instavmBash, callInstavmStage, InstavmLapMachine, openInstavmLapMachine, instavmClientFromEnv, type InstaVmClientLike } from "../src/machine-instavm";
import { InfraUnavailableError } from "../src/machine";
import { loadRepoConfig } from "../src/config";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// fast poll loop: the driver reads PDF_INSTAVM_POLL_MS per poll, not at load
process.env.PDF_INSTAVM_POLL_MS = "10";

const instavmCfg = (): any => {
  const dir = mkdtempSync(join(tmpdir(), "pdf-instavm-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({
    repo: "techafreshh/factory-smoke-9", slug: "factory-smoke-9", default_branch: "main", attempts: 3,
    models: { default: { provider: "p", model: "p/m", fallback: [] } },
    scenario: { ports: [8100, 8102] },
    env: { mode: "instavm", instavm: { repo_dir: "/app/repo", snapshot: "factory-base-instavm-r1", api_base: "https://api.instavm.io/v1" } },
  }));
  return loadRepoConfig(p);
};

/** A stub InstaVmClientLike. The REST wire shapes here are RECORDED from the
 *  official SDK source (instavm 0.26.1, BandarLabs/sandbox_client, read
 *  2026-11-13): POST /execute_async (root) → {task_id}, poll
 *  GET /v1/executions/{id} → {is_complete, serialized_stdout, …}, VM
 *  lifecycle under /v1/vms with a bare-array list. */
function stubClient(opts: { stdout?: string; rc?: number; execError?: Error; createError?: Error; quotaFirst?: number; listAfterDelete?: boolean; pollsBeforeDone?: number } = {}) {
  const calls: any = { exec: [], create: 0, deleted: [] as string[], createParams: [] as any[], requests: [] as any[] };
  let polls = 0;
  let lastCommand = "";
  const client: InstaVmClientLike = {
    request: async (method, path, body) => {
      calls.requests.push({ method, path, body });
      if (path === "/v1/vms" && method === "POST") {
        calls.create++;
        calls.createParams.push(body);
        if (calls.create <= (opts.quotaFirst ?? 0)) {
          const e: any = new Error("concurrent VM limit reached"); e.status = 429; throw e;
        }
        if (opts.createError) throw opts.createError;
        return { vm_id: "vm-1", session_id: "s-1", status: "running" };
      }
      if (path === "/v1/vms" && method === "GET")
        // recorded: a bare array
        return opts.listAfterDelete ? [{ vm_id: "vm-1", metadata: { factory: "1", name: "pdf-factory-smoke-9-i11-g3" } }] : [];
      if (path === "/v1/snapshots" && method === "GET") return { snapshots: [{ id: "snap-1", name: "factory-base-instavm-r1" }] };
      if (path === "/execute_async") {
        if (opts.execError) throw opts.execError;
        return { task_id: "task-1" };
      }
      if (path.startsWith("/v1/executions/")) {
        polls++;
        const nonce = String(lastCommand).match(/PDFO-([a-z0-9]+)-START/)?.[1] ?? "ab12cd";
        const rc = opts.rc ?? 0;
        if (polls <= (opts.pollsBeforeDone ?? 0)) return { is_complete: false };
        return {
          is_complete: true,
          serialized_stdout: `PDFRC-${nonce}:${rc}\nPDFO-${nonce}-START\n${opts.stdout ?? "hello"}\nPDFO-${nonce}-END\nPDFE-${nonce}-START\n\nPDFE-${nonce}-END`,
        };
      }
      return {};
    },
    async createVm(spec) {
      return this.request("POST", "/v1/vms", spec);
    },
    async getVm(id) {
      return this.request("GET", `/v1/vms/${id}`);
    },
    async listVms() {
      return this.request("GET", "/v1/vms");
    },
    async deleteVm(id) {
      calls.deleted.push(id);
      await this.request("DELETE", `/v1/vms/${id}`);
    },
    async snapshotIdByName(name) {
      const res = await this.request("GET", "/v1/snapshots");
      const items = res.snapshots ?? res.items ?? [];
      const hit = items.find((s: any) => s.name === name);
      if (!hit) throw new Error(`instavm snapshot "${name}" not found — bake it first: foreman bake <slug>`);
      return hit.id;
    },
    async execAsync(sessionId, command) {
      calls.exec.push({ command });
      lastCommand = command;
      // recorded: session_id rides the async submit body
      return this.request("POST", "/execute_async", { command, session_id: sessionId, language: "bash" }).then((r) => String(r.task_id));
    },
    async pollExecution(taskId) {
      return this.request("GET", `/v1/executions/${taskId}`);
    },
  };
  return { client, calls };
}

describe("instavmBash", () => {
  test("async exec + poll maps framed output onto the same ShRes the other transports produce", async () => {
    const { client } = stubClient({ stdout: "BOOTSTRAP_OK", pollsBeforeDone: 2 });
    const res = await instavmBash(client, "s-1", "echo BOOTSTRAP_OK", { timeoutMs: 9000 });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("BOOTSTRAP_OK");
    expect(res.timedOut).toBe(false);
  });

  test("sends ONE async exec to the recorded root path (the sync timeout is an HTTP wait, max 600s)", async () => {
    const { client, calls } = stubClient();
    await instavmBash(client, "s-1", "true", { timeoutMs: 9000 });
    expect(calls.requests.filter((r: any) => r.path === "/execute_async").length).toBe(1);
    expect(calls.requests.some((r: any) => r.path.startsWith("/v1/executions/") && r.method === "POST")).toBe(false);
    // recorded: session_id rides the submit body
    expect(calls.requests.find((r: any) => r.path === "/execute_async").body.session_id).toBe("s-1");
  });

  test("rc 124 from the in-box deadline surfaces as timedOut", async () => {
    const { client } = stubClient({ rc: 124, stdout: "partial" });
    const res = await instavmBash(client, "s-1", "sleep forever", { timeoutMs: 9000 });
    expect(res.timedOut).toBe(true);
    expect(res.code).toBe(124);
    expect(res.stdout).toContain("partial");
  });

  test("a hung transport (async submit) throws the typed infra error", async () => {
    const { client } = stubClient({ execError: new Error("connection reset") });
    expect(instavmBash(client, "s-1", "true")).rejects.toThrow(InfraUnavailableError);
  });

  test("stage env rides embedded exports in the script (REST exec takes no env param)", async () => {
    const { client, calls } = stubClient();
    await instavmBash(client, "s-1", "true", { timeoutMs: 9000, env: { PDF_L_ENV: "PDFENV QUJD" } });
    expect(calls.exec[0].command).toContain("export PDF_L_ENV='PDFENV QUJD'");
  });
});

describe("InstavmLapMachine", () => {
  test("ensure boots from the golden snapshot once, with an explicit lifetime and metadata", async () => {
    const { client, calls } = stubClient();
    const m = new InstavmLapMachine(instavmCfg(), 11, () => {}, 3, undefined, client);
    await m.bash("true");
    await m.bash("true");
    expect(calls.create).toBe(1);
    expect(calls.createParams[0].snapshot_id).toBe("snap-1");
    expect(calls.createParams[0].vm_lifetime_seconds).toBeGreaterThanOrEqual(600);
    expect(calls.createParams[0].metadata).toMatchObject({ factory: "1", repo: "techafreshh/factory-smoke-9", issue: "11", name: "pdf-factory-smoke-9-i11-g3" });
    expect(calls.exec.length).toBe(2);
  });

  test("the plan VM cap queues with the attempt budget preserved", async () => {
    const logs: string[] = [];
    const { client } = stubClient({ quotaFirst: 2 });
    const m = new InstavmLapMachine(instavmCfg(), 11, (s) => logs.push(s), 3, undefined, client);
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

  test("a missing snapshot is a config error, not infra", async () => {
    const { client } = stubClient({ createError: new Error("snapshot snap-x not found") });
    const m = new InstavmLapMachine(instavmCfg(), 11, () => {}, 3, undefined, client);
    try {
      await m.bash("true");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).not.toBeInstanceOf(InfraUnavailableError);
    }
  });

  test("a VM past its lifetime wall mid-exec is the platform — typed defer, machine torn down", async () => {
    const logs: string[] = [];
    const { client, calls } = stubClient();
    const m = new InstavmLapMachine(instavmCfg(), 11, (s) => logs.push(s), 3, undefined, client);
    await m.bash("true"); // boots vm-1
    // next exec: the platform reports the VM gone
    (client as any).request = async (method: string, path: string) => {
      if (path === "/execute_async") {
        const e: any = new Error("vm terminated: lifetime expired"); e.status = 410; throw e;
      }
      if (path === "/v1/vms" && method === "GET") return [];
      return {};
    };
    await expect(m.bash("true")).rejects.toThrow(InfraUnavailableError);
    expect(calls.deleted).toEqual(["vm-1"]);
  });

  test("destroy deletes by id and resolves orphans by metadata name", async () => {
    const logs: string[] = [];
    const { client, calls } = stubClient({ listAfterDelete: true });
    const m = new InstavmLapMachine(instavmCfg(), 11, (s) => logs.push(s), 3, undefined, client);
    await m.destroy(); // no live handle — falls back to the list
    expect(calls.deleted).toEqual(["vm-1"]);
    expect(logs.join("\n")).toContain("instavm VM pdf-factory-smoke-9-i11-g3 deleted");
  });

  test("bootstrap resolves the instavm repo_dir (/app/repo)", async () => {
    const cfg = instavmCfg();
    const { bootstrapScriptFor } = await import("../src/machine");
    const script = bootstrapScriptFor(cfg, "factory/issue-11");
    expect(script).toContain("/app/repo");
  });
});

describe("stage protocol over script-embedded env", () => {
  const canned = `BOOTSTRAP_OK\nPDFRC=0\n${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "PI_OK" }] } })}\n`;
  const stageEnv = (command: string) => {
    const m = command.match(/export PDF_L_ENV='PDFENV ([A-Za-z0-9+/=]+)'/)!;
    return Buffer.from(m[1], "base64").toString("utf8");
  };
  const run = async (stage: "plan" | "implement" | "review") => {
    const { client, calls } = stubClient({ stdout: canned });
    const m = new InstavmLapMachine(instavmCfg(), 11, () => {}, 3, undefined, client);
    const r = await m.callStage(stage, { models: { base: { provider: "p", model: "p/m" }, fallback: [] }, prompt: "x", systemPrompt: "sys", timeoutMs: 9000 });
    expect(r.outcome.kind).toBe("ok");
    return calls.exec as any[];
  };

  test("plan bootstraps the clone (the lap's first stage), runs without gates, and is reset after", async () => {
    const execs = await run("plan");
    expect(execs.length).toBe(2); // bootstrap, then the stage
    expect(execs[0].command).not.toContain("PDF_L_ENV");
    const env = stageEnv(execs[1].command);
    expect(env).toContain("export PDF_GATES=0\n");
    expect(env).toContain("export PDF_RESTORE=1\n");
  });

  test("implement bootstraps and gates, and keeps its work", async () => {
    const execs = await run("implement");
    expect(execs.length).toBe(2);
    const env = stageEnv(execs[1].command);
    expect(env).toContain("export PDF_GATES=1\n");
    expect(env).toContain("export PDF_RESTORE=0\n");
  });

  test("review reuses the clone as it stands and is reset after", async () => {
    const execs = await run("review");
    expect(execs.length).toBe(1);
    const env = stageEnv(execs[0].command);
    expect(env).toContain("export PDF_GATES=0\n");
    expect(env).toContain("export PDF_RESTORE=1\n");
  });

  test("callInstavmStage advances the model chain on provider errors", async () => {
    const fail = `PDFRC=1\n${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "bad" }] } })}\n`;
    const { client, calls } = stubClient({ stdout: fail });
    const r = await callInstavmStage(client, "s-1", {
      models: { base: { provider: "p", model: "p/a" }, fallback: [{ provider: "p", model: "p/b" }] },
      gates: false, branch: "factory/issue-11", base: "main",
      envFile: "export PDF_GATES=0",
      prompt: "x", systemPrompt: "sys", timeoutMs: 9000,
    });
    expect(r.outcome.kind).toBe("provider_error");
    expect(r.modelsTried.map((t) => t.spec.model)).toEqual(["p/a", "p/b"]);
    expect(calls.exec.length).toBe(2);
  });
});

describe("instavmClientFromEnv + dispatch", () => {
  test("refuses to build without a key", () => {
    const had = process.env.INSTAVM_API_KEY;
    delete process.env.INSTAVM_API_KEY;
    try {
      expect(() => instavmClientFromEnv(instavmCfg())).toThrow(/INSTAVM_API_KEY is not set/);
    } finally {
      if (had) process.env.INSTAVM_API_KEY = had;
    }
  });

  test("openInstavmLapMachine names VMs with the fleet convention", () => {
    const m = openInstavmLapMachine(instavmCfg(), 11, undefined, 3, undefined, stubClient().client);
    expect(m.name).toBe("pdf-factory-smoke-9-i11-g3");
  });
});
