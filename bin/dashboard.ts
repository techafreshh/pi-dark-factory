/**
 * Factory telemetry dashboard — a READ-ONLY sidecar.
 *
 * Opens factory.db in SQLite readonly mode (it physically cannot write),
 * tails laps.log, reads paused markers and per-issue session files, and
 * optionally lists the InstaBox and boxd machines. Serves the built React app
 * plus a small JSON API on its own port. The factory never knows it exists:
 * no imports from src/, no writes, no locks, no ledger schema opinions beyond
 * SELECTs. Default bind 10.0.1.1 (the web_gateway bridge — reachable by the
 * Caddy container at that address, unreachable publicly; auth lives on the
 * Caddyfile block).
 *
 *   GET /api/summary              overview: KPIs, needs-you, live laps, charts
 *   GET /api/projects             one row per repo with lap/cost stats
 *   GET /api/laps?repo&outcome&q&sort&order&limit&offset   paged lap list
 *   GET /api/laps/:id             one lap: stages, artifacts, plan
 *   GET /api/session?slug&issue&file   one session file, parsed into messages
 *   GET /api/activity?slug&q&limit     laps.log tail, filtered
 */
import { Database } from "bun:sqlite";
import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = process.env.DASHBOARD_STATE_DIR ?? "/home/factory/state";
const HOST = process.env.DASHBOARD_HOST ?? "10.0.1.1";
const PORT = Number(process.env.DASHBOARD_PORT ?? 8787);
const MACHINES_URL = process.env.DASHBOARD_MACHINES_URL ?? "https://api.instabox.sh/v1/machines";
const FACTORYD_HEALTH = process.env.DASHBOARD_FACTORYD_HEALTH ?? "http://127.0.0.1:8077/health";
const KEY_FILE = process.env.DASHBOARD_ENV_FILE ?? "/home/factory/dashboard.env";

const DB_PATH = join(STATE_DIR, "factory.db");
const LOG_PATH = join(STATE_DIR, "laps.log");

const DAY_MS = 86_400_000;
const DEFAULT_DAILY_ATTEMPTS = 60;
const BILLING_RE = /\b40[12]\b|insufficient.?balance|out of credit|invalid.?api.?key|unauthori[sz]ed|payment required/i;
export const OUTCOMES = [
  "running", "merged", "blocked", "error", "interrupted", "no_action", "needs_context",
  "infra_deferred", "billing_hold", "unended",
] as const;

function openReadonly(): Database {
  try {
    return new Database(DB_PATH, { readonly: true });
  } catch {
    // older bun: readonly flag unsupported — a plain open still never writes
    // (every statement below is a SELECT; the factory keeps its own locks)
    return new Database(DB_PATH);
  }
}

const q = (db: Database, sql: string, ...params: any[]): any[] => {
  try {
    return db.query(sql).all(...params) as any[];
  } catch {
    return []; // missing table/column on a fresh or old state dir — panels render empty
  }
};

const hasColumn = (db: Database, table: string, col: string) =>
  q(db, `PRAGMA table_info(${table})`).some((c) => c.name === col);

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const utcMidnight = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").toISOString();

// ── state-dir readers ───────────────────────────────────────────────────────

interface RepoInfo { slug: string; repo: string; mode: string; dailyAttempts: number; paused: { at: string; reason: string } | null }

/** every onboarded repo from repos/<slug>/config.json, keyed by full name */
export function repoInfo(): Map<string, RepoInfo> {
  const out = new Map<string, RepoInfo>();
  let slugs: string[] = [];
  try {
    slugs = readdirSync(join(STATE_DIR, "repos"));
  } catch {
    return out;
  }
  for (const slug of slugs) {
    const p = join(STATE_DIR, "repos", slug, "config.json");
    if (!existsSync(p)) continue;
    try {
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      if (!cfg.repo) continue;
      let paused: RepoInfo["paused"] = null;
      const pf = join(STATE_DIR, "repos", slug, "paused");
      if (existsSync(pf)) {
        // marker format: "<iso> <reason>" (billing hold) or just "<iso>" (manual)
        const raw = readFileSync(pf, "utf8").trim();
        const m = /^(\S+)\s*([\s\S]*)$/.exec(raw);
        paused = { at: m?.[1] ?? "", reason: m?.[2] || "paused by hand" };
      }
      const daily = cfg.limits?.daily_attempts;
      out.set(cfg.repo, {
        slug,
        repo: cfg.repo,
        mode: cfg.env?.mode ?? "host",
        dailyAttempts: typeof daily === "number" ? daily : DEFAULT_DAILY_ATTEMPTS,
        paused,
      });
    } catch {}
  }
  return out;
}

