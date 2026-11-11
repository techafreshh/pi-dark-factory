import { useMemo, useState } from "react";
import { Bot, Brain, ChevronDown, FileText, Lock, User } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleIndicator, CollapsibleTrigger } from "@/components/motion/collapsible";
import { ToolResult, ToolResultOutput } from "@/components/agents/tool-result";
import { Badge, Button, Card, Empty, ErrorNote } from "@/components/ui";
import { useApi, type Session, type SessionMessage, type SessionPart } from "@/lib/api";
import { bytes, dur, num, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

/** one line that says what a tool call did: the command, the path, the pattern */
function summarize(args: string, cwd?: string): string {
  let out = args.replace(/\s+/g, " ");
  try {
    const a = JSON.parse(args);
    const v = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.url ?? a.query ?? a.urls?.[0];
    if (typeof v === "string") out = v.split("\n")[0];
  } catch {}
  // paths inside the session's working directory read better relative
  if (cwd) out = out.split(cwd + "/").join("").split(cwd).join(".");
  return out.slice(0, 200);
}

const lang = (name: string) => (name === "bash" ? "bash" : "text") as "bash" | "text";

function ToolCall({ call, result, cwd }: { call: Extract<SessionPart, { type: "tool_call" }>; result?: SessionMessage; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const out = result?.parts[0]?.type === "text" ? result.parts[0].text : "";
  const status = !result ? "cancelled" : result.isError ? "error" : "success";
  return (
    <ToolResult
      tool={call.name}
      title={<span className="font-mono text-xs font-normal">{summarize(call.args, cwd)}</span>}
      status={status}
      meta={result?.durationMs && result.durationMs >= 1000 ? dur(result.durationMs / 1000) : undefined}
      open={open}
      onOpenChange={setOpen}
      collapseOnComplete={false}
      maxHeight={420}
      copyText={out || call.args}
      labels={{ cancelled: "no result" }}
    >
      {/* mounted only while open: hundreds of highlighted outputs would stall the page */}
      {open ? (
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">arguments</div>
            <ToolResultOutput language="json">{call.args}</ToolResultOutput>
          </div>
          {result && (
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{result.isError ? "error" : "output"}</div>
              <ToolResultOutput language={lang(call.name)}>{out || "(empty)"}</ToolResultOutput>
            </div>
          )}
        </div>
      ) : <span />}
    </ToolResult>
  );
}

function Thinking({ part }: { part: Extract<SessionPart, { type: "thinking" }> }) {
  const long = part.text.length > 700;
  const [open, setOpen] = useState(!long);
  if (part.redacted) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Lock aria-hidden className="size-3.5" /> reasoning encrypted by the provider
      </div>
    );
  }
  return (
    <div className="rounded-lg border-l-2 border-violet/60 bg-violet/5 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-violet">
        <Brain aria-hidden className="size-3.5" /> thinking
      </div>
      <p className={cn("whitespace-pre-wrap break-words text-[13px] italic leading-relaxed text-foreground/75", !open && "line-clamp-6")}>{part.text}</p>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-xs text-violet hover:underline">
          {open ? "show less" : `show all (${num(part.text.length)} chars)`}
        </button>
      )}
    </div>
  );
}

function Prose({ text }: { text: string }) {
  return <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">{text}</div>;
}

