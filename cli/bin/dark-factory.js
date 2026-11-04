#!/usr/bin/env node
/**
 * dark-factory — drive a pi-dark-factory over HTTPS from any OS with
 * Node >= 18. Zero dependencies; the Windows/macOS/Linux twin of the VPS's
 * Python `factory-remote` (same verbs, same REST surface, same output
 * shapes), so the docs and muscle memory stay identical.
 *
 *   npx @techafresh/dark-factory status
 *   npm i -g @techafresh/dark-factory && dark-factory status
 *
 * Config (first run):  dark-factory setup <url> <key>
 *   stores {url, key} in ~/.dark-factory/config.json.
 *   Env DARK_FACTORY_URL / DARK_FACTORY_API_KEY override the file per shell.
 *
 * /health is open (no key); every other verb sends X-Api-Key. The key is a
 * factory edge key — treat the file like a password.
 *
 * Exit code 0 = success, 1 = error (message on stderr).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TIMEOUT_FAST = 60_000;
const TIMEOUT_SLOW = 900_000; // backlog slicing runs an LLM server-side
const STREAM_IDLE_MS = 120_000; // session follow: abort when no bytes land
const RECONNECT_MS = 5_000;

const VALUE_FLAGS = ["--repo", "--tail", "--issue", "--json", "--file", "--branch", "--prd-file", "--max", "--url", "--key", "--format"];
const BOOL_FLAGS = ["--raw", "--follow", "-f", "--think", "--lint", "--dump", "--test", "--create", "--prune", "--force", "--help", "-h"];

export function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (VALUE_FLAGS.includes(t)) {
      const v = argv[++i];
      if (v === undefined) return { error: `${t} needs a value` };
      a[t.slice(2)] = v;
    } else if (BOOL_FLAGS.includes(t)) {
      a[t.replace(/^-+/, "")] = true;
    } else if (t.startsWith("-")) {
      return { error: `unknown flag ${t}` };
    } else a._.push(t);
  }
  if (a.h) a.help = true; // -h and --help are the same verb-level help
  return a;
}

export function configPaths(home = homedir()) {
  return { file: join(home, ".dark-factory", "config.json") };
}

/* Connection resolution mirrors the n8n CLI: inline flags beat env vars beat
 * the stored config file. */
function loadConfig(home, override = {}) {
  const pick = (flagVal, envVal) => (flagVal ? [flagVal, "flags"] : envVal ? [envVal, "env"] : [undefined, undefined]);
  const [u, uTag] = pick(override.url, process.env.DARK_FACTORY_URL);
  const [k, kTag] = pick(override.key, process.env.DARK_FACTORY_API_KEY);
  const url = (u || "").replace(/\/+$/, "");
  const key = k || "";
  if (url && key) return { url, key, source: [...new Set([uTag, kTag])].join("+") };
  const { file } = configPaths(home);
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    return {
      url: (u || cfg.url || "").replace(/\/+$/, ""),
      key: k || cfg.key || "",
      source: [...new Set([uTag, kTag].filter(Boolean).concat("file"))].join("+"),
      file,
    };
  } catch {
    if (!(u || k))
      throw new Error(
        "not set up — run `dark-factory setup <url> <key>`, or set DARK_FACTORY_URL and DARK_FACTORY_API_KEY"
      );
    return { url, key, source: [...new Set([uTag, kTag].filter(Boolean))].join("+"), file };
  }
}

export function makeApi(cfg, fetchImpl = fetch) {
  return async function api(method, path, body = undefined, opts = {}) {
    const { timeout = TIMEOUT_FAST, allowStatus = [], needKey = true } = opts;
    const headers = { "Content-Type": "application/json" };
    if (needKey) headers["X-Api-Key"] = cfg.key;
    let res;
    try {
      res = await fetchImpl(cfg.url + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      throw new Error(
        `${method} ${path} failed to connect: ${e?.cause?.code || e?.name || e} — wrong URL? factoryd down?`
      );
    }
    let payload = {};
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!res.ok && !allowStatus.includes(res.status)) {
      throw new Error(`${method} ${path} -> HTTP ${res.status}: ${payload.error ?? text.slice(0, 200)}`);
    }
    return { status: res.status, body: payload };
  };
}

