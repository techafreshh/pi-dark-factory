import { useEffect, useMemo, useState } from "react";
import { BarChart } from "@/components/charts/bar-chart";
import { Sparkline } from "@/components/charts/sparkline";

/** The shape bin/dashboard.ts serves at api/summary. */
interface Summary {
  generatedAt: string;
  slugs: Record<string, string>;
  in_progress: {
    id: number; repo: string; issue_number: number; started_at: string;
    attempts: number | null; pr: number | null; issue_state: string | null;
    last_stage: { stage: string; model: string; attempt: number; started_at: string; ended_at: string | null } | null;
  }[];
  tokens_by_project: { repo: string; stages: number; i: number; o: number; cost: number | null; today_i: number; today_o: number; today_cost: number }[];
  tokens_by_lap: { lap_id: number; repo: string; issue_number: number; stages: number; i: number; o: number; cost: number | null; started: string }[];
  tokens_by_stage_model: { stage: string; model: string; n: number; i: number; o: number; cost: number | null }[];
  tokens_by_day: { day: string; i: number; o: number; cost: number | null }[];
  merges_per_day: { repo: string; day: string; n: number }[];
  issue_states: { repo: string; state: string; n: number }[];
  blocked: { repo: string; issue_number: number; attempts: number; pr: number | null; last_error: string | null; updated_at: string }[];
  paused: string[];
  receipts: string[];
  machines: { total: number | null; running: number | null; names: string[] } | null;
}

const f = (n: number | null | undefined) =>
  n == null ? "—" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
