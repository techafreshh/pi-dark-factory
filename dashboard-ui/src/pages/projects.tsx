import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { PageHeader } from "@/components/shell";
import { LapsTable } from "@/components/laps-table";
import { Badge, Card, Empty, ErrorNote, Input, Kpi, Link, Table, Td, Th, Tr } from "@/components/ui";
import { useApi, type Project } from "@/lib/api";
import { href, setQuery, type Route } from "@/lib/router";
import { ago, num, pct, usd } from "@/lib/format";

type Key = keyof Project;
const NUMERIC: Key[] = ["laps", "merged", "laps_7d", "merged_7d", "issues_blocked", "tokens", "cost", "cost_7d"];

export function Projects({ route }: { route: Route }) {
  const { data, error } = useApi<{ rows: Project[] }>("api/projects", 30_000);
  const sort = (route.query.get("sort") ?? "last_lap") as Key;
  const order = route.query.get("order") ?? "desc";
  const [filter, setFilter] = useState("");

  const rows = useMemo(() => {
    const list = (data?.rows ?? []).filter((r) => !filter || r.slug.toLowerCase().includes(filter.toLowerCase()));
    const dir = order === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      const x = a[sort] ?? (NUMERIC.includes(sort) ? 0 : ""), y = b[sort] ?? (NUMERIC.includes(sort) ? 0 : "");
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
  }, [data, filter, sort, order]);
  const onSort = (key: string) => setQuery({ sort: key, order: sort === key && order === "desc" ? "asc" : "desc" });
  const th = { sort, order, onSort };

  if (error && !data) return <ErrorNote>Could not load projects: {error}</ErrorNote>;
  return (
    <>
      <PageHeader title="Projects" description="Every onboarded repository. Pick one to see its laps." />
      <Card>
        <div className="border-b border-border p-3">
          <label className="relative block w-full sm:w-72">
            <span className="sr-only">Filter projects</span>
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter projects…" className="pl-8" />
          </label>
        </div>
        <Table>
          <thead>
            <tr>
              <Th sortKey="slug" {...th}>Project</Th>
              <Th sortKey="mode" {...th}>Lane</Th>
              <Th>State</Th>
              <Th sortKey="laps" {...th} align="right">Laps</Th>
              <Th sortKey="merged" {...th} align="right">Merged</Th>
              <Th sortKey="merged_7d" {...th} align="right">Merged · 7d</Th>
              <Th sortKey="issues_blocked" {...th} align="right">Blocked</Th>
              <Th sortKey="cost_7d" {...th} align="right">Cost · 7d</Th>
              <Th sortKey="cost" {...th} align="right">Cost</Th>
              <Th sortKey="last_lap" {...th}>Last lap</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.repo} href={href(`/projects/${r.slug}`)}>
                <Td><Link href={href(`/projects/${r.slug}`)}>{r.slug}</Link></Td>
                <Td className="text-muted-foreground">{r.mode ?? "—"}</Td>
                <Td>
                  <span className="flex gap-1">
                    {r.running && <Badge tone="info"><span className="size-1.5 animate-pulse rounded-full bg-info" />running</Badge>}
                    {r.paused && <Badge tone="warn" title={r.paused.reason}>paused</Badge>}
                    {!r.onboarded && <Badge>removed</Badge>}
                    {!r.running && !r.paused && r.onboarded && <Badge>idle</Badge>}
                  </span>
                </Td>
                <Td align="right">{r.laps}</Td>
                <Td align="right">{r.merged} <span className="text-xs text-muted-foreground">({pct(r.laps ? r.merged / r.laps : null)})</span></Td>
                <Td align="right">{r.merged_7d}</Td>
                <Td align="right" className={r.issues_blocked ? "text-bad" : undefined}>{r.issues_blocked}</Td>
                <Td align="right">{usd(r.cost_7d)}</Td>
                <Td align="right">{usd(r.cost)}</Td>
                <Td className="text-muted-foreground">{ago(r.last_lap)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {data && rows.length === 0 && <Empty>No project matches.</Empty>}
      </Card>
    </>
  );
}

export function ProjectPage({ route, slug }: { route: Route; slug: string }) {
  const { data } = useApi<{ rows: Project[] }>("api/projects", 30_000);
  const p = data?.rows.find((r) => r.slug === slug);
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Projects", href: "#/projects" }, { label: slug }]}
        title={slug}
        description={p && (
          <span className="flex flex-wrap items-center gap-2">
            <Link href={`https://github.com/${p.repo}`} external>{p.repo}</Link>
            {p.mode && <Badge>{p.mode}</Badge>}
            {p.running && <Badge tone="info">running</Badge>}
            {p.paused && <Badge tone="warn">paused {ago(p.paused.at)}: {p.paused.reason}</Badge>}
            <a className="text-xs hover:text-foreground" href={href("/activity", { slug })}>activity log →</a>
          </span>
        )}
      />
      {p && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label="Laps" value={p.laps} hint={`${p.laps_7d} in 7d`} />
          <Kpi label="Merged" value={p.merged} tone="text-ok" hint={`${p.merged_7d} in 7d`} />
          <Kpi label="Merge rate" value={pct(p.laps ? p.merged / p.laps : null)} />
          <Kpi label="Blocked issues" value={p.issues_blocked} tone={p.issues_blocked ? "text-bad" : undefined} />
          <Kpi label="Cost · 7d" value={usd(p.cost_7d)} />
          <Kpi label="Cost · all" value={usd(p.cost)} hint={`${num(p.tokens)} tokens`} />
        </div>
      )}
      <LapsTable route={route} repo={slug} />
    </>
  );
}

export function LapsPage({ route }: { route: Route }) {
  const { data } = useApi<{ rows: Project[] }>("api/projects", 60_000);
  const slugs = (data?.rows ?? []).map((r) => r.slug).sort();
  return (
    <>
      <PageHeader title="Laps" description="Every lap the factory ran. Search, filter, sort; open one to read its sessions." />
      <LapsTable route={route} slugs={slugs} />
    </>
  );
}