/* ── output (pure formatters so tests assert strings, not stdio) ────────── */

export function formatStatus(body) {
  const L = [];
  for (const r of body.repos ?? []) {
    const chainS =
      r.chain === -1
        ? "unknown (GitHub probe >5s)"
        : !r.chain
          ? "none (all delivered/blocked)"
          : String(r.chain);
    L.push(`${r.slug} (${r.repo}) — claimable chain: ${chainS}, in flight: ${r.in_flight}`);
  }
  L.push("\n== ledger ==");
  for (const i of body.issues ?? [])
    L.push(`#${i.issue_number} ${i.repo} [${i.state}] attempts=${i.attempts}${i.pr ? " PR#" + i.pr : ""} — ${(i.last_error || "").slice(0, 120)}`);
  L.push("\n== recent laps ==");
  for (const l of body.laps ?? [])
    L.push(`#${l.id} ${l.repo} issue=${l.issue_number ?? "-"} ${l.outcome ?? "…"} ${(l.detail || "").slice(0, 100)}`);
  L.push("\n== recent stages ==");
  for (const s of body.stages ?? [])
    L.push(`#${s.id} ${s.stage} a${s.attempt} ${s.model} ${s.exit ?? "…"} tok=${s.input_tokens}/${s.output_tokens}`);
  const wts = body.worktrees ?? [];
  if (wts.length) {
    L.push("\n== worktrees ==");
    for (const w of wts) L.push(`  ${w}`);
  }
  return L.join("\n");
}

export function formatDoctor(health, status) {
  const L = [`factoryd: ${health.service} v${health.version} — reachable`];
  const wt = health.web_tools ?? {};
  if (health.laptop_key_set === false) L.push("laptop key: NOT provisioned in factoryd.env — the dedicated second key is unset daemon-side");
  if (wt.extension_on_host && wt.key_set) L.push("web tools: OK — pi extension installed, TINYFISH_API_KEY set");
  else {
    const missing = [];
    if (!wt.extension_on_host) missing.push("pi extension not synced to ~/.pi/agent/extensions (a lap will install it on first stage)");
    if (!wt.key_set) missing.push("TINYFISH_API_KEY unset in factoryd.env — web_search/web_fetch will error until it is");
    L.push("web tools: " + missing.join("; "));
  }
  const sb = health.shared_base ?? {};
  const bases = health.bases ?? (sb.snapshot ? { "shared-base": sb } : {});
  if (Object.keys(bases).length) {
    for (const [alias, info] of Object.entries(bases)) {
      L.push(`base ${alias}: ${info.snapshot} — ${info.template ?? "template ?"}, baked ${(info.bakedAt ?? "?").slice(0, 10)}`);
      if (info.contents) L.push(`  contents: ${info.contents}`);
    }
  } else {
    L.push("shared base: UNMAPPED — write state/base-snapshot.json on the VPS (instabox repos naming 'shared-base' cannot boot until then)");
  }
  L.push(`auth OK — ${(status.repos ?? []).length} repo(s) onboarded`);
  if (status.repos?.length) L.push("repos: " + status.repos.map((r) => r.slug).join(", "));
  return L.join("\n");
}

export function formatModels(body) {
  const providers = body.providers ?? [];
  if (!providers.length) return body.note || "no providers configured";
  const L = [];
  for (const p of providers) {
    L.push(`${p.name} — ${p.api ?? ""} · ${p.baseUrl ?? ""}`);
    for (const m of p.models ?? []) {
      let t = "";
      if (m.thinking) {
        t = ` · thinking: ${m.thinking.supported.join(",")}`;
        if (m.thinking.unsupported?.length) t += ` (NOT: ${m.thinking.unsupported.join(",")})`;
      } else t = " · thinking: provider default";
      L.push(`  ${m.id} — reasoning=${m.reasoning ? "yes" : "no"} · ctx=${m.contextWindow}${t}`);
    }
  }
  L.push("\n(config writes validate against this roster: unknown providers and unsupported thinking levels reject)");
  return L.join("\n");
}

/* ── verbs ──────────────────────────────────────────────────────────────── */

