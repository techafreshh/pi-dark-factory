/**
 * InstaBox REST client — machine lifecycle and command execution for
 * env.mode "instabox". Auth: INSTABOX_API_KEY (ibk_...) via X-API-Key.
 *
 * Two transports matter for the factory:
 *  - REST exec: `bash -lc cmd` in the machine, full output at exit, hard
 *    10-minute cap — used for box control (clone, gates, verify, suspend).
 *  - SSH bridge: `instabox ssh <machine> -- <cmd>` streams stdin/stdout and
 *    has no such cap — what pi stage runs ride (see env.ts).
 *
 * Machines are per-lap by convention: the lap's caller derives a stable
 * name (pdf-<slug>-i<issue>) and ensureMachine reuses whatever exists
 * under that metadata name — stages of one lap share one box.
 */

const DEFAULT_BASE = "https://api.instabox.sh";

export interface InstaboxClient {
  baseUrl: string;
  apiKey: string;
}

export class InstaboxError extends Error {
  constructor(message: string, readonly status: number, readonly body?: string) {
    super(message);
  }
}

export function client(apiKey: string, baseUrl = process.env.INSTABOX_API_URL ?? DEFAULT_BASE): InstaboxClient {
  if (!apiKey) throw new InstaboxError("INSTABOX_API_KEY is not set — provision instabox mode first", 0);
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

async function call<T = any>(
  ib: InstaboxClient,
  method: string,
  path: string,
  opts: { body?: unknown; idempotent?: boolean; timeoutMs?: number } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "X-API-Key": ib.apiKey,
    "content-type": "application/json",
  };
  if (opts.idempotent) headers["Idempotency-Key"] = crypto.randomUUID();
  const res = await fetch(ib.baseUrl + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new InstaboxError(`instabox ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`, res.status, text);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** Stable per-lap machine name — matches how env.ts derives it from the
 *  stage uniqueName (`pdf-<slug>-<issue>-<stage>-<runTag>` minus the last
 *  two segments) so every stage of one lap lands in the same box. */
export function machineName(slug: string, issue: number): string {
  return `pdf-${slug}-${issue}`;
}

/** Find our machine for this lap, if one exists (list by metadata name). */
export async function listByName(ib: InstaboxClient, name: string): Promise<{ id: string; state: string } | null> {
  const res = await call<{ machines?: { id: string; state?: string; metadata?: Record<string, string> }[] }>(
    ib, "GET", `/v1/machines?metadata=name:${encodeURIComponent(name)}`, { timeoutMs: 30_000 }
  );
  const hit = (res.machines ?? [])[0];
  return hit ? { id: hit.id, state: hit.state ?? "?" } : null;
}

/** Ensure a running machine for the lap: reuse, or create from snapshot/template. */
export async function ensureMachine(
  ib: InstaboxClient,
  name: string,
  opts: { snapshot?: string; template?: string },
  waitMs = 120_000
): Promise<{ id: string; created: boolean }> {
  const existing = await listByName(ib, name).catch(() => null);
  if (existing) {
    if (existing.state === "suspended" || existing.state === "stopped") {
      await call(ib, "POST", `/v1/machines/${existing.id}/resume`, { idempotent: true, timeoutMs: 60_000 });
    }
    return { id: existing.id, created: false };
  }
  const body: Record<string, unknown> = { metadata: { name } };
  if (opts.snapshot) body.snapshotId = opts.snapshot;
  else body.template = opts.template ?? "universal";
  const created = await call<{ id?: string; machineId?: string }>(
    ib, "POST", "/v1/machines",
    { body, idempotent: true, timeoutMs: 60_000 }
  );
  const id = created.id ?? created.machineId;
  if (!id) throw new InstaboxError("instabox create returned no machine id", 200);
  // wait for Running (states per docs; tolerate case)
  const deadline = Date.now() + waitMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3_000));
    const cur = await call<{ state?: string; id?: string; machineId?: string }>(
      ib, "GET", `/v1/machines/${id}`, { timeoutMs: 30_000 }
    ).catch(() => null);
    const state = (cur?.state ?? "").toLowerCase();
    if (state === "running") return { id, created: true };
    if (state === "failed" || state === "error") throw new InstaboxError(`machine ${name} failed to start`, 200);
    if (Date.now() >= deadline) throw new InstaboxError(`machine ${name} did not reach Running in ${Math.round(waitMs / 1000)}s`, 408);
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run `bash -lc cmd` in the machine; hard 10-minute upstream cap. */
export async function exec(
  ib: InstaboxClient,
  id: string,
  cmd: string,
  opts: { cwd?: string; envs?: Record<string, string>; timeoutSeconds?: number } = {}
): Promise<ExecResult> {
  const res = await call<ExecResult>(
    ib, "POST", `/v1/machines/${id}/exec`,
    {
      body: { cmd, cwd: opts.cwd, envs: opts.envs, timeoutSeconds: opts.timeoutSeconds ?? 540 },
      timeoutMs: (opts.timeoutSeconds ?? 540) * 1000 + 30_000,
    }
  );
  return {
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
    exitCode: typeof res.exitCode === "number" ? res.exitCode : 1,
  };
}

export async function suspend(ib: InstaboxClient, id: string): Promise<void> {
  await call(ib, "POST", `/v1/machines/${id}/suspend`, { idempotent: true, timeoutMs: 60_000 }).catch(() => {});
}

export async function del(ib: InstaboxClient, id: string): Promise<void> {
  await call(ib, "DELETE", `/v1/machines/${id}`, { idempotent: true, timeoutMs: 60_000 }).catch(() => {});
}
