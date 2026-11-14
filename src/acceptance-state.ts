import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Factory-side state of one repo's PRD-delivery acceptance
 * (docs/acceptance.md). Everything here lives OUTSIDE the repo — the PRD
 * text, the authored e2e suite and the acceptance verdict are acceptance
 * surfaces, and the repo's agents must never be able to tune against them
 * (the same rule that keeps runtime.json/holdout.json in factory state).
 *
 *   state/repos/<slug>/prd.md            the PRD text (written by opsBacklog
 *                                        at slice time, replaceable via
 *                                        POST /repos/<slug>/prd)
 *   state/repos/<slug>/e2e/              the authored suite (e2e.config.ts,
 *                                        tests/*.e2e.ts) — authored by the
 *                                        drain-time acceptance agent
 *   state/repos/<slug>/acceptance.json   { gen, last, runs }
 *   state/repos/<slug>/acceptance.running  janitor guard while an accept
 *                                        machine is live (mirror of
 *                                        scen-test.running)
 */

export interface AcceptanceLast {
  status: "pass" | "fail";
  /** HEAD sha of origin/main the pass verdict was recorded on — a merge
   *  after the pass invalidates it and the next drain re-runs */
  main_head?: string;
  /** the backlog generation this verdict belongs to — a re-slice bumps the
   *  generation, so a PASS from the previous contract never skips a walk */
  gen?: number;
  at: string;
  /** one-line summary of the run (counts, or why it failed) */
  summary?: string;
}

export interface AcceptanceState {
  /** bumped every time a backlog is sliced from a PRD — a new backlog is a
   *  new delivery contract, so a stale PASS never outlives its generation */
  gen: number;
  /** the drain-time PRD acceptance verdict */
  last?: AcceptanceLast;
  /** the per-merge penthera security verdict (a different gate — never
   *  clobbers `last`) */
  last_security?: AcceptanceLast;
  /** drain-time acceptance attempts per UTC day: { "2026-11-14": 1 } — the
   *  cap (2) keeps a fail-without-filings loop from eating tokens forever */
  runs?: Record<string, number>;
}

export function prdPath(stateDir: string, slug: string): string {
  return join(stateDir, "repos", slug, "prd.md");
}

export function e2eSuiteDir(stateDir: string, slug: string): string {
  return join(stateDir, "repos", slug, "e2e");
}

export function acceptanceStatePath(stateDir: string, slug: string): string {
  return join(stateDir, "repos", slug, "acceptance.json");
}

export function acceptanceRunningPath(stateDir: string, slug: string): string {
  return join(stateDir, "repos", slug, "acceptance.running");
}

/** Run `fn` under the walker's marker — the ONLY thing protecting a
 *  `pdf-<slug>-i0` machine from the janitor (a live pid; a dead runner's
 *  machine is a quota-eating stray). Every code path that boots an
 *  acceptance machine wraps its lifetime in this: the drain walk and the
 *  per-merge e2e regression alike. */
export async function withAcceptanceMarker<T>(stateDir: string, slug: string, fn: () => Promise<T>): Promise<T> {
  writeFileSync(acceptanceRunningPath(stateDir, slug), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n");
  try {
    return await fn();
  } finally {
    rmSync(acceptanceRunningPath(stateDir, slug), { force: true });
  }
}

export function readPrd(stateDir: string, slug: string): string | null {
  const p = prdPath(stateDir, slug);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, "utf8").trim();
  return text.length > 0 ? text : null;
}

/** True when a suite with at least one test file exists. A directory with
 *  only a config is not a suite — the drain-time authoring step creates
 *  tests, and a config alone would run zero tests and pass vacuously. The
 *  accepted suffixes are exactly what the collectors copy back (".e2e.ts" /
 *  ".e2e.js", the e2e framework's convention) so detection and collection
 *  can never disagree. */
export function e2eSuiteExists(stateDir: string, slug: string): boolean {
  const dir = e2eSuiteDir(stateDir, slug);
  if (!existsSync(dir)) return false;
  const isTest = (f: string) => f.endsWith(".e2e.ts") || f.endsWith(".e2e.js");
  try {
    for (const e of readdirSafe(dir)) {
      if (isTest(e)) return true;
      const nested = join(dir, e);
      if (!e.startsWith(".") && existsSync(nested) && readdirSafe(nested).some(isTest)) return true;
    }
  } catch {}
  return false;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function readAcceptanceState(stateDir: string, slug: string): AcceptanceState {
  const p = acceptanceStatePath(stateDir, slug);
  if (!existsSync(p)) return { gen: 0 };
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return { gen: Number(j?.gen) || 0, last: j?.last, last_security: j?.last_security, runs: j?.runs ?? {} };
  } catch {
    // a corrupted state file must not freeze the trigger logic — treat as
    // fresh, the worst case is one extra acceptance walk
    return { gen: 0 };
  }
}

export function writeAcceptanceState(stateDir: string, slug: string, state: AcceptanceState): void {
  const p = acceptanceStatePath(stateDir, slug);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
}

/** How many drain-time acceptance runs happened today (UTC). */
export function acceptanceRunsToday(stateDir: string, slug: string): number {
  const today = new Date().toISOString().slice(0, 10);
  return readAcceptanceState(stateDir, slug).runs?.[today] ?? 0;
}

/** Record that an acceptance run happened today (UTC). */
export function recordAcceptanceRun(stateDir: string, slug: string): void {
  const state = readAcceptanceState(stateDir, slug);
  const today = new Date().toISOString().slice(0, 10);
  const runs = { ...(state.runs ?? {}) };
  runs[today] = (runs[today] ?? 0) + 1;
  // keep only the last two days of counters — the map would otherwise grow
  // by a key a day for the life of the repo
  for (const k of Object.keys(runs)) {
    if (k < new Date(Date.now() - 36 * 3600_000).toISOString().slice(0, 10)) delete runs[k];
  }
  writeAcceptanceState(stateDir, slug, { ...state, runs });
}