async function cmdSetup(a, ctx) {
  const [url, key] = a._;
  if (!url || !key) throw new Error("usage: dark-factory setup <url> <key>");
  const { file } = configPaths(ctx.home);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ url: url.replace(/\/+$/, ""), key }, null, 2) + "\n");
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows: NTFS perms are user-scope by default in the profile dir */
  }
  ctx.out(`stored config at ${file}\ntry it: dark-factory doctor`);
  return 0;
}

async function cmdWhere(a, ctx) {
  const cfg = loadConfig(ctx.home);
  const { file } = configPaths(ctx.home);
  ctx.out(`url: ${cfg.url}\nkey: ${cfg.key ? "set (" + cfg.key.slice(0, 4) + "…)" : "MISSING"}\nsource: ${cfg.source}\nfile: ${file}${existsSync(file) ? "" : " (absent)"}`);
  return 0;
}

async function cmdHealth(a, ctx) {
  const { body } = await ctx.api("GET", "/health", undefined, { needKey: false, timeout: 10_000 });
  ctx.out(JSON.stringify(body, null, 2));
  return 0;
}

async function cmdDoctor(a, ctx) {
  const health = (await ctx.api("GET", "/health", undefined, { needKey: false, timeout: 10_000 })).body;
  const status = (await ctx.api("GET", "/status")).body;
  if (a.format === "json") {
    ctx.out(JSON.stringify({ health, status }, null, 2));
    return 0;
  }
  ctx.out(formatDoctor(health, status));
  return 0;
}

async function cmdStatus(a, ctx) {
  const { body } = await ctx.api("GET", "/status" + (a.repo ? `?slug=${encodeURIComponent(a.repo)}` : ""));
  if (a.raw || a.format === "json") {
    ctx.out(JSON.stringify(body, null, 2));
    return 0;
  }
  ctx.out(formatStatus(body));
  return 0;
}

async function cmdLogs(a, ctx) {
  const q = [];
  if (a.repo) q.push(`slug=${encodeURIComponent(a.repo)}`);
  if (a.tail) q.push(`tail=${a.tail}`);
  const { body } = await ctx.api("GET", "/logs" + (q.length ? "?" + q.join("&") : ""));
  if (a.format === "json") {
    ctx.out(JSON.stringify(body, null, 2));
    return 0;
  }
  for (const line of body.lines ?? []) ctx.out(line);
  return 0;
}

async function cmdModels(a, ctx) {
  const { body } = await ctx.api("GET", "/models");
  if (a.format === "json") {
    ctx.out(JSON.stringify(body, null, 2));
    return 0;
  }
  ctx.out(formatModels(body));
  return 0;
}

async function streamOnce(a, ctx) {
  const qs = [];
  if (a.follow) qs.push("follow=1");
  if (a.think) qs.push("think=1");
  if (a.issue) qs.push(`issue=${a.issue}`);
  const path = `/session/${encodeURIComponent(a._[0])}` + (qs.length ? "?" + qs.join("&") : "");
  const ctrl = new AbortController();
  let idle = setTimeout(() => ctrl.abort(new Error("idle timeout")), STREAM_IDLE_MS);
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(new Error("idle timeout")), STREAM_IDLE_MS);
  };
  let res;
  try {
    res = await ctx.rawFetch(cfg_.url + path, { headers: { "X-Api-Key": cfg_.key }, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let payload = {};
      try {
        payload = JSON.parse(text || "{}");
      } catch {}
      throw Object.assign(new Error(`GET ${path} -> HTTP ${res.status}: ${payload.error ?? text.slice(0, 200)}`), { status: res.status });
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bump();
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        ctx.out(buf.slice(0, i + 1).trimEnd());
        buf = buf.slice(i + 1);
      }
    }
    if (buf) ctx.out(buf.trimEnd());
  } finally {
    clearTimeout(idle);
  }
}

let cfg_; // streamOnce needs url/key without re-loading per reconnect

async function cmdSession(a, ctx) {
  const cfg = loadConfig(ctx.home);
  cfg_ = cfg;
  for (;;) {
    try {
      await streamOnce(a, ctx);
      if (!a.follow) return 0;
      ctx.out("\n── stream ended by server, reconnecting in 5s (Ctrl-C to stop) ──");
      await new Promise((r) => setTimeout(r, RECONNECT_MS));
    } catch (e) {
      if (e?.name === "AbortError" && e?.message === "idle timeout") throw e;
      if (!a.follow) throw new Error(`session stream failed: ${e?.cause?.code || e}`);
      ctx.out("\n── stream dropped, reconnecting in 5s (Ctrl-C to stop) ──");
      await new Promise((r) => setTimeout(r, RECONNECT_MS));
    }
  }
}