/** issue titles from the lap-start receipts: `[ts] [slug] lap #N "title" (attempt base …` */
const titleCache = { size: -1, offset: 0, map: new Map<string, string>(), lastPass: null as string | null, lastPassLine: "" };
const TITLE_RE = /^\[[^\]]+\] \[([^\]]+)\] lap #(\d+) "(.*)" \(attempt base/;
const PASS_RE = /^\[([^\]]+)\] scheduler: (started .*)$/;
function scanLog() {
  let size = 0;
  try {
    size = statSync(LOG_PATH).size;
  } catch {
    return titleCache;
  }
  if (size === titleCache.size) return titleCache;
  if (size < titleCache.offset) {
    titleCache.offset = 0; // rotated/truncated: rescan
    titleCache.map.clear();
  }
  const fd = openSync(LOG_PATH, "r");
  try {
    const buf = Buffer.alloc(size - titleCache.offset);
    readSync(fd, buf, 0, buf.length, titleCache.offset);
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    const complete = lastNl < 0 ? "" : text.slice(0, lastNl);
    for (const line of complete.split("\n")) {
      const t = TITLE_RE.exec(line);
      if (t) {
        titleCache.map.set(`${t[1]}#${t[2]}`, t[3]);
        continue;
      }
      const p = PASS_RE.exec(line);
      if (p) {
        titleCache.lastPass = p[1];
        titleCache.lastPassLine = p[2];
      }
    }
    titleCache.offset += Buffer.byteLength(complete) + (lastNl < 0 ? 0 : 1);
    titleCache.size = size;
  } finally {
    closeSync(fd);
  }
  return titleCache;
}
const titleOf = (slug: string | undefined, n: number | null) =>
  slug && n != null ? scanLog().map.get(`${slug}#${n}`) ?? null : null;

function tailReceipts(lines = 200, filter?: { slug?: string; q?: string }): string[] {
  try {
    const size = statSync(LOG_PATH).size;
    const len = Math.min(size, filter?.slug || filter?.q ? 2 * 1024 * 1024 : 256 * 1024);
    const fd = openSync(LOG_PATH, "r");
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    const needle = filter?.q?.toLowerCase();
    return buf
      .toString("utf8")
      .split("\n")
      .slice(len < size ? 1 : 0) // first line may be cut mid-way
      .filter((l) => l && !/dispatching \d+ lap\(s\)/.test(l)) // per-repo dispatch chatter
      .filter((l) => !filter?.slug || l.includes(`] [${filter.slug}] `))
      .filter((l) => !needle || l.toLowerCase().includes(needle))
      .slice(-lines);
  } catch {
    return [];
  }
}

/** repo tick processes alive right now: tick-<slug>.lock pidfiles whose pid runs */
function liveTicks(): string[] {
  const out: string[] = [];
  try {
    for (const f of readdirSync(STATE_DIR)) {
      const m = /^tick-(.+)\.lock$/.exec(f);
      if (!m) continue;
      try {
        const pid = parseInt(readFileSync(join(STATE_DIR, f), "utf8"), 10);
        if (pid > 0 && existsSync(`/proc/${pid}`)) out.push(m[1]);
      } catch {}
    }
  } catch {}
  return out;
}

let healthCache: { at: number; data: any } = { at: 0, data: null };
async function factorydHealth(): Promise<any> {
  if (Date.now() - healthCache.at < 30_000) return healthCache.data;
  try {
    const r = await fetch(FACTORYD_HEALTH, { signal: AbortSignal.timeout(2000) });
    healthCache = { at: Date.now(), data: await r.json() };
  } catch {
    healthCache = { at: Date.now(), data: null };
  }
  return healthCache.data;
}

// ── machines (InstaBox + boxd), cached 30 s ─────────────────────────────────

const MACHINE_RE = /^pdf-(.+)-i(\d+)(?:-g(\d+))?$/;
interface MachineRow { provider: "instabox" | "boxd"; name: string; state: string; slug: string | null; issue: number | null; created: string | null }
interface MachinePool { provider: "instabox" | "boxd"; configured: boolean; error: string | null; machines: MachineRow[] }

