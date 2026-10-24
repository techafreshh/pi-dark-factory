import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e: any) {
    if (e.code === "ESRCH") return false;
    // EPERM: alive under another user
  }
  return true;
}

function looksLikeFactory(pid: number): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    return /foreman|pi-dark-factory/.test(cmdline);
  } catch {
    // no /proc (non-Linux dev box) — trust liveness alone
    return true;
  }
}

function lockAcquire(path: string): boolean {
  if (existsSync(path)) {
    const pid = parseInt(readFileSync(path, "utf8").trim(), 10);
    if (Number.isFinite(pid) && isAlive(pid) && looksLikeFactory(pid)) return false;
  }
  writeFileSync(path, `${process.pid}\n`);
  return true;
}

function lockRelease(path: string) {
  try {
    if (readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path);
  } catch {
    // absent or raced — nothing to release
  }
}

/**
 * Scheduler mutual exclusion via pidfile + liveness: only ONE tick (the
 * dispatcher) may run at a time. Laps themselves run in parallel inside it.
 * systemd never overlaps the service with itself; this only guards a manual
 * `foreman tick` against the scheduled one. A dead holder's lock is
 * reclaimed, so a crashed tick can never wedge the timer forever.
 */
export function acquireTickLock(stateDir: string): boolean {
  return lockAcquire(join(stateDir, "tick.lock"));
}

export function releaseTickLock(stateDir: string) {
  lockRelease(join(stateDir, "tick.lock"));
}

const repoLockName = (slug: string) => `tick-${slug.replace(/[^a-z0-9-]+/g, "-")}.lock`;

/**
 * Per-repo mutual exclusion: a slug-scoped tick holds only its repo's lock,
 * so one repo's blocked-issue churn (revive rounds + their 10-min in-tick
 * cooldowns) can no longer starve manual ticks for an unrelated repo —
 * observed 2026-10-24: todos-api held the global pidfile ~1h, silently
 * skipping seven laptop ticks for tic-tac-toe. Full ticks take the global
 * lock and additionally skip any repo whose per-repo lock is held.
 */
export function acquireRepoLock(stateDir: string, slug: string): boolean {
  return lockAcquire(join(stateDir, repoLockName(slug)));
}

export function releaseRepoLock(stateDir: string, slug: string) {
  lockRelease(join(stateDir, repoLockName(slug)));
}
