/**
 * Remote bake jobs — the daemon-side wrapper that lets the laptop trigger a
 * base or repo bake without holding an HTTP request open for 5–40 minutes.
 *
 * The actual work is still `foreman base bake` / `foreman bake` in its own
 * detached process (fresh code from disk, survives a daemon restart exactly
 * like a tick). This module owns the small pieces around it:
 *   - a status file the CLI polls (`base-bakes/<platform>.json`,
 *     `repos/<slug>/bake.json`),
 *   - a pidfile per key (`lock.ts`'s bake-*.lock) so a manual foreman bake
 *     and a remote one cannot run together,
 *   - the spawn env: provider/platform keys ride in, the daemon's own API
 *     keys stay out (same rule as spawnRepoTick).
 *
 * Status is advisory for the CLI; the receipt in laps.log remains the audit
 * spine. A status still "running" whose pid is dead is reported (and
 * rewritten) as failed, so a daemon restart never leaves a job looking alive.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadRepoConfig } from "./config";
import { bakeLockHeld, pidAlive, repoLockHeld } from "./lock";
import { receipt } from "./receipts";
import { SHARED_BASE_ALIAS } from "./sharedbase";
import {
  BASE_PLATFORMS,
  assertBaseAlias,
  assertBaseName,
  assertNotAlias,
  isBasePlatform,
  seedFor,
  type BasePlatform,
  type BaseSeedKind,
} from "./basebake";

const CHECKOUT = join(import.meta.dir, "..");
const FOREMAN = join(import.meta.dir, "foreman.ts");

export type BakeKind = "base" | "repo";

export interface BakeStatus {
  kind: BakeKind;
  /** platform for a base bake, slug for a repo bake */
  key: string;
  state: "running" | "done" | "failed";
  pid?: number;
  started_at: string;
  ended_at?: string;
  platform?: string;
  alias?: string;
  name?: string;
  slug?: string;
  snapshot?: string;
  snapshot_id?: string;
  contents?: string;
  error?: string;
}

const nowIso = () => new Date().toISOString();

export function baseStatusPath(stateDir: string, platform: string): string {
  return join(stateDir, "base-bakes", `${platform.replace(/[^a-z0-9-]+/g, "-")}.json`);
}

export function repoStatusPath(stateDir: string, slug: string): string {
  return join(stateDir, "repos", slug, "bake.json");
}

/** Merge-write one status file; concurrent writers (spawner + child) only
 *  ever add their own fields. */
