/**
 * InstaBox REST client (https://instabox.sh — Firecracker microVMs for coding
 * agents). Zero dependencies: plain fetch against /v1 on api.instabox.sh,
 * X-API-Key auth, Idempotency-Key on the writes that need it.
 *
 * Only the surface the factory needs: machine ensure/start/resume/delete,
 * ssh-tokens (the transport for every stage), snapshots (golden per-repo
 * environments), listing (the cleanup janitor) and usage reporting.
 */
export interface InstaMachine {
  id: string;
  name: string;
  state: string; // creating | booting | running | pausing | paused | stopping | stopped | deleting
  desiredState?: string;
  operationId?: string | null;
  metadata?: Record<string, string>;
  guestUser?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface InstaOperation {
  id: string;
  machineId: string;
  type: string;
  state: string; // pending | running? | succeeded | failed (+ progress like "booting")
  error?: string | null;
  machine?: InstaMachine;
}

export interface InstaSshToken {
  id: string;
  host: string;
  port: number;
  token: string;
  command?: string;
  expiresAt?: string;
}

export interface InstaSnapshot {
  id: string;
  name: string;
  status: string; // saving | ready | failed
  sourceMachineId?: string;
  rootSizeBytes?: number;
  dataSizeBytes?: number;
}

export interface InstaUsage {
  machines: number;
  snapshots: number;
  storedBytes: number;
  limits?: { maxMachines?: number; maxSnapshots?: number; maxStoredGiB?: number };
}

export class InstaBoxError extends Error {
  constructor(
    public status: number,
    public path: string,
    public body: string
  ) {
    super(`instabox ${status} on ${path}: ${(body || "(no body)").slice(0, 300)}`);
  }
}

export function machineNameFor(slug: string, issue: number): string {
  return `pdf-${sanitizeMachinePart(slug)}-i${issue}`;
}

/** Machine/snapshot-safe name part: [a-z0-9-], reasonably short. */
export function sanitizeMachinePart(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "repo";
}

export interface CreateMachineInput {
  name: string;
  template?: string;
  snapshotId?: string;
  metadata?: Record<string, string>;
}

export interface InstaBoxOptions {
  /** poll cadence + deadlines for waits */
  pollMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_POLL_MS = 2000;

export class InstaBox {
  private fetchFn: typeof fetch;

  constructor(
    public base: string,
    public apiKey: string,
    private opts: InstaBoxOptions = {}
  ) {
    this.base = base.replace(/\/+$/, "");
    this.fetchFn = opts.fetchImpl ?? fetch;
  }

  static fromEnv(cfg: { api_base: string; api_key_env: string }): InstaBox {
    const key = process.env[cfg.api_key_env];
    if (!key) {
      throw new Error(`instabox mode needs the API key in $${cfg.api_key_env} (set it in the service unit or your shell)`);
    }
    return new InstaBox(cfg.api_base, key);
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { idempotent?: boolean; tolerate404?: boolean } = {}
  ): Promise<T> {
    const headers: Record<string, string> = { "X-API-Key": this.apiKey };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotent) headers["Idempotency-Key"] = crypto.randomUUID();
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => "");
    if (res.status === 404 && opts.tolerate404) return null as T;
    if (!res.ok) throw new InstaBoxError(res.status, path, text);
    return (text ? JSON.parse(text) : null) as T;
  }

  async machineByName(name: string): Promise<InstaMachine | null> {
    return this.call<InstaMachine | null>("GET", `/v1/machines/${encodeURIComponent(name)}`, undefined, {
      tolerate404: true,
    });
  }

  async createMachine(input: CreateMachineInput): Promise<InstaOperation> {
    // 202 Accepted → an operation; waitOperation tracks it to done
    return this.call<InstaOperation>("POST", "/v1/machines", input, { idempotent: true });
  }

  private async lifecycle(id: string, action: "start" | "resume"): Promise<void> {
    const op = await this.call<InstaOperation>(`POST`, `/v1/machines/${encodeURIComponent(id)}/${action}`);
    await this.waitOperation(op.id);
  }

  async resume(id: string): Promise<void> {
    await this.lifecycle(id, "resume");
  }

  async start(id: string): Promise<void> {
    await this.lifecycle(id, "start");
  }

  async deleteMachine(id: string): Promise<void> {
    try {
      const op = await this.call<InstaOperation>("DELETE", `/v1/machines/${encodeURIComponent(id)}`);
      if (op?.id) await this.waitOperation(op.id);
    } catch (e: any) {
      if (!(e instanceof InstaBoxError && (e.status === 404 || e.status === 409))) throw e;
      // already gone, or mid-operation — nothing a janitor can do about it now
    }
  }

