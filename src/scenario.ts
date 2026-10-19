import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sh } from "./sh";

export interface Probe {
  id: string;
  description: string;
  command: string;
  expect: string;
  timeout_ms?: number;
}

export interface ScenarioSpec {
  name: string;
  port: number;
  setup?: string;
  /** foreground server command — the harness backgrounds it and kills it on teardown */
  start: string;
  readiness_path?: string;
  teardown?: string;
  probes: Probe[];
}

export interface ProbeResult {
  id: string;
  description: string;
  pass: boolean;
  detail: string;
}

export interface ScenarioResult {
  name: string;
  pass: boolean;
  results: ProbeResult[];
  error?: string;
}

/**
 * Anything listening on the port — another lap's server, or a stray process
 * unrelated to the factory — makes the scenario unsafe to run. A connect
 * probe (bash /dev/tcp) catches both; a bind test alone would too, but
 * this needs no privileges and no extra tools.
 */
export async function portBusy(port: number): Promise<boolean> {
  const res = await sh(["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`], { timeoutMs: 3000 });
  return res.code === 0;
}

function walkJson(obj: any, path: string): any {
  let cur = obj;
  for (const seg of path.split(".").filter(Boolean)) {
    const m = seg.match(/^(\w+)(?:\[(\d+)\])?$/);
    if (!m) throw new Error(`bad json path segment "${seg}"`);
    if (m[1]) cur = cur?.[m[1]];
    if (m[2] !== undefined) cur = cur?.[Number(m[2])];
  }
  return cur;
}

function lenientValue(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Expect tokens, space-separated, e.g.:
 *   "status:200 json:status=ok body_contains:welcome exit:0 max_ms:3000"
 * exit:0 is implicit unless another exit: token is present.
 * max_ms is documentation for the runner (the caller parses it for the
 * probe timeout); it evaluates to pass here.
 */
export function evalExpects(stdout: string, exitCode: number, expect: string): { pass: boolean; failed?: string } {
  const tokens = expect.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) tokens.push("exit:0");
  const hasExit = tokens.some((t) => t.startsWith("exit:"));
  if (!hasExit) tokens.push("exit:0");
  for (const token of tokens) {
    const kind = token.slice(0, token.indexOf(":"));
    const val = token.slice(token.indexOf(":") + 1);
    let ok: boolean;
    let why = token;
    switch (kind) {
      case "status": {
        const last = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
        ok = last === val;
        why = `status: got "${last.slice(0, 40)}", want "${val}"`;
        break;
      }
      case "json": {
        const eq = val.indexOf("=");
        if (eq < 0) return { pass: false, failed: `bad json token "${token}" (want json:path=value)` };
        let parsed: any;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return { pass: false, failed: `json: stdout is not valid JSON` };
        }
        let got: any;
        try {
          got = walkJson(parsed, val.slice(0, eq));
        } catch (e: any) {
          return { pass: false, failed: `json: ${e.message}` };
        }
        ok = JSON.stringify(got) === JSON.stringify(lenientValue(val.slice(eq + 1)));
        why = `json:${val.slice(0, eq)}: got ${JSON.stringify(got)?.slice(0, 60)}`;
        break;
      }
      case "body_contains":
        ok = stdout.includes(val);
        why = `body_contains: not found`;
        break;
      case "body_matches":
        try {
          ok = new RegExp(val).test(stdout);
        } catch {
          return { pass: false, failed: `body_matches: invalid regex /${val}/` };
        }
        why = `body_matches: no match`;
        break;
      case "exit":
        ok = exitCode === Number(val);
        why = `exit: got ${exitCode}, want ${val}`;
        break;
      case "max_ms":
        ok = true; // enforced by the runner's timeout
        break;
      default:
        return { pass: false, failed: `unknown expect token "${token}"` };
    }
    if (!ok) return { pass: false, failed: `${token} → ${why}` };
  }
  return { pass: true };
}

export function parseMaxMs(expect: string): number | null {
  const m = expect.trim().split(/\s+/).find((t) => t.startsWith("max_ms:"));
  return m ? Number(m.slice("max_ms:".length)) : null;
}

export function loadScenario(path: string): ScenarioSpec {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const spec: ScenarioSpec = {
    name: raw.name ?? "scenario",
    port: raw.port,
    setup: raw.setup || undefined,
    start: raw.start,
    readiness_path: raw.readiness_path ?? "/",
    teardown: raw.teardown || undefined,
    probes: Array.isArray(raw.probes) ? raw.probes : [],
  };
  if (!Number.isInteger(spec.port) || spec.port <= 0) throw new Error(`${path}: "port" must be a positive integer`);
  if (!spec.start || typeof spec.start !== "string") throw new Error(`${path}: "start" must be a non-empty string`);
  if (spec.probes.length === 0) throw new Error(`${path}: "probes" must be a non-empty array`);
  const ids = new Set<string>();
  for (const p of spec.probes) {
    if (!p.id || ids.has(p.id)) throw new Error(`${path}: probes need unique non-empty "id"s`);
    if (!p.command) throw new Error(`${path}: probe "${p.id}" needs a non-empty "command"`);
    if (!p.expect) throw new Error(`${path}: probe "${p.id}" needs an "expect"`);
  }
  return spec;
}

async function ready(port: number, path: string, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const res = await sh(
      [
        "bash", "-c",
        `curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:${port}${path}`,
      ],
      { timeoutMs: 4000 }
    );
    // a real HTTP answer means listening; curl's "000" means no answer at all
    if (/^[1-5]\d{2}$/.test(res.stdout.trim())) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Black-box verification harness. The scenario file lives OUTSIDE the
 * project repo by contract, so the implementing agent can never tune code
 * against its own acceptance. `start` runs in the foreground of a child
 * process; the harness owns its life and kills its process group no matter
 * what — `ownership: external` in the old factory's terms.
 */
export async function runScenario(
  spec: ScenarioSpec,
  scratchDir: string,
  opts: { readinessSeconds: number; defaultProbeMs: number }
): Promise<ScenarioResult> {
  const mkResults = (pass: boolean, error: string): ScenarioResult => ({
    name: spec.name,
    pass,
    results: spec.probes.map((p) => ({ id: p.id, description: p.description, pass: false, detail: "not run" })),
    error,
  });

  if (await portBusy(spec.port)) {
    return mkResults(false, `port ${spec.port} is busy (another server is listening)`);
  }

  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(scratchDir, { recursive: true });
  const env = { ...process.env, PORT: String(spec.port) };

  if (spec.setup) {
    const res = await sh(["bash", "-c", spec.setup], { cwd: scratchDir, env, timeoutMs: 300000, killGroup: true });
    if (res.code !== 0) {
      return mkResults(false, `setup failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`);
    }
  }

  // foreground server under its own session — group kill on teardown
  const full = process.platform === "linux" ? ["setsid", "bash", "-c", spec.start] : ["bash", "-c", spec.start];
  const server = Bun.spawn(full, {
    cwd: scratchDir,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const logSink = Bun.file(join(scratchDir, "server.log")).writer();
  const pump = (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of server.stdout) logSink.write(dec.decode(chunk, { stream: true }));
      for await (const chunk of server.stderr) logSink.write(dec.decode(chunk, { stream: true }));
    } catch {}
  })();

  try {
    if (!(await ready(spec.port, spec.readiness_path ?? "/", opts.readinessSeconds))) {
      return mkResults(false, `server never became ready within ${opts.readinessSeconds}s (see server.log)`);
    }
    const results: ProbeResult[] = [];
    let pass = true;
    for (const probe of spec.probes) {
      const timeoutMs = probe.timeout_ms ?? parseMaxMs(probe.expect) ?? opts.defaultProbeMs;
      const res = await sh(["bash", "-c", probe.command], {
        cwd: scratchDir,
        env,
        timeoutMs,
        killGroup: true,
      });
      const verdict = res.timedOut
        ? { pass: false, failed: `timed out after ${timeoutMs}ms` }
        : evalExpects(res.stdout, res.code, probe.expect);
      if (!verdict.pass) pass = false;
      results.push({
        id: probe.id,
        description: probe.description,
        pass: verdict.pass,
        detail: verdict.failed ?? "ok",
      });
    }
    return { name: spec.name, pass, results };
  } finally {
    // authoritative teardown: kill the server group first, then run the
    // scenario's own teardown (best-effort) — cancellation never skips the kill
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      try {
        server.kill();
      } catch {}
    }
    await Promise.race([server.exited, new Promise((r) => setTimeout(r, 5000))]).catch(() => {});
    await pump.catch(() => {});
    try { logSink.end(); } catch {} // FileSink.end() is sync in Bun
    if (spec.teardown) {
      await sh(["bash", "-c", spec.teardown], { cwd: scratchDir, env, timeoutMs: 60000, killGroup: true });
    }
  }
}
