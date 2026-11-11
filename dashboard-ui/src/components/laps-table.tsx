import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { Pagination } from "@/components/motion/pagination";
import {
  MultiSelect, MultiSelectContent, MultiSelectEmpty, MultiSelectInput, MultiSelectItem,
  MultiSelectList, MultiSelectTrigger, MultiSelectValue,
} from "@/components/motion/multi-select";
import { Button, Card, Empty, ErrorNote, Input, Link, Select, STATUS, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";
import { useApi, type LapPage } from "@/lib/api";
import { href, setQuery, type Route } from "@/lib/router";
import { ago, dur, num, usd, when } from "@/lib/format";

const SIZES = [25, 50, 100, 200];

function FacetFilter({ label, options, value, onChange }: {
  label: string; options: { value: string; label: string; color?: string }[]; value: string[]; onChange: (v: string[]) => void;
}) {
  return (
    <div className="w-full sm:w-64">
      <MultiSelect value={value} onValueChange={onChange} labels={{ valuePlaceholder: label, inputPlaceholder: "" }}>
        <MultiSelectTrigger className="min-h-8 text-xs">
          <MultiSelectValue placeholder={label} />
          <MultiSelectInput aria-label={`Filter by ${label.toLowerCase()}`} />
        </MultiSelectTrigger>
        <MultiSelectContent>
          <MultiSelectList ariaLabel={label}>
            {options.map((o) => (
              <MultiSelectItem key={o.value} value={o.value} textValue={o.label}>
                <span className="flex items-center gap-2">
                  {o.color && <span aria-hidden className="size-2 rounded-full" style={{ background: o.color }} />}
                  {o.label}
                </span>
              </MultiSelectItem>
            ))}
            <MultiSelectEmpty>Nothing matches.</MultiSelectEmpty>
          </MultiSelectList>
        </MultiSelectContent>
      </MultiSelect>
    </div>
  );
}

/**
 * The lap list: server-side search, status/project facets, sorting and
 * paging. All state lives in the URL query, so a filtered view is a link.
 * `repo` pins it to one project (the project page).
 */
export function LapsTable({ route, repo, slugs }: { route: Route; repo?: string; slugs?: string[] }) {
  const qp = route.query;
  const sort = qp.get("sort") ?? "id";
  const order = qp.get("order") ?? "desc";
  const size = Number(qp.get("size")) || 50;
  const page = Math.max(1, Number(qp.get("page")) || 1);
  const status = qp.get("status")?.split(",").filter(Boolean) ?? [];
  const repos = repo ? [repo] : qp.get("repo")?.split(",").filter(Boolean) ?? [];
  const q = qp.get("q") ?? "";
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    if (text === q) return;
    const t = setTimeout(() => setQuery({ q: text, page: null }), 300);
    return () => clearTimeout(t);
  }, [text, q]);

  const url = `api/laps?${new URLSearchParams({
    sort, order, limit: String(size), offset: String((page - 1) * size),
    ...(status.length ? { outcome: status.join(",") } : {}),
    ...(repos.length ? { repo: repos.join(",") } : {}),
    ...(q ? { q } : {}),
  })}`;
  const { data, error, loading } = useApi<LapPage>(url, 20_000);
  const totalPages = data ? Math.max(1, Math.ceil(data.total / size)) : 1;

  const onSort = (key: string) =>
    setQuery({ sort: key, order: sort === key && order === "desc" ? "asc" : "desc", page: null });
  const th = { sort, order, onSort };
  const filtered = status.length > 0 || (!repo && repos.length > 0) || q;

  return (
    <Card>
      <div className="flex flex-col gap-2 border-b border-border p-3 lg:flex-row lg:items-start">
        <label className="relative w-full lg:w-72">
          <span className="sr-only">Search laps</span>
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search title, #issue, error…" className="pl-8" />
        </label>
        <FacetFilter
          label="Status"
          value={status}
          onChange={(v) => setQuery({ status: v.join(","), page: null })}
          options={Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label, color: s.color }))}
        />
        {!repo && slugs && (
          <FacetFilter
            label="Project"
            value={repos}
            onChange={(v) => setQuery({ repo: v.join(","), page: null })}
            options={slugs.map((s) => ({ value: s, label: s }))}
          />
        )}
        {filtered && (
          <Button onClick={() => setQuery({ q: null, status: null, repo: null, page: null })}>
            <X className="size-3.5" aria-hidden /> Reset
          </Button>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground lg:ml-auto">
          {loading && <span aria-live="polite">loading…</span>}
          <label className="flex items-center gap-1.5">
            Rows
            <Select value={size} onChange={(e) => setQuery({ size: e.target.value, page: null })}>
              {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </label>
        </div>
      </div>

      {error && <div className="p-3"><ErrorNote>Could not load laps: {error}</ErrorNote></div>}

      <Table>
        <thead>
          <tr>
            <Th sortKey="id" {...th}>Lap</Th>
            {!repo && <Th sortKey="repo" {...th}>Project</Th>}
            <Th sortKey="issue" {...th}>Issue</Th>
            <Th sortKey="status" {...th}>Status</Th>
            <Th sortKey="started" {...th}>Started</Th>
            <Th sortKey="duration" {...th} align="right">Duration</Th>
            <Th sortKey="attempts" {...th} align="right">Attempts</Th>
            <Th sortKey="tokens" {...th} align="right">Tokens</Th>
            <Th sortKey="cost" {...th} align="right">Cost</Th>
          </tr>
        </thead>
        <tbody>
          {data?.rows.map((l) => (
            <Tr key={l.id} href={href(`/laps/${l.id}`)}>
              <Td className="font-mono text-xs text-muted-foreground">{l.id}</Td>
              {!repo && <Td className="whitespace-nowrap"><Link href={href(`/projects/${l.slug}`)}>{l.slug}</Link></Td>}
              <Td className="min-w-64 max-w-sm">
                <div className="truncate">
                  <span className="mr-1.5 font-mono text-xs text-muted-foreground">#{l.issue_number}</span>
                  {l.title ?? <span className="text-muted-foreground">untitled</span>}
                </div>
                {l.detail && l.status !== "merged" && <div className="truncate text-xs text-muted-foreground" title={l.detail}>{l.detail}</div>}
              </Td>
              <Td><StatusBadge status={l.status} /></Td>
              <Td className="whitespace-nowrap text-muted-foreground" title={l.started_at}>{when(l.started_at)} <span className="text-xs">· {ago(l.started_at)}</span></Td>
              <Td align="right">{l.status === "running" ? <span className="text-info">{dur((Date.now() - Date.parse(l.started_at)) / 1000)}</span> : dur(l.duration_s)}</Td>
              <Td align="right">{l.attempts ?? "—"}</Td>
              <Td align="right">{num((l.i ?? 0) + (l.o ?? 0))}</Td>
              <Td align="right">{usd(l.cost)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {data && data.rows.length === 0 && <Empty>No laps match these filters.</Empty>}

      <div className="flex flex-col items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground sm:flex-row">
        <span className="tabular">
          {data ? (data.total === 0 ? "0 laps" : `${data.offset + 1}–${data.offset + data.rows.length} of ${data.total.toLocaleString()} laps`) : " "}
        </span>
        {totalPages > 1 && <Pagination totalPages={totalPages} page={Math.min(page, totalPages)} onPageChange={(p) => setQuery({ page: p === 1 ? null : p })} />}
      </div>
    </Card>
  );
}
