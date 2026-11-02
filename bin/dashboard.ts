/**
 * Factory telemetry dashboard — a READ-ONLY sidecar.
 *
 * Opens factory.db in SQLite readonly mode (it physically cannot write),
 * tails laps.log, checks paused markers, and optionally queries the InstaBox
 * machine list. Serves one HTML page + one JSON endpoint on its own port.
 * The factory never knows it exists: no imports from src/, no writes, no
 * locks, no ledger schema opinions beyond SELECTs. Default bind 10.0.1.1
 * (the web_gateway bridge — reachable by the Caddy container at that
 * address, unreachable publicly; put auth on the Caddyfile block).
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = process.env.DASHBOARD_STATE_DIR ?? "/home/factory/state";
const HOST = process.env.DASHBOARD_HOST ?? "10.0.1.1";
const PORT = Number(process.env.DASHBOARD_PORT ?? 8787);
const MACHINES_URL = process.env.DASHBOARD_MACHINES_URL ?? "https://api.instabox.sh/v1/machines";

const DB_PATH = join(STATE_DIR, "factory.db");
const LOG_PATH = join(STATE_DIR, "laps.log");

function openReadonly(): Database {
  try {
    return new Database(DB_PATH, { readonly: true });
  } catch {
    // older bun: readonly flag unsupported — a plain open still never writes
    // (every statement below is a SELECT; the factory keeps its own locks)
    return new Database(DB_PATH);
  }
}

const q = (db: Database, sql: string): any[] => {
  try {
    return db.query(sql).all() as any[];
  } catch {
    return []; // missing table on a fresh state dir — panels render empty
  }
};

function tokensByProject(db: Database) {
  const all = q(db, `SELECT repo, COUNT(*) stages, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost) cost
                     FROM stage_runs GROUP BY repo ORDER BY o DESC`);
  const today = q(db, `SELECT repo, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost) cost
                      FROM stage_runs WHERE substr(started_at,1,10) = date('now') GROUP BY repo`);
  const t = new Map(today.map((r) => [r.repo, r]));
  return all.map((r) => ({ ...r, today_i: t.get(r.repo)?.i ?? 0, today_o: t.get(r.repo)?.o ?? 0, today_cost: t.get(r.repo)?.cost ?? 0 }));
}

function inProgressLaps(db: Database) {
  // issue state 'in_progress' is the authoritative current-work signal — the
  // laps table carries every interrupted lap since forever as outcome NULL,
  // and without this filter the panel showed weeks of crash leftovers
  const laps = q(db, `SELECT l.id, l.repo, l.issue_number, l.started_at, i.attempts, i.pr, i.state AS issue_state
                      FROM laps l JOIN issues i ON i.repo = l.repo AND i.issue_number = l.issue_number
                      WHERE l.outcome IS NULL AND l.issue_number IS NOT NULL AND i.state = 'in_progress'
                      ORDER BY l.started_at`);
  return laps.map((l) => {
    const [last] = q(db, `SELECT stage, model, attempt, started_at, ended_at
                          FROM stage_runs WHERE lap_id = ${Number(l.id)} ORDER BY id DESC LIMIT 1`);
    return { ...l, last_stage: last ?? null };
  });
}

function tokensByLap(db: Database) {
  return q(db, `SELECT lap_id, repo, issue_number, COUNT(*) stages,
                       SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost) cost, MIN(started_at) started
                FROM stage_runs WHERE lap_id IS NOT NULL
                GROUP BY lap_id ORDER BY lap_id DESC LIMIT 40`);
}

function tokensByStageModel(db: Database) {
  return q(db, `SELECT stage, model, COUNT(*) n, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost) cost
                FROM stage_runs GROUP BY stage, model ORDER BY o DESC LIMIT 24`);
}

function tokensByDay(db: Database) {
  const rows = q(db, `SELECT substr(started_at,1,10) day, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost) cost
                      FROM stage_runs GROUP BY day ORDER BY day DESC LIMIT 30`);
  return rows.reverse(); // oldest first for the chart
}

function mergesPerDay(db: Database) {
  return q(db, `SELECT repo, substr(ended_at,1,10) day, COUNT(*) n
                FROM laps WHERE outcome='merged' AND ended_at >= date('now','-13 days')
                GROUP BY repo, day ORDER BY day DESC`);
}

function issueStates(db: Database) {
  return q(db, `SELECT repo, state, COUNT(*) n FROM issues GROUP BY repo, state`);
}

function blocked(db: Database) {
  return q(db, `SELECT repo, issue_number, attempts, pr, last_error, updated_at
                FROM issues WHERE state='blocked' ORDER BY updated_at DESC LIMIT 20`);
}

function tailReceipts(lines = 40): string[] {
  try {
    const size = statSync(LOG_PATH).size;
    const start = Math.max(0, size - 64 * 1024);
    const buf = readFileSync(LOG_PATH).subarray(start); // ≤64KB — cheap per request
    return buf.toString("utf8").split("\n").filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

function pausedSlugs(): string[] {
  try {
    return readdirSync(join(STATE_DIR, "repos")).filter((s) =>
      existsSync(join(STATE_DIR, "repos", s, "paused"))
    );
  } catch {
    return [];
  }
}

function repoSlugs(): Record<string, string> {
  // slug → full repo name (the ledger keys rows by full name; humans think in slugs)
  const out: Record<string, string> = {};
  try {
    for (const slug of readdirSync(join(STATE_DIR, "repos"))) {
      const p = join(STATE_DIR, "repos", slug, "config.json");
      if (existsSync(p)) {
        try {
          out[JSON.parse(readFileSync(p, "utf8")).repo] = slug;
        } catch {}
      }
    }
  } catch {}
  return out;
}

let machinesCache: { at: number; data: any } = { at: 0, data: null };
async function machines(): Promise<any> {
  if (Date.now() - machinesCache.at < 30_000) return machinesCache.data;
  try {
    // dedicated key file (mode 600, factory-owned) — the dashboard gets only
    // the InstaBox key, never the whole factoryd.env; key is used server-side
    // for the read-only machine list and never served
    const env = readFileSync("/home/factory/dashboard.env", "utf8");
    const key = /^INSTABOX_API_KEY=(.*)$/m.exec(env)?.[1]?.trim();
    if (!key) throw new Error("no key");
    const res = await fetch(MACHINES_URL, {
      headers: { "X-API-Key": key },
      signal: AbortSignal.timeout(5000),
    });
    const list = (await res.json()) as any[];
    const machines = Array.isArray(list) ? list : list?.machines ?? [];
    machinesCache = {
      at: Date.now(),
      data: {
        total: machines.length,
        running: machines.filter((m) => m.state === "running").length,
        names: machines.map((m) => m.name ?? m.id).slice(0, 12),
      },
    };
  } catch {
    machinesCache = { at: Date.now(), data: { total: null, running: null, names: [] } };
  }
  return machinesCache.data;
}

export function computeSummary(db: Database) {
  const slugs = repoSlugs();
  return {
    generatedAt: new Date().toISOString(),
    slugs,
    in_progress: inProgressLaps(db),
    tokens_by_project: tokensByProject(db),
    tokens_by_lap: tokensByLap(db),
    tokens_by_stage_model: tokensByStageModel(db),
    tokens_by_day: tokensByDay(db),
    merges_per_day: mergesPerDay(db),
    issue_states: issueStates(db),
    blocked: blocked(db),
    paused: pausedSlugs(),
    receipts: tailReceipts(),
  };
}

// ── UI: the built React app (dashboard-ui/dist, beUI charts) ────────────────

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
  return new Response(readFileSync(file), {
    headers: { "content-type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" },
  });
}

function handler() {
  const db = openReadonly();
  try {
    return computeSummary(db);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  Bun.serve({
    hostname: HOST,
    port: PORT,
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ ok: true });
      if (url.pathname === "/api/summary") {
        return Response.json({ ...handler(), machines: await machines() });
      }
      const staticRes = serveStatic(url.pathname);
      if (staticRes) return staticRes;
      // SPA fallback: unknown non-API paths render the app
      return serveStatic("/index.html") ?? new Response("dashboard ui not built", { status: 404 });
    },
  });
  console.log(`dashboard reading ${DB_PATH} — serving http://${HOST}:${PORT}`);
}
