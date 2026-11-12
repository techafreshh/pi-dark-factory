import { AlertTriangle, CircleDollarSign, Clock, DatabaseBackup, Gauge, Hourglass, PauseCircle } from "lucide-react";
import { BarChart } from "@/components/charts/bar-chart";
import { PageHeader } from "@/components/shell";
import { Badge, Card, CardHeader, Empty, ErrorNote, EXIT_TONE, Kpi, Link, Table, Td, Th, Tr } from "@/components/ui";
import { useApi, type NeedsYou, type Scheduling, type Summary } from "@/lib/api";
import { href } from "@/lib/router";
import { ago, dur, num, pct, since, usd } from "@/lib/format";

const NEED = {
  blocked: { label: "blocked", tone: "bad", icon: AlertTriangle, color: "text-bad" },
  paused: { label: "paused", tone: "warn", icon: PauseCircle, color: "text-warn" },
  daily_cap: { label: "daily ceiling", tone: "orange", icon: Gauge, color: "text-orange" },
  billing: { label: "out of credit", tone: "warn", icon: CircleDollarSign, color: "text-warn" },
  backup: { label: "backup", tone: "bad", icon: DatabaseBackup, color: "text-bad" },
  slot_wait: { label: "slot wait", tone: "violet", icon: Hourglass, color: "text-violet" },
} as const;