async function cmdOnboard(a, ctx) {
  const { body } = await ctx.api("POST", "/repos", { repo: a._[0] });
  if (body.already) {
    ctx.out(`already onboarded: ${body.config_path}`);
    return 0;
  }
  ctx.out(
    `onboarded ${body.repo} (slug: ${body.slug}, branch: ${body.default_branch}, ports: ${(body.ports ?? []).join(" + ")})`
  );
  ctx.out("wrote:");
  for (const f of body.config_written ?? []) ctx.out(`  ${f}`);
  ctx.out("next: push your config decisions with the config verb (models, env, required_checks);");
  ctx.out("next: push scenarios with the scenario verb;");
  ctx.out("then backlog + tick.");
  return 0;
}

async function cmdConfig(a, ctx) {
  const slug = a._[0];
  if (!a.json) {
    const { body } = await ctx.api("GET", `/repos/${encodeURIComponent(slug)}/config`);
    ctx.out(`effective config for ${slug} — complete, nothing filtered:`);
    ctx.out(JSON.stringify(body.config ?? {}, null, 2));
    return 0;
  }
  let patch;
  try {
    patch = JSON.parse(a.json);
  } catch (e) {
    throw new Error(`--json is not valid JSON: ${e.message}`);
  }
  const { body } = await ctx.api("POST", `/repos/${encodeURIComponent(slug)}/config`, patch);
  ctx.out("config updated: " + body.config_path);
  ctx.out(JSON.stringify(body.config ?? {}, null, 2));
  return 0;
}

async function cmdScenario(a, ctx) {
  const [slug, kind] = a._;
  if (kind !== "runtime" && kind !== "holdout") throw new Error("kind must be runtime or holdout");
  const enc = encodeURIComponent(slug);
  if (a.dump) {
    const { body } = await ctx.api("GET", `/repos/${enc}/scenario?kind=${kind}`);
    ctx.out(JSON.stringify(body.scenario, null, 2));
    return 0;
  }
  if (a.test) {
    const body = { kind };
    if (a.branch) body.branch = a.branch;
    const resp = (await ctx.api("POST", `/repos/${enc}/scenario/test`, body, { timeout: TIMEOUT_SLOW })).body;
    const r = resp.result ?? {};
    const where = resp.machine ? `machine ${resp.machine}` : "host worktree";
    ctx.out(`scenario ${kind} TEST vs ${resp.branch} (${where})`);
    if (r.error) ctx.out(`  SCENARIO ERROR: ${r.error}`);
    for (const p of r.results ?? []) ctx.out(`  [${p.pass ? "ok " : "FAIL"}] ${p.id} — ${String(p.detail ?? "").slice(0, 140)}`);
    ctx.out(`VERDICT: ${r.pass ? "ALL GREEN" : "FAILED"}`);
    return r.pass ? 0 : 1;
  }
  if (!a.file) throw new Error("provide --file F (write or --lint), --dump, or --test (execute the stored scenario without a lap)");
  const content = readFileSync(a.file, "utf8");
  if (a.lint) {
    const { body } = await ctx.api("PUT", `/repos/${enc}/scenario`, { kind, content, lint: true });
    ctx.out(`LINT OK for ${kind}.json (nothing written)`);
    for (const w of body.warnings ?? []) ctx.out(`  warn: ${w}`);
    return 0;
  }
  const { body } = await ctx.api("PUT", `/repos/${enc}/scenario`, { kind, content });
  ctx.out(`${kind}.json updated for ${slug}: ${body.path}`);
  return 0;
}

async function cmdProveGates(a, ctx) {
  const resp = (
    await ctx.api("POST", `/repos/${encodeURIComponent(a._[0])}/prove-gates`, {}, { timeout: TIMEOUT_SLOW })
  ).body;
  ctx.out(JSON.stringify(resp, null, 2));
  return resp.verdict === "healthy" ? 0 : 1;
}

