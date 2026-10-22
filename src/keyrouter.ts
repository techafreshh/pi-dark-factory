/**
 * ClinePass key router — local proxy that fans one logical provider over N
 * ClinePass API keys, so a weekly cap on one key fails over to the next
 * instead of killing factory laps.
 *
 * How it fits: Pi talks OpenAI-compatible to http://host.docker.internal:8099/v1
 * (a provider entry in the factory user's models.json), the router forwards to
 * ClinePass stamping whichever upstream key is currently hot. 429s parse the
 * reset window from ClinePass's own error text ("The limit resets in 4d 5h")
 * and cool that key exactly that long; other keys keep serving. SSE streams
 * pass straight through.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const VERSION = "0.1.0";
const DAY = 24 * 60 * 60 * 1000;

export function parseResetLine(text: string, now = Date.now()): number | null {
  const m = text.match(/resets?\s+in\s+(?:(\d+)\s*d(?:ay)?)?\s*(?:(\d+)\s*h(?:our)?)?/i);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  if (days === 0 && hours === 0) return null;
  return now + (days * 24 + hours) * 60 * 60 * 1000;
}

export interface PoolStats {
  keys: number;
  hot: number;
  cooling: number;
}

export class KeyPool {
  /** priority order — keys are consumed in file order, hot key first */
  private cooldowns = new Map<string, { until: number; reason: string }>();
  private pins = new Map<string, string>(); // session affinity hash -> key fingerprint
  private lastMtime = 0;

  constructor(
    public keys: string[],
    private opts: { stateFile?: string; defaultCoolMs?: number } = {}
  ) {
    if (opts.stateFile && existsSync(opts.stateFile)) {
      try {
        const saved = JSON.parse(readFileSync(opts.stateFile, "utf8"));
        for (const [fp, v] of Object.entries(saved as Record<string, { until: number; reason: string }>)) {
          this.cooldowns.set(fp, v);
        }
      } catch {}
    }
  }

  private fp(key: string): string {
    return key.slice(0, 10);
  }

  cool(key: string, until: number, reason: string) {
    this.cooldowns.set(this.fp(key), { until, reason });
    if (this.opts.stateFile) {
      const out: Record<string, unknown> = {};
      for (const [fp, v] of this.cooldowns) out[fp] = v;
      try {
        writeFileSync(this.opts.stateFile, JSON.stringify(out, null, 2));
      } catch {}
    }
  }

  coolUntil(key: string): { until: number; reason: string } | null {
    const c = this.cooldowns.get(this.fp(key));
    return c && c.until > Date.now() ? c : null;
  }

  /** First non-cooling key in file order; null when every key is cooling. */
  next(): string | null {
    for (const key of this.keys) {
      if (!this.coolUntil(key)) return key;
    }
    return null;
  }

  /** Session affinity: keep one key pinned per conversation so upstream
   *  prompt caches (per key/account + prefix) stay warm across the turns of
   *  that conversation, and concurrent conversations spread across the pool
   *  instead of stacking on the first hot key. Re-pins to the first hot key
   *  when the pinned one cools. */
  nextFor(affinity: string): string | null {
    if (affinity) {
      const pinned = this.pins.get(affinity);
      if (pinned) {
        const key = this.keys.find((k) => this.fp(k) === pinned && !this.coolUntil(k));
        if (key) return key;
        this.pins.delete(affinity);
      }
    }
    const key = this.next();
    if (key && affinity) {
      this.pins.set(affinity, this.fp(key));
      if (this.pins.size > 256) {
        for (const d of [...this.pins.keys()].slice(0, this.pins.size - 192)) this.pins.delete(d);
      }
    }
    return key;
  }

  pinCount(): number {
    return this.pins.size;
  }

  /** Reload the keys file if it changed (add/revoke keys without restart). */
  reload(file: string): boolean {
    if (!existsSync(file)) return false;
    const mtime = statSync(file).mtimeMs;
    if (mtime === this.lastMtime && this.keys.length > 0) return false;
    this.lastMtime = mtime;
    const keys = readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    const changed = JSON.stringify(keys) !== JSON.stringify(this.keys);
    this.keys = keys;
    return changed;
  }

  stats(): PoolStats {
    const cooling = this.keys.filter((k) => this.coolUntil(k)).length;
    return { keys: this.keys.length, hot: this.keys.length - cooling, cooling };
  }
}

const FORWARD_HEADERS = ["content-type", "accept", "user-agent"];

const hopByHop = (h: Headers) => {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (FORWARD_HEADERS.includes(k.toLowerCase())) out[k] = v;
  });
  if (!out["content-type"]) out["content-type"] = "application/json";
  return out;
};

