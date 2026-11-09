/**
 * Per-repo tick processes, started by the daemon.
 *
 * The systemd timer ran ONE oneshot service for the whole fleet, and systemd
 * cannot start a timer's service while it is still running: a repo whose lap
 * ran long held every other repo's next tick (33 of 311 ticks in the week to
 * 2026-11-09 overran their 15-minute slot, the longest took 126 minutes). And
 * the daemon ran slug ticks in-process, so it kept its start-time code until
 * a restart, and the restart killed the laps running inside it.
 *
 * Here every repo tick is its own `foreman tick --repo <slug>` process:
 * fresh code from disk on every tick, one lifetime per repo, and, with
 * KillMode=process on pi-factoryd, a daemon restart that leaves running laps
 * alone. The child takes the repo's tick lock itself, exactly like a manual
 * scoped tick, so the scheduler, the API, the old timer and a human at the
 * shell all arbitrate through the same pidfiles.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "./ledger";
import { repoLockHeld } from "./lock";
import { reapOrphanMachines } from "./ops";
import { receipt } from "./receipts";

const CHECKOUT = join(import.meta.dir, "..");
const FOREMAN = join(import.meta.dir, "foreman.ts");

/** Start `foreman tick --repo <slug>` detached from the caller. Its receipts
 *  go to laps.log as always; stderr (a crash before the tick's own receipts
 *  take over) is appended to <state>/ticks.err. */
export function spawnRepoTick(stateDir: string, slug: string): number | undefined {
  // the tick needs the gh, machine-platform and web keys; never the daemon's
  // own API keys, which only the HTTP gate uses
  const { FACTORY_API_KEY: _key, DARK_FACTORY_LAPTOP_KEY: _laptop, ...env } = process.env;
  const err = openSync(join(stateDir, "ticks.err"), "a");
  try {
    const child = spawn(process.execPath, [FOREMAN, "tick", "--repo", slug, "--state-dir", stateDir], {
      // the checkout as cwd: lock.ts recognizes factory processes by it
      cwd: CHECKOUT,
      // own session and process group: a signal aimed at the daemon's group
      // (a restart) does not reach the lap
      detached: true,
      stdio: ["ignore", "ignore", err],
      env,
    });
    child.on("error", (e) => receipt(stateDir, `could not start a tick process for ${slug}: ${e.message}`, slug));
    child.unref();
    return child.pid;
  } finally {
    closeSync(err); // the child holds its own copy of the descriptor
  }
}

/** onboarded repos: every directory under <state>/repos with a config.json */
export function onboardedSlugs(stateDir: string): string[] {
  const reposDir = join(stateDir, "repos");
  if (!existsSync(reposDir)) return [];
  return readdirSync(reposDir)
    .filter((e) => e !== "source" && existsSync(join(reposDir, e, "config.json")))
    .sort();
}

/** One scheduling pass: start a tick process for every repo that has none
 *  running (up to `concurrency` live repo ticks; 0 = unlimited), then reap
 *  orphaned lap machines. Pause handling stays in the child, which receipts
 *  the pause and its reason exactly as the fleet tick did. */
export async function schedulePass(
  stateDir: string,
  opts: { concurrency?: number; spawnTick?: (stateDir: string, slug: string) => number | undefined } = {}
): Promise<{ started: string[]; running: string[] }> {
  const start = opts.spawnTick ?? spawnRepoTick;
  const slugs = onboardedSlugs(stateDir);
  const running = slugs.filter((s) => repoLockHeld(stateDir, s));
  const limit = opts.concurrency ?? 0;
  const started: string[] = [];
  for (const slug of slugs) {
    if (running.includes(slug)) {
      receipt(stateDir, `skipping ${slug}: its previous tick is still running (per-repo pidfile)`, slug);
      continue;
    }
    if (limit > 0 && running.length + started.length >= limit) {
      receipt(stateDir, `skipping ${slug}: concurrency cap (${limit}) reached this pass`, slug);
      continue;
    }
    start(stateDir, slug);
    started.push(slug);
  }
  receipt(stateDir, `scheduler: started ${started.length} repo tick(s), ${running.length} still running${limit > 0 ? `, concurrency=${limit}` : ""}`);
  // the janitor ran at the tail of every fleet tick; it only reaps machines
  // whose issue has no in_progress row, so laps running in children are safe
  try {
    await reapOrphanMachines(stateDir, new Ledger(join(stateDir, "factory.db")), (m) => receipt(stateDir, m));
  } catch {}
  return { started, running };
}

/** Run schedulePass on wall-clock multiples of `everyMs` (every 15 minutes =
 *  :00 :15 :30 :45, the timer's OnCalendar), so a daemon restart never
 *  shifts or skips the schedule. */
export function startScheduler(stateDir: string, everyMs: number, concurrency = 0): { stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    const wait = everyMs - (Date.now() % everyMs);
    timer = setTimeout(async () => {
      try {
        await schedulePass(stateDir, { concurrency });
      } catch (e: any) {
        receipt(stateDir, `scheduler pass failed: ${String(e?.message ?? e).slice(0, 300)}`);
      }
      arm();
    }, wait);
  };
  arm();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