async function cmdDiscoveries(a, ctx) {
  const resp = (
    await ctx.api("POST", `/repos/${encodeURIComponent(a._[0])}/discoveries`, { file: !!a.file }, { timeout: TIMEOUT_SLOW })
  ).body;
  if (!a.file) {
    for (const d of resp.discoveries ?? [])
      ctx.out(`#${d.issue} (attempt ${d.attempt}) ${d.title}\n  ${d.claim}\n  why: ${d.why}`);
    ctx.out(`-- ${resp.count ?? 0} discovery(ies); re-run with --file to open deduped issues`);
  } else {
    for (const f of resp.filed ?? []) ctx.out(`filed #${f.issue}: ${f.title}`);
    ctx.out(`-- ${(resp.filed ?? []).length} filed of ${resp.count ?? 0} harvested`);
  }
  return 0;
}

async function cmdBacklog(a, ctx) {
  const slug = a._[0];
  if (!a["prd-file"]) throw new Error("--prd-file is required");
  let prd;
  try {
    prd = readFileSync(a["prd-file"], "utf8");
  } catch {
    throw new Error(`PRD file not found: ${a["prd-file"]}`);
  }
  const body = (
    await ctx.api(
      "POST",
      `/repos/${encodeURIComponent(slug)}/backlog`,
      { prd_text: prd, dry_run: !a.create, max: Number(a.max ?? 40) },
      { timeout: TIMEOUT_SLOW }
    )
  ).body;
  ctx.out(`sliced ${body.sliced} issues; ${body.existing} already exist (deduped by title)`);
  if (!a.create) {
    ctx.out("PREVIEW (run again with --create to publish):");
    (body.preview ?? []).forEach((p, i) => {
      ctx.out(
        `${i + 1}. ${p.title}` + (p.depends?.length ? ` (depends: ${p.depends.join(", ")})` : "")
      );
    });
  } else {
    ctx.out("created / resolved:");
    for (const c of body.created ?? []) ctx.out(`  #${c.number}: ${c.title}`);
  }
  return 0;
}

async function cmdTick(a, ctx) {
  const slug = a._[0];
  const { status, body } = await ctx.api("POST", `/repos/${encodeURIComponent(slug)}/tick`, {}, { allowStatus: [409] });
  if (body.queued === false || status === 409)
    throw new Error("tick SKIPPED: " + body.skipped + " — retry when the running tick settles (only a `queued: <slug> #N` log line means a lap truly started)");
  ctx.out(`lap dispatched for ${body.slug} — follow with: dark-factory status --repo ${body.slug} (or logs)`);
  return 0;
}

async function cmdPause(a, ctx) {
  const slug = a._[0];
  await ctx.api("POST", `/repos/${encodeURIComponent(slug)}/pause`, {});
  ctx.out(`${slug} PAUSED — ticks skip it (an in-flight lap finishes); dark-factory unpause ${slug} to resume`);
  return 0;
}

async function cmdUnpause(a, ctx) {
  const slug = a._[0];
  await ctx.api("POST", `/repos/${encodeURIComponent(slug)}/unpause`, {});
  ctx.out(`${slug} UNPAUSED — the next tick picks it up; fire one now: dark-factory tick ${slug}`);
  return 0;
}

async function cmdUnblock(a, ctx) {
  const [slug, issue] = a._;
  const { body } = await ctx.api(
    "POST",
    `/repos/${encodeURIComponent(slug)}/unblock`,
    { issue: Number(issue), prune: !!a.prune, force: !!a.force },
    { allowStatus: [409] }
  );
  if (body.refused) {
    ctx.out(`REFUSED (${body.refused}): ${body.note}`);
    return 1;
  }
  ctx.out(JSON.stringify(body, null, 2));
  return 0;
}

async function cmdCleanup(a, ctx) {
  const { body } = await ctx.api("POST", "/cleanup", {}, { timeout: TIMEOUT_SLOW });
  for (const line of body.log ?? []) ctx.out(line);
  return 0;
}

