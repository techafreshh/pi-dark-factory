import { mkdirSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { opsAcceptanceRun, opsBacklog, opsBake, opsCleanup, opsHostTools, opsLogs, opsOnboard, opsPrdSet, opsSecurityScan, opsStatus, opsUnblock } from "./ops";
import { opsBaseBake, opsBaseList } from "./basebake";
import { updateBakeStatus } from "./bakejobs";
import { acquireBakeLock, releaseBakeLock, repoLockHeld } from "./lock";
import { runTick } from "./tick";

const HELP = `pi-dark-factory foreman — local CLI over the ops core

Usage: foreman <command> [options]

Commands:
  tick   [--repo <slug>] [--concurrency N]   one lap per repo (next claimable link in its
                                             dependency chain); repos run in parallel,
                                             N caps that (0 or omitted = unlimited)
  status [--repo <slug>]              claim ledger, recent laps/stages, worktrees
  logs   [--repo <slug>] [--tail N]   laps.log tail (the audit spine)
  onboard <owner/name>                register a repo: config + scenario templates + port pair
  backlog <slug> --prd <path>         slice a PRD into ordered GitHub issues (dedup by title)
                                         [--max N] [--dry-run]
  bake <slug>                         build the repo's golden snapshot on its machine
                                         platform (instabox/boxd machine flows; daytona
                                         sandbox flow; e2b/instavm remote builds) from the
                                         base snapshot/template + clone + env.<platform>.bake
                                         script; sets env.<platform>.snapshot in the config.
                                         A configured shared-base/stack alias is LAYERED on
                                         (boot it, save <slug>-base, switch the config);
                                         empty = platform seed; literal = enrich in place
                                         [--from <alias|snapshot>] [--name <snapshot>]
  unblock <slug> <issue>              drop the ledger row so intake re-claims the issue
                                         [--prune] also close PR + delete branch + worktree
                                         [--force] override the in-progress guard (verify dead first)
  cleanup                             prune blocked worktrees' dep caches, kill stale pi,
                                       reap leftover pdf-* lap machines (all machine platforms),
                                       report disk
  prd <slug> --prd <path>             store/replace the PRD the acceptance walks judge
  acceptance <slug>                   run the drain-time PRD acceptance walk now
                                         (docs/acceptance.md; bypasses the daily cap)
  security-scan <slug>                penthera scan of merged main; findings file issues
  host-tools                          install/verify the host browser + scanner toolchain
  base list                           shared base aliases and their per-platform snapshots
  base bake --platform <p> --name <n> bake a shared DEV base on instabox | boxd | daytona |
                                         e2b from the provider's richest stock image: node,
                                         python, go, git, gh, bun, pi, Chromium + the e2e
                                         toolchain and penthera; records it as
                                         shared-base.platforms.<p>
                                         [--seed <value>] [--seed-kind template|snapshot|image]
                                         [--alias <alias>]

Options:
  --state-dir <path>    default: $PI_FACTORY_STATE or ./state

The same core is served remotely by factoryd (src/factoryd.ts) and driven by the
dark-factory client + dark-factory skill — the CLI is just the local face.`;

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

function printStatus(s: Awaited<ReturnType<typeof opsStatus>>) {
  console.log("== repos ==");
  for (const r of s.repos) console.log(`${r.slug} (${r.repo}) — claimable chain: ${r.chain}, in flight: ${r.in_flight}`);
  console.log("\n== ledger ==");
  for (const row of s.issues) {
    console.log(
      `#${row.issue_number} ${row.repo} [${row.state}] attempts=${row.attempts}${row.pr ? ` PR#${row.pr}` : ""} — ${(row.last_error ?? "").slice(0, 120)}`
    );
  }
  console.log("\n== recent laps ==");
  for (const lap of s.laps) {
    console.log(`#${lap.id} ${lap.repo} issue=${lap.issue_number ?? "-"} ${lap.outcome ?? "…"} ${(lap.detail ?? "").slice(0, 100)}`);
  }
  console.log("\n== recent stages ==");
  for (const st of s.stages) {
    console.log(`#${st.id} ${st.stage} a${st.attempt} ${st.model} ${st.exit ?? "…"} tok=${st.input_tokens}/${st.output_tokens}`);
  }
  console.log("\n== worktrees ==");
  for (const wt of s.worktrees) console.log(wt);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  if (!command || command === "help" || flags.help) {
    console.log(HELP);
    return;
  }
  const stateDir = stateDirOf(flags);
  const slug = typeof flags.repo === "string" ? flags.repo : undefined;

  switch (command) {
    case "tick": {
      const fromFlag = typeof flags.concurrency === "string" ? Number(flags.concurrency) : undefined;
      const fromEnv = process.env.PI_FACTORY_CONCURRENCY ? Number(process.env.PI_FACTORY_CONCURRENCY) : undefined;
      const concurrency = Number.isFinite(fromFlag) ? fromFlag! : Number.isFinite(fromEnv) ? fromEnv : 0;
      await runTick({ stateDir, repoSlug: slug, concurrency });
      break;
    }
    case "status":
      printStatus(await opsStatus(stateDir, slug));
      break;
    case "logs": {
      const tail = typeof flags.tail === "string" ? Number(flags.tail) : 100;
      for (const line of opsLogs(stateDir, { slug, tail }).lines) console.log(line);
      break;
    }
    case "onboard": {
      if (!pos[0]) throw new Error("onboard needs owner/name");
      const r = await opsOnboard(stateDir, pos[0]);
      if (r.already) {
        console.log(`already onboarded: ${r.config_path}`);
      } else {
        console.log(`onboarded ${r.repo} (slug: ${r.slug}, branch: ${r.default_branch}, ports: ${r.ports!.join(" + ")})`);
        console.log(`\nNext steps:`);
        console.log(`1. edit ${r.config_written![0]} — set models.default to your planner/implementer/review model`);
        console.log(`2. edit ${r.config_written![1]} and ${r.config_written![2]} — real setup/start/probes for THIS product`);
        console.log(`3. foreman backlog ${r.slug} --prd <path-to-PRD>`);
        console.log(`4. foreman tick`);
      }
      break;
    }
    case "backlog": {
      const s = pos[0];
      const prd = typeof flags.prd === "string" ? flags.prd : undefined;
      if (!s || !prd) throw new Error("backlog needs <slug> and --prd <path>");
      const r = await opsBacklog(stateDir, s, readFileSync(prd, "utf8"), {
        max: typeof flags.max === "string" ? Number(flags.max) : 40,
        dryRun: flags["dry-run"] === true,
      });
      console.log(`sliced ${r.sliced} issues; ${r.existing} already exist (deduped by title)`);
      if (flags["dry-run"] === true) {
        r.preview!.forEach((p, i) => console.log(`${i + 1}. ${p.title}${p.depends.length ? ` (depends: ${p.depends.join(",")})` : ""}`));
      } else {
        r.created!.forEach((c) => console.log(`#${c.number}: ${c.title}`));
      }
      break;
    }
    case "bake": {
      if (!pos[0]) throw new Error("bake needs <slug>");
      const slug = pos[0];
      const statusFile = typeof flags["status-file"] === "string" ? flags["status-file"] : undefined;
      const lockKey = `repo-${slug}`;
      // a bake mutates the repo's snapshot/config while a lap may be using
      // the same checkout — same guard as the remote job. This child owns
      // the status file, so record the real reason for a --wait client.
      if (repoLockHeld(stateDir, slug)) {
        const error = `a tick is live for ${slug} — run the bake when the repo is idle`;
        if (statusFile) updateBakeStatus(statusFile, { state: "failed", ended_at: new Date().toISOString(), error });
        throw new Error(error);
      }
      // a remote job and a manual bake serialize on this pidfile; a loser
      // must not clobber the live job's status file
      if (!acquireBakeLock(stateDir, lockKey)) throw new Error(`a bake for ${slug} is already live (pidfile)`);
      if (statusFile) {
        updateBakeStatus(statusFile, {
          kind: "repo",
          key: slug,
          state: "running",
          pid: process.pid,
          started_at: new Date().toISOString(),
          slug,
        });
      }
      try {
        const r = await opsBake(stateDir, slug, {
          from: typeof flags.from === "string" ? flags.from : undefined,
          name: typeof flags.name === "string" ? flags.name : undefined,
        });
        if (statusFile) {
          updateBakeStatus(statusFile, {
            state: "done",
            ended_at: new Date().toISOString(),
            snapshot: r.snapshot,
            snapshot_id: r.snapshotId,
            platform: r.platform,
          });
        }
        console.log(`baked ${r.snapshot} (${r.snapshotId}) from machine ${r.machine}`);
        if (r.rootSizeBytes !== undefined) {
          console.log(`size: root ${Math.round(r.rootSizeBytes / 2 ** 30)} GiB${r.dataSizeBytes !== undefined ? `, data ${Math.round(r.dataSizeBytes / 2 ** 30)} GiB` : ""}`);
        }
        if (r.config_updated) console.log(`config updated: env.${r.platform}.snapshot = "${r.snapshot}"`);
      } catch (e) {
        if (statusFile) {
          updateBakeStatus(statusFile, {
            state: "failed",
            ended_at: new Date().toISOString(),
            error: (e instanceof Error ? e.message : String(e)).slice(0, 800),
          });
        }
        throw e;
      } finally {
        releaseBakeLock(stateDir, lockKey);
      }
      break;
    }
    case "unblock": {
      const s = pos[0];
      const n = Number(pos[1]);
      if (!s || !Number.isFinite(n)) throw new Error("unblock needs <slug> <issue-number>");
      const r = await opsUnblock(stateDir, s, n, flags.prune === true, flags.force === true);
      if (!r.dropped) {
        console.log(r.note);
      } else {
        console.log(`dropped ledger row for #${n} — intake can reclaim it`);
        if (r.pr_closed) console.log(`closed PR #${r.pr_closed}`);
        if (r.worktree) console.log(`worktree + local branch: ${r.worktree}`);
        if (Array.isArray(r.retired)) console.log(`retired ${r.retired.join(" + ")} — the next lap plans from scratch`);
      }
      break;
    }
    case "cleanup": {
      for (const line of await opsCleanup(stateDir)) console.log(line);
      break;
    }
    case "prd": {
      const s = pos[0];
      const prd = typeof flags.prd === "string" ? flags.prd : undefined;
      if (!s || !prd) throw new Error("prd needs <slug> and --prd <path>");
      const r = opsPrdSet(stateDir, s, readFileSync(prd, "utf8"));
      console.log(`prd stored at ${r.path} (acceptance generation ${r.gen})`);
      break;
    }
    case "acceptance": {
      if (!pos[0]) throw new Error("acceptance needs <slug>");
      const r = await opsAcceptanceRun(stateDir, pos[0], { force: true });
      console.log(r.ran ? `acceptance walk: ${r.summary ?? (r.pass ? "PASS" : "FAILED")}` : `not run: ${r.reason ?? "unknown reason"}`);
      for (const f of r.filed) console.log(`  filed #${f.issue}: ${f.title}`);
      break;
    }
    case "security-scan": {
      if (!pos[0]) throw new Error("security-scan needs <slug>");
      const r = await opsSecurityScan(stateDir, pos[0]);
      console.log(r.pass ? `security scan clean: ${r.summary}` : `security scan: ${r.summary}`);
      for (const f of r.filed) console.log(`  filed #${f.issue}: ${f.title}`);
      if (r.note) console.log(`  note: ${r.note}`);
      break;
    }
    case "host-tools": {
      const r = await opsHostTools(stateDir);
      for (const line of r.lines) console.log(`  ${line}`);
      console.log("host tools ready");
      break;
    }
    case "base": {
      const sub = pos[0];
      if (!sub || sub === "list") {
        const bases = opsBaseList(stateDir);
        if (bases.length === 0) {
          console.log("no base aliases — bake one with: foreman base bake --platform daytona --name factory-dev-daytona-r1");
          break;
        }
        for (const b of bases) {
          console.log(`== ${b.alias} ==`);
          if (b.snapshot) console.log(`  (legacy/generic snapshot) ${b.snapshot}`);
          for (const p of b.platforms) console.log(`  ${p.platform}: ${p.snapshot}${p.bakedAt ? ` (${p.bakedAt})` : ""}`);
          if (b.contents) console.log(`  contents: ${b.contents}`);
        }
        break;
      }
      if (sub === "bake") {
        const platform = typeof flags.platform === "string" ? flags.platform : undefined;
        const name = typeof flags.name === "string" ? flags.name : undefined;
        if (!platform || !name)
          throw new Error("base bake needs --platform <instabox|boxd|daytona|e2b> and --name <versioned-name>");
        const statusFile = typeof flags["status-file"] === "string" ? flags["status-file"] : undefined;
        const alias = typeof flags.alias === "string" ? flags.alias : undefined;
        const lockKey = `base-${platform}`;
        // a remote job and a manual bake serialize on this pidfile; a loser
        // must not clobber the live job's status file
        if (!acquireBakeLock(stateDir, lockKey)) throw new Error(`a base bake for ${platform} is already live (pidfile)`);
        if (statusFile) {
          updateBakeStatus(statusFile, {
            kind: "base",
            key: platform,
            state: "running",
            pid: process.pid,
            started_at: new Date().toISOString(),
            platform,
            name,
            alias,
          });
        }
        try {
          const r = await opsBaseBake(stateDir, platform, {
            name,
            seed: typeof flags.seed === "string" ? flags.seed : undefined,
            seedKind: typeof flags["seed-kind"] === "string" ? (flags["seed-kind"] as any) : undefined,
            alias,
          });
          if (statusFile) {
            updateBakeStatus(statusFile, {
              state: "done",
              ended_at: new Date().toISOString(),
              snapshot: r.snapshot,
              snapshot_id: r.snapshotId,
              contents: r.contents,
            });
          }
          console.log(`\nbase baked: ${r.platform} ${r.snapshot} from ${r.seed}`);
          console.log(`alias ${r.alias} now resolves ${r.platform} → ${r.snapshot}`);
          if (r.sizeBytes) console.log(`size: ${(r.sizeBytes / 2 ** 30).toFixed(1)} GiB`);
          console.log(`contents: ${r.contents}`);
        } catch (e) {
          if (statusFile) {
            updateBakeStatus(statusFile, {
              state: "failed",
              ended_at: new Date().toISOString(),
              error: (e instanceof Error ? e.message : String(e)).slice(0, 800),
            });
          }
          throw e;
        } finally {
          releaseBakeLock(stateDir, lockKey);
        }
        break;
      }
      throw new Error(`unknown base command "${sub}" — use base list or base bake`);
    }
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
