/**
 * The ops core — every factory mutation and read, shared by the foreman CLI
 * (local) and factoryd (remote HTTP). Functions return data; the surfaces
 * decide how to print it.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync as mvSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoConfig, resolveModels } from "./config";
import { Gh, repoDefaultBranch } from "./gh";
import { deleteRemoteBranch, removeWorktree } from "./gitws";
import { Ledger } from "./ledger";
import { portBusy } from "./scenario";
import { loadScenario } from "./scenario";
import { buildSlicerPrompt, filterNew, parseSlicerOutput } from "./slicer";
import { receipt } from "./receipts";
import { sh } from "./sh";
import type { RepoConfig } from "./types";

const repoCfgDir = (stateDir: string, slug: string) => join(stateDir, "repos", slug);
const wtRoot = (stateDir: string, slug: string) => join(stateDir, "worktrees", slug);

// ── reads ────────────────────────────────────────────────────────────────────

export interface OpsStatus {
  version: string;
  repos: { slug: string; repo: string; chain: number; in_flight: number }[];
  issues: ReturnType<Ledger["listIssues"]>;
  laps: ReturnType<Ledger["recentLaps"]>;
  stages: ReturnType<Ledger["recentStages"]>;
  worktrees: string[];
}

export async function opsStatus(stateDir: string, slug?: string): Promise<OpsStatus> {
  const reposDir = join(stateDir, "repos");
  const repoList: OpsStatus["repos"] = [];
  let repoForStages: string | undefined;
  if (existsSync(reposDir)) {
    for (const entry of readdirSync(reposDir).filter((e) => e !== "source")) {
      const cfgPath = join(reposDir, entry, "config.json");
      if (!existsSync(cfgPath)) continue;
      try {
        const cfg = loadRepoConfig(cfgPath);
        if (slug && cfg.slug !== slug) continue;
        if (slug) repoForStages = cfg.repo; // stage rows are keyed by repo (owner/name), not slug
        const ledger = new Ledger(join(stateDir, "factory.db"));
        const chain = (await (await import("./stages/intake")).listClaimable(cfg, ledger, new Gh(cfg.repo))).length;
        const inFlight = ledger
          .listIssues(cfg.repo)
          .filter((r) => r.state === "in_progress").length;
        repoList.push({ slug: cfg.slug, repo: cfg.repo, chain, in_flight: inFlight });
      } catch (e: any) {
        repoList.push({ slug: entry, repo: `unloadable: ${e.message?.slice(0, 80)}`, chain: 0, in_flight: 0 });
      }
    }
  }
  const ledger = new Ledger(join(stateDir, "factory.db"));
  const worktrees: string[] = [];
  if (existsSync(join(stateDir, "worktrees"))) {
    for (const slug2 of readdirSync(join(stateDir, "worktrees"))) {
      for (const wt of readdirSync(join(stateDir, "worktrees", slug2))) worktrees.push(`${slug2}/${wt}`);
    }
  }
  return {
    version: "0.1.0",
    repos: repoList,
    issues: ledger.listIssues(),
    laps: ledger.recentLaps(slug, 10),
    stages: ledger.recentStages(repoForStages, 15),
    worktrees,
  };
}

export function opsLogs(stateDir: string, opts: { slug?: string; tail?: number } = {}) {
  const path = join(stateDir, "laps.log");
  if (!existsSync(path)) return { lines: [], note: "no laps.log yet" };
  const all = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const lines = opts.slug ? all.filter((l) => l.includes(` on ${opts.slug}:`) || !l.includes(" on ") || l.includes(` ${opts.slug} `)) : all;
  return { lines: lines.slice(-(opts.tail ?? 100)) };
}

// ── mutations ────────────────────────────────────────────────────────────────

/** Reserve a free port pair for a new repo: config inventory + docker
 *  publishes + factory services + live bind test, over a wide candidate
 *  range. The OS ephemeral range (typically 32768-60999) is excluded —
 *  outbound connections transiently grab ports there. */