export function startKeyrouter(opts: {
  port: number;
  keysFile: string;
  upstream: string;
  stateFile?: string;
  defaultCoolMs?: number;
}) {
  const pool = new KeyPool([], { stateFile: opts.stateFile, defaultCoolMs: opts.defaultCoolMs });
  pool.reload(opts.keysFile);

  async function proxy(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname; // /v1/... or /api/v1/... — forwarded as-is
    let body: string | undefined = undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await req.text();
    }
    const inHeaders = hopByHop(req.headers);

    // Default caller requests to low reasoning effort: the pass pool's
    // reasoning models emit enormous hidden thinking regardless of the
    // caller's own thinking controls (a trivial "say OK" carried a full
    // reasoning paragraph; long toolized stage turns produced megabytes of
    // reasoning before any content — multi-hour laps). An explicit
    // reasoning_effort on the request still wins. Bodies only; JSON only.
    if (
      body &&
      req.method === "POST" &&
      path.includes("/chat/completions") &&
      (req.headers.get("content-type") ?? "").includes("application/json")
    ) {
      try {
        const parsed = JSON.parse(body) as { reasoning_effort?: unknown; [k: string]: unknown };
        if (parsed && typeof parsed === "object" && parsed.reasoning_effort === undefined) {
          parsed.reasoning_effort = "low";
          body = JSON.stringify(parsed);
          inHeaders.delete("content-length"); // fetch recomputes for the new body
        }
      } catch { /* malformed or streamed body — forward as-is */ }
    }

    // stable per-conversation affinity: hash the request head (model + system
    // + early messages — identical across the turns of one stage), so repeat
    // turns ride the same upstream key and prompt caches stay warm
    let affinity = "";
    if (path.includes("/chat/completions") && body) {
      const h = new Bun.CryptoHasher("sha1");
      h.update(body.slice(0, 65536));
      affinity = h.digest("hex").slice(0, 16);
    }

    for (;;) {
      pool.reload(opts.keysFile);
      const key = affinity ? pool.nextFor(affinity) : pool.next();
      if (!key) {
        return new Response(
          JSON.stringify({ error: { message: "all clinepass keys are cooling — add a key or wait for a reset" } }),
          { status: 429, headers: { "content-type": "application/json" } }
        );
      }
      let upstream: Response;
      try {
        upstream = await fetch(opts.upstream + path, {
          method: req.method,
          headers: { ...inHeaders, authorization: `Bearer ${key}` },
          body,
        });
      } catch (e: any) {
        return new Response(
          JSON.stringify({ error: { message: `router -> upstream transport failure: ${e.message}` } }),
          { status: 502, headers: { "content-type": "application/json" } }
        );
      }
      if (upstream.status === 429 || upstream.status === 402 || upstream.status === 401) {
        const text = await upstream.text().catch(() => "");
        let until: number;
        if (upstream.status === 429) {
          until = parseResetLine(text, Date.now()) ?? Date.now() + (opts.defaultCoolMs ?? DAY);
        } else if (upstream.status === 402) {
          until = Date.now() + 7 * DAY; // out of balance — not coming back this week
        } else {
          until = Date.now() + 30 * DAY; // invalid key
        }
        pool.cool(key, until, `upstream ${upstream.status}`);
        continue; // try the next key immediately
      }
      // success (or a non-key upstream failure) — stream straight through,
      // SSE included
      return new Response(upstream.body, { status: upstream.status, headers: hopByHop(upstream.headers) });
    }
  }

  return Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ ok: true, service: "clinepass-keyrouter", version: VERSION, pool: pool.stats() });
      }
      if (url.pathname === "/pool") {
        pool.reload(opts.keysFile);
        return Response.json({ ...pool.stats(), pins: pool.pinCount(), detail: stats_detail(pool) });
      }
      return proxy(req);
    },
  });
}

function stats_detail(pool: KeyPool) {
  return pool.keys.map((k) => {
    const c = pool.coolUntil(k);
    return { key: `${k.slice(0, 8)}…`, state: c ? `cooling until ${new Date(c.until).toISOString()} (${c.reason})` : "hot" };
  });
}

if (import.meta.main) {
  const keysFile = process.env.CRPASS_KEYS_FILE ?? "";
  if (!keysFile || !existsSync(keysFile)) {
    console.error(`CRPASS_KEYS_FILE (${keysFile || "unset"}) must point at a keys file (one key per line)`);
    process.exit(1);
  }
  const port = Number(process.env.CRPASS_PORT ?? 8099);
  const upstream = process.env.CRPASS_UPSTREAM ?? "https://api.cline.bot/api";
  const stateFile = process.env.CRPASS_STATE_FILE ?? `${keysFile}.state.json`;
  startKeyrouter({ port, keysFile, upstream, stateFile });
  console.log(`clinepass keyrouter v${VERSION} on :${port} -> ${upstream} (keys: ${keysFile})`);
}