  async saveSnapshot(machineId: string, name: string, opts: { description?: string; rootOnly?: boolean } = {}): Promise<InstaSnapshot> {
    const snap = await this.call<InstaSnapshot>("POST", `/v1/machines/${encodeURIComponent(machineId)}/snapshots`, {
      name,
      description: opts.description,
      rootOnly: opts.rootOnly,
    });
    return this.waitSnapshot(snap.id);
  }

  async deleteSnapshot(id: string): Promise<void> {
    await this.call<void>("DELETE", `/v1/snapshots/${encodeURIComponent(id)}`).catch((e) => {
      if (!(e instanceof InstaBoxError && e.status === 404)) throw e;
    });
  }

  async listSnapshots(): Promise<InstaSnapshot[]> {
    const res = await this.call<{ snapshots: InstaSnapshot[] }>("GET", "/v1/snapshots");
    return res?.snapshots ?? [];
  }

  async listMachines(): Promise<InstaMachine[]> {
    const out: InstaMachine[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const res: { machines: InstaMachine[]; nextCursor: string | null } | null = await this.call<{
        machines: InstaMachine[];
        nextCursor: string | null;
      }>("GET", `/v1/machines${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      out.push(...(res?.machines ?? []));
      cursor = res?.nextCursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  async createSshToken(machineId: string, opts: { name?: string; ttlSeconds?: number } = {}): Promise<InstaSshToken> {
    return this.call<InstaSshToken>(
      "POST",
      `/v1/machines/${encodeURIComponent(machineId)}/ssh-tokens`,
      { name: opts.name ?? "factory", ttlSeconds: opts.ttlSeconds ?? 7200 }
    );
  }

  async usage(): Promise<InstaUsage> {
    return this.call<InstaUsage>("GET", "/v1/usage");
  }

  private deadline(ms: number): number {
    return Date.now() + ms;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  /** Poll an operation until succeeded; throws with its error on failed. */
  async waitOperation(opId: string, timeoutMs = 10 * 60_000): Promise<InstaOperation> {
    const until = this.deadline(timeoutMs);
    for (;;) {
      const op = await this.call<InstaOperation>("GET", `/v1/operations/${encodeURIComponent(opId)}`);
      const s = (op.state ?? "").toLowerCase();
      if (s === "succeeded" || s === "finished" || s === "completed") return op;
      if (s === "failed" || s === "errored") {
        throw new InstaBoxError(500, `/v1/operations/${opId}`, `operation ${op.type} failed: ${op.error ?? "unknown"}`);
      }
      if (Date.now() >= until) throw new Error(`instabox operation ${op.type ?? opId} timed out after ${Math.round(timeoutMs / 1000)}s`);
      await this.sleep(this.opts.pollMs ?? DEFAULT_POLL_MS);
    }
  }

  private async waitSnapshot(id: string, timeoutMs = 30 * 60_000): Promise<InstaSnapshot> {
    const until = this.deadline(timeoutMs);
    for (;;) {
      const snap = await this.call<InstaSnapshot>("GET", `/v1/snapshots/${encodeURIComponent(id)}`);
      const s = (snap.status ?? "").toLowerCase();
      if (s === "ready") return snap;
      if (s === "failed" || s === "errored") throw new Error(`instabox snapshot ${snap.name} failed`);
      if (Date.now() >= until) throw new Error(`instabox snapshot ${snap.name} not ready after ${Math.round(timeoutMs / 60000)}m`);
      await this.sleep(this.opts.pollMs ?? DEFAULT_POLL_MS);
    }
  }

  /**
   * Machine exists (ours), is running, and stayed ours: get-or-create, then
   * drive paused/stopped states to running. One operation at a time per
   * machine — every lifecycle step waits for its operation.
   */
  async ensureRunning(
    input: CreateMachineInput,
    opts: { timeoutMs?: number; adoptExisting?: boolean } = {}
  ): Promise<InstaMachine> {
    const until = this.deadline(opts.timeoutMs ?? 10 * 60_000);
    let m = await this.machineByName(input.name);
    if (!m) {
      const op = await this.createMachine(input);
      m = (await this.waitOperation(op.id, opts.timeoutMs ?? 10 * 60_000)).machine ?? (await this.machineByName(input.name));
      if (!m) throw new Error(`instabox machine ${input.name} vanished right after creation`);
    }
    for (;;) {
      const state = (m.state ?? "").toLowerCase();
      if (state === "running") return m;
      if (state === "paused") await this.resume(m.id);
      else if (state === "stopped") await this.start(m.id);
      // creating/booting/pausing/stopping/deleting: just wait for the machine
      if (Date.now() >= until) throw new Error(`instabox machine ${input.name} never reached running (state: ${m.state})`);
      await this.sleep(this.opts.pollMs ?? DEFAULT_POLL_MS);
      m = await this.machineByName(input.name);
      if (!m) throw new Error(`instabox machine ${input.name} disappeared while waiting for it to run`);
    }
  }
}