function keyFromFile(name: string): string | null {
  try {
    const env = readFileSync(KEY_FILE, "utf8");
    return new RegExp(`^${name}=(.*)$`, "m").exec(env)?.[1]?.trim().replace(/^["']|["']$/g, "") || null;
  } catch {
    return null;
  }
}
const toRow = (provider: MachineRow["provider"], name: string, state: string, created: unknown): MachineRow => {
  const m = MACHINE_RE.exec(name);
  return {
    provider,
    name,
    state,
    slug: m?.[1] ?? null,
    issue: m ? Number(m[2]) : null,
    created: created ? new Date(created as any).toISOString() : null,
  };
};

async function instaboxPool(): Promise<MachinePool> {
  // dedicated key file (mode 600, factory-owned) — the dashboard gets only the
  // machine-list keys, never the whole factoryd.env; keys stay server-side
  const key = keyFromFile("INSTABOX_API_KEY");
  if (!key) return { provider: "instabox", configured: false, error: null, machines: [] };
  try {
    const res = await fetch(MACHINES_URL, { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.json()) as any;
    const ms: any[] = Array.isArray(list) ? list : list?.machines ?? [];
    return {
      provider: "instabox",
      configured: true,
      error: null,
      machines: ms.map((m) => toRow("instabox", m.name ?? m.id, m.state ?? m.status ?? "?", m.created_at ?? m.createdAt)),
    };
  } catch (e: any) {
    return { provider: "instabox", configured: true, error: String(e?.message ?? e).slice(0, 160), machines: [] };
  }
}

async function boxdPool(): Promise<MachinePool> {
  const key = keyFromFile("BOXD_API_KEY");
  if (!key) return { provider: "boxd", configured: false, error: null, machines: [] };
  let client: any = null;
  try {
    const { Boxd } = await import("@boxd-sh/sdk");
    client = new Boxd({ apiKey: key });
    const list: any = await Promise.race([
      client.machines.list({ region: "all", labels: { factory: "1" } }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
    ]);
    const ms: any[] = Array.isArray(list) ? list : list?.machines ?? [];
    return { provider: "boxd", configured: true, error: null, machines: ms.map((m) => toRow("boxd", m.name, m.status, m.createdAt)) };
  } catch (e: any) {
    return { provider: "boxd", configured: true, error: String(e?.message ?? e).slice(0, 160), machines: [] };
  } finally {
    await client?.close?.().catch?.(() => {});
  }
}

let machinesCache: { at: number; data: MachinePool[] | null } = { at: 0, data: null };
let machinesInflight: Promise<MachinePool[]> | null = null;
async function machines(): Promise<MachinePool[]> {
  if (machinesCache.data && Date.now() - machinesCache.at < 30_000) return machinesCache.data;
  machinesInflight ??= Promise.all([instaboxPool(), boxdPool()]).then((d) => {
    machinesCache = { at: Date.now(), data: d };
    machinesInflight = null;
    return d;
  });
  return machinesInflight;
}

// ── ledger queries ──────────────────────────────────────────────────────────

/** lap status: the stored outcome, or for an open row whether it is truly
 *  live (its issue is in_progress and this is the issue's newest lap) or a
 *  crash leftover from before reconcile closed dangling laps */
const STATUS_SQL = `CASE
  WHEN l.outcome IS NOT NULL THEN l.outcome
  WHEN l.ended_at IS NULL AND i.state = 'in_progress'
       AND l.id = (SELECT MAX(id) FROM laps l2 WHERE l2.repo = l.repo AND l2.issue_number = l.issue_number) THEN 'running'
  ELSE 'unended' END`;

const STAGE_AGG = `SELECT lap_id, COUNT(*) stages, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost) cost,
                          MAX(attempt) attempts, GROUP_CONCAT(DISTINCT model) models
                   FROM stage_runs WHERE lap_id IS NOT NULL GROUP BY lap_id`;

function liveLaps(db: Database, info: Map<string, RepoInfo>) {
  const laps = q(db, `SELECT l.id, l.repo, l.issue_number, l.started_at, i.attempts, i.pr
                      FROM laps l JOIN issues i ON i.repo = l.repo AND i.issue_number = l.issue_number
                      WHERE (${STATUS_SQL}) = 'running' ORDER BY l.started_at`);
  return laps.map((l) => {
    const [stage] = q(db, `SELECT stage, model, attempt, started_at, ended_at, exit FROM stage_runs
                           WHERE lap_id = ? ORDER BY id DESC LIMIT 1`, l.id);
    const slug = info.get(l.repo)?.slug;
    return { ...l, slug: slug ?? l.repo, title: titleOf(slug, l.issue_number), stage: stage ?? null };
  });
}

function parseTried(row: any): { model: string; outcome: string; error?: string }[] {
  if (row.tried) {
    try {
      return JSON.parse(row.tried);
    } catch {}
  }
  // pre-`tried` rows: only the base model is known
  return [{ model: row.model, outcome: row.exit ?? "?", error: row.error ?? undefined }];
}

/** per-model health over the last 24 h, from each stage's fallback trail */
function modelHealth(db: Database, triedCol: boolean) {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const rows = q(db, `SELECT model, exit, error, started_at, ended_at${triedCol ? ", tried" : ""}
                      FROM stage_runs WHERE started_at >= ? AND ended_at IS NOT NULL ORDER BY id`, since);
  const by = new Map<string, { model: string; tries: number; ok: number; failed: number; billing: number; last_at: string; last_outcome: string; last_error: string | null }>();
  for (const r of rows) {
    for (const t of parseTried(r)) {
      const h = by.get(t.model) ?? { model: t.model, tries: 0, ok: 0, failed: 0, billing: 0, last_at: "", last_outcome: "", last_error: null };
      h.tries++;
      const billing = t.outcome !== "ok" && BILLING_RE.test(t.error ?? "");
      if (t.outcome === "ok") h.ok++;
      else h.failed++;
      if (billing) h.billing++;
      h.last_at = r.ended_at;
      h.last_outcome = billing ? "billing" : t.outcome;
      h.last_error = t.outcome === "ok" ? null : (t.error ?? null)?.slice(0, 240) ?? null;
      by.set(t.model, h);
    }
  }
  return [...by.values()].sort((a, b) => b.tries - a.tries);
}

function needsYou(db: Database, info: Map<string, RepoInfo>, health: ReturnType<typeof modelHealth>) {
  const items: { kind: string; repo: string | null; slug: string | null; issue: number | null; title: string | null; detail: string; at: string | null; pr?: number | null; attempts?: number; lap_id?: number | null }[] = [];
  for (const b of q(db, `SELECT repo, issue_number, attempts, pr, last_error, updated_at,
                                (SELECT MAX(id) FROM laps l WHERE l.repo = issues.repo AND l.issue_number = issues.issue_number) lap_id
                         FROM issues WHERE state = 'blocked' ORDER BY updated_at DESC`)) {
    const slug = info.get(b.repo)?.slug ?? null;
    items.push({ kind: "blocked", repo: b.repo, slug, issue: b.issue_number, title: titleOf(slug ?? undefined, b.issue_number),
      detail: (b.last_error ?? "").slice(0, 400), at: b.updated_at, pr: b.pr, attempts: b.attempts, lap_id: b.lap_id });
  }
  for (const r of info.values()) {
    if (r.paused) items.push({ kind: "paused", repo: r.repo, slug: r.slug, issue: null, title: null, detail: r.paused.reason.slice(0, 400), at: r.paused.at || null });
  }
  const today = utcMidnight();
  for (const c of q(db, `SELECT repo, COUNT(*) n FROM stage_runs WHERE stage = 'implement' AND started_at >= ? GROUP BY repo`, today)) {
    const r = info.get(c.repo);
    const cap = r?.dailyAttempts ?? DEFAULT_DAILY_ATTEMPTS;
    if (cap > 0 && c.n >= cap) {
      items.push({ kind: "daily_cap", repo: c.repo, slug: r?.slug ?? null, issue: null, title: null,
        detail: `${c.n} implement attempts today (ceiling ${cap}) — the chain waits for 00:00 UTC`, at: null });
    }
  }
  // one item per model, not per thinking level (river/x:low and river/x:max share a balance)
  const billing = new Map<string, (typeof health)[number]>();
  for (const h of health) {
    if (h.last_outcome !== "billing") continue;
    const base = h.model.replace(/:[a-z]+$/, "");
    if (!billing.has(base) || billing.get(base)!.last_at < h.last_at) billing.set(base, h);
  }
  for (const [base, h] of billing) {
    items.push({ kind: "billing", repo: null, slug: null, issue: null, title: null,
      detail: `${base}: ${h.last_error ?? "out of credit"}`, at: h.last_at });
  }
  return items;
}

function outcomesByDay(db: Database, days = 30) {
  const since = isoDay(Date.now() - (days - 1) * DAY_MS);
  const rows = q(db, `SELECT substr(l.started_at,1,10) day, ${STATUS_SQL} status, COUNT(*) n
                      FROM laps l LEFT JOIN issues i ON i.repo = l.repo AND i.issue_number = l.issue_number
                      WHERE l.issue_number IS NOT NULL AND l.started_at >= ? GROUP BY day, status`, since);
  return fillDays(days, (day) => {
    const o: Record<string, number> = {};
    for (const r of rows) if (r.day === day) o[r.status] = r.n;
    return o;
  });
}

function costByDay(db: Database, days = 30) {
  const since = isoDay(Date.now() - (days - 1) * DAY_MS);
  const rows = q(db, `SELECT substr(started_at,1,10) day, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost) cost, COUNT(*) stages
                      FROM stage_runs WHERE started_at >= ? GROUP BY day`, since);
  const by = new Map(rows.map((r) => [r.day, r]));
  return fillDays(days, (day) => {
    const r = by.get(day);
    return { i: r?.i ?? 0, o: r?.o ?? 0, cost: r?.cost ?? 0, stages: r?.stages ?? 0 };
  });
}

function fillDays<T extends object>(days: number, f: (day: string) => T): (T & { day: string })[] {
  const out: (T & { day: string })[] = [];
  for (let k = days - 1; k >= 0; k--) {
    const day = isoDay(Date.now() - k * DAY_MS);
    out.push({ day, ...f(day) });
  }
  return out;
}

function kpis(db: Database) {
  const today = utcMidnight();
  const week = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const lapStats = (since: string) =>
    q(db, `SELECT COUNT(*) laps, SUM(outcome = 'merged') merged, SUM(outcome = 'blocked') blocked
           FROM laps WHERE issue_number IS NOT NULL AND started_at >= ?`, since)[0] ?? {};
  const spend = (since: string) =>
    q(db, `SELECT SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost) cost FROM stage_runs WHERE started_at >= ?`, since)[0] ?? {};
  const all = q(db, `SELECT SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost) cost FROM stage_runs`)[0] ?? {};
  const t = lapStats(today), w = lapStats(week), st = spend(today), sw = spend(week);
  const closed7 = q(db, `SELECT COUNT(*) n FROM laps WHERE issue_number IS NOT NULL AND started_at >= ?
                         AND outcome IN ('merged','blocked','error','no_action','needs_context')`, week)[0]?.n ?? 0;
  return {
    laps_today: t.laps ?? 0, merged_today: t.merged ?? 0,
    laps_7d: w.laps ?? 0, merged_7d: w.merged ?? 0, blocked_7d: w.blocked ?? 0,
    merge_rate_7d: closed7 ? (w.merged ?? 0) / closed7 : null,
    cost_today: st.cost ?? 0, cost_7d: sw.cost ?? 0, cost_all: all.cost ?? 0,
    tokens_today: (st.i ?? 0) + (st.o ?? 0), tokens_7d: (sw.i ?? 0) + (sw.o ?? 0), tokens_all: (all.i ?? 0) + (all.o ?? 0),
    blocked_issues: q(db, `SELECT COUNT(*) n FROM issues WHERE state = 'blocked'`)[0]?.n ?? 0,
  };
}

function stageModel(db: Database, days = 7) {
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  return q(db, `SELECT stage, model, COUNT(*) n, SUM(exit = 'ok') ok, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost) cost,
                       AVG(CASE WHEN ended_at IS NOT NULL AND (julianday(ended_at) - julianday(started_at)) * 86400 >= 1
                                THEN (julianday(ended_at) - julianday(started_at)) * 86400 END) avg_s
                FROM stage_runs WHERE started_at >= ? GROUP BY stage, model ORDER BY cost DESC, n DESC`, since);
}

/** the overview page. Pure over the ledger + state dir (machines/scheduler are added by the server). */
export function computeSummary(db: Database) {
  const info = repoInfo();
  const triedCol = hasColumn(db, "stage_runs", "tried");
  const health = modelHealth(db, triedCol);
  const log = scanLog();
  return {
    generatedAt: new Date().toISOString(),
    slugs: Object.fromEntries([...info.values()].map((r) => [r.repo, r.slug])),
    kpis: kpis(db),
    needs_you: needsYou(db, info, health),
    live: liveLaps(db, info),
    outcomes_by_day: outcomesByDay(db),
    cost_by_day: costByDay(db),
    model_health: health,
    stage_model: stageModel(db),
    scheduler: { last_pass_at: log.lastPass, last_pass: log.lastPassLine, ticks_running: liveTicks() },
  };
}

export function listProjects(db: Database) {
  const info = repoInfo();
  const week = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const laps = new Map(q(db, `SELECT repo, COUNT(*) laps, SUM(outcome = 'merged') merged, SUM(outcome = 'blocked') blocked,
                                     SUM(started_at >= ?) laps_7d, SUM(outcome = 'merged' AND started_at >= ?) merged_7d, MAX(started_at) last_lap
                              FROM laps WHERE issue_number IS NOT NULL GROUP BY repo`, week, week).map((r) => [r.repo, r]));
  const spend = new Map(q(db, `SELECT repo, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost) cost,
                                      SUM(CASE WHEN started_at >= ? THEN cost END) cost_7d
                               FROM stage_runs GROUP BY repo`, week).map((r) => [r.repo, r]));
  const issues = new Map<string, Record<string, number>>();
  for (const r of q(db, `SELECT repo, state, COUNT(*) n FROM issues GROUP BY repo, state`)) {
    const m = issues.get(r.repo) ?? {};
    m[r.state] = r.n;
    issues.set(r.repo, m);
  }
  const live = new Set(liveLaps(db, info).map((l) => l.repo));
  const repos = new Set([...info.keys(), ...laps.keys()]);
  return [...repos].map((repo) => {
    const i = info.get(repo), l = laps.get(repo) ?? {}, s = spend.get(repo) ?? {}, st = issues.get(repo) ?? {};
    return {
      repo, slug: i?.slug ?? repo, mode: i?.mode ?? null, onboarded: !!i,
      paused: i?.paused ?? null, running: live.has(repo),
      laps: l.laps ?? 0, merged: l.merged ?? 0, blocked_laps: l.blocked ?? 0, laps_7d: l.laps_7d ?? 0, merged_7d: l.merged_7d ?? 0,
      last_lap: l.last_lap ?? null,
      issues_blocked: st.blocked ?? 0, issues_in_progress: st.in_progress ?? 0, issues_merged: st.merged ?? 0,
      tokens: (s.i ?? 0) + (s.o ?? 0), cost: s.cost ?? 0, cost_7d: s.cost_7d ?? 0,
    };
  });
}

const LAP_SORTS: Record<string, string> = {
  id: "l.id", started: "l.started_at", repo: "l.repo", issue: "l.issue_number", status: "status",
  duration: "duration_s", cost: "s.cost", tokens: "(COALESCE(s.i,0) + COALESCE(s.o,0))", attempts: "s.attempts",
};

export interface LapQuery { repo?: string; outcome?: string; q?: string; sort?: string; order?: string; limit?: number; offset?: number }

export function listLaps(db: Database, p: LapQuery) {
  const info = repoInfo();
  const bySlug = new Map([...info.values()].map((r) => [r.slug, r.repo]));
  const where: string[] = ["l.issue_number IS NOT NULL"];
  const params: any[] = [];
  if (p.repo) {
    const repos = p.repo.split(",").map((r) => bySlug.get(r) ?? r);
    where.push(`l.repo IN (${repos.map(() => "?").join(",")})`);
    params.push(...repos);
  }
  if (p.outcome) {
    const outs = p.outcome.split(",");
    where.push(`(${STATUS_SQL}) IN (${outs.map(() => "?").join(",")})`);
    params.push(...outs);
  }
  if (p.q?.trim()) {
    const needle = p.q.trim();
    const ors = ["l.detail LIKE ?"];
    params.push(`%${needle}%`);
    const num = /^#?(\d+)$/.exec(needle);
    if (num) {
      ors.push("l.issue_number = ?", "l.id = ?");
      params.push(Number(num[1]), Number(num[1]));
    }
    // issue titles live in laps.log, not the ledger: match them here and feed
    // the hits back to SQL as (repo, issue) keys
    const lower = needle.toLowerCase();
    const keys: string[] = [];
    for (const [k, title] of scanLog().map) if (title.toLowerCase().includes(lower)) keys.push(k);
    if (keys.length) {
      const pairs = keys.slice(0, 2000).map((k) => {
        const [slug, n] = k.split("#");
        return [bySlug.get(slug) ?? slug, Number(n)];
      });
      ors.push(`(l.repo || '#' || l.issue_number) IN (${pairs.map(() => "?").join(",")})`);
      params.push(...pairs.map(([r, n]) => `${r}#${n}`));
    }
    where.push(`(${ors.join(" OR ")})`);
  }
  const sortCol = LAP_SORTS[p.sort ?? "id"] ?? "l.id";
  const order = p.order === "asc" ? "ASC" : "DESC";
  const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 200);
  const offset = Math.max(Number(p.offset) || 0, 0);
  const from = `FROM laps l
    LEFT JOIN issues i ON i.repo = l.repo AND i.issue_number = l.issue_number
    LEFT JOIN (${STAGE_AGG}) s ON s.lap_id = l.id
    WHERE ${where.join(" AND ")}`;
  const total = q(db, `SELECT COUNT(*) n ${from}`, ...params)[0]?.n ?? 0;
  const rows = q(
    db,
    `SELECT l.id, l.repo, l.issue_number, l.started_at, l.ended_at, l.detail, i.pr, ${STATUS_SQL} status,
            CASE WHEN l.ended_at IS NOT NULL THEN (julianday(l.ended_at) - julianday(l.started_at)) * 86400 END duration_s,
            s.stages, s.i, s.o, s.cost, s.attempts, s.models
     ${from} ORDER BY ${sortCol} ${order} NULLS LAST, l.id DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset
  );
  return {
    total, limit, offset,
    rows: rows.map((r) => {
      const slug = info.get(r.repo)?.slug;
      return { ...r, slug: slug ?? r.repo, title: titleOf(slug, r.issue_number), detail: r.detail?.slice(0, 300) ?? null };
    }),
  };
}

// ── per-lap artifacts ───────────────────────────────────────────────────────

interface Artifact { file: string; stage: string | null; attempt: number | null; started: string | null; ended: string; bytes: number; kind: "machine" | "host" }

const STAGE_FILE_RE = /^(plan|implement|review)-(\d+)\.jsonl$/;
const SESSION_FILE_RE = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)_[\w-]+\.jsonl$/;

function issueDirOf(slug: string, n: number) {
  return join(STATE_DIR, "repos", slug, "issues", String(n));
}

function firstLine(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1024);
    const got = readSync(fd, buf, 0, 1024, 0);
    return buf.subarray(0, got).toString("utf8").split("\n")[0];
  } finally {
    closeSync(fd);
  }
}

/** every session file of an issue: machine stage JSONLs and host session files */
export function issueArtifacts(slug: string, n: number): Artifact[] {
  const dir = issueDirOf(slug, n);
  const out: Artifact[] = [];
  const add = (file: string, stage: string | null, attempt: number | null, kind: Artifact["kind"], started: string | null) => {
    try {
      const st = statSync(join(dir, file));
      out.push({ file, stage, attempt, started, ended: st.mtime.toISOString(), bytes: st.size, kind });
    } catch {}
  };
  try {
    for (const f of readdirSync(dir)) {
      const m = STAGE_FILE_RE.exec(f);
      if (!m) continue;
      let started: string | null = null;
      try {
        started = JSON.parse(firstLine(join(dir, f))).timestamp ?? null;
      } catch {}
      add(f, m[1], Number(m[2]), "machine", started);
    }
  } catch {}
  try {
    for (const f of readdirSync(join(dir, "sessions"))) {
      const m = SESSION_FILE_RE.exec(f);
      if (!m) continue;
      const iso = m[1].replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, "T$1:$2:$3.$4Z");
      add(`sessions/${f}`, null, null, "host", iso);
    }
  } catch {}
  return out;
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * Pair a lap's stage rows with session files. Attempt-numbered machine files
 * are overwritten by later laps of the same issue, so a file belongs to a
 * stage only if it was last written inside that stage's window (older ledger
 * rows recorded start and end together at the stage's end, so the window is
 * widened by the stage's real start, read from the file header). Host session
 * files carry no stage name: they pair by time alone.
 */
export function matchArtifacts(stages: any[], files: Artifact[], lap: { started_at: string; ended_at: string | null }) {
  const used = new Set<string>();
  const SLACK = 120_000;
  const byStage = new Map<number, Artifact>();
  for (const s of stages) {
    const end = ms(s.ended_at) || Date.now();
    let best: Artifact | null = null;
    let bestD = Infinity;
    for (const f of files) {
      if (used.has(f.file)) continue;
      if (f.stage && (f.stage !== s.stage || f.attempt !== s.attempt)) continue;
      const fStart = ms(f.started), fEnd = ms(f.ended);
      const winStart = Math.min(ms(s.started_at), Number.isFinite(fStart) ? fStart : Infinity) - SLACK;
      if (fEnd < winStart || fEnd > end + SLACK) continue;
      if (Number.isFinite(fStart) && fStart < ms(lap.started_at) - SLACK) continue;
      const d = Math.abs(fEnd - end);
      if (d < bestD) {
        best = f;
        bestD = d;
      }
    }
    if (best) {
      used.add(best.file);
      byStage.set(s.id, best);
    }
  }
  // files written during the lap that no stage row claimed (e.g. a re-ask)
  const lapEnd = ms(lap.ended_at) || Date.now();
  const extra = files.filter((f) => !used.has(f.file) && ms(f.ended) >= ms(lap.started_at) - SLACK && ms(f.ended) <= lapEnd + SLACK);
  return { byStage, extra };
}

export function lapDetail(db: Database, id: number) {
  const info = repoInfo();
  const [lap] = q(db, `SELECT l.*, i.state issue_state, i.attempts issue_attempts, i.pr, i.branch, i.last_error, ${STATUS_SQL} status
                       FROM laps l LEFT JOIN issues i ON i.repo = l.repo AND i.issue_number = l.issue_number WHERE l.id = ?`, id);
  if (!lap) return null;
  const slug = info.get(lap.repo)?.slug ?? null;
  const triedCol = hasColumn(db, "stage_runs", "tried");
  const stages = q(db, `SELECT * FROM stage_runs WHERE lap_id = ? ORDER BY id`, id);
  const files = slug && lap.issue_number != null ? issueArtifacts(slug, lap.issue_number) : [];
  const { byStage, extra } = matchArtifacts(stages, files, lap);
  const dir = slug && lap.issue_number != null ? issueDirOf(slug, lap.issue_number) : null;
  let plan: string | null = null;
  try {
    if (dir) plan = readFileSync(join(dir, "plan.md"), "utf8").slice(0, 60_000);
  } catch {}
  const laps = q(db, `SELECT id, started_at, ${STATUS_SQL} status FROM laps l
                      LEFT JOIN issues i ON i.repo = l.repo AND i.issue_number = l.issue_number
                      WHERE l.repo = ? AND l.issue_number = ? ORDER BY l.id`, lap.repo, lap.issue_number);
  return {
    lap: { ...lap, slug, title: titleOf(slug ?? undefined, lap.issue_number) },
    stages: stages.map((s) => {
      const f = byStage.get(s.id);
      const recorded = ms(s.ended_at) - ms(s.started_at);
      // rows written before stages opened at start have a ~0 s window: take
      // the real start from the session file header, else "unknown"
      const started = recorded >= 1000 ? s.started_at : f?.started ?? null;
      const duration_s = s.ended_at && started ? Math.max(0, (ms(s.ended_at) - ms(started)) / 1000) : null;
      return {
        id: s.id, stage: s.stage, attempt: s.attempt, model: s.model, started_at: started, ended_at: s.ended_at, exit: s.exit,
        duration_s: duration_s != null && duration_s >= 1 ? duration_s : null,
        input_tokens: s.input_tokens, output_tokens: s.output_tokens, cost: s.cost, error: s.error,
        tried: triedCol && s.tried ? parseTried(s) : null,
        artifact: f ?? null,
      };
    }),
    extra_artifacts: extra,
    plan,
    issue_laps: laps,
  };
}

// ── session parser ──────────────────────────────────────────────────────────

const CAP_TEXT = 40_000, CAP_TOOL = 12_000, CAP_SYSTEM = 20_000;
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more chars]` : s);

export type SessionPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; redacted: boolean }
  | { type: "tool_call"; id: string; name: string; args: string };

export interface SessionMessage {
  role: "system" | "user" | "assistant" | "tool";
  ts: number | null;
  parts: SessionPart[];
  // assistant
  model?: string; provider?: string; usage?: { input: number; output: number; cacheRead: number; cost: number } | null;
  durationMs?: number | null; stopReason?: string | null; error?: string | null;
  // tool result
  toolCallId?: string; toolName?: string; isError?: boolean;
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : "")).join("\n");
}

function normalize(m: any): SessionMessage | null {
  const ts = typeof m.timestamp === "number" ? m.timestamp : ms(m.timestamp) || null;
  switch (m.role) {
    case "system": {
      const s = m.sections && typeof m.sections === "object"
        ? Object.entries(m.sections).map(([k, v]) => `## ${k}\n${v}`).join("\n\n")
        : "";
      return { role: "system", ts, parts: [{ type: "text", text: cap([textOf(m.content), s].filter(Boolean).join("\n\n"), CAP_SYSTEM) }] };
    }
    case "user":
      return { role: "user", ts, parts: [{ type: "text", text: cap(textOf(m.content), CAP_TEXT) }] };
    case "assistant": {
      const parts: SessionPart[] = [];
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === "thinking") {
          const t = String(c.thinking ?? "");
          parts.push({ type: "thinking", text: cap(t, CAP_TEXT), redacted: !t.trim() });
        } else if (c?.type === "text" && c.text) parts.push({ type: "text", text: cap(c.text, CAP_TEXT) });
        else if (c?.type === "toolCall") {
          parts.push({ type: "tool_call", id: c.id, name: c.name, args: cap(JSON.stringify(c.arguments ?? {}, null, 2), CAP_TOOL) });
        }
      }
      const u = m.usage;
      return {
        role: "assistant", ts, parts, model: m.model, provider: m.provider,
        usage: u ? { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cost: u.cost?.total ?? 0 } : null,
        durationMs: m.durationMs ?? null, stopReason: m.stopReason ?? null, error: m.errorMessage ?? null,
      };
    }
    case "toolResult":
      return {
        role: "tool", ts, parts: [{ type: "text", text: cap(textOf(m.content), CAP_TOOL) }],
        toolCallId: m.toolCallId, toolName: m.toolName, isError: !!m.isError, durationMs: m.durationMs ?? null,
      };
  }
  return null;
}

