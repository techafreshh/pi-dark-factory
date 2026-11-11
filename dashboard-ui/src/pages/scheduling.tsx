import { PageHeader } from "@/components/shell";
import { Badge, Card, CardHeader, Empty, ErrorNote, EXIT_TONE, Link, Table, Td, Th, Tr, type Tone } from "@/components/ui";
import { useApi, type MergeQueueRow, type Scheduling } from "@/lib/api";
import { ago, since } from "@/lib/format";
import { href } from "@/lib/router";

const PRIORITY_TONE: Record<string, Tone> = { high: "orange", normal: "neutral", low: "neutral" };
const QUEUE_TONE: Record<string, Tone> = {
  waiting: "neutral",
  rebasing: "violet",
  reverifying: "info",
  merging: "info",
  merged: "ok",
  bounced: "warn",
};

function Priority({ base, effective }: { base: string; effective?: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={PRIORITY_TONE[base] ?? "neutral"}>{base}</Badge>
      {effective && effective !== base && <span className="text-xs text-muted-foreground" title="after aging">→ {effective}</span>}
    </span>
  );
}

function IssueCell({ slug, issue, title, lapId }: { slug: string; issue: number | null; title: string | null; lapId?: number | null }) {
  if (issue == null) return <span className="text-muted-foreground">—</span>;
  const label = (
    <>
      <span className="mr-1.5 font-mono text-xs text-muted-foreground">#{issue}</span>
      {title}
    </>
  );
  return lapId ? <Link href={href(`/laps/${lapId}`)}>{label}</Link> : <Link href={href(`/projects/${slug}`)}>{label}</Link>;
}

function QueueRows({ rows }: { rows: MergeQueueRow[] }) {
  return (
    <>
      {rows.map((r) => (
        <Tr key={r.id} href={href(`/laps/${r.lap_id}`)}>
          <Td className="max-w-sm truncate"><span className="mr-1.5 font-mono text-xs text-muted-foreground">#{r.issue_number}</span>{r.title}</Td>
          <Td><Badge tone={QUEUE_TONE[r.state] ?? "neutral"}>{r.state}</Badge></Td>
          <Td className="max-w-md truncate font-mono text-xs text-muted-foreground" title={r.detail ?? undefined}>{r.detail ?? "—"}</Td>
          <Td align="right">{since(r.entered_at)}</Td>
        </Tr>
      ))}
    </>
  );
}