const VERBS = {
  health: { min: 0, fn: cmdHealth },
  doctor: { min: 0, fn: cmdDoctor },
  models: { min: 0, fn: cmdModels },
  status: { min: 0, fn: cmdStatus },
  logs: { min: 0, fn: cmdLogs },
  session: { min: 1, fn: cmdSession },
  onboard: { min: 1, fn: cmdOnboard },
  config: { min: 1, fn: cmdConfig },
  scenario: { min: 2, fn: cmdScenario },
  "prove-gates": { min: 1, fn: cmdProveGates },
  discoveries: { min: 1, fn: cmdDiscoveries },
  backlog: { min: 1, fn: cmdBacklog },
  tick: { min: 1, fn: cmdTick },
  pause: { min: 1, fn: cmdPause },
  unpause: { min: 1, fn: cmdUnpause },
  unblock: { min: 2, fn: cmdUnblock },
  cleanup: { min: 0, fn: cmdCleanup },
  setup: { min: 2, fn: cmdSetup, noApi: true },
  where: { min: 0, fn: cmdWhere, noApi: true },
};

/* `setup` needs no factory connection; everything else builds an api client */
export async function run(argv, ctx = {}) {
  const out = ctx.out ?? ((s) => process.stdout.write(String(s) + "\n"));
  const err = ctx.err ?? ((s) => process.stderr.write(String(s) + "\n"));
  const home = ctx.home;
  const a = parseArgs(argv);
  if (a.error) {
    err(a.error);
    return 2;
  }
  const verb = a._[0];
  if (!verb || verb === "help" || verb === "--help") {
    out(USAGE);
    return verb ? 0 : 2;
  }
  const def = VERBS[verb];
  if (!def) {
    err(`unknown verb: ${verb} (dark-factory help lists verbs)`);
    return 2;
  }
  if (a.help) {
    out(HELP[verb] ?? USAGE);
    return 0;
  }
  if (a._.length - 1 < def.min) {
    err(`${verb}: missing arguments (dark-factory help)`);
    return 2;
  }
  a._.shift(); // verbs see pure positionals; the verb name is dispatch, not data
  let api = ctx.api;
  if (!def.noApi) {
    if (!api) {
      try {
        const cfg = loadConfig(home, { url: a.url, key: a.key });
        cfg_ = cfg;
        api = makeApi(cfg, ctx.fetchImpl ?? fetch);
      } catch (e) {
        err(e.message);
        return 1;
      }
    }
  }
  const rawFetch = ctx.rawFetch ?? ctx.fetchImpl ?? fetch;
  const runCtx = { out, err, home, api, rawFetch };
  try {
    return await def.fn(a, runCtx);
  } catch (e) {
    err(e.message);
    return 1;
  }
}