const $ = (n: number | null | undefined) => (n == null ? "—" : "$" + n.toFixed(2));
const ago = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1e3;
  return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-[#21262d] bg-[#010409] p-4 ${className}`}>
      <h2 className="mb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-[#8b949e]">{title}</h2>
      {children}
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr>{head.map((h) => <th key={h} className="border-b border-[#21262d] px-2 py-1.5 text-left font-medium text-[#8b949e]">{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-[#161b22] hover:bg-[#161b22]">
            {r.map((c, j) => <td key={j} className="px-2 py-1.5">{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function App() {
  const [d, setD] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("api/summary")
        .then((r) => r.json())
        .then(setD)
        .catch((e) => setErr(String(e)));
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  const S = d?.slugs ?? {};
  const slug = (repo: string) => S[repo] ?? repo;

  const today = useMemo(() => {
    const t = { i: 0, o: 0, cost: 0 };
    for (const r of d?.tokens_by_project ?? []) { t.i += r.today_i; t.o += r.today_o; t.cost += r.today_cost ?? 0; }
    return t;
  }, [d]);
  const all = useMemo(() => {
    const t = { i: 0, o: 0, cost: 0 };
    for (const r of d?.tokens_by_project ?? []) { t.i += r.i; t.o += r.o; t.cost += r.cost ?? 0; }
    return t;
  }, [d]);

  const trendDays = (d?.tokens_by_day ?? []).slice(-14);
  const costShare = (d?.tokens_by_project ?? []).filter((r) => (r.cost ?? 0) > 0).slice(0, 8);

  if (err) return <div className="p-8 text-[#f85149]">dashboard failed to load: {esc(err)}</div>;
  if (!d) return <div className="p-8 text-[#8b949e]">loading…</div>;

  return (
    <div className="mx-auto max-w-6xl p-4">
      <header className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-lg">🕯️ pi-dark-factory</h1>
        <span className="text-xs text-[#8b949e]">
          refreshed {new Date(d.generatedAt).toLocaleTimeString()} · auto every 20s
        </span>
        <span className="ml-auto flex gap-2 text-xs">
          {d.machines && d.machines.total != null && (
            <span className="rounded border border-[#30363d] px-2 py-0.5">
              machines <b className="text-[#f0883e]">{d.machines.running}</b>/{d.machines.total} <span className="text-[#8b949e]">(cap 5)</span>
            </span>
          )}
          <span className="rounded border border-[#30363d] px-2 py-0.5">
            laps active <b className="text-[#3fb950]">{d.in_progress.length}</b>
          </span>
        </span>
      </header>

      {(d.blocked.length > 0 || d.paused.length > 0) && (
        <Card title="Needs you" className="mb-4 border-[#d29922]/40">
          <div className="space-y-1 text-[12.5px]">
            {d.blocked.map((b) => (
              <div key={b.repo + b.issue_number}>
                <span className="text-[#58a6ff]">{slug(b.repo)} #{b.issue_number}</span> blocked ×{b.attempts}{" "}
                <span className="text-[#f85149]">{esc((b.last_error ?? "").slice(0, 140))}</span>
              </div>
            ))}
            {d.paused.map((p) => (
              <div key={p}><span className="text-[#58a6ff]">{esc(p)}</span> <span className="text-[#d29922]">paused</span></div>
            ))}
          </div>
        </Card>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Today in", f(today.i), "#58a6ff"],
          ["Today out", f(today.o), "#f0883e"],
          ["Today $", $(today.cost), "#3fb950"],
          ["All-time in", f(all.i), "#58a6ff"],
          ["All-time out", f(all.o), "#f0883e"],
          ["All-time $", $(all.cost), "#3fb950"],
        ].map(([label, value, color]) => (
          <div key={label} className="rounded-lg border border-[#21262d] bg-[#010409] p-3">
            <div className="text-[11px] text-[#8b949e]">{label}</div>
            <div className="font-mono text-xl" style={{ color }}>{value}</div>
          </div>
        ))}
      </div>

      <Card title="Laps in progress" className="mb-4">
        {d.in_progress.length === 0 ? (
          <div className="text-[#8b949e]">no laps in progress</div>
        ) : (
          <Table
            head={["repo", "issue", "stage", "model", "attempt", "lap age", "stage age"]}
            rows={d.in_progress.map((l) => {
              const running = l.last_stage && !l.last_stage.ended_at;
              return [
                <span key="r" className="text-[#58a6ff]">{slug(l.repo)}</span>,
                <>#{l.issue_number}</>,
                <span key="s" className={running ? "text-[#3fb950]" : "text-[#8b949e]"}>
                  {l.last_stage?.stage ?? "starting"}{running ? " ▸" : ""}
                </span>,
                <span key="m" className="text-[#8b949e]">{l.last_stage?.model ?? ""}</span>,
                <>{l.last_stage?.attempt ?? l.attempts}</>,
                <span key="a" className="text-[#8b949e]">{ago(l.started_at)}</span>,
                <span key="sa" className="text-[#8b949e]">{ago(l.last_stage?.started_at)}</span>,
              ];
            })}
          />
        )}
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title="Daily token trend (14d, stacked)">
          <BarChart
            label="Daily tokens"
            layout="stacked"
            categories={trendDays.map((r) => r.day.slice(5))}
            series={[
              { id: "input", name: "Input (cached+uncached)", color: "#58a6ff", values: trendDays.map((r) => r.i) },
              { id: "output", name: "Output (+reasoning)", color: "#f0883e", values: trendDays.map((r) => r.o) },
            ]}
            formatValue={(v) => f(v)}
          />
        </Card>
        <Card title="Cost by project (all-time)">
          <BarChart
            label="Cost by project"
            orientation="horizontal"
            sort="descending"
            categories={costShare.map((r) => slug(r.repo))}
            series={[{ id: "cost", name: "Cost", color: "#3fb950", values: costShare.map((r) => r.cost ?? 0) }]}
            formatValue={(v) => $(v)}
          />
          <div className="mt-3">
            <div className="mb-1 text-[11px] text-[#8b949e]">daily cost trend</div>
            <Sparkline
              data={(d?.tokens_by_day ?? []).map((r) => r.cost ?? 0)}
              labels={(d?.tokens_by_day ?? []).map((r) => r.day)}
              label="Daily cost"
              variant="area"
              color="#3fb950"
              formatValue={(v) => $(v)}
              interactive
            />
          </div>
        </Card>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title="Tokens by project">
          <Table
            head={["repo", "today in/out", "all-time in/out", "cost", "stages"]}
            rows={(d.tokens_by_project ?? []).map((r) => [
              <span key="r" className="text-[#58a6ff]">{slug(r.repo)}</span>,
              <span key="t" className="text-[#f0883e]">{f(r.today_i)} / {f(r.today_o)}</span>,
              <span key="a" className="num">{f(r.i)} / {f(r.o)}</span>,
              <span key="c" className="text-[#3fb950]">{$(r.cost)}</span>,
              <span key="s" className="text-[#8b949e]">{f(r.stages)}</span>,
            ])}
          />
        </Card>
        <Card title="Tokens by lap (recent)">
          <Table
            head={["repo", "issue", "stages", "in", "out", "cost", "when"]}
            rows={(d.tokens_by_lap ?? []).slice(0, 15).map((l) => [
              <span key="r" className="text-[#58a6ff]">{slug(l.repo)}</span>,
              <>#{l.issue_number}</>,
              <span key="s" className="text-[#8b949e]">{l.stages}</span>,
              <span key="i">{f(l.i)}</span>,
              <span key="o">{f(l.o)}</span>,
              <span key="c" className="text-[#3fb950]">{$(l.cost)}</span>,
              <span key="w" className="text-[#8b949e]">{ago(l.started)}</span>,
            ])}
          />
        </Card>
      </div>

      <Card title="By stage × model" className="mb-4">
        <Table
          head={["stage", "model", "runs", "in", "out", "cost"]}
          rows={(d.tokens_by_stage_model ?? []).map((s) => [
            <>{s.stage}</>,
            <span key="m" className="text-[#8b949e]">{s.model}</span>,
            <span key="n" className="text-[#8b949e]">{s.n}</span>,
            <span key="i">{f(s.i)}</span>,
            <span key="o">{f(s.o)}</span>,
            <span key="c" className="text-[#3fb950]">{$(s.cost)}</span>,
          ])}
        />
      </Card>

      <Card title="Live activity">
        <div className="feed max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-[#21262d] bg-[#010409] p-2 text-[11.5px] leading-relaxed">
          {d.receipts.slice().reverse().join("\n")}
        </div>
      </Card>
    </div>
  );
}
