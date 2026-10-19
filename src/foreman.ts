import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRepoConfig } from "./config";
import { Gh, repoDefaultBranch } from "./gh";
import { removeWorktree, sourceDir, worktreeDir } from "./gitws";
import { Ledger } from "./ledger";
import { portBusy } from "./scenario";
import { receipt } from "./receipts";
import { buildSlicerPrompt, filterNew, parseSlicerOutput } from "./slicer";
import { runTick } from "./tick";
import { callPi } from "./pi";
import { resolveModels } from "./config";
import type { RepoConfig } from "./types";

const HELP = `pi-dark-factory foreman — unattended build loop on Pi

Usage: foreman <command> [options]

Commands:
  tick   [--repo <slug>] [--concurrency N]   one lap per repo (next claimable link in its
                                             dependency chain); repos run in parallel,
                                             N caps that (0 or omitted = unlimited)
  status [--repo <slug>]              claim ledger, recent laps/stages, worktrees
  onboard <owner/name>                register a repo: config + scenario templates + port pair
  backlog <slug> --prd <path>         slice a PRD into ordered GitHub issues (dedup by title)
                                         [--max N] [--dry-run]
  unblock <slug> <issue>              drop the ledger row so intake re-claims the issue
                                         [--prune] also close PR + delete branch + worktree
  cleanup                             prune blocked worktrees' dep caches, kill stale pi,
                                       report disk

Options:
  --state-dir <path>    default: $PI_FACTORY_STATE or ./state

The lifecycle: intake (deterministic, ledger-gated) → plan → implement (fresh
worktree) → verify (git + CI + black-box scenarios) → review → squash-merge →
close. Blocked issues get a GitHub comment and are never auto-re-tried.`;

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      pos.push(argv[i]);
    }
  }
  return { pos, flags };
}

