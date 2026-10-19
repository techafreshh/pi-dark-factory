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

/**
 * Tick mutual exclusion via pidfile + liveness. systemd never overlaps the
 * service with itself; this only guards a manual `foreman tick` against the
 * scheduled one. A dead holder's lock is reclaimed, so a crashed tick can
 * never wedge the timer forever.
 */
export function acquireTickLock(stateDir: string): boolean {
  const path = join(stateDir, "tick.lock");
  if (existsSync(path)) {
    const pid = parseInt(readFileSync(path, "utf8").trim(), 10);
    if (Number.isFinite(pid) && isAlive(pid) && looksLikeFactory(pid)) return false;
  }
  writeFileSync(path, `${process.pid}\n`);
  return true;
}

export function releaseTickLock(stateDir: string) {
  const path = join(stateDir, "tick.lock");
  try {
    if (readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path);
  } catch {
    // absent or raced — nothing to release
  }
}