async function pickPorts(stateDir: string): Promise<number[]> {
  const reserved = new Set<number>([8077, 8099, 9000]); // factory's own services
  const reposDir = join(stateDir, "repos");
  if (existsSync(reposDir)) {
    for (const entry of readdirSync(reposDir)) {
      const cfgPath = join(reposDir, entry, "config.json");
      if (!existsSync(cfgPath)) continue;
      try {
        loadRepoConfig(cfgPath).scenario.ports.forEach((p) => reserved.add(p));
      } catch {}
    }
  }
  // host ports already published by running containers (any scheme)
  const dockerPorts = await sh(["bash", "-c", `docker ps --format '{{.Ports}}' 2>/dev/null || true`], { timeoutMs: 15000 });
  const pubRe = /(?:[\d.]+|\[[0-9a-f:]+\]):(\d+)->/g;
  for (const m of (dockerPorts.stdout ?? "").matchAll(pubRe)) {
    const n = Number(m[1]);
    if (Number.isInteger(n)) reserved.add(n);
  }
  const pools: [number, number][] = [[8100, 8999], [9001, 32767]];
  const ports: number[] = [];
  outer: for (const [lo, hi] of pools) {
    for (let p = lo; p <= hi; p += 2) {
      if (ports.length >= 2) break outer;
      if (reserved.has(p) || reserved.has(p + 1)) continue;
      if (await portBusy(p) || await portBusy(p + 1)) { reserved.add(p); reserved.add(p + 1); continue; }
      ports.push(p, p + 1);
    }
  }
  if (ports.length < 2) throw new Error("no free port pair in 8100-32767 (excl. ephemeral, docker publishes and reserved pairs)");
  return ports;
}

export async function opsOnboard(
  stateDir: string,
  target: string
): Promise<
  | { already: true; slug: string; config_path: string }
  | { already: false; slug: string; repo: string; default_branch: string; ports: number[]; config_written: string[]; next_steps: string[] }
> {
  if (!/^[^/\s]+\/[^/\s]+$/.test(target)) throw new Error(`expected owner/name, got "${target}"`);
  const slug = target.split("/")[1];
  if (existsSync(join(repoCfgDir(stateDir, slug), "config.json"))) {
    return { already: true, slug, config_path: join(repoCfgDir(stateDir, slug), "config.json") };
  }
  const branch = await repoDefaultBranch(target);
  const ports = await pickPorts(stateDir);
  const cfg = {
    _readme:
      "pi-dark-factory repo config. models.default applies to every stage until overridden; stage keys: plan, implement, review. fallback entries are 'provider/model[:thinking]' strings tried in order on provider errors (timeouts are NOT retried on another model). required_checks: names of GitHub checks that must pass before merge; ["*"] (the onboard default) autodetects — every check the PR reports must pass, none = no CI gate; an empty list disables the CI gate. scenario.ports are RESERVED across all repos. env: 'host' runs stages as plain processes; 'compose' runs every stage as root inside the product's own docker-compose worker (must publish the scenario ports on 127.0.0.1) or the fallback image with cache volumes.",
    repo: target,
    slug,
    default_branch: branch,
    attempts: 3,
    merge: { method: "squash", required_checks: ["*"] as string[], delete_branch: true },
    models: { default: { provider: "SET-ME", model: "SET-ME", thinking: "medium", fallback: [] as string[] } },
    timeouts: { stage_minutes: 60, checks_minutes: 30, readiness_seconds: 120, probe_ms: 10000 },
    scenario: { ports, runtime: "runtime.json", holdout: "holdout.json" },
    skip_labels: [] as string[],
    env: {
      mode: "host",
      compose_file: "docker-compose.yml",
      service: "worker",
      image: "ubuntu:24.04",
      pass_env: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "ZAI_API_KEY", "DEEPSEEK_API_KEY", "GITHUB_TOKEN"],
    },
    pi: {
      binary: "pi",
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      plan_tools: ["read", "bash", "grep", "find", "ls"],
      extra_args: [] as string[],
    },
  };
  mkdirSync(repoCfgDir(stateDir, slug), { recursive: true });
  writeFileSync(join(repoCfgDir(stateDir, slug), "config.json"), JSON.stringify(cfg, null, 2) + "\n");
  const tplDir = join(import.meta.dir, "..", "templates");
  writeFileSync(
    join(repoCfgDir(stateDir, slug), "runtime.json"),
    readFileSync(join(tplDir, "runtime.json"), "utf8").replace(/"port":\s*\d+/, `"port": ${ports[0]}`)
  );
  writeFileSync(
    join(repoCfgDir(stateDir, slug), "holdout.json"),
    readFileSync(join(tplDir, "holdout.json"), "utf8").replace(/"port":\s*\d+/, `"port": ${ports[1]}`)
  );
  receipt(stateDir, `onboarded ${target} (slug: ${slug}, branch: ${branch}, ports: ${ports.join(" + ")})`);
  return {
    already: false,
    slug,
    repo: target,
    default_branch: branch,
    ports,
    config_written: ["config.json", "runtime.json", "holdout.json"].map((f) => join(repoCfgDir(stateDir, slug), f)),
    next_steps: [
      "set models in config.json (default tier + per-stage overrides)",
      "fill runtime.json + holdout.json probes for this product",
      "foreman backlog (or POST /repos/<slug>/backlog) to slice the PRD",
      "foreman tick / POST /repos/<slug>/tick for the first lap (spends tokens)",
    ],
  };
}

