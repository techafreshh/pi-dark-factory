/**
 * The ops core — every factory mutation and read, shared by the foreman CLI
 * (local) and factoryd (remote HTTP). Functions return data; the surfaces
 * decide how to print it.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync as mvSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoConfig, resolveModels } from "./config";
import { buildStageCmd } from "./env";
import { Gh, repoDefaultBranch } from "./gh";
import { deleteRemoteBranch, ensureSource, removeWorktree } from "./gitws";
import { InstaBox, MACHINE_NAME_RE, sanitizeMachinePart } from "./instabox";
import { bootstrapScriptFor, buildMachineEnvFile, escapeSh, machineBash } from "./machine";
import { Ledger } from "./ledger";
import { portBusy, resolveScenarioPort, runScenario, runScenarioInMachine } from "./scenario";
import { loadScenario, type ScenarioResult } from "./scenario";
import { buildSlicerPrompt, filterNew, graphProblems, parseSlicerOutput } from "./slicer";
import { receipt } from "./receipts";
import { sh } from "./sh";
import { bumpInputsEpoch } from "./tick"; // function-body use only — ops↔tick is a live-binding cycle
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
    // every repo's chain count probes LIVE GitHub (issues, PRs, depends) —
    // done serially that is seconds of gh subprocess round-trips per repo,
    // and the status route once stalled past every proxy's patience while
    // four repos queued up (laptop saw 502s, 2026-10-24). Parallel with a
    // cap: a repo whose GitHub probe outruns 5s reports chain -1 instead of
    // hanging the whole status read.
    const probe = async (entry: string): Promise<OpsStatus["repos"][number] | null> => {
      const cfgPath = join(reposDir, entry, "config.json");
      if (!existsSync(cfgPath)) return null;
      try {
        const cfg = loadRepoConfig(cfgPath);
        if (slug && cfg.slug !== slug) return null;
        if (slug) repoForStages = cfg.repo; // stage rows are keyed by repo (owner/name), not slug
        const ledger = new Ledger(join(stateDir, "factory.db"));
        const claimable = (await import("./stages/intake")).listClaimable(cfg, ledger, new Gh(cfg.repo));
        const chain = await Promise.race([
          claimable.then((r) => r.length),
          new Promise<number>((resolve) => setTimeout(() => resolve(-1), 5000)),
        ]);
        const inFlight = ledger
          .listIssues(cfg.repo)
          .filter((r) => r.state === "in_progress").length;
        return { slug: cfg.slug, repo: cfg.repo, chain, in_flight: inFlight };
      } catch (e: any) {
        return { slug: entry, repo: `unloadable: ${e.message?.slice(0, 80)}`, chain: 0, in_flight: 0 };
      }
    };
    const rows = await Promise.all(readdirSync(reposDir).filter((e) => e !== "source").map(probe));
    repoList.push(...(rows.filter(Boolean) as OpsStatus["repos"][]));
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
    // --repo <slug> scopes ledger rows too — status --repo used to dump every
    // repo's issues and the operator grep'd manually every time (tic-tac-toe
    // postmortem 2026-10-25, P1-15a). Unknown slug → empty list, not all
    // (listIssues("") would be falsy and mean "no filter" — hence the ternary).
    issues: slug ? (repoForStages ? ledger.listIssues(repoForStages) : []) : ledger.listIssues(),
    laps: ledger.recentLaps(slug, 10),
    stages: ledger.recentStages(repoForStages, 15),
    worktrees,
  };
}

export function opsLogs(stateDir: string, opts: { slug?: string; tail?: number } = {}) {
  const path = join(stateDir, "laps.log");
  if (!existsSync(path)) return { lines: [], note: "no laps.log yet" };
  const all = readFileSync(path, "utf8").split("\n").filter(Boolean);
  // Lines are `[iso] [slug] msg` — every tick.ts receipt stamps the repo
  // slug, so `logs --repo <slug>` sees exactly that repo's laps with no
  // multi-tenant flood. Pre-tagging history (before 2026-10-25) falls back
  // to a loose substring match — the best an untagged line can do.
  const lines = opts.slug
    ? all.filter((l) => {
        const tag = /^\[[^\]]+\] \[([^\]]+)\]/.exec(l);
        if (tag) return tag[1] === opts.slug;
        return l.includes(opts.slug!);
      })
    : all;
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
  receipt(stateDir, `onboarded ${target} (slug: ${slug}, branch: ${branch}, ports: ${ports.join(" + ")})`, slug);
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

/**
 * Bake the repo's golden instabox snapshot: boot a machine from the template,
 * clone the repo, run the repo's `bake` shell (install deps...), snapshot it
 * as `<slug>-base`, and record the name in the repo config. Idempotent — the
 * old bake machine is rebuilt and the snapshot overwritten.
 */