export function SchedulingPage() {
  const { data: d, error } = useApi<Scheduling>("api/scheduling", 10_000);
  if (error && !d) return <ErrorNote>Scheduling failed to load: {error}</ErrorNote>;
  if (!d) return <div className="text-sm text-muted-foreground">loading…</div>;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Overview", href: href("/") }, { label: "Scheduling" }]}
        title="Scheduling"
        description={
          <span>
            Machine-slot pools, the waiting queue in grant order (first lanes first, then priority with one level per {d.aging_minutes} min waited),
            parallel lanes and merge queues. <span className="text-xs">refreshed {new Date(d.generatedAt).toLocaleTimeString()}{d.daemon_up ? "" : " · daemon unreachable, caps from the dashboard env"}</span>
          </span>
        }
      />

      <div className="mb-5 grid gap-3 md:grid-cols-2">
        {d.pools.map((p) => {
          const full = p.used >= p.cap;
          return (
            <Card key={p.pool} className="px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">{p.pool}</div>
                <Badge tone={full ? "warn" : p.used ? "info" : "neutral"}>{full ? "full" : `${p.cap - p.used} free`}</Badge>
              </div>
              <div className="mt-1 font-mono text-2xl tabular">{p.used}<span className="text-base text-muted-foreground"> / {p.cap}</span></div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div className={`h-full ${full ? "bg-warn" : "bg-info"}`} style={{ width: `${p.cap ? Math.min(100, (p.used / p.cap) * 100) : 0}%` }} />
              </div>
              <div className="mt-1.5 text-xs text-muted-foreground">{p.waiting} waiting · {p.parked} parked between ticks</div>
            </Card>
          );
        })}
      </div>

      <Card className="mb-5">
        <CardHeader title={`Leases (${d.leases.length})`} description="Every lap holding a machine slot, from before its claim until its machine is destroyed." />
        {d.leases.length === 0 ? <Empty>No lap holds a slot right now.</Empty> : (
          <Table>
            <thead><tr><Th>Project</Th><Th>Lane</Th><Th>Issue</Th><Th>Pool</Th><Th>Priority</Th><Th>Stage</Th><Th align="right">Held</Th></tr></thead>
            <tbody>
              {d.leases.map((l) => {
                const running = l.stage && !l.stage.ended_at;
                return (
                  <Tr key={l.id}>
                    <Td><Link href={href(`/projects/${l.slug}`)}>{l.slug}</Link></Td>
                    <Td>{l.lane}</Td>
                    <Td className="max-w-sm truncate"><IssueCell slug={l.slug} issue={l.issue} title={l.title} lapId={l.lap_id} /></Td>
                    <Td>{l.pool}{l.spilled && <Badge tone="violet" className="ml-1.5">spilled</Badge>}</Td>
                    <Td><Priority base={l.priority} /></Td>
                    <Td>
                      {l.stage ? (
                        <Badge tone={running ? "info" : EXIT_TONE(l.stage.exit)}>
                          {running && <span className="size-1.5 animate-pulse rounded-full bg-info" />}
                          {l.stage.stage}{running ? "" : ` · ${l.stage.exit}`}
                        </Badge>
                      ) : <Badge>booting</Badge>}
                    </Td>
                    <Td align="right">{since(l.granted_at)}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="mb-5">
        <CardHeader title={`Waiting queue (${d.waiting.length})`} description="Requests in the order the next free slots go to. Parked requests keep their place while their repo waits for its next tick." />
        {d.waiting.length === 0 ? <Empty>Nothing is waiting for a slot.</Empty> : (
          <Table>
            <thead><tr><Th align="right">#</Th><Th>Project</Th><Th>Lane</Th><Th>Pools</Th><Th>Priority</Th><Th>State</Th><Th align="right">Waiting</Th></tr></thead>
            <tbody>
              {d.waiting.map((w) => (
                <Tr key={w.id}>
                  <Td align="right">{w.position}</Td>
                  <Td><Link href={href(`/projects/${w.slug}`)}>{w.slug}</Link></Td>
                  <Td>{w.lane}{w.extra_lane && <span className="ml-1.5 text-xs text-muted-foreground">extra</span>}</Td>
                  <Td>{w.pools.join(" → ")}</Td>
                  <Td><Priority base={w.priority} effective={w.effective} /></Td>
                  <Td><Badge tone={w.state === "parked" ? "neutral" : "info"}>{w.state}</Badge></Td>
                  <Td align="right">{since(w.requested_at)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="mb-5">
        <CardHeader title="Lanes" description="Parallel projects and every project holding a slot: lanes in use out of the project's maximum." />
        {d.lanes.length === 0 ? <Empty>No project runs in parallel mode, and no lap holds a slot.</Empty> : (
          <Table>
            <thead><tr><Th>Project</Th><Th>Mode</Th><Th>Priority</Th><Th>Lanes</Th><Th>In flight</Th></tr></thead>
            <tbody>
              {d.lanes.map((r) => (
                <Tr key={r.repo} href={href(`/projects/${r.slug}`)}>
                  <Td><Link href={href(`/projects/${r.slug}`)}>{r.slug}</Link></Td>
                  <Td>
                    {r.mode ?? "—"}
                    {r.parallel && <Badge tone="info" className="ml-1.5">parallel</Badge>}
                    {r.spill_over && <Badge tone="violet" className="ml-1.5">spill-over</Badge>}
                  </Td>
                  <Td><Priority base={r.priority} /></Td>
                  <Td className="whitespace-nowrap">
                    <span className="inline-flex gap-1" aria-label={`${r.laps.length} of ${r.max_lanes} lanes in use`}>
                      {Array.from({ length: r.max_lanes }, (_, i) => (
                        <span key={i} className={`size-2.5 rounded-sm ${i < r.laps.length ? "bg-info" : "bg-muted"}`} />
                      ))}
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground">{r.laps.length}/{r.max_lanes}{r.waiting ? ` · ${r.waiting} waiting` : ""}</span>
                  </Td>
                  <Td className="max-w-md truncate">
                    {r.laps.length === 0 ? <span className="text-muted-foreground">—</span> : r.laps.map((l) => (
                      <span key={l.id} className="mr-3 text-xs">
                        <span className="font-mono text-muted-foreground">L{l.lane}</span> #{l.issue ?? "?"} {l.stage?.stage ?? "booting"}
                      </span>
                    ))}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="mb-5">
        <CardHeader title="Merge queues" description="Parallel projects land one approved branch at a time: rebased onto the current main and re-verified when main moved." />
        {d.merge_queues.length === 0 ? <Empty>No merge-queue activity in the last 7 days.</Empty> : (
          <div className="divide-y divide-border">
            {d.merge_queues.map((m) => (
              <div key={m.repo}>
                <div className="flex items-center gap-2 px-4 py-2 text-sm">
                  <Link href={href(`/projects/${m.slug}`)}>{m.slug}</Link>
                  <span className="text-xs text-muted-foreground">{m.open.length} in the queue · last {m.recent.length} finished below</span>
                </div>
                <Table>
                  <thead><tr><Th>Issue</Th><Th>State</Th><Th>Detail</Th><Th align="right">Entered</Th></tr></thead>
                  <tbody>
                    <QueueRows rows={m.open} />
                    <QueueRows rows={m.recent} />
                  </tbody>
                </Table>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title={`Spill-over · 24h (${d.spills.length})`} description="Leases granted on a platform other than the project's own, because its own pool was full." />
        {d.spills.length === 0 ? <Empty>No lap spilled over in the last 24 hours.</Empty> : (
          <Table>
            <thead><tr><Th>Project</Th><Th>Issue</Th><Th>Own</Th><Th>Ran on</Th><Th>Lease</Th><Th align="right">Granted</Th></tr></thead>
            <tbody>
              {d.spills.map((x) => (
                <Tr key={x.id}>
                  <Td><Link href={href(`/projects/${x.slug}`)}>{x.slug}</Link></Td>
                  <Td className="max-w-sm truncate"><IssueCell slug={x.slug} issue={x.issue} title={x.title} /></Td>
                  <Td>{x.own ?? "—"}</Td>
                  <Td>{x.pool}</Td>
                  <Td><Badge tone={x.state === "granted" ? "info" : "neutral"}>{x.state}</Badge></Td>
                  <Td align="right">{ago(x.granted_at)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