export function opsScenarioSet(stateDir: string, slug: string, kind: "runtime" | "holdout", content: string) {
  const dir = repoCfgDir(stateDir, slug);
  if (!existsSync(join(dir, "config.json"))) throw new Error(`repo ${slug} is not onboarded`);
  JSON.parse(content); // syntactic check first
  // validate before it can ever reach a lap: write to a temp path, parse as a
  // scenario, only then commit; on any failure the temp file dies with it
  const tmp = join(dir, `${kind}.json.candidate-${Date.now()}`);
  writeFileSync(tmp, content);
  try {
    loadScenario(tmp);
  } catch (e: any) {
    rmSync(tmp, { force: true });
    throw new Error(`rejected ${kind}.json: ${e.message}`);
  }
  const path = join(dir, `${kind}.json`);
  rmSync(path, { force: true });
  mvSync(tmp, path);
  receipt(stateDir, `scenario ${kind}.json updated for ${slug} (validated)`);
  return { ok: true, path };
}

const SLICER_TIMEOUT_MS = 900_000;

/**
 * The slicer needs no tools and no agent harness — a single chat completion
 * through the provider's OpenAI-compatible endpoint. It used to run through
 * `pi --mode json` like the stages, but that spawn shape parked pre-spawn
 * (futex, no child, unrecoverable by any timeout) nondeterministically.
 * Plain HTTP fails fast with the upstream error and retries cleanly.
 */
