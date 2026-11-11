/**
 * Machine-slot allocator (docs/parallel-mode.md). Every machine-mode lap —
 * serial or parallel — leases a slot from a fleet-wide, priority-ordered
 * queue BEFORE it claims an issue, so a lap waiting for a box holds no
 * in_progress row and the platforms' own caps are never raced first-come.
 *
 * State lives in factory.db (slot_requests), not in daemon memory: the grant
 * decision is one BEGIN IMMEDIATE transaction that orders every waiting
 * request and grants what fits. factoryd runs it every 15 s; every waiting
 * requester runs it on each poll. A daemon restart (KillMode=process keeps
 * lap processes alive) or a manual `foreman tick` therefore never stalls a
 * waiting lap, and no poll can grant out of order — each pass decides over
 * all rows.
 *
 * Order: first lanes before extra lanes (one wide repo must not starve the
 * fleet), then effective priority (base + one level per PDF_AGING_MINUTES
 * waited, capped at high), then oldest request. Each request takes the first
 * pool in its preference list with a free slot (spill-over lists both). A
 * granted lease is never pre-empted.
 */
import type { Ledger } from "./ledger";
import { pidAlive } from "./lock";
import type { RepoConfig, SchedulingPriority } from "./types";

export type Pool = "instabox" | "boxd";
export const POOLS: Pool[] = ["instabox", "boxd"];
export type SlotState = "waiting" | "parked" | "granted" | "released" | "lost";

export const PRIORITY_LEVEL: Record<SchedulingPriority, number> = { low: 0, normal: 1, high: 2 };
export const LEVEL_NAME = ["low", "normal", "high"] as const;

/** an unadopted parked request is the trace of a repo that went idle */
const PARKED_TTL_MS = 60 * 60_000;

export interface SlotRequestRow {
  id: number;
  repo: string;
  slug: string;
  lane: number;
  pools: string; // JSON Pool[]
  priority: SchedulingPriority;
  extra_lane: number;
  pid: number | null;
  state: SlotState;
  requested_at: string;
  granted_at: string | null;
  pool: Pool | null;
  issue_number: number | null;
  lap_id: number | null;
  released_at: string | null;
  parked_at: string | null;
  detail: string | null;
}

export interface SlotRequest {
  repo: string;
  slug: string;
  lane: number;
  pools: Pool[];
  priority: SchedulingPriority;
  extraLane: boolean;
}

export interface SlotLease {
  id: number;
  pool: Pool;
  /** granted on a platform other than the first preference */
  spilled: boolean;
  waitedMs: number;
}

/** pool caps: InstaBox entry tier = 5; boxd's account limit is 100, so its
 *  pool is a cost cap the owner picks (10). Read per call: tests and a
 *  daemon env change both take effect without a restart of the caller. */
export function poolCaps(): Record<Pool, number> {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
  };
  return { instabox: num(process.env.PDF_POOL_INSTABOX, 5), boxd: num(process.env.PDF_POOL_BOXD, 10) };
}