/** parse a pi session file — `--mode json` stage stream (message_end events)
 *  or a host session file (type "message" lines) — into display messages */
export function parseSession(raw: string) {
  const messages: SessionMessage[] = [];
  let header: any = null, truncated = false, bad = 0;
  const lines = raw.split("\n");
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (!line) continue;
    // the stream's bulk is per-token deltas and tool progress: skip unparsed
    if (line.startsWith('{"type":"message_update"') || line.startsWith('{"type":"tool_execution_update"') ||
        line.startsWith('{"type":"message_start"')) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      if (k >= lines.length - 2) truncated = true; // capped raw: last line cut mid-JSON
      else bad++;
      continue;
    }
    if (ev.type === "session") header = { id: ev.id, timestamp: ev.timestamp, cwd: ev.cwd };
    else if ((ev.type === "message_end" || ev.type === "message") && ev.message) {
      const m = normalize(ev.message);
      if (m) messages.push(m);
    }
  }
  const stats = { turns: 0, tool_calls: 0, tool_errors: 0, input: 0, output: 0, cacheRead: 0, cost: 0, thinking: 0, thinking_redacted: 0,
    tools: {} as Record<string, number>, models: [] as string[] };
  for (const m of messages) {
    if (m.role === "assistant") {
      stats.turns++;
      stats.input += m.usage?.input ?? 0;
      stats.output += m.usage?.output ?? 0;
      stats.cacheRead += m.usage?.cacheRead ?? 0;
      stats.cost += m.usage?.cost ?? 0;
      const id = [m.provider, m.model].filter(Boolean).join("/");
      if (id && !stats.models.includes(id)) stats.models.push(id);
      for (const p of m.parts) {
        if (p.type === "tool_call") {
          stats.tool_calls++;
          stats.tools[p.name] = (stats.tools[p.name] ?? 0) + 1;
        } else if (p.type === "thinking") p.redacted ? stats.thinking_redacted++ : stats.thinking++;
      }
    } else if (m.role === "tool" && m.isError) stats.tool_errors++;
  }
  return { header, messages, stats, truncated, unparsed_lines: bad };
}

