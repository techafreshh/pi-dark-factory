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
  /** resolved number, or "first"/"second" — resolveScenarioPort pins it from
   *  the repo config's reserved pair, which is the single source of truth */
  port: number | "first" | "second";
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
  /** failed probes only — the reproduction facts the repair round needs:
   *  exactly what was sent and (capped) what came back, so the implementing
   *  agent doesn't guess at the failing input from a probe name */
  command?: string;
  body?: string;
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

/** Pin an abstract "first"/"second" port to the repo's reserved pair —
 *  keeping config.json the single place a project's scenario ports exist. */
export function resolveScenarioPort(spec: ScenarioSpec, reserved: number[]): number {
  if (typeof spec.port === "number") return spec.port;
  const idx = spec.port === "first" ? 0 : spec.port === "second" ? 1 : -1;
  const port = idx >= 0 ? reserved[idx] : undefined;
  if (!port) throw new Error(`scenario ${spec.name}: "${spec.port}" has no ${spec.port} port in config scenario.ports`);
  return port;
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
  if (!("first" === spec.port || "second" === spec.port) && (!Number.isInteger(spec.port) || spec.port <= 0))
    throw new Error(`${path}: "port" must be a positive integer or "first"/"second"`);
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
 * process; the harness owns its life and kills it no matter what (host mode:
 * process group; container mode: the wrapper's cleanup, e.g. docker rm -f).
 * Probes always run host-side, black-box, against published ports.
 */
export async function runScenario(
  spec: ScenarioSpec,
  scratchDir: string,
  opts: {
    readinessSeconds: number;
    defaultProbeMs: number;
    /** the lap's product worktree, exported to setup/start/teardown as $WORKTREE
     *  so a scenario can copy its build artifact into the empty scratch dir */
    worktree?: string;
    /** container mode: prefix for setup/start/teardown + authoritative cleanup */
    wrap?: { argvPrefix: string[]; cleanup: () => Promise<void> | void };
    /** docker name prefix for this repo's stage containers — swept before the
     *  scenario starts so a container leaked by a killed lap (which holds the
     *  published scenario port) cannot pre-fail every attempt */
    preClean?: string;
  }
): Promise<ScenarioResult> {
  const mkResults = (pass: boolean, error: string): ScenarioResult => ({
    name: spec.name,
    pass,
    results: spec.probes.map((p) => ({ id: p.id, description: p.description, pass: false, detail: "not run" })),
    error,
  });

  // a container-mode port check still makes sense: another lap or a stray
  // host process on the published port breaks deterministic verification
  if (opts.preClean) {
    // reclaim this repo's leaked stage containers before anything else
    await sh(["bash", "-c",
      `docker run --rm -v /home/factory/.pi:/fix alpine chown -R 1001:1001 /fix 2>/dev/null || true; ` +
      `docker ps -aq --filter name=${opts.preClean} | xargs -r docker rm -f`], { timeoutMs: 30000 });
  }
  if (await portBusy(spec.port)) {
    // the port pair belongs to this repo's reservation, so a listener here
    // is a stray from an earlier attempt (a crashed server can escape the
    // process-group kill) — reclaim it before failing the scenario
    await sh(["bash", "-c", `fuser -k -n tcp ${spec.port} 2>/dev/null || true`], { timeoutMs: 10000 });
    await new Promise((r) => setTimeout(r, 1500));
    if (await portBusy(spec.port)) {
      return mkResults(false, `port ${spec.port} is still busy (a non-factory process is listening on it)`);
    }
  }

  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(scratchDir, { recursive: true });
  const env = {
    ...process.env,
    PORT: String(spec.port),
    ...(opts.worktree ? { WORKTREE: opts.worktree } : {}),
  };
  const raw = (cmd: string) => (opts.wrap ? [...opts.wrap.argvPrefix, "bash", "-c", cmd] : ["bash", "-c", cmd]);

  if (spec.setup) {
    const res = await sh(raw(spec.setup), { cwd: scratchDir, env, timeoutMs: 600000, killGroup: !opts.wrap });
    if (res.code !== 0) {
      return mkResults(false, `setup failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`);
    }
  }

  // foreground server under its own session (host) or named container (wrap)
  const full = opts.wrap ? raw(spec.start) : ["setsid", "bash", "-c", spec.start];
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
      if (!verdict.pass) {
        pass = false;
        results.push({
          id: probe.id,
          description: probe.description,
          pass: false,
          detail: verdict.failed ?? "failed",
          command: probe.command.length > 240 ? probe.command.slice(0, 240) + " …" : probe.command,
          body: res.stdout.length > 800 ? res.stdout.slice(0, 800) + ` …(+${res.stdout.length} bytes total)` : res.stdout,
        });
      } else {
        results.push({ id: probe.id, description: probe.description, pass: true, detail: "ok" });
      }
    }
    return { name: spec.name, pass, results };
  } finally {
    // authoritative teardown: kill the server first (process group in host
    // mode, docker client + rm -f in container mode), then run the
    // scenario's own teardown (best-effort) — cancellation never skips it
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
    if (opts.wrap) {
      await Promise.resolve(opts.wrap.cleanup()).catch(() => {});
    }
    if (spec.teardown) {
      await sh(raw(spec.teardown), { cwd: scratchDir, env, timeoutMs: 60000, killGroup: !opts.wrap });
    }
  }
}
