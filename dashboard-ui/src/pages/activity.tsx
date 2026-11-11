import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { PageHeader } from "@/components/shell";
import { Card, ErrorNote, Input, Select } from "@/components/ui";
import { useApi, type Project } from "@/lib/api";
import { setQuery, type Route } from "@/lib/router";
import { cn } from "@/lib/utils";

const LINE_RE = /^\[([^\]]+)\] (?:\[([^\]]+)\] )?(.*)$/;
const tone = (msg: string) =>
  /BLOCKED|failed|ERROR|BILLING HOLD/i.test(msg) ? "text-bad" : /merged|verify green|opened PR/i.test(msg) ? "text-ok" : /attempt \d+\/|lap #/.test(msg) ? "text-info" : "text-foreground/80";

export function ActivityPage({ route }: { route: Route }) {
  const slug = route.query.get("slug") ?? "";
  const q = route.query.get("q") ?? "";
  const [text, setText] = useState(q);
  useEffect(() => {
    setText(q);
  }, [q]);
  useEffect(() => {
    if (text === q) return;
    const t = setTimeout(() => setQuery({ q: text }), 300);
    return () => clearTimeout(t);
  }, [text, q]);
  const { data: projects } = useApi<{ rows: Project[] }>("api/projects", 60_000);
  const { data, error } = useApi<{ lines: string[] }>(`api/activity?${new URLSearchParams({ limit: "500", ...(slug ? { slug } : {}), ...(q ? { q } : {}) })}`, 10_000);

  return (
    <>
      <PageHeader title="Activity" description="The factory's receipts (laps.log), newest first. Refreshes every 10 s." />
      <Card>
        <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row">
          <label className="relative w-full sm:w-72">
            <span className="sr-only">Search activity</span>
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search receipts…" className="pl-8" />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Project
            <Select value={slug} onChange={(e) => setQuery({ slug: e.target.value })}>
              <option value="">all</option>
              {(projects?.rows ?? []).map((p) => p.slug).sort().map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </label>
        </div>
        {error && <div className="p-3"><ErrorNote>{error}</ErrorNote></div>}
        <ol className="max-h-[75vh] overflow-y-auto p-2 font-mono text-xs leading-relaxed">
          {(data?.lines ?? []).slice().reverse().map((l, i) => {
            const m = LINE_RE.exec(l);
            return (
              <li key={i} className="flex gap-3 rounded px-2 py-0.5 hover:bg-muted/50">
                <time className="shrink-0 text-muted-foreground">{m ? new Date(m[1]).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""}</time>
                {m?.[2] && <a href={`#/projects/${m[2]}`} className="shrink-0 text-info hover:underline">{m[2]}</a>}
                <span className={cn("min-w-0 whitespace-pre-wrap break-words", tone(m?.[3] ?? l))}>{m?.[3] ?? l}</span>
              </li>
            );
          })}
          {data && data.lines.length === 0 && <li className="p-6 text-center text-muted-foreground">No receipts match.</li>}
        </ol>
      </Card>
    </>
  );
}