function stateDirOf(flags: Record<string, string | boolean>): string {
  const fromFlag = typeof flags["state-dir"] === "string" ? flags["state-dir"] : undefined;
  const dir = fromFlag ?? process.env.PI_FACTORY_STATE ?? "./state";
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function cmdOnboard(stateDir: string, target: string) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(target)) throw new Error(`expected owner/name, got "${target}"`);
  const slug = target.split("/")[1];
  const repoCfgDir = join(stateDir, "repos", slug);
  if (existsSync(join(repoCfgDir, "config.json"))) {
    console.log(`already onboarded: ${join(repoCfgDir, "config.json")}`);
    return;
  }
  console.log(`reading default branch of ${target}...`);
  const branch = await repoDefaultBranch(target);

  // reserved ports = every port referenced by any existing config (a port
  // probe alone lies — nothing listens between laps), plus a live bind test
  const reserved = new Set<number>();
  if (existsSync(join(stateDir, "repos"))) {
    for (const entry of readdirSync(join(stateDir, "repos"))) {
      const cfgPath = join(stateDir, "repos", entry, "config.json");
      if (!existsSync(cfgPath)) continue;
      try {
        loadRepoConfig(cfgPath).scenario.ports.forEach((p) => reserved.add(p));
      } catch {}
    }
  }
  const ports: number[] = [];
  for (let p = 8100; ports.length < 2 && p < 8200; p += 2) {
    if (reserved.has(p)) continue;
    if (!(await portBusy(p))) ports.push(p);
  }
  if (ports.length < 2) throw new Error("no free port pair in 8100-8200");

  const cfg = {
    _readme: "pi-dark-factory repo config. models.default applies to every stage until overridden; stage keys: plan, implement, review. fallback entries are 'provider/model[:thinking]' strings tried in order on provider errors (timeouts are NOT retried on another model).",
    repo: target,
    slug,
    default_branch: branch,
    attempts: 3,
    merge: { method: "squash", required_checks: [], delete_branch: true },
    models: {
      default: { provider: "SET-ME", model: "SET-ME", thinking: "medium", fallback: [] },
    },
    timeouts: { stage_minutes: 30, checks_minutes: 30, readiness_seconds: 120, probe_ms: 10000 },
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
      extra_args: [],
    },
  };

  mkdirSync(repoCfgDir, { recursive: true });
  writeFileSync(join(repoCfgDir, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
  const tplRuntime = readFileSync(join(import.meta.dir, "..", "templates", "runtime.json"), "utf8");
  const tplHoldout = readFileSync(join(import.meta.dir, "..", "templates", "holdout.json"), "utf8");
  writeFileSync(join(repoCfgDir, "runtime.json"), tplRuntime.replace(/"port":\s*\d+/, `"port": ${ports[0]}`));
  writeFileSync(join(repoCfgDir, "holdout.json"), tplHoldout.replace(/"port":\s*\d+/, `"port": ${ports[1]}`));
  console.log(`onboarded ${target} (slug: ${slug}, branch: ${branch}, ports: ${ports.join(" + ")})`);
  console.log(`\nNext steps:`);
  console.log(`1. edit ${join(repoCfgDir, "config.json")} — set models.default to your planner/implementer/review model`);
  console.log(`2. edit ${join(repoCfgDir, "runtime.json")} and holdout.json — real setup/start/probes for THIS product`);
  console.log(`3. foreman backlog ${slug} --prd <path-to-PRD>`);
  console.log(`4. foreman tick`);
}

function cmdStatus(stateDir: string, slug?: string) {
  const ledger = new Ledger(join(stateDir, "factory.db"));
  console.log(`== ledger (${slug ?? "all repos"}) ==`);
  for (const row of ledger.listIssues(slug)) {
    console.log(
      `#${row.issue_number} [${row.state}] attempts=${row.attempts}${row.pr ? ` PR#${row.pr}` : ""} — ${(row.last_error ?? "").slice(0, 120)}`
    );
  }
  console.log("\n== recent laps ==");
  for (const lap of ledger.recentLaps(slug, 10)) {
    console.log(`#${lap.id} ${lap.repo} issue=${lap.issue_number ?? "-"} ${lap.outcome ?? "…"} ${(lap.detail ?? "").slice(0, 100)}`);
  }
  console.log("\n== recent stages ==");
  for (const s of ledger.recentStages(slug, 15)) {
    console.log(`#${s.id} ${s.stage} a${s.attempt} ${s.model} ${s.exit ?? "…"} tok=${s.input_tokens}/${s.output_tokens}`);
  }
  const reposDir = join(stateDir, "repos");
  if (existsSync(reposDir)) {
    console.log("\n== worktrees ==");
    for (const entry of readdirSync(reposDir)) {
      const wtRoot = join(stateDir, "worktrees", entry);
      if (existsSync(wtRoot)) {
        for (const wt of readdirSync(wtRoot)) console.log(`${entry}/${wt}`);
      }
    }
  }
}

async function cmdBacklog(stateDir: string, slug: string, prdPath: string, max: number, dryRun: boolean) {
  const cfgPath = join(stateDir, "repos", slug, "config.json");
  const cfg: RepoConfig = loadRepoConfig(cfgPath);
  const prd = readFileSync(prdPath, "utf8");
  const gh = new Gh(cfg.repo);
  const models = resolveModels(cfg, "plan");
  console.log(`slicing ${prdPath} with ${models.base.provider}/${models.base.model}...`);
  const res = await callPi({
    binary: cfg.pi.binary,
    model: models.base,
    prompt: buildSlicerPrompt(prd, max),
    cwd: stateDir,
    noTools: true,
    timeoutMs: cfg.timeouts.stage_minutes * 60_000,
  });
  if (res.kind !== "ok") throw new Error(`slicer failed: ${"error" in res ? res.error : res.kind}`);
  const sliced = parseSlicerOutput(res.text);
  if (sliced.length === 0) {
    writeFileSync(join(stateDir, `slicer-raw-${Date.now()}.txt`), res.text);
    throw new Error("slicer output unparsable — raw output saved next to the state dir for inspection");
  }
  const existing = await gh.issueList("all", 500);
  const fresh = filterNew(sliced, existing.map((i) => i.title));
  console.log(`sliced ${sliced.length} issues; ${sliced.length - fresh.length} already exist (deduped by title)`);
  if (dryRun) {
    fresh.forEach((s, i) =>
      console.log(`${i + 1}. ${s.title}${s.dependsOn.length ? ` (depends: ${s.dependsOn.join(",")})` : ""}`)
    );
    return;
  }
  const numbers: number[] = [];
  for (let i = 0; i < sliced.length; i++) {
    const s = sliced[i];
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
      console.log(`created #${num}: ${s.title}`);
    }
    numbers.push(num);
  }
  receipt(stateDir, `backlog: ${numbers.length} issues resolved for ${cfg.repo}`);
}

