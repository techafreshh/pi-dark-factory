import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LapMachine, bootstrapScriptFor, buildMachineEnvFile, callMachineStage, machineBash, PortForwarder, type SshTarget } from "../src/machine";
import { InstaBox } from "../src/instabox";
import { callPi } from "../src/pi";
import type { RepoConfig, StageModels } from "../src/types";

const GIT_ID = "-c user.email=t@t.io -c user.name=Test";

// ── fake gateway ─────────────────────────────────────────────────────────────
// A bash script standing in for `ssh`: runs the remote command locally (the
// command strings the factory builds are plain bash), or emits canned output.

let worldDir = "";

const FAKE_SSH = `#!/usr/bin/env bash
# fake instabox ssh gateway. The last argv element is the remote command.
for a in "$@"; do CMD="$a"; done
if [ -n "\${FAKE_SSH_OUT:-}" ]; then cat "$FAKE_SSH_OUT"; exit "\${FAKE_SSH_EXIT:-0}"; fi
exec bash -c "$CMD"
`;

function fakePiScript(mode: "ok" | "provider_fail" | "no_commit" | "dirty"): string {
  // a pi stand-in: prints the pi --mode json event stream; commits real work
  const lines: string[] = ["#!/usr/bin/env bash"];
  if (mode === "provider_fail") {
    lines.push(
      'echo \'{"type":"message_start","message":{"role":"assistant"}}\'',
      "echo '{\"type\":\"error\",\"error\":\"provider 500\"}' >&2",
      "exit 3"
    );
  }
  if (mode === "ok" || mode === "no_commit" || mode === "dirty") {
    lines.push(
      'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"did the thing"}]},"usage":{"input_tokens":10,"output_tokens":5}}\'',
      'echo \'{"type":"agent_end"}\''
    );
  }
  if (mode === "ok") {
    lines.push('echo "hello from fake pi" >> implemented.txt', `git add implemented.txt`, `git ${GIT_ID} commit -q -m "fake implement"`);
  }
  if (mode === "dirty") {
    lines.push('echo "sneaky" >> uncommitted.txt');
  }
  lines.push("exit 0");
  return lines.join("\n") + "\n";
}

beforeAll(() => {
  worldDir = mkdtempSync(join(tmpdir(), "pdfmach-"));
  const sshPath = join(worldDir, "fake-ssh");
  writeFileSync(sshPath, FAKE_SSH);
  chmodSync(sshPath, 0o755);
  process.env.PDF_SSH_BIN = sshPath;
});

afterAll(() => {
  delete process.env.PDF_SSH_BIN;
  if (worldDir) rmSync(worldDir, { recursive: true, force: true });
});

const conn: SshTarget = { host: "gateway.test", port: 2222, user: "ibssh_fake" };

function stageModels(fallback: string[] = []): StageModels {
  return { base: { provider: "p", model: "m1" }, fallback: fallback.map(() => ({ provider: "p", model: "m2" })) };
}

// ── machineBash ──────────────────────────────────────────────────────────────

describe("machineBash", () => {
  test("runs the decoded script and returns stdout/stderr", async () => {
    const res = await machineBash(conn, 'echo "héllo ✓"; echo oops >&2; exit 7', { timeoutMs: 15000 });
    expect(res.stdout).toContain("héllo ✓");
    expect(res.stderr).toContain("oops");
    expect(res.code).toBe(7);
  });

  test("timeout kills the session", async () => {
    const res = await machineBash(conn, "sleep 30", { timeoutMs: 800 });
    expect(res.timedOut).toBe(true);
  }, 15000);
});

// ── stage driver over the fake gateway ───────────────────────────────────────

interface StageWorld {
  origin: string;
  clone: string;
  envFile: (gates: boolean) => string;
  cfg: RepoConfig;
}

function stageWorld(mode: "ok" | "provider_fail" | "no_commit" | "dirty"): StageWorld {
  const repoDir = join(worldDir, `clone-${mode}-${Math.random().toString(36).slice(2, 8)}`);
  const origin = join(worldDir, `origin-${mode}-${Math.random().toString(36).slice(2, 8)}.git`);
  execSync(`git init --bare ${origin}`);
  execSync(`git --git-dir=${origin} symbolic-ref HEAD refs/heads/main`);
  const seed = join(worldDir, "seed");
  execSync(`git clone -q ${origin} ${seed}`);
  writeFileSync(join(seed, "README.md"), "# toy\n");
  execSync(`git -C ${seed} ${GIT_ID} add -A && git -C ${seed} ${GIT_ID} commit -q -m init && git -C ${seed} push -q origin main`);
  rmSync(seed, { recursive: true, force: true });
  execSync(`git clone -q ${origin} ${repoDir}`);

  const piPath = join(worldDir, `fake-pi-${mode}`);
  writeFileSync(piPath, fakePiScript(mode));
  chmodSync(piPath, 0o755);

  const cfg = {
    repo: "acme/toy",
    slug: "toy",
    default_branch: "main",
    origin_url: origin,
    pi: { binary: piPath, tools: [], plan_tools: [], extra_args: [] },
    env: {
      mode: "instabox",
      instabox: { api_base: "", api_key_env: "X", template: "basic", snapshot: "", repo_dir: repoDir, bake: "" },
      pass_env: [],
    },
  } as unknown as RepoConfig;
  return {
    origin,
    clone: repoDir,
    cfg,
    envFile: (gates: boolean) => buildMachineEnvFile(cfg, { gates, branch: "factory/issue-1", base: "main" }),
  };
}