async function slice(prdText: string, cfg: RepoConfig, max: number): Promise<ReturnType<typeof parseSlicerOutput>> {
  const models = resolveModels(cfg, "plan");
  const providers = JSON.parse(
    readFileSync(join(process.env.HOME ?? "", ".pi", "agent", "models.json"), "utf8")
  ) as { providers: Record<string, { baseUrl: string; apiKey: string }> };
  const provider = providers.providers[models.base.provider];
  if (!provider?.baseUrl) throw new Error(`slicer: provider ${models.base.provider} has no baseUrl in ~/.pi/agent/models.json`);
  // Two cliffs live below, both proven the hard way:
  // 1. non-streaming POSTs: the ClinePass pool hangs forever on big reasoning
  //    prompts (zero bytes, no error) while streaming the same request answers
  //    immediately — opencode never trips this because it always streams.
  // 2. Bun.fetch -> Bun.serve streaming POST (client and keyrouter are both
  //    Bun) deadlocks the same way, even though curl against the identical
  //    endpoint streams fine — so this call shells out to curl.
  const body = JSON.stringify({
    model: models.base.model,
    max_tokens: 16384,
    stream: true,
    // default-effort reasoning on these models can outburn max_tokens with
    // zero content deltas (the slicer prompt is big); low finishes in ~30s
    reasoning_effort: "low",
    messages: [
      { role: "system", content: "You decompose PRDs into build orders for an unattended software factory. Answer ONLY in the requested block format." },
      { role: "user", content: buildSlicerPrompt(prdText, max) },
    ],
  });
  const scratch = join(tmpdir(), "pdf-slicer");
  mkdirSync(scratch, { recursive: true });
  const bodyFile = join(scratch, `body-${Date.now()}.json`);
  const outFile = join(scratch, `raw-${Date.now()}.sse`);
  writeFileSync(bodyFile, body);
  try {
    const res = await sh(
      ["curl", "-sN", "--max-time", String(Math.floor(SLICER_TIMEOUT_MS / 1000)),
       "-X", "POST", `${provider.baseUrl}/chat/completions`,
       "-H", "content-type: application/json",
       "-H", `authorization: Bearer ${provider.apiKey}`,
       "--data-binary", `@${bodyFile}`, "-o", outFile],
      { timeoutMs: SLICER_TIMEOUT_MS + 15_000 }
    );
    if (res.code !== 0) throw new Error(`slicer curl exited ${res.code}`);
  } finally {
    try { rmSync(bodyFile); } catch {}
  }
  let text = "";
  for (const rawLine of readFileSync(outFile, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const ev = JSON.parse(payload) as any;
      // both the bare OpenAI shape and the pass pool's {"data":{...}} wrapper
      const delta = ev?.choices?.[0]?.delta?.content ?? ev?.data?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) text += delta;
    } catch { /* keep-alive or split frame */ }
  }
  try { rmSync(outFile); } catch {}
  if (!text.trim()) throw new Error("slicer failed: empty streamed completion (check provider quota/max_tokens)");
  return parseSlicerOutput(text);
}

const CONFIG_PATCH_ALLOW = [
  "models", "env", "timeouts", "merge", "default_branch", "attempts", "skip_labels", "pi",
];

function deepMerge(base: any, patch: any): any {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: any = { ...(typeof base === "object" && base !== null ? base : {}) };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
  return out;
}

/** Remote wizard support: deep-merge a patch into an onboarded repo's
 *  config.json. Keys outside the allowlist are refused — the patch may set
 *  models/env/merge knobs but never touches repo identity, scenario ports,
 *  or the onboarding itself. The merged result is re-validated by loadRepoConfig. */
export async function opsSetConfig(stateDir: string, slug: string, patch: any) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("config patch must be a JSON object");
  const bad = Object.keys(patch).filter((k) => !CONFIG_PATCH_ALLOW.includes(k));
  if (bad.length > 0)
    throw new Error("config patch keys outside the allowlist (" + CONFIG_PATCH_ALLOW.join(", ") + "): " + bad.join(", "));
  const path = join(repoCfgDir(stateDir, slug), "config.json");
  if (!existsSync(path)) throw new Error("repo " + slug + " is not onboarded");
  const merged = deepMerge(JSON.parse(readFileSync(path, "utf8")), patch);
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
  loadRepoConfig(path); // re-validate shape
  return { config_path: path, config: merged };
}

export async function opsBacklog(
  stateDir: string,
  slug: string,
  prdText: string,
  opts: { max?: number; dryRun?: boolean } = {}
) {
  const cfg: RepoConfig = loadRepoConfig(join(repoCfgDir(stateDir, slug), "config.json"));
  const gh = new Gh(cfg.repo);
  const sliced = await slice(prdText, cfg, opts.max ?? 40);
  if (sliced.length === 0) {
    const rawPath = join(stateDir, `slicer-raw-${Date.now()}.txt`);
    writeFileSync(rawPath, res.text);
    throw new Error(`slicer output unparsable — raw output saved to ${rawPath}`);
  }
  const existing = await gh.issueList("all", 500);
  const fresh = filterNew(sliced, existing.map((i) => i.title));
  const preview = fresh.map((s) => ({ title: s.title, depends: s.dependsOn }));
  if (opts.dryRun) {
    return { sliced: sliced.length, existing: sliced.length - fresh.length, preview, created: null };
  }
  const numbers: number[] = [];
  const created: { number: number; title: string }[] = [];
  for (const s of sliced) {
    const existingMatch = existing.find((e) => e.title.trim().toLowerCase() === s.title.trim().toLowerCase());
    let num: number;
    if (existingMatch) {
      num = existingMatch.number;
    } else {
      const dependsLine = s.dependsOn
        .map((d) => numbers[d - 1])
        .filter((d) => d !== undefined)
        .map((d) => `Depends on: #${d}`)
        .join("\n");
      const body = [s.body, dependsLine].filter(Boolean).join("\n\n");
      num = await gh.issueCreate(s.title, body);
    }
    numbers.push(num);
    created.push({ number: num, title: s.title });
  }
  receipt(stateDir, `backlog: ${numbers.length} issues resolved for ${cfg.repo}`);
  return { sliced: sliced.length, existing: sliced.length - fresh.length, preview, created };
}

