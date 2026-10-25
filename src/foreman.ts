import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { opsBacklog, opsBake, opsCleanup, opsLogs, opsOnboard, opsStatus, opsUnblock } from "./ops";
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
  bake <slug>                         build the repo's golden instabox snapshot: machine from
                                         template + clone + env.instabox.bake script; sets
                                         env.instabox.snapshot in the repo config
  unblock <slug> <issue>              drop the ledger row so intake re-claims the issue
                                         [--prune] also close PR + delete branch + worktree
                                         [--force] override the in-progress guard (verify dead first)
  cleanup                             prune blocked worktrees' dep caches, kill stale pi,
                                       reap leftover pdf-* instabox machines, report disk

Options:
  --state-dir <path>    default: $PI_FACTORY_STATE or ./state

The same core is served remotely by factoryd (src/factoryd.ts) and driven by the
factory-remote client + pi-factory skill — the CLI is just the local face.`;

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
      const r = await opsBake(stateDir, pos[0]);
      console.log(`baked ${r.snapshot} (${r.snapshotId}) from machine ${r.machine}`);
      if (r.rootSizeBytes !== undefined) {
        console.log(`size: root ${Math.round(r.rootSizeBytes / 2 ** 30)} GiB${r.dataSizeBytes !== undefined ? `, data ${Math.round(r.dataSizeBytes / 2 ** 30)} GiB` : ""}`);
      }
      if (r.config_updated) console.log(`config updated: env.instabox.snapshot = "${r.snapshot}"`);
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
      }
      break;
    }
    case "cleanup": {
      for (const line of await opsCleanup(stateDir)) console.log(line);
      break;
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