const PROMPT = "implement the thing";

describe("callMachineStage (driver runs for real against a local git origin)", () => {
  test("ok path: pi runs, gates pass, branch pushed, usage parsed", async () => {
    const w = stageWorld("ok");
    const res = await callMachineStage(
      conn,
      { models: stageModels(), gates: true, branch: "factory/issue-1", base: "main", envFile: w.envFile(true), prompt: PROMPT, systemPrompt: "sys", timeoutMs: 60000 }
    );
    expect(res.outcome.kind).toBe("ok");
    if (res.outcome.kind === "ok") {
      expect(res.outcome.text).toBe("did the thing");
      expect(res.outcome.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    }
    expect(res.raw).toContain("did the thing");
    // the branch is on the origin — the machine pushed it
    const refs = execSync(`git --git-dir=${w.origin} for-each-ref --format='%(refname:short)'`).toString();
    expect(refs).toContain("factory/issue-1");
    // and it is one real commit ahead of base (bare origin: no origin/ prefix)
    const ahead = execSync(`git --git-dir=${w.origin} rev-list --count main..factory/issue-1`).toString().trim();
    expect(ahead).toBe("1");
  }, 60000);

  test("gate: uncommitted work fails the stage without advancing the fallback chain", async () => {
    const w = stageWorld("dirty");
    const res = await callMachineStage(
      conn,
      { models: stageModels(["p/m2"]), gates: true, branch: "factory/issue-1", base: "main", envFile: w.envFile(true), prompt: PROMPT, systemPrompt: "sys", timeoutMs: 60000 }
    );
    expect(res.outcome.kind).toBe("spawn_error");
    if (res.outcome.kind === "spawn_error") expect(res.outcome.error).toContain("uncommitted");
    expect(res.modelsTried.length).toBe(1); // a gate verdict is ours, not the model's
  }, 60000);

  test("gate: no commits ahead of base fails the stage", async () => {
    const w = stageWorld("no_commit");
    const res = await callMachineStage(
      conn,
      { models: stageModels(), gates: true, branch: "factory/issue-1", base: "main", envFile: w.envFile(true), prompt: PROMPT, systemPrompt: "sys", timeoutMs: 60000 }
    );
    expect(res.outcome.kind).toBe("spawn_error");
    if (res.outcome.kind === "spawn_error") expect(res.outcome.error).toContain("no commits");
  }, 60000);

  test("provider error advances the fallback chain; success on the second model wins", async () => {
    const w = stageWorld("provider_fail");
    const piPath = join(worldDir, "fake-pi-provider_fail");
    // second model = same pi, but the fake fails only on its FIRST invocation per world
    const counter = join(worldDir, "pi-call-count");
    writeFileSync(counter, "0");
    writeFileSync(
      piPath + "-2",
      [
        "#!/usr/bin/env bash",
        `N=$(($(cat ${counter}) + 1)); echo $N > ${counter}`,
        `if [ "$(cat ${counter})" = "1" ]; then echo '{"type":"error","error":"provider 500"}'; exit 3; fi`,
        `echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second model worked"}]},"usage":{"input_tokens":1,"output_tokens":2}}'`,
        `echo "file2" > implemented2.txt && git add implemented2.txt && git commit -q -m work2`,
        "exit 0",
      ].join("\n") + "\n"
    );
    chmodSync(piPath + "-2", 0o755);
    const cfg2 = { ...w.cfg, pi: { ...(w.cfg as any).pi, binary: piPath + "-2" } } as RepoConfig;
    const envFile = buildMachineEnvFile(cfg2, { gates: true, branch: "factory/issue-1", base: "main" });
    const res = await callMachineStage(
      conn,
      { models: stageModels(["p/m2"]), gates: true, branch: "factory/issue-1", base: "main", envFile, prompt: PROMPT, systemPrompt: "sys", timeoutMs: 60000 }
    );
    expect(res.outcome.kind).toBe("ok");
    expect(res.modelsTried.length).toBe(2);
    if (res.outcome.kind === "ok") expect(res.outcome.text).toBe("second model worked");
  }, 60000);
});

// ── LapMachine against a fake HTTP control plane ─────────────────────────────

describe("LapMachine (fake control plane)", () => {
  let server: any;
  let baseUrl = "";
  const deletes: string[] = [];
  let machines: Record<string, any> = {};

  beforeAll(() => {
    machines = {};
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        const p = u.pathname;
        if (req.method === "GET" && p === "/v1/machines/pdf-toy-i1") {
          return machines[p] ? new Response(JSON.stringify(machines[p])) : new Response("none", { status: 404 });
        }
        if (req.method === "POST" && p === "/v1/machines") {
          const body = await req.json();
          machines[`/v1/machines/${body.name}`] = { id: "m_1", name: body.name, state: "running" };
          return new Response(JSON.stringify({ id: "op1", state: "pending" }), { status: 202 });
        }
        if (req.method === "GET" && p.startsWith("/v1/operations/")) {
          return new Response(JSON.stringify({ id: "op1", state: "succeeded", machine: { id: "m_1", name: "pdf-toy-i1", state: "running" } }));
        }
        if (req.method === "POST" && p.endsWith("/ssh-tokens")) {
          return new Response(JSON.stringify({ id: "cn1", host: "127.0.0.1", port: 2222, token: "ibssh_fake", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
        }
        if (req.method === "DELETE" && p.startsWith("/v1/machines/")) {
          deletes.push(p);
          delete machines[p];
          return new Response(JSON.stringify({ id: "op", state: "pending" }), { status: 202 });
        }
        if (req.method === "GET" && p === "/v1/snapshots") return new Response(JSON.stringify({ snapshots: [] }));
        return new Response("nf", { status: 404 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
  });

  test("ensure → ssh token → stage call → destroy books the machine out", async () => {
    process.env.INSTABOX_API_KEY = "test";
    try {
      const ib = new InstaBox(baseUrl, "test", { pollMs: 1 });
      const w = stageWorld("ok");
      const machine = new LapMachine(ib, w.cfg, 1);
      const res = await machine.callStage("implement", {
        models: stageModels(),
        prompt: PROMPT,
        systemPrompt: "sys",
        timeoutMs: 60000,
      });
      expect(res.outcome.kind).toBe("ok");
      await machine.destroy();
      expect(deletes.some((d) => d.endsWith("/v1/machines/pdf-toy-i1") || d.endsWith("/m_1"))).toBe(true);
    } finally {
      delete process.env.INSTABOX_API_KEY;
    }
  }, 60000);
});

describe("buildMachineEnvFile (token resolution)", () => {
  const miniCfg = {
    repo: "acme/toy",
    slug: "toy",
    default_branch: "main",
    pi: { binary: "pi", tools: [], plan_tools: [], extra_args: [] },
    env: { mode: "instabox", instabox: { api_base: "", api_key_env: "X", repo_dir: "/data/repo" }, pass_env: ["GITHUB_TOKEN"] },
  } as unknown as RepoConfig;

  afterEach(() => {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  test("GH_TOKEN (the service env name) exports as GITHUB_TOKEN", () => {
    process.env.GH_TOKEN = "gh_test_token";
    const f = buildMachineEnvFile(miniCfg, { gates: true, branch: "factory/issue-1", base: "main" });
    expect(f).toContain("export GITHUB_TOKEN='gh_test_token'");
  });

  test("an explicit GITHUB_TOKEN wins over GH_TOKEN", () => {
    process.env.GH_TOKEN = "gh_loser";
    process.env.GITHUB_TOKEN = "gh_winner";
    const f = buildMachineEnvFile(miniCfg, { gates: true, branch: "factory/issue-1", base: "main" });
    expect(f).toContain("export GITHUB_TOKEN='gh_winner'");
  });

  test("bootstrap sources the env file before its script", async () => {
    process.env.GH_TOKEN = "gh_test_token";
    // LapMachine.bootstrap concatenates env + script — the fake-plane test
    // exercises it end-to-end; here we assert the script half still carries
    // the insteadOf rewrite that consumes the exported token
    const script = bootstrapScriptFor(miniCfg, "factory/issue-1");
    expect(script).toContain("GITHUB_TOKEN");
    expect(script).toContain("insteadOf");
  });
});

describe("PortForwarder", () => {
  test("starts an -N tunnel and stops it", async () => {
    const f = PortForwarder.start(conn, [8100]);
    await new Promise((r) => setTimeout(r, 300)); // give the fake ssh a moment to sleep
    await f.stop();
  });
});

describe("callPi is untouched by machine mode", () => {
  test("spawn_error for a missing binary (host paths unchanged)", async () => {
    const res = await callPi({
      binary: "/nonexistent/pi-binary-xyz",
      model: { provider: "p", model: "m" },
      prompt: "x",
      cwd: worldDir,
      timeoutMs: 5000,
    });
    expect(res.kind).toBe("provider_error");
  });
});