async function cmdUnblock(stateDir: string, slug: string, issue: number, prune: boolean) {
  const cfgPath = join(stateDir, "repos", slug, "config.json");
  const cfg = loadRepoConfig(cfgPath);
  const ledger = new Ledger(join(stateDir, "factory.db"));
  const row = ledger.getIssue(cfg.repo, issue);
  if (!row) {
    console.log(`#${issue} has no ledger row — nothing to unblock`);
    return;
  }
  ledger.dropIssue(cfg.repo, issue);
  console.log(`dropped ledger row for #${issue} — intake can reclaim it`);
  if (prune) {
    const gh = new Gh(cfg.repo);
    if (row.pr) {
      try {
        await gh.prClose(row.pr);
        console.log(`closed PR #${row.pr}`);
      } catch (e: any) {
        console.log(`PR close: ${e.message}`);
      }
    }
    try {
      await removeWorktree(stateDir, cfg, issue, { deleteBranch: true });
      console.log("removed worktree + local branch");
    } catch (e: any) {
      console.log(`worktree: ${e.message}`);
    }
  }
}

function cmdCleanup(stateDir: string) {
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
        console.log(`skip ${slug}: ${e.message}`);
        continue;
      }
      const wtRoot = join(stateDir, "worktrees", slug);
      if (!existsSync(wtRoot)) continue;
      for (const wt of readdirSync(wtRoot)) {
        const m = wt.match(/^issue-(\d+)$/);
        if (!m) continue;
        const n = Number(m[1]);
        const row = ledger.getIssue(cfg.repo, n);
        // merged rows' worktrees are removed at merge; blocked rows keep
        // their code for forensics — only dep caches are pruned
        if (row?.state === "blocked" || !row) {
          const dirs = ["node_modules", ".venv", "venv", "dist", "build", "target", "__pycache__"];
          for (const d of dirs) {
            const p = join(wtRoot, wt, d);
            if (existsSync(p)) {
              execSync(`rm -rf ${JSON.stringify(p)}`);
              console.log(`pruned ${p}`);
            }
          }
        }
      }
    }
  }
  // stale pi workers: older than 2× the stage timeout, no live lap can own them
  try {
    const ps = execSync(`ps -eo pid,etimes,args --sort=pid`, { encoding: "utf8" });
    for (const line of ps.split("\n").slice(1)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const [, pidS, etimeS, args] = m;
      if (!/--mode\s+json/.test(args)) continue;
      const etime = Number(etimeS);
      if (etime < 7200) continue;
      try {
        process.kill(Number(pidS), "SIGKILL");
        console.log(`killed stale pi worker pid=${pidS} (alive ${Math.round(etime / 3600)}h)`);
      } catch {}
    }
  } catch {
    // ps unavailable (non-Linux dev box)
  }
  try {
    const du = execSync(`du -sh ${JSON.stringify(stateDir)} 2>/dev/null || true`, { encoding: "utf8" }).trim();
    if (du) console.log(du);
  } catch {}
  receipt(stateDir, "cleanup pass complete");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  if (!command || command === "help" || flags.help) {
    console.log(HELP);
    return;
  }
  const stateDir = stateDirOf(flags);
  switch (command) {
    case "tick": {
      const fromFlag = typeof flags.concurrency === "string" ? Number(flags.concurrency) : undefined;
      const fromEnv = process.env.PI_FACTORY_CONCURRENCY ? Number(process.env.PI_FACTORY_CONCURRENCY) : undefined;
      const concurrency = Number.isFinite(fromFlag) ? fromFlag! : Number.isFinite(fromEnv) ? fromEnv : 0;
      await runTick({ stateDir, repoSlug: typeof flags.repo === "string" ? flags.repo : undefined, concurrency });
      break;
    }
    case "status":
      cmdStatus(stateDir, typeof flags.repo === "string" ? flags.repo : undefined);
      break;
    case "onboard":
      if (!pos[0]) throw new Error("onboard needs owner/name");
      await cmdOnboard(stateDir, pos[0]);
      break;
    case "backlog": {
      const slug = pos[0];
      const prd = typeof flags.prd === "string" ? flags.prd : undefined;
      if (!slug || !prd) throw new Error("backlog needs <slug> and --prd <path>");
      await cmdBacklog(stateDir, slug, prd, typeof flags.max === "string" ? Number(flags.max) : 40, flags["dry-run"] === true);
      break;
    }
    case "unblock": {
      const slug = pos[0];
      const n = Number(pos[1]);
      if (!slug || !Number.isFinite(n)) throw new Error("unblock needs <slug> <issue-number>");
      await cmdUnblock(stateDir, slug, n, flags.prune === true);
      break;
    }
    case "cleanup":
      cmdCleanup(stateDir);
      break;
    default:
      console.log(`unknown command "${command}"\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