export async function opsUnblock(stateDir: string, slug: string, issue: number, prune: boolean) {
  const cfg = loadRepoConfig(join(repoCfgDir(stateDir, slug), "config.json"));
  const ledger = new Ledger(join(stateDir, "factory.db"));
  const row = ledger.getIssue(cfg.repo, issue);
  if (!row) return { dropped: false, note: `#${issue} has no ledger row` };
  ledger.dropIssue(cfg.repo, issue);
  receipt(stateDir, `unblocked ${slug} #${issue} (ledger row dropped)`);
  const out: Record<string, unknown> = { dropped: true, issue };
  if (prune) {
    const gh = new Gh(cfg.repo);
    if (row.pr) {
      try { await gh.prClose(row.pr); out.pr_closed = row.pr; } catch (e: any) { out.pr_close_error = e.message?.slice(0, 150); }
    }
    try {
      await removeWorktree(stateDir, cfg, issue, { deleteBranch: true });
      out.worktree = "removed";
    } catch (e: any) {
      out.worktree_error = e.message?.slice(0, 150);
    }
    try {
      await deleteRemoteBranch(stateDir, cfg, issue);
      out.remote_branch = "deleted";
    } catch (e: any) {
      out.remote_branch_error = e.message?.slice(0, 150);
    }
  }
  return out;
}

export async function opsCleanup(stateDir: string): Promise<string[]> {
  const log: string[] = [];
  const ledger = new Ledger(join(stateDir, "factory.db"));
  const reposDir = join(stateDir, "repos");
  if (existsSync(reposDir)) {
    for (const slug of readdirSync(reposDir)) {
      const cfgPath = join(reposDir, slug, "config.json");
      if (!existsSync(cfgPath)) continue;
      let cfg: RepoConfig;
      try {
        cfg = loadRepoConfig(cfgPath);
      } catch (e: any) {
        log.push(`skip ${slug}: ${e.message}`);
        continue;
      }
      const root = wtRoot(stateDir, slug);
      if (!existsSync(root)) continue;
      for (const wt of readdirSync(root)) {
        const m = wt.match(/^issue-(\d+)$/);
        if (!m) continue;
        const row = ledger.getIssue(cfg.repo, Number(m[1]));
        if (row?.state === "blocked" || !row) {
          for (const d of ["node_modules", ".venv", "venv", "dist", "build", "target", "__pycache__"]) {
            const p = join(root, wt, d);
            if (existsSync(p)) {
              execSync(`rm -rf ${JSON.stringify(p)}`);
              log.push(`pruned ${p}`);
            }
          }
        }
      }
    }
  }
  try {
    const ps = execSync("ps -eo pid,etimes,args --sort=pid", { encoding: "utf8" });
    for (const line of ps.split("\n").slice(1)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m || !/--mode\s+json/.test(m[3])) continue;
      if (Number(m[2]) < 7200) continue;
      try {
        process.kill(Number(m[1]), "SIGKILL");
        log.push(`killed stale pi worker pid=${m[1]} (alive ${Math.round(Number(m[2]) / 3600)}h)`);
      } catch {}
    }
  } catch {}
  log.push("cleanup pass complete");
  receipt(stateDir, "cleanup pass complete");
  return log;
}