function NeedsYouCard({ items }: { items: NeedsYou[] }) {
  if (items.length === 0) return null;
  return (
    <Card className="mb-5 border-warn/40">
      <CardHeader title={`Needs you (${items.length})`} description="Blocked issues, paused projects, daily ceilings, models whose last call failed on billing, state backups that stopped, and lanes waiting over an hour for a machine slot." />
      <ul className="divide-y divide-border/60">
        {items.map((n, i) => {
          const k = NEED[n.kind];
          const Icon = k.icon;
          const target = n.lap_id ? href(`/laps/${n.lap_id}`) : n.slug ? href(`/projects/${n.slug}`) : null;
          return (
            <li key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
              <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${k.color}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Badge tone={k.tone}>{k.label}</Badge>
                  {n.slug && <Link href={href(`/projects/${n.slug}`)}>{n.slug}</Link>}
                  {n.issue != null && (
                    target ? <Link href={target}>#{n.issue}{n.title ? ` ${n.title}` : ""}</Link> : <span>#{n.issue}</span>
                  )}
                  {n.attempts != null && <span className="text-xs text-muted-foreground">×{n.attempts}</span>}
                  {n.at && <span className="text-xs text-muted-foreground">{ago(n.at)}</span>}
                </div>
                <div className="mt-0.5 line-clamp-2 break-all font-mono text-xs text-muted-foreground" title={n.detail}>{n.detail}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function Overview() {
  const { data: d, error } = useApi<Summary>("api/summary", 15_000);
  const { data: sch } = useApi<Scheduling>("api/scheduling", 15_000);
  if (error && !d) return <ErrorNote>Dashboard failed to load: {error}</ErrorNote>;
  if (!d) return <div className="text-sm text-muted-foreground">loading…</div>;
  const k = d.kpis;
  const sched = d.scheduler;
  const allMachines = d.machines.flatMap((p) => p.machines);

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className={`size-2 rounded-full ${sched.daemon_up ? "bg-ok" : "bg-bad"}`} />
              daemon {sched.daemon_up ? "up" : "unreachable"}
            </span>
            <span className="flex items-center gap-1"><Clock aria-hidden className="size-3.5" />
              last pass {ago(sched.last_pass_at)}{sched.next_pass_at && <> · next {ago(sched.next_pass_at)}</>}
              {sched.minutes && <> · every {sched.minutes} min</>}
            </span>
            {d.backup && <span>backup {ago(d.backup.last_ok_at)}</span>}
            <span>{sched.ticks_running.length} repo tick{sched.ticks_running.length === 1 ? "" : "s"} running</span>
            <span className="text-xs">refreshed {new Date(d.generatedAt).toLocaleTimeString()}</span>
          </span>
        }
      />

      <NeedsYouCard items={d.needs_you} />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Laps today" value={k.laps_today} hint={`${k.merged_today} merged`} />
        <Kpi label="Merged · 7d" value={k.merged_7d} tone="text-ok" hint={`${pct(k.merge_rate_7d)} of finished laps`} />
        <Kpi label="Blocked issues" value={k.blocked_issues} tone={k.blocked_issues ? "text-bad" : undefined} hint={`${k.blocked_7d} blocked laps · 7d`} />
        <Kpi label="Cost today" value={usd(k.cost_today)} hint={`${num(k.tokens_today)} tokens`} />
        <Kpi label="Cost · 7d" value={usd(k.cost_7d)} hint={`${num(k.tokens_7d)} tokens`} />
        <Kpi label="Cost · all time" value={usd(k.cost_all)} hint={`${num(k.tokens_all)} tokens`} />
      </div>

      <Card className="mb-5">
        <CardHeader title={`Live laps (${d.live.length})`} description="Laps whose issue is in progress, with the stage running now." />
        {d.live.length === 0 ? (
          <Empty>No lap is running. The next scheduler pass is {ago(sched.next_pass_at)}.</Empty>
        ) : (
          <Table>
            <thead><tr><Th>Project</Th><Th>Issue</Th><Th>Stage</Th><Th>Model</Th><Th align="right">Attempt</Th><Th align="right">Stage age</Th><Th align="right">Lap age</Th></tr></thead>
            <tbody>
              {d.live.map((l) => {
                const running = l.stage && !l.stage.ended_at;
                return (
                  <Tr key={l.id} href={href(`/laps/${l.id}`)}>
                    <Td><Link href={href(`/projects/${l.slug}`)}>{l.slug}</Link></Td>
                    <Td className="max-w-sm truncate"><span className="mr-1.5 font-mono text-xs text-muted-foreground">#{l.issue_number}</span>{l.title}</Td>
                    <Td>
                      {l.stage ? (
                        <Badge tone={running ? "info" : EXIT_TONE(l.stage.exit)}>
                          {running && <span className="size-1.5 animate-pulse rounded-full bg-info" />}
                          {l.stage.stage}{running ? "" : ` · ${l.stage.exit}`}
                        </Badge>
                      ) : <Badge>starting</Badge>}
                    </Td>
                    <Td className="font-mono text-xs text-muted-foreground">{l.stage?.model ?? "—"}</Td>
                    <Td align="right">{l.stage?.attempt ?? l.attempts ?? "—"}</Td>
                    <Td align="right">{running ? since(l.stage!.started_at) : "—"}</Td>
                    <Td align="right">{since(l.started_at)}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="mb-5 grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Tokens used per day" description="Last 30 days of input and output tokens, as recorded per stage." />
          <div className="p-4">
            <BarChart
              label="Tokens used per day"
              layout="stacked"
              categories={d.cost_by_day.map((r) => r.day.slice(5))}
              series={[
                { id: "input", name: "Input", color: "#58a6ff", values: d.cost_by_day.map((r) => r.i) },
                { id: "output", name: "Output", color: "#a371f7", values: d.cost_by_day.map((r) => r.o) },
              ]}
              formatValue={(v) => num(v)}
            />
          </div>
        </Card>
        <Card>
          <CardHeader title="Cost per day" description="Last 30 days of provider cost, as recorded per stage." />
          <div className="p-4">
            <BarChart
              label="Cost per day"
              categories={d.cost_by_day.map((r) => r.day.slice(5))}
              series={[{ id: "cost", name: "Cost", color: "#3fb950", values: d.cost_by_day.map((r) => r.cost) }]}
              formatValue={(v) => usd(v)}
            />
          </div>
        </Card>
      </div>

      <div className="mb-5 grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Model health · 24h" description="Every model a stage tried, fallbacks included." />
          {d.model_health.length === 0 ? <Empty>No stage ran in the last 24 hours.</Empty> : (
            <Table>
              <thead><tr><Th>Model</Th><Th align="right">Tries</Th><Th align="right">OK</Th><Th align="right">Failed</Th><Th>Last</Th></tr></thead>
              <tbody>
                {d.model_health.map((h) => (
                  <Tr key={h.model}>
                    <Td className="font-mono text-xs">{h.model}</Td>
                    <Td align="right">{h.tries}</Td>
                    <Td align="right" className="text-ok">{h.ok}</Td>
                    <Td align="right" className={h.failed ? "text-bad" : undefined}>{h.failed}</Td>
                    <Td title={h.last_error ?? undefined} className="whitespace-nowrap">
                      <Badge tone={h.last_outcome === "ok" ? "ok" : h.last_outcome === "billing" ? "warn" : "bad"}>{h.last_outcome}</Badge>
                      <span className="ml-2 text-xs text-muted-foreground">{ago(h.last_at)}</span>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader
            title={`Machines (${allMachines.length})`}
            description="Lap machines on InstaBox and boxd, matched to their project and issue."
            action={<Link href={href("/scheduling")}>scheduling</Link>}
          />
          <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2 text-xs">
            {d.machines.map((p) => (
              <span key={p.provider} className="flex items-center gap-1.5">
                <span className="font-medium">{p.provider}</span>
                {!p.configured ? <Badge>no key</Badge> : p.error ? <Badge tone="bad" title={p.error}>error</Badge> : (
                  <Badge tone={p.machines.length ? "info" : "neutral"}>{p.machines.filter((m) => m.state === "running").length} running / {p.machines.length}</Badge>
                )}
                {(() => {
                  const pool = sch?.pools.find((x) => x.pool === p.provider);
                  return pool ? (
                    <Badge tone={pool.used >= pool.cap ? "warn" : "neutral"} title="factory slots leased / pool cap; waiting requests">
                      {pool.used}/{pool.cap} slots{pool.waiting ? ` · ${pool.waiting} waiting` : ""}
                    </Badge>
                  ) : null;
                })()}
              </span>
            ))}
          </div>
          {allMachines.length === 0 ? <Empty>No lap machines exist right now.</Empty> : (
            <Table>
              <thead><tr><Th>Machine</Th><Th>Provider</Th><Th>State</Th><Th>Project</Th><Th align="right">Age</Th></tr></thead>
              <tbody>
                {allMachines.map((m) => (
                  <Tr key={m.provider + m.name}>
                    <Td className="font-mono text-xs">{m.name}</Td>
                    <Td>{m.provider}</Td>
                    <Td><Badge tone={m.state === "running" ? "ok" : "neutral"}>{m.state}</Badge></Td>
                    <Td>{m.slug ? <Link href={href(`/projects/${m.slug}`)}>{m.slug}{m.issue != null ? ` #${m.issue}` : ""}</Link> : "—"}</Td>
                    <Td align="right">{since(m.created)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Stages by model · 7d" description="Runs, success rate, average duration (stages recorded with a real start) and spend." />
        <Table>
          <thead><tr><Th>Stage</Th><Th>Model</Th><Th align="right">Runs</Th><Th align="right">OK</Th><Th align="right">Avg time</Th><Th align="right">Tokens</Th><Th align="right">Cost</Th></tr></thead>
          <tbody>
            {d.stage_model.map((s) => (
              <Tr key={s.stage + s.model}>
                <Td>{s.stage}</Td>
                <Td className="font-mono text-xs text-muted-foreground">{s.model}</Td>
                <Td align="right">{s.n}</Td>
                <Td align="right">{pct(s.n ? s.ok / s.n : null)}</Td>
                <Td align="right">{dur(s.avg_s)}</Td>
                <Td align="right">{num((s.i ?? 0) + (s.o ?? 0))}</Td>
                <Td align="right">{usd(s.cost)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {d.stage_model.length === 0 && <Empty>No stages in the last 7 days.</Empty>}
      </Card>
    </>
  );
}