export function updateBakeStatus(path: string, patch: Partial<BakeStatus>): BakeStatus {
  let current: any = {};
  try {
    current = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  const next = { ...current, ...patch } as BakeStatus;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** Read one status; a "running" job whose pid is gone is failed on read. */
export function readBakeStatus(path: string): BakeStatus | null {
  let job: BakeStatus | null = null;
  try {
    job = JSON.parse(readFileSync(path, "utf8")) as BakeStatus;
  } catch {
    return null;
  }
  if (job?.state === "running" && typeof job.pid === "number" && !pidAlive(job.pid)) {
    job = updateBakeStatus(path, {
      state: "failed",
      ended_at: nowIso(),
      error: `bake process ${job.pid} is gone (daemon restart or crash) — see laps.log for the last receipt`,
    });
  }
  return job;
}

export function readBaseBakeStatus(stateDir: string, platform: string): BakeStatus | null {
  return readBakeStatus(baseStatusPath(stateDir, platform));
}

export function readRepoBakeStatus(stateDir: string, slug: string): BakeStatus | null {
  return readBakeStatus(repoStatusPath(stateDir, slug));
}

/** Every platform's latest job, whether it exists or not (running/done/failed). */
export function listBaseBakeStatuses(stateDir: string): BakeStatus[] {
  return BASE_PLATFORMS.flatMap((p) => {
    const s = readBaseBakeStatus(stateDir, p);
    return s ? [s] : [];
  });
}

/** In-process start guard: two API requests cannot both pass the read-only
 *  pidfile check before the first child has taken its lock. */
const pending = new Set<string>();

export interface SpawnBaseOpts {
  platform: string;
  name: string;
  seed?: string;
  seedKind?: BaseSeedKind;
  alias?: string;
}

export interface SpawnResult {
  started: boolean;
  reason?: string;
  status: BakeStatus | null;
}

function spawnDetached(
  stateDir: string,
  args: string[],
  what: string,
  spawnImpl: typeof spawn = spawn
): number | undefined {
  // the bake needs the gh, machine-platform and web keys; never the daemon's
  // own API keys, which only the HTTP gate uses
  const { FACTORY_API_KEY: _key, DARK_FACTORY_LAPTOP_KEY: _laptop, ...env } = process.env;
  const err = openSync(join(stateDir, "bakes.err"), "a");
  try {
    const child = spawnImpl(process.execPath, [FOREMAN, ...args, "--state-dir", stateDir], {
      // the checkout as cwd: lock.ts recognizes factory processes by it
      cwd: CHECKOUT,
      detached: true,
      stdio: ["ignore", "ignore", err],
      env,
    });
    child.on("error", (e: any) => receipt(stateDir, `could not start ${what}: ${e.message}`));
    child.unref();
    return child.pid;
  } finally {
    closeSync(err);
  }
}

/**
 * Start a base bake server-side. Validation happens here (before any cloud
 * call) so the API answers 400/409 immediately; the child re-acquires the
 * same lock, so a manual `foreman base bake` racing a remote one still
 * serializes.
 */
export function spawnBaseBake(
  stateDir: string,
  opts: SpawnBaseOpts,
  deps: { spawnImpl?: typeof spawn } = {}
): SpawnResult {
  if (!isBasePlatform(opts.platform))
    throw new Error(
      `base bake supports ${BASE_PLATFORMS.join(" | ")} (got "${opts.platform}"). ` +
        `InstaVM is excluded: its snapshot build disk is capped at 3 GiB and cannot carry a dev base.`
    );
  assertBaseName(opts.name);
  const alias = opts.alias ?? SHARED_BASE_ALIAS;
  assertBaseAlias(alias);
  assertNotAlias(stateDir, opts.name, alias);
  seedFor(opts.platform as BasePlatform, { name: opts.name, seed: opts.seed, seedKind: opts.seedKind });

  const key = `base-${opts.platform}`;
  const path = baseStatusPath(stateDir, opts.platform);
  const live = readBaseBakeStatus(stateDir, opts.platform);
  if (pending.has(key) || bakeLockHeld(stateDir, key) || live?.state === "running")
    return {
      started: false,
      reason: `a base bake for ${opts.platform} is already live (pid ${live?.pid ?? "pending"})`,
      status: live,
    };

  updateBakeStatus(path, {
    kind: "base",
    key: opts.platform,
    state: "running",
    started_at: nowIso(),
    ended_at: undefined,
    error: undefined,
    platform: opts.platform,
    alias,
    name: opts.name,
    snapshot: undefined,
    snapshot_id: undefined,
    contents: undefined,
  });
  const args = ["base", "bake", "--platform", opts.platform, "--name", opts.name, "--alias", alias, "--status-file", path];
  if (opts.seed !== undefined) args.push("--seed", opts.seed);
  if (opts.seedKind) args.push("--seed-kind", opts.seedKind);
  pending.add(key);
  try {
    const pid = spawnDetached(stateDir, args, `base bake ${opts.platform}`, deps.spawnImpl);
    if (typeof pid === "number") updateBakeStatus(path, { pid });
    return { started: true, status: readBaseBakeStatus(stateDir, opts.platform) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    updateBakeStatus(path, { state: "failed", ended_at: nowIso(), error });
    return { started: false, reason: error, status: readBaseBakeStatus(stateDir, opts.platform) };
  } finally {
    pending.delete(key);
  }
}

/** Start a per-repo golden-snapshot bake server-side (same job model). */
export function spawnRepoBake(
  stateDir: string,
  slug: string,
  deps: { spawnImpl?: typeof spawn } = {}
): SpawnResult {
  const cfgPath = join(stateDir, "repos", slug, "config.json");
  if (!existsSync(cfgPath)) throw new Error(`repo ${slug} is not onboarded`);
  loadRepoConfig(cfgPath); // surface a broken config as a client error, not a dead child
  const key = `repo-${slug}`;
  const path = repoStatusPath(stateDir, slug);
  const live = readRepoBakeStatus(stateDir, slug);
  if (pending.has(key) || bakeLockHeld(stateDir, key) || live?.state === "running")
    return {
      started: false,
      reason: `a bake for ${slug} is already live (pid ${live?.pid ?? "pending"})`,
      status: live,
    };
  // a bake mutates the repo's snapshot/config while a lap may be using the
  // same checkout — make the operator wait for the tick to finish
  if (repoLockHeld(stateDir, slug))
    return {
      started: false,
      reason: `a tick is live for ${slug} — run the bake when the repo is idle`,
      status: null,
    };
  updateBakeStatus(path, {
    kind: "repo",
    key: slug,
    state: "running",
    started_at: nowIso(),
    ended_at: undefined,
    error: undefined,
    slug,
    snapshot: undefined,
    snapshot_id: undefined,
  });
  pending.add(key);
  try {
    const pid = spawnDetached(stateDir, ["bake", slug, "--status-file", path], `bake ${slug}`, deps.spawnImpl);
    if (typeof pid === "number") updateBakeStatus(path, { pid });
    return { started: true, status: readRepoBakeStatus(stateDir, slug) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    updateBakeStatus(path, { state: "failed", ended_at: nowIso(), error });
    return { started: false, reason: error, status: readRepoBakeStatus(stateDir, slug) };
  } finally {
    pending.delete(key);
  }
}