export async function opsBake(stateDir: string, slug: string): Promise<{
  machine: string;
  snapshot: string;
  snapshotId: string;
  rootSizeBytes?: number;
  dataSizeBytes?: number;
  config_updated: boolean;
}> {
  const cfg = loadRepoConfig(join(repoCfgDir(stateDir, slug), "config.json"));
  const ibx = cfg.env.instabox;
  const ib = InstaBox.fromEnv(ibx);
  const name = `pdf-bake-${sanitizeMachinePart(slug)}`;

  receipt(stateDir, `bake ${slug}: booting machine ${name} from template ${ibx.template}`, slug);
  const existing = await ib.machineByName(name);
  if (existing) await ib.deleteMachine(name);
  const op = await ib.createMachine({ name, template: ibx.template, metadata: { factory: "1", bake: cfg.slug } });
  await ib.waitOperation(op.id);
  const machine = await ib.machineByName(name);
  if (!machine) throw new Error(`bake machine ${name} vanished after creation`);

  const envExports = (cfg.env.pass_env ?? [])
    .filter((k) => process.env[k] !== undefined && process.env[k] !== "")
    .map((k) => `export ${k}=${escapeSh(process.env[k]!)}`)
    .join("\n");
  const clone = [
    `set -eu`,
    envExports,
    `if [ -n "\${GITHUB_TOKEN:-}" ]; then git config --global url."https://x-access-token:$GITHUB_TOKEN@github.com/".insteadOf "https://github.com/" 2>/dev/null || true; fi`,
    `if [ ! -d ${escapeSh(ibx.repo_dir)}/.git ]; then git clone ${escapeSh(cfg.origin_url ?? `https://github.com/${cfg.repo}.git`)} ${escapeSh(ibx.repo_dir)}; fi`,
    `cd ${escapeSh(ibx.repo_dir)}`,
    `git fetch origin --prune >/dev/null 2>&1 || true`,
    `git reset --hard "origin/${cfg.default_branch}" >/dev/null`,
    `echo CLONE_OK`,
  ]
    .filter(Boolean)
    .join("\n");
  const tok = await ib.createSshToken(machine.id, { name: "bake", ttlSeconds: 8 * 3600 });
  const conn = { host: tok.host, port: tok.port, user: tok.token };
  const cloned = await machineBash(conn, clone, { timeoutMs: 15 * 60_000 });
  if (cloned.code !== 0 || !cloned.stdout.includes("CLONE_OK")) {
    throw new Error(`bake clone failed (exit ${cloned.code}): ${(cloned.stderr || cloned.stdout).trim().slice(0, 300)}`);
  }
  if (ibx.bake) {
    receipt(stateDir, `bake ${slug}: running bake script (${ibx.bake.length} chars)`, slug);
    const bakeScript = `set -eu\ncd ${escapeSh(ibx.repo_dir)}\nprintf %s ${Buffer.from(ibx.bake, "utf8").toString("base64")} | base64 -d | bash\n`;
    const res = await machineBash(conn, bakeScript, { timeoutMs: 120 * 60_000 });
    if (res.code !== 0) {
      throw new Error(`bake script failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 500)}`);
    }
  }

  const snapName = ibx.snapshot || `${sanitizeMachinePart(slug)}-base`;
  const snap = await ib.saveSnapshot(machine.id, snapName, {
    description: `pi-dark-factory golden environment for ${cfg.repo}`,
  });
  await ib.deleteMachine(name);

  let config_updated = false;
  const cfgPath = join(repoCfgDir(stateDir, slug), "config.json");
  if (!ibx.snapshot) {
    const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
    raw.env = raw.env ?? {};
    raw.env.instabox = { ...(raw.env.instabox ?? {}), snapshot: snapName };
    writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n");
    config_updated = true;
  }
  receipt(stateDir, `bake ${slug}: snapshot ${snapName} ready (${Math.round((snap.rootSizeBytes ?? 0) / 2 ** 30)} GiB root)`, slug);
  return {
    machine: name,
    snapshot: snapName,
    snapshotId: snap.id,
    rootSizeBytes: snap.rootSizeBytes,
    dataSizeBytes: snap.dataSizeBytes,
    config_updated,
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
    const spec = loadScenario(tmp);
    // upload-time probe lint — the same deterministic hazards the --lint
    // dry run rejects (quoted $PORT, bare parens in URLs, unknown tokens)
    // must never reach a lap: "a bad scenario can never burn a lap" only
    // holds if the write path checks what the bench checks (magpie
    // postmortem 2026-10-25, incident 10: lint passed the file that
    // burned the laps)
    const { errors } = lintProbes(spec);
    if (errors.length > 0) throw new Error(errors.join("; "));
  } catch (e: any) {
    rmSync(tmp, { force: true });
    throw new Error(`rejected ${kind}.json: ${e.message}`);
  }
  const path = join(dir, `${kind}.json`);
  rmSync(path, { force: true });
  mvSync(tmp, path);
  receipt(stateDir, `scenario ${kind}.json updated for ${slug} (validated)`, slug);
  // the world the blocked issues' fuses were measured against just changed
  bumpInputsEpoch(stateDir, slug);
  return { ok: true, path };
}