const SESSION_PATH_RE = /^(?:(?:plan|implement|review)-\d+\.jsonl|sessions\/\d{4}-\d\d-\d\dT[\w-]+\.jsonl)$/;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;

export function readSession(slug: string, issue: number, file: string) {
  if (!/^[a-z0-9][\w.-]*$/i.test(slug) || !Number.isInteger(issue) || !SESSION_PATH_RE.test(file)) return null;
  const path = join(issueDirOf(slug, issue), file);
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    const fd = openSync(path, "r");
    const len = Math.min(st.size, MAX_SESSION_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    closeSync(fd);
    return { file, bytes: st.size, modified: st.mtime.toISOString(), ...parseSession(buf.toString("utf8")) };
  } catch {
    return null;
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const DIST = join(import.meta.dir, "..", "dashboard-ui", "dist");
const MIME: Record<string, string> = {
  ".js": "text/javascript", ".css": "text/css", ".html": "text/html",
  ".svg": "image/svg+xml", ".map": "application/json", ".woff2": "font/woff2",
};

function serveStatic(pathname: string): Response | null {
  // mounted at / (operator) and behind Caddy at /dashboard/ (handle_path strips
  // the prefix) — accept both shapes
  let p = pathname.startsWith("/dashboard/") ? pathname.slice("/dashboard".length) : pathname;
  if (p === "/" || p === "") p = "/index.html";
  const file = join(DIST, p.replace(/^\/+/, ""));
  if (p.includes("..") || !existsSync(file) || !statSync(file).isFile()) return null;
  const hashed = p.startsWith("/assets/");
  return new Response(readFileSync(file), {
    headers: {
      "content-type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}

function withDb<T>(f: (db: Database) => T): T {
  const db = openReadonly();
  try {
    return f(db);
  } finally {
    db.close();
  }
}

export async function route(url: URL): Promise<Response | null> {
  const p = url.pathname.replace(/^\/dashboard(?=\/)/, "");
  const sp = url.searchParams;
  if (p === "/health") return Response.json({ ok: true });
  if (p === "/api/summary") {
    const [m, h] = await Promise.all([machines(), factorydHealth()]);
    const s = withDb(computeSummary);
    const minutes = h?.scheduler_minutes ?? null;
    const next = minutes && s.scheduler.last_pass_at ? new Date(ms(s.scheduler.last_pass_at) + minutes * 60_000).toISOString() : null;
    return Response.json({ ...s, scheduler: { ...s.scheduler, minutes, next_pass_at: next, daemon_up: !!h?.ok }, machines: m });
  }
  if (p === "/api/projects") return Response.json({ generatedAt: new Date().toISOString(), rows: withDb(listProjects) });
  if (p === "/api/laps") {
    return Response.json(withDb((db) => listLaps(db, {
      repo: sp.get("repo") ?? undefined, outcome: sp.get("outcome") ?? undefined, q: sp.get("q") ?? undefined,
      sort: sp.get("sort") ?? undefined, order: sp.get("order") ?? undefined,
      limit: Number(sp.get("limit") ?? 50), offset: Number(sp.get("offset") ?? 0),
    })));
  }
  const lap = /^\/api\/laps\/(\d+)$/.exec(p);
  if (lap) {
    const d = withDb((db) => lapDetail(db, Number(lap[1])));
    return d ? Response.json(d) : Response.json({ error: "no such lap" }, { status: 404 });
  }
  if (p === "/api/session") {
    const s = readSession(sp.get("slug") ?? "", Number(sp.get("issue")), sp.get("file") ?? "");
    return s ? Response.json(s) : Response.json({ error: "no such session file" }, { status: 404 });
  }
  if (p === "/api/activity") {
    const lines = Math.min(Math.max(Number(sp.get("limit")) || 300, 1), 2000);
    return Response.json({ lines: tailReceipts(lines, { slug: sp.get("slug") ?? undefined, q: sp.get("q") ?? undefined }) });
  }
  if (p.startsWith("/api/")) return Response.json({ error: "not found" }, { status: 404 });
  return null;
}

if (import.meta.main) {
  Bun.serve({
    hostname: HOST,
    port: PORT,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      try {
        const api = await route(url);
        if (api) return api;
      } catch (e: any) {
        return Response.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
      }
      const staticRes = serveStatic(url.pathname);
      if (staticRes) return staticRes;
      // SPA fallback: unknown non-API paths render the app
      return serveStatic("/index.html") ?? new Response("dashboard ui not built", { status: 404 });
    },
  });
  console.log(`dashboard reading ${DB_PATH} — serving http://${HOST}:${PORT}`);
}
