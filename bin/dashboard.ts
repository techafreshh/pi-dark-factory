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
  const all = q(db, `SELECT repo, COUNT(*) stages, SUM(input_tokens) i, SUM(output_tokens) o
                     FROM stage_runs GROUP BY repo ORDER BY o DESC`);
  const today = q(db, `SELECT repo, SUM(input_tokens) i, SUM(output_tokens) o
                      FROM stage_runs WHERE substr(started_at,1,10) = date('now') GROUP BY repo`);
  const t = new Map(today.map((r) => [r.repo, r]));
  return all.map((r) => ({ ...r, today_i: t.get(r.repo)?.i ?? 0, today_o: t.get(r.repo)?.o ?? 0 }));
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
                       SUM(input_tokens) i, SUM(output_tokens) o, MIN(started_at) started
                FROM stage_runs WHERE lap_id IS NOT NULL
                GROUP BY lap_id ORDER BY lap_id DESC LIMIT 40`);
}

function tokensByStageModel(db: Database) {
  return q(db, `SELECT stage, model, COUNT(*) n, SUM(input_tokens) i, SUM(output_tokens) o
                FROM stage_runs GROUP BY stage, model ORDER BY o DESC LIMIT 24`);
}

function tokensByDay(db: Database) {
  const rows = q(db, `SELECT substr(started_at,1,10) day, SUM(input_tokens) i, SUM(output_tokens) o
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

// ── HTML: one page, dark, no dependencies, auto-refresh every 20s ────────────