/** Probe-level lint shared by the upload path and the --lint dry run:
 * deterministic authoring hazards reject (they can only burn laps);
 * classic traps warn. "A bad scenario can never burn a lap" only holds
 * when the write path runs the same checks as the bench. */
function lintProbes(spec: ReturnType<typeof loadScenario>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const KNOWN = /^(status|status_in|json|body_contains|body_matches|exit|max_ms):/;
  for (const p of spec.probes ?? []) {
    for (const t of (p.expect ?? "").trim().split(/\s+/).filter(Boolean)) {
      if (!KNOWN.test(t))
        errors.push(
          `probe ${p.id}: unknown token "${t}" — expect values cannot contain spaces (tokens split on whitespace; use body_matches with \\s patterns)`
        );
      if (t.startsWith("body_matches:")) {
        try {
          new RegExp(t.slice("body_matches:".length));
        } catch {
          errors.push(`probe ${p.id}: body_matches regex does not compile — the matcher is a JavaScript RegExp (not ERE/BRE)`);
        }
      }
    }
    // single-quoted $PORT never expands: the probe curls a literal "$PORT"
    // and every attempt dies as 000/exit 6 while the app is perfectly up
    // (magpie postmortem 2026-10-25, incident 10 — lint passed the file).
    // A regex can't tell an OPENING quote from a closing one, so walk the
    // quote state the way the shell does.
    const cmd = p.command ?? "";
    let inSquote = false;
    for (let i = 0; i < cmd.length; i++) {
      if (cmd[i] === "'") inSquote = !inSquote;
      else if (inSquote && cmd.startsWith("$PORT", i)) {
        errors.push(
          `probe ${p.id}: '$PORT' in single quotes never expands — the shell treats it as a literal string; use double quotes or no quotes around $PORT`
        );
        break;
      }
    }
    // a bare URL with ( or ) is a shell syntax error before curl even runs
    // — percent-encode them (%28/%29); parens inside single quotes are
    // literal, so test the command with its single-quoted stretches blanked
    // (same incident, same lint gap)
    const unquoted = cmd.replace(/'[^']*'/g, (m) => " ".repeat(m.length));
    if (/https?:\/\/[^'"\s]*[()]/.test(unquoted))
      errors.push(
        `probe ${p.id}: the URL carries an unencoded ( or ) — a bare paren is a shell syntax error; percent-encode them (%28/%29)`
      );
    if (/status(_in)?:/.test(p.expect ?? "") && /\bcurl\b/.test(p.command ?? "") && !/-w\s+(['"])(\\n)?%\{http_code\}\1/.test(p.command ?? ""))
      warnings.push(
        `probe ${p.id}: status/status_in compare the command's LAST stdout line — the command must emit the code itself (curl -s -o /dev/null -w '%{http_code}'; a plain curl -s puts the BODY there and the probe fails as got "{…}", want "200")`
      );
    if (/(127\.0\.0\.1|localhost):\d{4,5}/.test(p.command ?? ""))
      warnings.push(`probe ${p.id}: command hardcodes a port — use $PORT (injected per run from the repo's reserved pair)`);
  }
  return { errors, warnings };
}

/**
 * Dry-run the scenario gate: the same shape validation as opsScenarioSet
 * plus probe-token linting, with NO write. Deterministic runtime failures
 * (unknown tokens from space-split values, uncompilable regexes) reject;
 * the classic authoring traps (status:N whose command never emits the code,
 * hardcoded ports) warn. todos-api postmortem 2026-10-24: "a scenario
 * lint verb would have saved every blocked lap we had."
 */
export function opsScenarioLint(stateDir: string, slug: string, kind: "runtime" | "holdout", content: string) {
  const dir = repoCfgDir(stateDir, slug);
  if (!existsSync(join(dir, "config.json"))) throw new Error(`repo ${slug} is not onboarded`);
  JSON.parse(content);
  const warnings: string[] = [];
  const tmp = join(dir, `.${kind}.json.lint-${Date.now()}`);
  writeFileSync(tmp, content);
  let spec;
  try {
    spec = loadScenario(tmp);
  } catch (e: any) {
    throw new Error(`rejected ${kind}.json: ${e.message}`);
  } finally {
    rmSync(tmp, { force: true });
  }
  const { errors, warnings: w } = lintProbes(spec);
  if (errors.length > 0) throw new Error(errors.join("; "));
  warnings.push(...w);
  return { ok: true, slug, kind, warnings };
}

/**
 * Run the STORED scenario against a branch WITHOUT spending a lap — the
 * verifier's own test bench. Every verifier bug in the tic-tac-toe and
 * bi-ai-ui runs (2026-10-24/25) could only be validated by burning a full
 * lap, because nothing could execute a scenario outside the verify stage.
 * This runs the exact same runners the verify gate uses: host/compose modes
 * get a temp worktree of the branch; instabox gets a throwaway
 * `pdf-<slug>-scen-test` machine booted from the same snapshot, bootstrap-
 * cloned to the branch, and destroyed in the finally. Read-only for the
 * ledger; a receipt lands either way.
 */
export async function opsScenarioTest(
  stateDir: string,
  slug: string,
  kind: "runtime" | "holdout",
  branch?: string
): Promise<{ slug: string; kind: string; branch: string; result: ScenarioResult; machine?: string }> {
  const cfgDir = repoCfgDir(stateDir, slug);
  if (!existsSync(join(cfgDir, "config.json"))) throw new Error(`repo ${slug} is not onboarded`);
  const cfg = loadRepoConfig(join(cfgDir, "config.json"));
  const file = kind === "runtime" ? cfg.scenario.runtime : cfg.scenario.holdout;
  const path = join(cfgDir, file);
  if (!existsSync(path)) throw new Error(`no ${kind} scenario for ${slug} — onboard templates or a validated upload would have written one`);
  const spec = loadScenario(path);
  spec.port = resolveScenarioPort(spec, cfg.scenario.ports);
  const target = branch ?? cfg.default_branch;

  if (cfg.env.mode === "instabox" && cfg.env.instabox) {
    const ib = InstaBox.fromEnv(cfg.env.instabox);
    const name = `pdf-${sanitizeMachinePart(slug)}-scen-test`;
    const marker = join(cfgDir, "scen-test.running");
    let snaps: Awaited<ReturnType<InstaBox["listSnapshots"]>> = [];
    try {
      snaps = await ib.listSnapshots();
    } catch {}
    const snap = snaps.find((s) => s.name === cfg.env.instabox!.snapshot);
    const m = await ib.ensureRunning({
      name,
      template: snap ? undefined : cfg.env.instabox.template,
      snapshotId: snap?.id,
      metadata: { factory: "1", repo: cfg.repo, issue: "scen-test" },
    });
    writeFileSync(marker, JSON.stringify({ pid: process.pid, machine: name }) + "\n");
    let result: ScenarioResult;
    try {
      const tok = await ib.createSshToken(m.id, { name: "factory", ttlSeconds: 3600 });
      const conn = { host: tok.host, port: tok.port, user: tok.token };
      const envFile = buildMachineEnvFile(cfg, { gates: false, branch: target, base: cfg.default_branch });
      // from:"branch" — the bench tests the BRANCH's tree; laps' default
      // (branch-at-base) would leave a fresh machine on main's tree
      const boot = await machineBash(conn, envFile + "\n" + bootstrapScriptFor(cfg, target, { from: "branch" }), { timeoutMs: 10 * 60_000 });
      if (boot.code !== 0 || !boot.stdout.includes("BOOTSTRAP_OK")) {
        throw new Error(`test machine bootstrap failed (exit ${boot.code}): ${boot.stderr.trim().slice(0, 300) || boot.stdout.trim().slice(0, 300)}`);
      }
      result = await runScenarioInMachine(
        spec,
        { ssh: async () => conn, repoDir: cfg.env.instabox!.repo_dir },
        {
          readinessSeconds: cfg.timeouts.readiness_seconds,
          defaultProbeMs: cfg.timeouts.probe_ms,
          key: `${slug}-scen-test`,
          reservedPorts: cfg.scenario.ports,
        }
      );
    } finally {
      rmSync(marker, { force: true });
      try {
        await ib.deleteMachine(m.id);
      } catch (e: any) {
        receipt(stateDir, `scenario test machine ${name} delete failed (janitor will catch it): ${String(e.message).slice(0, 120)}`, slug);
      }
    }
    receipt(stateDir, `scenario ${kind} TEST vs ${target} (machine ${name}, destroyed): ${result.pass ? "ALL GREEN" : "FAILED"}`, slug);
    return { slug, kind, branch: target, result, machine: name };
  }

  // host / compose: temp worktree of the branch, same runners as the gate
  const src = await ensureSource(stateDir, cfg);
  const wt = mkdtempSync(join(tmpdir(), `pdfscen-${sanitizeMachinePart(slug)}-`));
  const scratch = wt + ".scratch";
  const add = await sh(["git", "-C", src, "worktree", "add", "--detach", wt, `origin/${target}`], { timeoutMs: 120000 });
  if (add.code !== 0) {
    await sh(["git", "-C", src, "worktree", "remove", "--force", wt], { timeoutMs: 60000 });
    throw new Error(`branch ${target} not testable: ${add.stderr.trim().slice(0, 200)}`);
  }
  try {
    const envBuild =
      cfg.env.mode === "compose"
        ? buildStageCmd(cfg, wt, stateDir, `pdf-${slug}-scen-test`, {
            extraEnv: { PORT: String(spec.port), WORKTREE: wt },
            publishPorts: true,
          })
        : undefined;
    const result = await runScenario(spec, scratch, {
      readinessSeconds: cfg.timeouts.readiness_seconds,
      defaultProbeMs: cfg.timeouts.probe_ms,
      worktree: wt,
      preClean: `pdf-${slug}-`,
      wrap: envBuild
        ? { argvPrefix: envBuild.argvPrefix, cleanup: () => sh(envBuild.cleanup!, { timeoutMs: 20000 }) }
        : undefined,
    });
    receipt(stateDir, `scenario ${kind} TEST vs ${target} (host worktree): ${result.pass ? "ALL GREEN" : "FAILED"}`, slug);
    return { slug, kind, branch: target, result };
  } finally {
    await sh(["git", "-C", src, "worktree", "remove", "--force", wt], { timeoutMs: 120000 });
    rmSync(scratch, { recursive: true, force: true });
  }
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
  const parsed = parseSlicerOutput(text);
  if (parsed.length === 0) {
    // parse returned nothing — park the raw model output where the operator
    // (and the laptop agent) can read it instead of masking the failure
    // behind an undefined variable
    const rawPath = join(tmpdir(), `pdf-slicer-raw-${Date.now()}.txt`);
    try { writeFileSync(rawPath, text); } catch {}
    throw new Error(
      `slicer completed but 0 issues parsed from its output — raw saved to ${rawPath}; ` +
        `sharpen the PRD's deliverables or adjust models.plan in config`
    );
  }
  return parsed;
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
  // shape-validate models at WRITE time — the silent-broken shapes (dotted
  // strings, thinking suffixes inside the model id) passed this write-only
  // merge and cost a whole onboarding session (kvstore 2026-10-23)
  if (patch.models && typeof patch.models === "object") {
    for (const [stage, entry] of Object.entries(patch.models)) {
      if (entry === null) continue;
      if (typeof entry !== "object" || Array.isArray(entry))
        throw new Error(
          `models.${stage} must be an object {provider, model, thinking?, fallback?} — ` +
            `a dotted string ("provider/model:thinking") is valid only in fallback arrays`
        );
      const model = (entry as any).model;
      if (model !== undefined && (typeof model !== "string" || model.includes(":")))
        throw new Error(
          `models.${stage}.model must be the bare model id (got ${JSON.stringify(model)}) — ` +
            `put the level in models.${stage}.thinking; the provider/model:thinking form belongs in fallback arrays`
        );
      if ((entry.provider !== undefined || model !== undefined) && !model)
        throw new Error(`models.${stage} must set both provider and model`);
      const fb = (entry as any).fallback;
      if (fb !== undefined) {
        if (!Array.isArray(fb))
          throw new Error(`models.${stage}.fallback must be an array of "provider/model[:thinking]" strings`);
        for (const f of fb)
          if (typeof f !== "string" || !/^[^\s]+\/[^\s]+(:\w+)?$/.test(f))
            throw new Error(
              `models.${stage}.fallback entries must be "provider/model[:thinking]" strings (got ${JSON.stringify(f)})`
            );
      }
    }
  }
  const path = join(repoCfgDir(stateDir, slug), "config.json");
  if (!existsSync(path)) throw new Error("repo " + slug + " is not onboarded");
  const merged = deepMerge(JSON.parse(readFileSync(path, "utf8")), patch);
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
  loadRepoConfig(path); // re-validate shape
  // config writes (models, env, timeouts) change lap inputs — blocked
  // issues get a fresh revive budget, same as scenario writes
  bumpInputsEpoch(stateDir, slug);
  return { config_path: path, config: merged };
}

/** Read verb the config gate always needed: the EFFECTIVE config, not an
 *  echo — write-only state forced operators to probe by mutation and the
 *  probes wrote (kvstore postmortem 2026-10-24, lesson 7). */
export function opsGetConfig(stateDir: string, slug: string) {
  const path = join(repoCfgDir(stateDir, slug), "config.json");
  if (!existsSync(path)) throw new Error("repo " + slug + " is not onboarded");
  return { slug, config: loadRepoConfig(path) };
}

/** Same read need for scenarios: dump the stored verifier, don't re-derive
 *  it from validator behavior. */
export function opsGetScenario(stateDir: string, slug: string, kind: "runtime" | "holdout") {
  const path = join(repoCfgDir(stateDir, slug), `${kind}.json`);
  if (!existsSync(path)) throw new Error(`no ${kind} scenario for ${slug} (onboard templates or a validated upload would have written one)`);
  return { slug, kind, scenario: loadScenario(path) };
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
  // note: slice() throws if its output parses to zero issues (raw kept in
  // /tmp), so `sliced` always carries at least one build order here
  const existing = await gh.issueList("all", 500);
  const fresh = filterNew(sliced, existing.map((i) => i.title));
  const preview = fresh.map((s) => ({ title: s.title, depends: s.dependsOn }));
  // deps are indices into the slicer's own output — validate that graph
  // before anything is created: a self/forward/out-of-range dep used to
  // drop silently in the create loop below, losing the dependency and
  // letting the chain claim an issue before its prerequisite existed
  const graph = graphProblems(sliced);
  if (opts.dryRun) {
    return { sliced: sliced.length, existing: sliced.length - fresh.length, preview, created: null, graph_problems: graph };
  }
  if (graph.length > 0)
    throw new Error(
      `backlog graph invalid — refusing to create issues (re-slice, or sharpen the PRD's build order): ` +
        graph.join("; ")
    );
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
  receipt(stateDir, `backlog: ${numbers.length} issues resolved for ${cfg.repo}`, slug);
  return { sliced: sliced.length, existing: sliced.length - fresh.length, preview, created };
}

/** Pause/resume a repo's lane on the tick wheel. A paused repo is skipped
 * whole — no claims, no revives — until unpause: the remote lever the wheel
 * lacked while a crash-looping repo ate every tick and its neighbors
 * starved (magpie postmortem 2026-10-25, incident 21). An in-flight lap
 * finishes; pause only stops NEW work. */
export function opsPause(stateDir: string, slug: string, paused: boolean) {
  const dir = repoCfgDir(stateDir, slug);
  if (!existsSync(join(dir, "config.json"))) throw new Error("repo " + slug + " is not onboarded");
  const flag = join(dir, "paused");
  if (paused) writeFileSync(flag, new Date().toISOString() + "\n", { mode: 0o644 });
  else rmSync(flag, { force: true });
  receipt(
    stateDir,
    paused ? `paused: ${slug} skips ticks until unpause (an in-flight lap, if any, finishes)` : `unpaused: ${slug} resumes on the next tick`,
    slug
  );
  return { slug, paused };
}

export async function opsUnblock(stateDir: string, slug: string, issue: number, prune: boolean, force = false) {
  const cfg = loadRepoConfig(join(repoCfgDir(stateDir, slug), "config.json"));
  const ledger = new Ledger(join(stateDir, "factory.db"));
  const row = ledger.getIssue(cfg.repo, issue);
  if (!row) return { dropped: false, note: `#${issue} has no ledger row` };
  // guard: an in_progress row may be a LIVE lap — dropping it mid-flight
  // orphaned a working lap once (tic-tac-toe #10, 2026-10-24: pruned while
  // the implement stage was still running; the PR opened 36 seconds later;
  // survival was luck, not design). The next tick's reconcile cleans up
  // genuinely crashed laps by itself; --force is the verified-dead override.
  if (row.state === "in_progress" && !force) {
    let machine = "";
    if (cfg.env.mode === "instabox" && cfg.env.instabox) {
      try {
        // any generation of this issue's machine counts (-g<lapId> suffixes)
        const prefix = `pdf-${sanitizeMachinePart(slug)}-i${issue}`;
        const hit = (await InstaBox.fromEnv(cfg.env.instabox).listMachines()).find(
          (m) => (m.name ?? "") === prefix || new RegExp(`^${prefix}-g\\d+$`).test(m.name ?? "")
        );
        if (hit) machine = ` Its machine ${hit.name} still exists — the janitor reaps it after the row drops.`;
      } catch {}
    }
    return {
      dropped: false,
      issue,
      refused: "in_progress",
      note:
        `#${issue} is in_progress — a lap may be LIVE. A genuinely crashed lap reconciles automatically on the next tick. ` +
        `If you have verified it is dead (quiet session tail, no machine activity), re-run with --force.${machine}`,
    };
  }
  ledger.dropIssue(cfg.repo, issue);
  receipt(stateDir, `unblocked ${slug} #${issue} (ledger row dropped)`, slug);
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

  // instabox janitor — guarded: a LIVE lap's machine must never be reaped
  // (its clone is the worktree), so only machines whose issue has no
  // in_progress ledger row are deleted
  try {
    const reaped = await reapOrphanMachines(stateDir, ledger, (m) => log.push(m));
    if (reaped === 0) log.push("no orphaned instabox machines");
  } catch (e: any) {
    log.push(`instabox cleanup skipped: ${e.message?.slice(0, 150)}`);
  }
  log.push("cleanup pass complete");
  receipt(stateDir, "cleanup pass complete");
  return log;
}

/**
 * InstaBox janitor: pdf-* machines are per-lap disposables, but a live lap's
 * machine must survive (its /data clone IS the worktree). A machine is an
 * orphan unless its issue's ledger row is in_progress — merged/blocked/no-row
 * machines (crashed laps, phantom platform records, de-onboarded repos) get
 * deleted. Runs at every tick's tail and inside `cleanup`.
 */
export async function reapOrphanMachines(
  stateDir: string,
  ledger: Pick<Ledger, "getIssue">,
  log: (m: string) => void
): Promise<number> {
  const reposDir = join(stateDir, "repos");
  if (!existsSync(reposDir)) return 0;
  const instaboxBySlug = new Map<string, RepoConfig>();
  for (const slug of readdirSync(reposDir)) {
    const cfgPath = join(reposDir, slug, "config.json");
    if (!existsSync(cfgPath)) continue;
    try {
      const cfg = loadRepoConfig(cfgPath);
      if (cfg.env.mode === "instabox" && cfg.env.instabox) instaboxBySlug.set(slug, cfg);
    } catch {}
  }
  if (instaboxBySlug.size === 0) return 0;
  const ib = InstaBox.fromEnv(instaboxBySlug.values().next().value!.env.instabox!);
  let machines;
  try {
    machines = await ib.listMachines();
  } catch (e: any) {
    log(`instabox janitor skipped: ${e.message?.slice(0, 150)}`);
    return 0;
  }
  let reaped = 0;
  for (const m of machines) {
    const hit = MACHINE_NAME_RE.exec(m.name ?? "");
    const testHit = /^pdf-(.+)-scen-test$/.exec(m.name ?? "");
    if (!hit && !testHit) continue;
    const slugOf = (hit ?? testHit)![1];
    if (testHit) {
      // a scenario-test machine belongs to no lap — it is protected ONLY by
      // its runner's marker (pid + name); a dead pid or missing marker
      // means the test crashed and the box is quota-eating stray
      const markerPath = join(stateDir, "repos", slugOf, "scen-test.running");
      try {
        const marker = JSON.parse(readFileSync(markerPath, "utf8"));
        if (marker.machine === m.name && typeof marker.pid === "number") {
          try { process.kill(marker.pid, 0); continue; } catch {} // runner still alive
        }
      } catch {}
      try {
        await ib.deleteMachine(m.id);
        reaped++;
        log(`janitor deleted stray scenario-test machine ${m.name}`);
      } catch (e: any) {
        log(`janitor could not delete ${m.name}: ${e.message?.slice(0, 120)}`);
      }
      continue;
    }
    const cfg = instaboxBySlug.get(slugOf);
    if (cfg) {
      const row = ledger.getIssue(cfg.repo, Number(hit![2]));
      if (row && row.state === "in_progress") continue; // a lap is live in it
      try {
        await ib.deleteMachine(m.id);
        reaped++;
        log(`janitor deleted instabox machine ${m.name} (${row?.state ?? "no ledger row"})`);
      } catch (e: any) {
        log(`janitor could not delete ${m.name}: ${e.message?.slice(0, 120)}`);
      }
    } else {
      // unknown slug (repo de-onboarded or switched off machine mode) — the
      // machine can't belong to any live lap we know; reap it
      try {
        await ib.deleteMachine(m.id);
        reaped++;
        log(`janitor deleted instabox machine ${m.name} (unknown repo)`);
      } catch (e: any) {
        log(`janitor could not delete ${m.name}: ${e.message?.slice(0, 120)}`);
      }
    }
  }
  return reaped;
}
