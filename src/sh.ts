import { spawn as nodeSpawn } from "node:child_process";

export interface ShOpts {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  input?: string;
  /** spawn under setsid so a timeout can kill the whole process tree (Linux) */
  killGroup?: boolean;
}

export interface ShRes {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const OUT_CAP = 2_000_000;

export function killTree(pid: number) {
  try {
    process.kill(-pid, "SIGKILL"); // process group (setsid child)
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export async function sh(cmd: string[], opts: ShOpts = {}): Promise<ShRes> {
  // node:child_process, not Bun.spawn: the Bun transport sat wedged inside
  // long-lived factory processes (daemon laps, ticks) with no child and an
  // unresolved exit promise, while identical invocations from plain shells
  // worked. Same argv contract, same setsid/killTree semantics.
  const full =
    opts.killGroup && process.platform === "linux" ? ["setsid", ...cmd] : cmd;
  let child;
  try {
    child = nodeSpawn(full[0], full.slice(1), {
      cwd: opts.cwd,
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...opts.env }).filter(([, v]) => v !== undefined)
      ),
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    return { code: 127, stdout: "", stderr: `spawn failed: ${e.message}`, timedOut: false };
  }
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c: any) => { if (stdout.length < OUT_CAP) stdout += c.toString(); });
  child.stderr?.on("data", (c: any) => { if (stderr.length < OUT_CAP) stderr += c.toString(); });
  if (opts.input !== undefined) {
    child.stdin?.write(opts.input);
    try { child.stdin?.end(); } catch {}
  }
  let timedOut = false;
  let timer: any = null;
  let resolveExited: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
    child.on("exit", (c: any) => resolveExited(c ?? 137));
    child.on("error", () => { if (!timedOut) resolveExited(127); });
  });
  let code: number;
  if (opts.timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid!);
      resolveExited(137);
    }, opts.timeoutMs);
  }
  code = await exited;
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}

export function shOk(res: ShRes, what: string): string {
  if (res.code !== 0) {
    throw new Error(
      `${what} failed (exit ${res.code}${res.timedOut ? ", timed out" : ""}): ${res.stderr.trim().slice(0, 500) || res.stdout.trim().slice(0, 500)}`
    );
  }
  return res.stdout;
}
