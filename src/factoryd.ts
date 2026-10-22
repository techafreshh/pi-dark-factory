/**
 * factoryd — the remote-control API over the foreman ops core.
 *
 * Bun-serve, zero deps. Reads are GET; every mutation is POST/PUT and gated
 * client-side by the pi-factory skill (laps and backlog slices spend real
 * tokens). `tick` is fired detached and returns immediately — the pidfile
 * arbitrates against the systemd timer's tick, so a manual or remote tick
 * can never double-run a lap.
 */
import { statSync } from "node:fs";
import { opsBacklog, opsCleanup, opsLogs, opsOnboard, opsScenarioSet, opsStatus, opsUnblock, opsSetConfig } from "./ops";
import { runTick } from "./tick";
import {
  newRenderState,
  newestSessionFileForSlug,
  readSessionTail,
  readSlice,
  renderSessionLine,
  renderSessionText,
} from "./sessionlog";

const VERSION = "0.1.0";

interface FactorydOpts {
  stateDir: string;
  port: number;
  key: string;
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

export function startFactoryd(opts: FactorydOpts) {
  return Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const respond = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });
      const fail = (status: number, error: string) => respond({ error }, status);

      if (req.method === "GET" && path === "/health") {
        return respond({ ok: true, service: "pi-dark-factory", version: VERSION });
      }

      const key = req.headers.get("x-api-key");
      if (!opts.key || key !== opts.key) return fail(401, "bad or missing X-Api-Key");
      const slug = decodeURIComponent(/^\/repos\/([^/]+)/.exec(path)?.[1] ?? "");
      const tickEnd = /^\/repos\/[^/]+\/(tick|backlog|unblock)$/.exec(path)?.[1];

      try {
        if (req.method === "GET" && path === "/status") {
          return respond(await opsStatus(opts.stateDir, url.searchParams.get("slug") ?? undefined));
        }
        if (req.method === "GET" && path === "/logs") {
          return respond(
            opsLogs(opts.stateDir, {
              slug: url.searchParams.get("slug") ?? undefined,
              tail: Number(url.searchParams.get("tail") ?? 200),
            })
          );
        }
        if (req.method === "GET" && /^\/session\//.test(path)) {
          const sslug = decodeURIComponent(/^\/session\/([^/]+)/.exec(path)![1]);
          const issueParam = url.searchParams.get("issue");
          const file = newestSessionFileForSlug(opts.stateDir, sslug, issueParam ? Number(issueParam) : undefined);
          if (!file) return fail(404, `no session file for repo ${sslug} — has any lap run yet?`);
          const rOpts = { think: url.searchParams.get("think") === "1", color: false };
          const label = `== pi session — ${sslug}${issueParam ? ` issue ${issueParam}` : ""}\n== ${file}\n`;
          if (url.searchParams.get("follow") !== "1") {
            const body = label + "\n" + renderSessionText(readSessionTail(file, 8_000_000), rOpts, newRenderState());
            return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
          }
          // follow: render the recent 64KB as context, then stream appends as
          // they land. Tool starts and tool results hit the session the
          // moment they happen; every turn adds a thinking marker with its
          // char count. Silence here means a stalled stage — go look.
          const enc = new TextEncoder();
          const st = newRenderState();
          const ctx = readSessionTail(file, 65_536);
          const startPos = Math.max(0, statSync(file).size - Buffer.byteLength(ctx));
          let pos = startPos;
          let buf = "";
          let iv: ReturnType<typeof setInterval> | null = null;
          let stopTimer: ReturnType<typeof setTimeout> | null = null;
          const stop = () => {
            if (iv) clearInterval(iv);
            if (stopTimer) clearTimeout(stopTimer);
            iv = stopTimer = null;
          };
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                enc.encode(
                  label +
                    "== recent context first, then following live — Ctrl-C to stop\n\n" +
                    renderSessionText(ctx, rOpts, st) +
                    "\n== ── live ──\n"
                )
              );
              let lastBeat = Date.now();
              iv = setInterval(() => {
                try {
                  const size = statSync(file).size;
                  if (size > pos) {
                    buf += readSlice(file, pos, Math.min(size, pos + 8_000_000));
                    pos = size;
                    const lines = buf.split("\n");
                    buf = lines.pop() ?? "";
                    const out = renderSessionText(lines.join("\n") + "\n", rOpts, st);
                    if (out) controller.enqueue(enc.encode(out));
                  } else if (Date.now() - lastBeat > 15_000) {
                    controller.enqueue(enc.encode("·\n"));
                  }
                  lastBeat = Date.now();
                } catch {
                  // session file rotated between stages — keep polling
                }
              }, 2000);
              // hard cap so an abandoned tab can't pin a stream forever
              stopTimer = setTimeout(() => {
                stop();
                try { controller.close(); } catch {}
              }, 4 * 3_600_000);
            },
            cancel() {
              stop();
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
          });
        }
        if (req.method === "POST" && path === "/repos") {
          return respond(await opsOnboard(opts.stateDir, String((await readJson(req)).repo ?? "")));
        }
        if (req.method === "POST" && tickEnd === undefined && path.endsWith("/config")) {
          return respond(await opsSetConfig(opts.stateDir, slug, await readJson(req)));
        }
        if (req.method === "PUT" && tickEnd === undefined && path.endsWith("/scenario")) {
          const body = await readJson(req);
          const kind = body.kind === "holdout" ? "holdout" : "runtime";
          if (typeof body.content !== "string" || !body.content.trim()) {
            return fail(422, "body must be {kind: 'runtime'|'holdout', content: '<json string>'}");
          }
          return respond(await Promise.resolve(opsScenarioSet(opts.stateDir, slug, kind, body.content)));
        }
        if (req.method === "POST" && tickEnd === "backlog") {
          const body = await readJson(req);
          if (typeof body.prd_text !== "string" || !body.prd_text.trim()) {
            return fail(422, "body must be {prd_text, dry_run?, max?} — the client reads the PRD from the product repo and ships its text");
          }
          return respond(
            await opsBacklog(opts.stateDir, slug, body.prd_text, {
              dryRun: body.dry_run !== false,
              max: Number(body.max ?? 40),
            })
          );
        }
        if (req.method === "POST" && tickEnd === "tick") {
          // detached: laps run for up to hours; the pidfile arbitrates with the timer
          void runTick({ stateDir: opts.stateDir, repoSlug: slug }).catch(() => {});
          return respond({ queued: true, slug, note: "lap dispatched — watch GET /status (pidfile arbitrates with the systemd timer)" });
        }
        if (req.method === "POST" && tickEnd === "unblock") {
          const body = await readJson(req);
          const issue = Number(body.issue);
          if (!Number.isFinite(issue)) return fail(422, "body must be {issue: <number>, prune?}");
          return respond(await opsUnblock(opts.stateDir, slug, issue, body.prune === true));
        }
        if (req.method === "POST" && path === "/cleanup") {
          return respond({ log: await opsCleanup(opts.stateDir) });
        }
        return fail(404, `no route ${req.method} ${path}`);
      } catch (e: any) {
        return fail(500, e.message ?? String(e));
      }
    },
  });
}

if (import.meta.main) {
  const key = process.env.FACTORY_API_KEY;
  if (!key) {
    console.error("FACTORY_API_KEY is not set — refusing to start (this is the internet-facing gate)");
    process.exit(1);
  }
  const stateDir = process.env.PI_FACTORY_STATE ?? "./state";
  const port = Number(process.env.FACTORYD_PORT ?? 8077);
  startFactoryd({ stateDir, port, key });
  console.log(`factoryd v${VERSION} listening on :${port} (state: ${stateDir})`);
}
