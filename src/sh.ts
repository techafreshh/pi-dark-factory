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

async function drain(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return "";
  const dec = new TextDecoder();
  let out = "";
  try {
    for await (const chunk of stream) {
      if (out.length < OUT_CAP) out += dec.decode(chunk, { stream: true });
    }
    out += dec.decode();
  } catch {
    // stream killed mid-read — keep what we have
  }
  return out;
}

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
  const full =
    opts.killGroup && process.platform === "linux" ? ["setsid", ...cmd] : cmd;
  let proc: any;
  try {
    proc = Bun.spawn(full, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdin: opts.input !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e: any) {
    return { code: 127, stdout: "", stderr: `spawn failed: ${e.message}`, timedOut: false };
  }
  const stdoutP = drain(proc.stdout);
  const stderrP = drain(proc.stderr);
  if (opts.input !== undefined) {
    proc.stdin.write(opts.input);
    try { proc.stdin.end(); } catch {} // FileSink.end() is sync in Bun
  }
  let timedOut = false;
  let timer: any = null;
  const exited = proc.exited as Promise<number>;
  let code: number;
  if (opts.timeoutMs) {
    const timeoutP = new Promise<number>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(proc.pid);
        resolve(137);
      }, opts.timeoutMs);
    });
    code = await Promise.race([exited, timeoutP]);
  } else {
    code = await exited;
  }
  if (timer) clearTimeout(timer);
  const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
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
