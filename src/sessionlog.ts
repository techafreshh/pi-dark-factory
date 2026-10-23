/**
 * sessionlog — render pi session jsonl (the machine replay format pi reads
 * back with --session) as something a human can follow live. The jsonl is
 * one JSON blob per event, including every few-byte thinking delta, so raw
 * tailing is noise; this renders the spine: what tool ran with what
 * command, what each tool returned, how much the model thought, and what it
 * finally said.
 *
 * Used two ways:
 *  - `bun src/sessionlog.ts <file.jsonl> [--follow] [--think]` from a shell
 *  - factoryd GET /session/:slug (streams this through to the laptop's
 *    `factory-remote session <slug> --follow`)
 *
 * Deltas (message_update) are skipped on purpose — tool starts and tool
 * results land the moment they happen, and each turn produces a thinking
 * marker (with its char count, a live signal for reasoning storms), so the
 * stream updates in near-real-time without megabytes of delta spam.
 * --think adds the model's reasoning text, capped per turn.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RenderOpts {
  think?: boolean;
  color?: boolean;
}

/** per-render mutable state (thinking-mark dedup etc.) */
export interface RenderState {
  sawAny: boolean;
}

export const newRenderState = (): RenderState => ({ sawAny: false });

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + ` …(+${s.length - n} chars)` : s);

const paint = (opts: RenderOpts, code: string, s: string) => (opts.color ? `\x1b[${code}m${s}\x1b[0m` : s);

function stamp(ts: unknown): string {
  let iso: string;
  if (typeof ts === "number") iso = new Date(ts).toISOString();
  else if (typeof ts === "string" && ts.length >= 19) iso = ts;
  else return "";
  return iso.slice(11, 19);
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Render one jsonl line; "" when the line carries nothing worth showing. */
export function renderSessionLine(raw: string, opts: RenderOpts, st: RenderState): string {
  const line = raw.trim();
  if (!line) return "";
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return "";
  }
  const t = d.type;
  const ts = stamp(d.timestamp);

  if (t === "tool_execution_start") {
    const a = d.args ?? {};
    const brief = oneLine(String(a.command ?? a.cmd ?? a.prompt ?? JSON.stringify(a)));
    st.sawAny = true;
    return `${ts}▶ ${d.toolName}: ${paint(opts, "96", cap(brief, 220))}\n`;
  }

  if (t === "message" && d.message?.role === "toolResult") {
    const text = (d.message.content ?? [])
      .filter((p: any) => p?.type === "text")
      .map((p: any) => String(p.text ?? ""))
      .join("\n")
      .replace(/\s+$/, "");
    if (!text.trim()) return "";
    st.sawAny = true;
    return `${ts}⎸ ${paint(opts, "90", cap(text, 900).split("\n").join("\n  "))}\n\n`;
  }

  if ((t === "message" || t === "message_end") && d.message?.role === "assistant") {
    const m = d.message;
    const out: string[] = [];
    for (const part of m.content ?? []) {
      if (part?.type === "thinking" && part.thinking) {
        if (opts.think) {
          out.push(paint(opts, "90", `${ts}·· think: ${cap(oneLine(part.thinking), 1200)}`));
        } else {
          out.push(paint(opts, "90", `${ts}⋯ thinking (${part.thinking.length} chars)`));
        }
      } else if (part?.type === "text" && String(part.text ?? "").trim()) {
        const fin = m.stopReason === "stop";
        st.sawAny = true;
        const text = oneLine(part.text);
        out.push(fin ? `${ts}${paint(opts, "92", "✔ FINAL")} ${cap(text, 3000)}` : `${ts}· ${cap(text, 400)}`);
      }
      // toolCall parts are surfaced by tool_execution_start instead
    }
    return out.length ? out.join("\n") + "\n" : "";
  }
  return "";
}

/** Render a buffer of complete lines through a shared state object. */
export function renderSessionText(text: string, opts: RenderOpts, st: RenderState): string {
  let out = "";
  for (const l of text.split("\n")) out += renderSessionLine(l, opts, st);
  return out;
}

/** Newest session jsonl across a slug's issues (or a pinned issue number). */
export function newestSessionFileForSlug(stateDir: string, slug: string, issue?: number): string | null {
  const root = join(stateDir, "repos", slug, "issues");
  let dirs: string[];
  try {
    dirs = issue !== undefined ? [String(issue)] : readdirSync(root).filter((d) => /^\d+$/.test(d));
  } catch {
    return null;
  }
  let best: { f: string; m: number } | null = null;
  for (const dir of dirs) {
    // machine-mode (instabox) stages run in the box: their event streams are
    // captured beside the issue dir as implement-<attempt>.jsonl /
    // review-<attempt>.jsonl (written when the stage settles) rather than in
    // sessions/ — same pi event format, so they compete on newest-wins
    const candidates: string[] = [];
    const sdir = join(root, dir, "sessions");
    try {
      candidates.push(...readdirSync(sdir).filter((f) => f.endsWith(".jsonl")).map((f) => join(sdir, f)));
    } catch {}
    const idir = join(root, dir);
    try {
      candidates.push(
        ...readdirSync(idir)
          .filter((f) => /^(implement|review)-\d+\.jsonl$/.test(f))
          .map((f) => join(idir, f))
      );
    } catch {}
    for (const p of candidates) {
      try {
        const m = statSync(p).mtimeMs;
        if (!best || m > best.m) best = { f: p, m };
      } catch {}
    }
  }
  return best?.f ?? null;
}

/** Read [start,end) bytes of a file, looping to fill the buffer. */
export function readSlice(path: string, start: number, end: number): string {
  const fd = openSync(path, "r");
  try {
    const want = end - start;
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Last maxBytes of a file, first partial line dropped so every line parses. */
export function readSessionTail(path: string, maxBytes = 4_000_000): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  let s = readSlice(path, start, size);
  if (start > 0) {
    const nl = s.indexOf("\n");
    s = nl >= 0 ? s.slice(nl + 1) : "";
  }
  return s;
}

/** Render a whole session (tail-capped) — one-shot views and postmortems. */
export function renderSessionFile(path: string, opts: RenderOpts, tailBytes = 8_000_000): string {
  return renderSessionText(readSessionTail(path, tailBytes), opts, newRenderState());
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("-"));
  if (!file) {
    console.error("usage: bun src/sessionlog.ts <session.jsonl> [--follow] [--think] [--color]");
    process.exit(1);
  }
  const opts: RenderOpts = {
    think: args.includes("--think"),
    color: args.includes("--color") || Boolean((process.stdout as any).isTTY),
  };
  process.stdout.write(renderSessionFile(file, opts));
  if (!args.includes("--follow")) process.exit(0);
  const st = newRenderState();
  // follow mode: skip the already-rendered prefix, then stream appends
  let pos = 0;
  try {
    pos = statSync(file).size - readSessionTail(file, 8_000_000).length;
  } catch {}
  if (pos < 0) pos = 0;
  let buf = "";
  let lastBeat = Date.now();
  setInterval(() => {
    try {
      const size = statSync(file).size;
      if (size > pos) {
        buf += readSlice(file, pos, size);
        pos = size;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        const out = renderSessionText(lines.join("\n") + "\n", opts, st);
        if (out) process.stdout.write(out);
      } else if (Date.now() - lastBeat > 60_000) {
        process.stdout.write(paint(opts, "90", "· heartbeat\n"));
      }
      lastBeat = Date.now();
    } catch {
      // file rotated between stages — keep polling for the next one
    }
  }, 2000);
}
