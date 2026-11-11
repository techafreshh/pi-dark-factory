import { ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/shell";
import { SessionView } from "@/components/session-view";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { Badge, Card, CardHeader, Empty, ErrorNote, EXIT_TONE, Link, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";
import { useApi, type Artifact, type LapDetail } from "@/lib/api";
import { href, setQuery, type Route } from "@/lib/router";
import { bytes, dur, num, usd, when } from "@/lib/format";
import { cn } from "@/lib/utils";

export function LapPage({ route, id }: { route: Route; id: number }) {
  const { data: d, error } = useApi<LapDetail>(`api/laps/${id}`, 15_000);
  const tab = route.query.get("tab") ?? "session";
  if (error && !d) return <ErrorNote>Could not load lap {id}: {error}</ErrorNote>;
  if (!d) return <div className="text-sm text-muted-foreground">loading…</div>;
  const { lap } = d;
  const slug = lap.slug ?? lap.repo;

  // every session file this lap touched, in stage order, then unclaimed ones
  const files: { a: Artifact; label: string }[] = [];
  for (const s of d.stages) if (s.artifact) files.push({ a: s.artifact, label: `${s.stage} · attempt ${s.attempt}` });
  for (const a of d.extra_artifacts) files.push({ a, label: a.stage ? `${a.stage} · attempt ${a.attempt}` : "session" });
  const file = route.query.get("file") ?? files[0]?.a.file ?? null;
  const duration = lap.ended_at ? (Date.parse(lap.ended_at) - Date.parse(lap.started_at)) / 1000 : (Date.now() - Date.parse(lap.started_at)) / 1000;
  const totals = d.stages.reduce((t, s) => ({ i: t.i + (s.input_tokens ?? 0), o: t.o + (s.output_tokens ?? 0), c: t.c + (s.cost ?? 0) }), { i: 0, o: 0, c: 0 });

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Projects", href: "#/projects" }, { label: slug, href: href(`/projects/${slug}`) }, { label: `Lap ${lap.id}` }]}
        title={<><span className="mr-2 font-mono text-muted-foreground">#{lap.issue_number}</span>{lap.title ?? "untitled issue"}</>}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge status={lap.status} />
            <span>started {when(lap.started_at)}</span>
            <span>{lap.ended_at ? "took" : "running for"} {dur(duration)}</span>
            <span>{d.stages.length} stages · {num(totals.i + totals.o)} tokens · {usd(totals.c)}</span>
            <Link href={`https://github.com/${lap.repo}/issues/${lap.issue_number}`} external>issue <ExternalLink aria-hidden className="inline size-3" /></Link>
            {lap.pr && <Link href={`https://github.com/${lap.repo}/pull/${lap.pr}`} external>PR #{lap.pr} <ExternalLink aria-hidden className="inline size-3" /></Link>}
          </span>
        }
      />

      {lap.detail && lap.status !== "merged" && (
        <pre className="mb-4 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-muted-foreground">{lap.detail}</pre>
      )}

      {d.issue_laps.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          Laps of this issue:
          {d.issue_laps.map((l) => (
            <a key={l.id} href={href(`/laps/${l.id}`)} aria-current={l.id === lap.id ? "page" : undefined}
              className={cn("rounded-md border px-1.5 py-0.5 font-mono hover:text-foreground", l.id === lap.id ? "border-ring/60 text-foreground" : "border-border")}>
              {l.id} <span className="font-sans">{l.status}</span>
            </a>
          ))}
        </div>
      )}

      <Card className="mb-5">
        <CardHeader title="Stages" description="Each agent stage the lap ran. Pick one with a session to read it below." />
        {d.stages.length === 0 ? <Empty>This lap recorded no stages.</Empty> : (
          <Table className={d.stages.length > 8 ? "max-h-[372px] overflow-y-auto" : undefined}>
            <thead><tr><Th>Stage</Th><Th align="right">Attempt</Th><Th>Model</Th><Th>Exit</Th><Th>Started</Th><Th align="right">Duration</Th><Th align="right">Tokens</Th><Th align="right">Cost</Th><Th>Session</Th></tr></thead>
            <tbody>
              {d.stages.map((s) => {
                const selected = s.artifact && s.artifact.file === file;
                const fallback = s.tried && s.tried.length > 1;
                return (
                  <Tr key={s.id} className={cn(selected && "bg-muted/60")}
                    onClick={s.artifact ? () => setQuery({ file: s.artifact!.file, tab: "session" }) : undefined}>
                    <Td className="font-medium">{s.stage}</Td>
                    <Td align="right">{s.attempt}</Td>
                    <Td className="font-mono text-xs text-muted-foreground">
                      {s.model}
                      {fallback && (
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {s.tried!.map((t, i) => <Badge key={i} tone={t.outcome === "ok" ? "ok" : "bad"} title={t.error}>{t.model.split("/").pop()}</Badge>)}
                        </div>
                      )}
                    </Td>
                    <Td title={s.error ?? undefined}><Badge tone={EXIT_TONE(s.exit)}>{s.exit ?? "running"}</Badge></Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{when(s.started_at ?? s.ended_at)}</Td>
                    <Td align="right">{dur(s.duration_s)}</Td>
                    <Td align="right">{num((s.input_tokens ?? 0) + (s.output_tokens ?? 0))}</Td>
                    <Td align="right">{usd(s.cost)}</Td>
                    <Td>{s.artifact ? <span className={cn("text-xs", selected ? "text-foreground" : "text-info")}>{selected ? "▸ viewing" : "view"} · {bytes(s.artifact.bytes)}</span> : <span className="text-xs text-muted-foreground">—</span>}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Tabs value={tab} onValueChange={(v) => setQuery({ tab: v === "session" ? null : v })} variant="underline">
        <TabsList>
          <TabsTrigger value="session">Session</TabsTrigger>
          <TabsTrigger value="plan">Plan</TabsTrigger>
          <TabsTrigger value="files">Files ({files.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="session" className="pt-4">
          {file && lap.slug ? <SessionView key={file} slug={lap.slug} issue={lap.issue_number} file={file} /> : (
            <Empty>No session file survives for this lap. Machine stage files are named by attempt, so a later lap of the same issue overwrites them.</Empty>
          )}
        </TabsContent>
        <TabsContent value="plan" className="pt-4">
          {d.plan ? (
            <Card className="p-4"><pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/85">{d.plan}</pre></Card>
          ) : <Empty>No plan.md for this issue.</Empty>}
          <p className="mt-2 text-xs text-muted-foreground">plan.md holds the issue's latest plan, which may come from a later lap.</p>
        </TabsContent>
        <TabsContent value="files" className="pt-4">
          <Card>
            {files.length === 0 ? <Empty>No session files matched this lap.</Empty> : (
              <Table>
                <thead><tr><Th>File</Th><Th>Stage</Th><Th>Kind</Th><Th>Written</Th><Th align="right">Size</Th></tr></thead>
                <tbody>
                  {files.map(({ a, label }) => (
                    <Tr key={a.file} onClick={() => setQuery({ file: a.file, tab: null })} className={cn(a.file === file && "bg-muted/60")}>
                      <Td className="font-mono text-xs">{a.file}</Td>
                      <Td>{label}</Td>
                      <Td className="text-muted-foreground">{a.kind}</Td>
                      <Td className="text-muted-foreground">{when(a.ended)}</Td>
                      <Td align="right">{bytes(a.bytes)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