const HELP = {
  setup: `setup <url> <key>
Store the connection in ~/.dark-factory/config.json (chmod 600 where the OS
allows). Flags --url/--key override env/file per call; env vars
DARK_FACTORY_URL / DARK_FACTORY_API_KEY rank between flags and the file.
Example: dark-factory setup https://pi-factory.techa.pro <edge-key>`,
  where: `where
Show the active connection: url, masked key, which layer it came from
(flags > env > file), and the config file path.`,
  health: `health
The open /health endpoint — connectivity check without a key. Prints JSON.`,
  doctor: `doctor [--format json]
Auth + readiness sweep: health, web tools, stack bases, repo count. Flags a
half-provisioned laptop key (daemon-side) without shell access to the VPS.`,
  models: `models [--format json]
The LIVE provider roster from models.json (signing keys stripped). Config
patches validate against this roster — unknown providers and unsupported
thinking levels reject.`,
  status: `status [--repo SLUG] [--raw | --format json]
Claimable chain depth, in-flight laps, ledger rows, recent laps/stages,
worktrees. --repo scopes to one slug; --raw/--format json dump the full
response for scripting.`,
  logs: `logs [--repo SLUG] [--tail N] [--format json]
laps.log tail (default 200) — the audit spine. --format json returns the raw
{lines:[...]} payload.`,
  session: `session SLUG [-f|--follow] [--think] [--issue N]
Human-readable view of the repo's newest pi session. --follow streams live
and auto-reconnects 5s after drops (the server caps a stream at 4h); --think
includes the model's reasoning text; --issue pins one issue. Ctrl-C stops.`,
  onboard: `onboard OWNER/NAME
Write the config template, scenario templates and a port pair. Idempotent
("already" when done). Then: config → scenario → backlog → tick.`,
  config: `config SLUG [--json PATCH]
Read the COMPLETE effective config (nothing filtered — a filtered readback
once hid env.instabox.* and thinking). With --json, deep-merge a patch:
  dark-factory config app --json '{"pi":{"web":{"search":false}}}'
A successful patch bumps the inputs-epoch; two-writer rule: last write wins.`,
  scenario: `scenario SLUG runtime|holdout [--file F | --lint | --dump | --test [--branch B]]
Write + server-side validate a scenario (--file), dry-run validate (--lint —
ALWAYS lint before writing), print stored (--dump), or execute WITHOUT
spending a lap (--test; targets the repo's default branch unless --branch;
exit 1 on a failed verdict).`,
  "prove-gates": `prove-gates SLUG
Plant every probe against a product-shaped stub; the gates must trip. Exit 1
unless the verdict is "healthy".`,
  discoveries: `discoveries SLUG [--file]
List harvested reviewer observations (preview). --file opens deduped
[discovery] issues — that spends repo writes.`,
  backlog: `backlog SLUG --prd-file F [--max N] [--create]
Slice a PRD into dependency-ordered issues. Preview by default; --create
publishes. --max caps issues (40).`,
  tick: `tick SLUG
Fire a lap now — the pidfile arbitrates with the systemd timer, so this can
never double-run a lap. 409 = another tick is mid-flight; only a
'queued: <slug> #N' log line means a lap truly started.`,
  pause: `pause SLUG / unpause SLUG
Pull a repo off the tick wheel / put it back. Pause lets an in-flight lap
finish; unpause is picked up on the next tick (fire one: tick SLUG).`,
  unblock: `unblock SLUG ISSUE [--prune] [--force]
Drop the ledger row for a wedged issue. --prune also closes the PR, branch
and worktree; --force overrides the in-progress guard — only after verifying
the lap is actually dead.`,
  cleanup: `cleanup
Prune caches and kill stale pi workers on the VPS.`,
};

const USAGE = `dark-factory — drive a pi-dark-factory over HTTPS (Node >= 18, zero deps)

setup <url> <key>                store connection in ~/.dark-factory/config.json
where                            show active connection config
health                           open endpoint — connectivity check
doctor                           connectivity + auth + version check
models                           the LIVE provider roster (keys stripped)
status [--repo SLUG] [--raw]     ledger, laps, stages, chain depth
logs [--repo SLUG] [--tail N]    laps.log tail (default 200)
session SLUG [-f|--follow] [--think] [--issue N]
                                 human-readable pi session view; --follow streams live
onboard OWNER/NAME               config + scenario templates + port pair
config SLUG [--json '{...}']     read the FULL effective config; --json deep-merges a patch
scenario SLUG runtime|holdout --file F [--lint]     write / dry-run-validate a scenario
scenario SLUG runtime|holdout --dump                  print the stored scenario
scenario SLUG runtime|holdout --test [--branch B]    execute WITHOUT spending a lap
prove-gates SLUG                 plant every probe; gates must trip
discoveries SLUG [--file]        list harvested findings; --file opens deduped issues
backlog SLUG --prd-file F [--max N] [--create]       slice a PRD (preview by default)
tick SLUG                        fire a lap now (pidfile arbitrates with the timer)
pause SLUG / unpause SLUG        pull a repo off / put it back on the tick wheel
unblock SLUG ISSUE [--prune] [--force]               drop a ledger row (optionally close PR/branch)
cleanup                          prune caches, kill stale pi workers

Env DARK_FACTORY_URL / DARK_FACTORY_API_KEY override the stored config;
inline --url / --key override everything (resolution: flags > env > file).
--format json gives machine-readable output on status/logs/models/doctor.
Every verb takes --help for its detailed usage (dark-factory unblock --help).
Exit codes: 0 success · 1 error or failed verdict · 2 usage.`;

/* ── entry: run when invoked directly (node, bun, npm bin shim) ─────────── */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.on("SIGINT", () => {
    process.stdout.write("\nbye\n");
    process.exit(0);
  });
  // exit via exitCode, never process.exit(): writes > 64KiB (status --format
  // json on a big fleet) flush to the pipes asynchronously, and a hard exit
  // truncates the remainder mid-JSON — seen live on pi-factory's real /status
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code ?? 0;
  });
}