function Disclosure({ icon, title, meta, children, defaultOpen = false }: { icon: React.ReactNode; title: string; meta?: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-lg border border-border">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring">
        {icon}
        <span className="font-medium">{title}</span>
        {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
        <CollapsibleIndicator className="ml-auto text-muted-foreground"><ChevronDown className="size-4" /></CollapsibleIndicator>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="max-h-[60vh] overflow-y-auto border-t border-border px-3 py-2">
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/80">{children}</pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const PAGE = 60;

export function SessionView({ slug, issue, file }: { slug: string; issue: number; file: string }) {
  const { data, error, loading } = useApi<Session>(`api/session?${new URLSearchParams({ slug, issue: String(issue), file })}`);
  const [showThinking, setShowThinking] = useState(true);
  const [limit, setLimit] = useState(PAGE);

  const results = useMemo(() => {
    const m = new Map<string, SessionMessage>();
    for (const msg of data?.messages ?? []) if (msg.role === "tool" && msg.toolCallId) m.set(msg.toolCallId, msg);
    return m;
  }, [data]);
  const callIds = useMemo(() => {
    const s = new Set<string>();
    for (const msg of data?.messages ?? []) for (const p of msg.parts) if (p.type === "tool_call") s.add(p.id);
    return s;
  }, [data]);

  if (error) return <ErrorNote>Could not read {file}: {error}</ErrorNote>;
  if (!data || data.file !== file) return <div className="p-4 text-sm text-muted-foreground">{loading ? "reading session…" : ""}</div>;

  const st = data.stats;
  // tool results render inside their call; only orphans show on their own
  const shown = data.messages.filter((m) => !(m.role === "tool" && m.toolCallId && callIds.has(m.toolCallId)));
  let turn = 0;

  return (
    <div>
      <Card className="mb-4 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span><b className="text-foreground">{st.turns}</b> turns</span>
          <span><b className="text-foreground">{st.tool_calls}</b> tool calls{st.tool_errors ? <span className="text-bad"> · {st.tool_errors} failed</span> : null}</span>
          <span><b className="text-foreground">{num(st.input)}</b> in · <b className="text-foreground">{num(st.output)}</b> out · {num(st.cacheRead)} cached</span>
          {st.cost > 0 && <span>{usd(st.cost)}</span>}
          <span>{st.thinking} readable thoughts{st.thinking_redacted ? ` · ${st.thinking_redacted} encrypted` : ""}</span>
          <span className="flex flex-wrap gap-1">{Object.entries(st.tools).sort((a, b) => b[1] - a[1]).map(([t, n]) => <Badge key={t}>{t} {n}</Badge>)}</span>
          <span className="ml-auto flex items-center gap-2">
            <span className="font-mono">{st.models.join(", ")}</span>
            <span>{bytes(data.bytes)}</span>
            <Button active={showThinking} onClick={() => setShowThinking(!showThinking)} aria-pressed={showThinking}>
              <Brain aria-hidden className="size-3.5" /> Thinking
            </Button>
          </span>
        </div>
        {data.truncated && <p className="mt-2 text-xs text-warn">The stored stream was capped, so the end of this session is missing.</p>}
      </Card>

      {shown.length === 0 && <Empty>This session file has no messages.</Empty>}
      <ol className="space-y-3">
        {shown.slice(0, limit).map((m, i) => {
          if (m.role === "system") {
            const text = m.parts[0]?.type === "text" ? m.parts[0].text : "";
            return <li key={i}><Disclosure icon={<FileText aria-hidden className="size-4 text-muted-foreground" />} title="System prompt" meta={`${num(text.length)} chars`}>{text}</Disclosure></li>;
          }
          if (m.role === "user") {
            const text = m.parts[0]?.type === "text" ? m.parts[0].text : "";
            return <li key={i}><Disclosure icon={<User aria-hidden className="size-4 text-info" />} title="Prompt" meta={`${num(text.length)} chars`}>{text}</Disclosure></li>;
          }
          if (m.role === "tool") {
            return (
              <li key={i} className="pl-9">
                <Disclosure icon={<FileText aria-hidden className="size-4" />} title={`${m.toolName ?? "tool"} result`}>{m.parts[0]?.type === "text" ? m.parts[0].text : ""}</Disclosure>
              </li>
            );
          }
          turn++;
          const parts = m.parts.filter((p) => (showThinking || p.type !== "thinking") && !(p.type === "text" && !p.text.trim()));
          return (
            <li key={i} className="flex gap-3">
              <div aria-hidden className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-border bg-muted">
                <Bot className="size-3.5 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Turn {turn}</span>
                  {m.durationMs != null && <span>{dur(m.durationMs / 1000)}</span>}
                  {m.usage && <span>{num(m.usage.input)} in · {num(m.usage.output)} out</span>}
                  {m.stopReason && m.stopReason !== "toolUse" && m.stopReason !== "stop" && <Badge tone="warn">{m.stopReason}</Badge>}
                  {m.ts && <time className="ml-auto">{new Date(m.ts).toLocaleTimeString()}</time>}
                </div>
                {m.error && <ErrorNote>{m.error}</ErrorNote>}
                {parts.length === 0 && <div className="text-xs text-muted-foreground">(no content)</div>}
                {parts.map((p, j) =>
                  p.type === "thinking" ? <Thinking key={j} part={p} /> :
                  p.type === "text" ? <Prose key={j} text={p.text} /> :
                  <ToolCall key={j} call={p} result={results.get(p.id)} cwd={data.header?.cwd} />
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {shown.length > limit && (
        <div className="mt-4 flex justify-center">
          <Button onClick={() => setLimit(limit + PAGE * 2)}>Show more ({shown.length - limit} messages left)</Button>
        </div>
      )}
    </div>
  );
}