const agingMinutes = () => {
  const n = Number(process.env.PDF_AGING_MINUTES ?? 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
};

/** base level + one level per `agingMin` minutes waited, capped at high (2).
 *  bin/dashboard.ts keeps a copy (it imports nothing from src/); a test pins
 *  both to the same answers. */
export function effectivePriority(base: SchedulingPriority, requestedAtIso: string, nowMs: number, agingMin = agingMinutes()): number {
  const waitedMin = Math.max(0, (nowMs - Date.parse(requestedAtIso)) / 60_000);
  return Math.min(2, (PRIORITY_LEVEL[base] ?? 1) + Math.floor(waitedMin / agingMin));
}

/** the platforms a lap of this repo may run on, in preference order */
export function lanePools(cfg: RepoConfig): Pool[] {
  if (cfg.env.mode !== "instabox" && cfg.env.mode !== "boxd") return [];
  const own: Pool = cfg.env.mode;
  return cfg.scheduling?.spill_over ? [own, own === "instabox" ? "boxd" : "instabox"] : [own];
}

/** a per-lap copy of the config on the granted platform: repoDirFor,
 *  openMachine, the runtime context and verify all branch on env.mode */
export function configForPool(cfg: RepoConfig, pool: Pool): RepoConfig {
  return pool === cfg.env.mode ? cfg : { ...cfg, env: { ...cfg.env, mode: pool } };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** waiting requests (live holder) in grant order */
export function grantOrder(rows: SlotRequestRow[], nowMs: number): SlotRequestRow[] {
  return rows
    .filter((r) => r.state === "waiting" && r.pid !== null)
    .map((r) => ({ r, eff: effectivePriority(r.priority, r.requested_at, nowMs) }))
    .sort(
      (a, b) =>
        a.r.extra_lane - b.r.extra_lane ||
        b.eff - a.eff ||
        a.r.requested_at.localeCompare(b.r.requested_at) ||
        a.r.id - b.r.id
    )
    .map((x) => x.r);
}

const getRow = (ledger: Ledger, id: number) =>
  (ledger.db.query("SELECT * FROM slot_requests WHERE id = ?").get(id) as SlotRequestRow | null) ?? null;

/** Register (or adopt) this lane's request. A repo's next tick adopts the
 *  newest parked row of the same lane, keeping its requested_at, so a wait
 *  that outlives one tick process still ages. Returns the row id. */
export function requestSlot(ledger: Ledger, req: SlotRequest, nowMs = Date.now()): number {
  return ledger.db.transaction(() => {
    const parked = ledger.db
      .query("SELECT id FROM slot_requests WHERE repo = ? AND lane = ? AND state = 'parked' AND parked_at >= ? ORDER BY id DESC LIMIT 1")
      .get(req.repo, req.lane, iso(nowMs - PARKED_TTL_MS)) as { id: number } | null;
    if (parked) {
      ledger.db
        .query("UPDATE slot_requests SET state = 'waiting', pid = ?, pools = ?, priority = ?, extra_lane = ?, parked_at = NULL, detail = 'adopted' WHERE id = ?")
        .run(process.pid, JSON.stringify(req.pools), req.priority, req.extraLane ? 1 : 0, parked.id);
      return parked.id;
    }
    const r = ledger.db
      .query(
        "INSERT INTO slot_requests (repo, slug, lane, pools, priority, extra_lane, pid, state, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?)"
      )
      .run(req.repo, req.slug, req.lane, JSON.stringify(req.pools), req.priority, req.extraLane ? 1 : 0, process.pid, iso(nowMs));
    return Number(r.lastInsertRowid);
  }).immediate();
}

/**
 * One allocation decision over every row, in a single immediate transaction:
 * sweep dead holders (lost) and abandoned parked rows, then walk the waiting
 * requests in grant order and grant each the first preferred pool with room.
 * `alive` is a test seam (default: pid alive AND a factory process).
 */
export function grantPass(
  ledger: Ledger,
  nowMs = Date.now(),
  opts: { alive?: (pid: number) => boolean; caps?: Record<Pool, number> } = {}
): SlotRequestRow[] {
  const alive = opts.alive ?? pidAlive;
  const caps = opts.caps ?? poolCaps();
  return ledger.db.transaction(() => {
    const open = ledger.db
      .query("SELECT * FROM slot_requests WHERE state IN ('waiting', 'granted', 'parked')")
      .all() as SlotRequestRow[];
    const lost = ledger.db.query("UPDATE slot_requests SET state = 'lost', released_at = ?, detail = ? WHERE id = ?");
    for (const r of open) {
      if ((r.state === "waiting" || r.state === "granted") && (r.pid === null || !alive(r.pid))) {
        lost.run(iso(nowMs), r.state === "granted" ? "holder process died (machine left to the janitor)" : "requester process died", r.id);
        r.state = "lost";
      } else if (r.state === "parked" && (!r.parked_at || Date.parse(r.parked_at) < nowMs - PARKED_TTL_MS)) {
        ledger.db.query("UPDATE slot_requests SET state = 'released', released_at = ?, detail = 'abandoned (parked, never adopted)' WHERE id = ?").run(iso(nowMs), r.id);
        r.state = "released";
      }
    }
    const used: Record<Pool, number> = { instabox: 0, boxd: 0 };
    for (const r of open) if (r.state === "granted" && r.pool && r.pool in used) used[r.pool]++;
    const grant = ledger.db.query("UPDATE slot_requests SET state = 'granted', pool = ?, granted_at = ? WHERE id = ?");
    const granted: SlotRequestRow[] = [];
    for (const r of grantOrder(open, nowMs)) {
      let pools: Pool[] = [];
      try {
        pools = JSON.parse(r.pools);
      } catch {}
      const pool = pools.find((p) => p in used && used[p] < (caps[p] ?? 0));
      if (!pool) continue; // this request waits; a lower one may still fit another pool
      used[pool]++;
      grant.run(pool, iso(nowMs), r.id);
      granted.push({ ...r, state: "granted", pool, granted_at: iso(nowMs) });
    }
    return granted;
  }).immediate();
}

export function bindLease(ledger: Ledger, id: number, issue: number, lapId: number) {
  ledger.db.query("UPDATE slot_requests SET issue_number = ?, lap_id = ? WHERE id = ?").run(issue, lapId, id);
}

export function releaseSlot(ledger: Ledger, id: number, detail?: string) {
  ledger.db
    .query("UPDATE slot_requests SET state = 'released', released_at = ?, detail = COALESCE(?, detail) WHERE id = ? AND state IN ('waiting', 'granted', 'parked')")
    .run(iso(Date.now()), detail ?? null, id);
}

function parkSlot(ledger: Ledger, id: number, nowMs: number) {
  ledger.db
    .query("UPDATE slot_requests SET state = 'parked', pid = NULL, parked_at = ?, detail = 'parked: the tick waited its window' WHERE id = ? AND state = 'waiting'")
    .run(iso(nowMs), id);
}

/** 1-based place of a waiting request in grant order (null when not waiting) */
export function queuePosition(ledger: Ledger, id: number, nowMs = Date.now()): number | null {
  const rows = ledger.db.query("SELECT * FROM slot_requests WHERE state = 'waiting'").all() as SlotRequestRow[];
  const i = grantOrder(rows, nowMs).findIndex((r) => r.id === id);
  return i < 0 ? null : i + 1;
}

/**
 * Request a slot and wait for it. Returns the lease, or null when the repo
 * was paused while waiting (request released) or the wait window ran out
 * (request parked for the repo's next tick to adopt). Nothing is claimed
 * while waiting.
 */
export async function acquireSlot(
  ledger: Ledger,
  req: SlotRequest,
  opts: {
    log?: (msg: string) => void;
    isPaused?: () => boolean;
    waitMs?: number;
    pollMs?: number;
    alive?: (pid: number) => boolean;
  } = {}
): Promise<SlotLease | null> {
  const log = opts.log ?? (() => {});
  const waitMs = opts.waitMs ?? Number(process.env.PDF_SLOT_WAIT_MS ?? 14 * 60_000);
  const pollMs = opts.pollMs ?? Number(process.env.PDF_SLOT_POLL_MS ?? 5000);
  const id = requestSlot(ledger, req);
  const start = Date.now();
  const requestedAt = Date.parse(getRow(ledger, id)?.requested_at ?? iso(start));
  let noted = false;
  let lastNote = start;
  for (;;) {
    try {
      grantPass(ledger, Date.now(), { alive: opts.alive });
    } catch {
      // a locked database past busy_timeout: poll again; the daemon's pass
      // or the next poll decides
    }
    const row = getRow(ledger, id);
    if (row?.state === "granted" && row.pool) {
      const waitedMs = Date.now() - requestedAt;
      const spilled = row.pool !== req.pools[0];
      if (noted || spilled)
        log(`slot granted on ${row.pool}${spilled ? ` — spilled over (${req.pools[0]} pool full)` : ""} after ${Math.round(waitedMs / 1000)}s (lane ${req.lane})`);
      return { id, pool: row.pool, spilled, waitedMs };
    }
    if (!row || (row.state !== "waiting" && row.state !== "granted")) {
      log(`slot request ${id} ended as ${row?.state ?? "missing"} while waiting — no lap this time`);
      return null;
    }
    if (opts.isPaused?.()) {
      releaseSlot(ledger, id, "repo paused while waiting");
      return null;
    }
    const now = Date.now();
    if (!noted || now - lastNote >= 10 * 60_000) {
      const pos = queuePosition(ledger, id, now);
      const eff = LEVEL_NAME[effectivePriority(req.priority, iso(requestedAt), now)];
      log(`waiting for a machine slot (${req.pools.join(" or ")}${req.extraLane ? ", extra lane" : ""}, priority ${req.priority}${eff !== req.priority ? ` → ${eff} after aging` : ""}, queue position ${pos ?? "?"}) — nothing claimed while waiting`);
      noted = true;
      lastNote = now;
    }
    if (now - start >= waitMs) {
      parkSlot(ledger, id, now);
      log(`slot wait window (${Math.round(waitMs / 60_000)} min) spent — request parked with its place; the next tick adopts it`);
      return null;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export interface PoolStatus {
  pool: Pool;
  cap: number;
  used: number;
  waiting: number;
  parked: number;
}

/** per-pool usage for /health, status and the dashboard */
export function poolStatus(ledger: Ledger): PoolStatus[] {
  const caps = poolCaps();
  const rows = ledger.db
    .query("SELECT state, pool, pools FROM slot_requests WHERE state IN ('waiting', 'granted', 'parked')")
    .all() as { state: SlotState; pool: Pool | null; pools: string }[];
  return POOLS.map((pool) => {
    const first = (r: { pools: string }) => {
      try {
        return (JSON.parse(r.pools) as Pool[])[0] === pool;
      } catch {
        return false;
      }
    };
    return {
      pool,
      cap: caps[pool],
      used: rows.filter((r) => r.state === "granted" && r.pool === pool).length,
      waiting: rows.filter((r) => r.state === "waiting" && first(r)).length,
      parked: rows.filter((r) => r.state === "parked" && first(r)).length,
    };
  });
}