const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pi-dark-factory</title><style>
:root{color-scheme:dark}
body{background:#0d1117;color:#c9d1d9;font:14px/1.45 ui-monospace,Menlo,Consolas,monospace;margin:0;padding:16px}
h1{font-size:18px;margin:0 0 2px} h2{font-size:13px;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin:22px 0 6px}
.sub{color:#8b949e;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th{color:#8b949e;text-align:left;font-weight:500;padding:3px 8px;border-bottom:1px solid #21262d}
td{padding:3px 8px;border-bottom:1px solid #161b22}
tr:hover td{background:#161b22}
.slug{color:#58a6ff}.num{color:#f0883e}.ok{color:#3fb950}.warn{color:#d29922}.bad{color:#f85149}.dim{color:#8b949e}
.gauge{display:inline-block;padding:2px 10px;border:1px solid #21262d;border-radius:4px;margin-right:8px}
.bar{height:10px;background:#1f6feb;border-radius:2px;min-width:2px;display:inline-block;vertical-align:middle}
.bar2{background:#f0883e}
.feed{max-height:260px;overflow-y:auto;font-size:11.5px;white-space:pre-wrap;background:#010409;padding:8px;border-radius:6px;border:1px solid #21262d}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}
.pill{display:inline-block;padding:0 8px;border-radius:10px;border:1px solid #30363d;font-size:11px;margin:1px 2px}
.err{color:#f85149;font-size:11px}
</style></head><body>
<h1>🕯️ pi-dark-factory</h1><div class="sub" id="meta">loading…</div>
<h2>Needs you</h2><div id="attention" class="sub">—</div>
<h2>Laps in progress</h2><table id="laps"><thead><tr><th>repo</th><th>issue</th><th>stage</th><th>model</th><th>attempt</th><th>lap age</th><th>last stage</th></tr></thead><tbody></tbody></table>
<h2>Tokens by project</h2><table id="byproj"><thead><tr><th>repo</th><th>today in/out</th><th>all-time in/out</th><th>stages</th><th>share</th></tr></thead><tbody></tbody></table>
<h2>Daily token trend (30d)</h2><div id="trend"></div>
<h2>Throughput — merges per day</h2><div id="throughput"></div>
<div class="grid"><div><h2>Tokens by lap (recent)</h2><table id="bylap"><thead><tr><th>repo</th><th>issue</th><th>stages</th><th>in</th><th>out</th><th>when</th></tr></thead><tbody></tbody></table></div>
<div><h2>By stage × model</h2><table id="bystage"><thead><tr><th>stage</th><th>model</th><th>runs</th><th>in</th><th>out</th></tr></thead><tbody></tbody></table></div></div>
<h2>Live activity</h2><div id="feed" class="feed"></div>
<script>
const f = n => n==null ? "—" : n>=1e6 ? (n/1e6).toFixed(1)+"M" : n>=1e3 ? (n/1e3).toFixed(1)+"k" : String(n);
const ago = iso => { if(!iso) return "—"; const s=(Date.now()-new Date(iso))/1e3;
  return s<90?Math.round(s)+"s":s<5400?Math.round(s/60)+"m":s<172800?Math.round(s/3600)+"h":Math.round(s/86400)+"d"; };
const slug = (repo,slugs) => slugs[repo] || repo;
const esc = s => String(s??"").replace(/[&<>]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
function row(t){const tr=document.createElement("tr");tr.innerHTML=t;return tr;}
async function refresh(){
  const d = await (await fetch("/api/summary")).json();
  const S = d.slugs;
  document.getElementById("meta").textContent =
    "refreshed " + new Date(d.generatedAt).toLocaleTimeString() +
    (d.machines && d.machines.total!=null ? " · machines: " + d.machines.running + " running / " + d.machines.total + " total (cap 5)" : "");
  // attention
  const attn=[];
  for(const b of d.blocked) attn.push('<span class="slug">'+esc(slug(b.repo,S))+' #'+b.issue_number+'</span> BLOCKED ×'+b.attempts+' <span class="err">'+esc((b.last_error||"").slice(0,140))+'</span>');
  for(const p of d.paused) attn.push('<span class="slug">'+esc(p)+'</span> <span class="warn">paused</span>');
  document.getElementById("attention").innerHTML = attn.length?attn.join("<br>"):"all clear — nothing blocked, nothing paused";
  // laps in progress
  const lb=document.querySelector("#laps tbody"); lb.innerHTML="";
  for(const l of d.in_progress){
    const running = l.last_stage && !l.last_stage.ended_at;
    lb.append(row('<td class="slug">'+esc(slug(l.repo,S))+'</td><td>#'+l.issue_number+'</td>'+
      '<td class="'+(running?"ok":"dim")+'">'+esc(l.last_stage?l.last_stage.stage:"starting")+(running?" ▸":"")+'</td>'+
      '<td class="dim">'+esc(l.last_stage?l.last_stage.model:"")+'</td><td>'+esc(l.last_stage?l.last_stage.attempt:l.attempts)+'</td>'+
      '<td class="dim">'+ago(l.started_at)+'</td><td class="dim">'+ago(l.last_stage?.started_at)+'</td>'));
  }
  if(!d.in_progress.length) lb.append(row('<td colspan="7" class="dim">no laps in progress</td>'));
  // tokens by project
  const pb=document.querySelector("#byproj tbody"); pb.innerHTML="";
  const maxO = Math.max(1,...d.tokens_by_project.map(r=>r.o||0));
  for(const r of d.tokens_by_project){
    pb.append(row('<td class="slug">'+esc(slug(r.repo,S))+'</td><td class="num">'+f(r.today_i)+' / '+f(r.today_o)+'</td>'+
      '<td class="num">'+f(r.i)+' / '+f(r.o)+'</td><td class="dim">'+f(r.stages)+'</td>'+
      '<td><span class="bar" style="width:'+Math.max(2,Math.round(120*(r.o||0)/maxO))+'px"></span> <span class="bar bar2" style="width:'+Math.max(2,Math.round(40*(r.today_o||0)/maxO))+'px"></span></td>'));
  }
  // daily trend
  const maxD = Math.max(1,...d.tokens_by_day.map(r=>(r.i||0)+(r.o||0)));
  document.getElementById("trend").innerHTML = d.tokens_by_day.map(r=>{
    const w=Math.round(100*((r.i||0)+(r.o||0))/maxD);
    return '<div style="display:flex;align-items:center;gap:8px;margin:2px 0"><span class="dim" style="width:80px">'+r.day.slice(5)+'</span>'+
      '<span class="bar" style="width:'+Math.max(2,w*3)+'px"></span><span class="num" style="width:110px">'+f(r.i)+' / '+f(r.o)+'</span></div>';
  }).join("") || '<span class="dim">no data</span>';
  // throughput: merges per day per repo
  const reposT=[...new Set(d.merges_per_day.map(r=>r.repo))];
  const daysT=[...new Set(d.merges_per_day.map(r=>r.day))].sort().reverse().slice(0,14);
  const m=new Map(d.merges_per_day.map(r=>[r.repo+"|"+r.day,r.n]));
  document.getElementById("throughput").innerHTML='<table><tr><th></th>'+daysT.map(x=>"<th>"+x.slice(5)+"</th>").join("")+'</tr>'+
    reposT.map(r=>'<tr><td class="slug">'+esc(slug(r,S))+'</td>'+daysT.map(day=>'<td class="dim">'+(m.get(r+"|"+day)||"·")+'</td>').join("")+'</tr>').join("")+'</table>';
  // tokens by lap
  const lb2=document.querySelector("#bylap tbody"); lb2.innerHTML="";
  for(const l of d.tokens_by_lap.slice(0,20))
    lb2.append(row('<td class="slug">'+esc(slug(l.repo,S))+'</td><td>#'+l.issue_number+'</td><td class="dim">'+l.stages+'</td>'+
      '<td class="num">'+f(l.i)+'</td><td class="num">'+f(l.o)+'</td><td class="dim">'+ago(l.started)+'</td>'));
  // stage × model
  const sb=document.querySelector("#bystage tbody"); sb.innerHTML="";
  for(const s of d.tokens_by_stage_model)
    sb.append(row('<td>'+esc(s.stage)+'</td><td class="dim" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">'+esc(s.model)+'</td><td class="dim">'+s.n+'</td><td class="num">'+f(s.i)+'</td><td class="num">'+f(s.o)+'</td>'));
  // feed
  document.getElementById("feed").textContent = d.receipts.slice().reverse().join("\\n");
}
refresh(); setInterval(refresh, 20000);
</script></body></html>`;

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
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  console.log(`dashboard reading ${DB_PATH} — serving http://${HOST}:${PORT}`);
}
