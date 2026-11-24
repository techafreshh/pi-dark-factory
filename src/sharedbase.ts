import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireBakeLock, releaseBakeLock } from "./lock";
import { MACHINE_MODES, type MachineMode } from "./types";

/**
 * Base snapshots resolve through named aliases so "the box starts with
 * whatever base we last baked for this stack" is a fact, not a memory
 * exercise. One state file (`state/base-snapshot.json`) maps alias tokens →
 * physical platform snapshots:
 *
 *   {
 *     "shared-base": {
 *       "platforms": {
 *         "instabox": { "snapshot": "factory-dev-instabox-r1", "bakedAt": "..." },
 *         "daytona":  { "snapshot": "factory-dev-daytona-r1",  "bakedAt": "..." }
 *       },
 *       "contents": "node + python + go + pi + e2e browser + penthera"
 *     },
 *     "godot-base":  { "snapshot": "factory-godot-r1", "bakedAt": "...", ... }
 *   }
 *
 * A base re-bake saves a NEW versioned platform name and flips its entry —
 * configs, templates, and skills only ever say the token, so the flip is the
 * entire rollout and the old physical snapshot stays as a rollback alias.
 * Stack bases (godot-base, …) are baked the same way as the shared base:
 * fresh template → tooling → stack install → verify → new versioned name.
 *
 * Platform scoping is load-bearing: snapshot names are per platform, so a
 * single flat `shared-base` entry can only be correct on that platform. A
 * platform-less entry stays readable for backward compatibility (the
 * original flat file), but a `platforms` entry is never resolved on a
 * platform it does not name — the error tells the operator to bake that
 * platform's base or use a literal per-repo snapshot.
 *
 * A config value that is not a known alias passes through untouched, so a
 * repo pointing at a literal snapshot (a per-repo fork) keeps working.
 */
export const SHARED_BASE_ALIAS = "shared-base";

export interface BaseEntry {
  snapshot: string;
  bakedAt?: string;
  template?: string;
  contents?: string;
}

export interface SharedBaseInfo extends BaseEntry {
  /** physical snapshot per machine platform; the current schema. */
  platforms?: Partial<Record<MachineMode, BaseEntry>>;
}

export function sharedBasePath(stateDir: string): string {
  return join(stateDir, "base-snapshot.json");
}

/** True for a snapshot name a platform can actually boot (a non-empty string). */
function usableSnapshot(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function validPlatformEntry(v: unknown): v is BaseEntry {
  return !!v && typeof v === "object" && usableSnapshot((v as BaseEntry).snapshot);
}

function normalizeEntry(v: any): SharedBaseInfo | null {
  if (!v || typeof v !== "object") return null;
  const out: SharedBaseInfo = { snapshot: "" };
  if (usableSnapshot(v.snapshot)) out.snapshot = v.snapshot;
  for (const k of ["bakedAt", "template", "contents"] as const) {
    if (typeof v[k] === "string" && v[k]) out[k] = v[k];
  }
  if (v.platforms && typeof v.platforms === "object") {
    const platforms: Partial<Record<MachineMode, BaseEntry>> = {};
    for (const mode of MACHINE_MODES) {
      const p = v.platforms[mode];
      if (validPlatformEntry(p)) platforms[mode] = normalizeEntry(p)!;
    }
    if (Object.keys(platforms).length > 0) out.platforms = platforms;
  }
  // a per-platform-only entry is valid; a flat entry needs its own snapshot
  if (!out.snapshot && !out.platforms) return null;
  return out;
}

/**
 * All alias mappings. Backward compatible with the original single-base flat
 * file (`{"snapshot": …}` → an implicit shared-base entry) and with flat
 * per-stack entries (`"godot-base": {"snapshot": …}`).
 */
export function readBases(stateDir: string): Record<string, SharedBaseInfo> {
  try {
    const j = JSON.parse(readFileSync(sharedBasePath(stateDir), "utf8"));
    // the original file held one base in the root object
    if (usableSnapshot(j?.snapshot)) {
      const one = normalizeEntry(j);
      return one ? { [SHARED_BASE_ALIAS]: one } : {};
    }
    const out: Record<string, SharedBaseInfo> = {};
    for (const [k, v] of Object.entries(j ?? {})) {
      const entry = normalizeEntry(v);
      if (entry) out[k] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

/** The default (shared) base — what repos mean when they say the shared token. */
export function readSharedBase(stateDir: string): SharedBaseInfo | null {
  return readBases(stateDir)[SHARED_BASE_ALIAS] ?? null;
}

/**
 * The physical snapshot name for a config value. A known alias resolves
 * through the state file; anything else is already physical. When the alias
 * carries a `platforms` map, the requested platform must be named there: a
 * fallback to another platform's snapshot would hand the platform a name it
 * cannot boot (the "snapshot not found" class this schema exists to kill).
 */
export function resolveSnapshotName(stateDir: string, name: string, platform?: MachineMode): string {
  const entry = readBases(stateDir)[name];
  const missing = (p: MachineMode) =>
    p === "instavm"
      ? `InstaVM has no shared base — use a literal env.instavm.snapshot (or empty to bake a per-repo snapshot) and install deps in env.instavm.bake`
      : `base alias "${name}" has no ${p} snapshot — bake one first: ` +
        `foreman base bake --platform ${p} --name <versioned-name>, or point env.${p}.snapshot at a literal snapshot name.`;
  if (!entry) {
    // the reserved shared token with no mapping is a missing BASE, not a
    // literal snapshot name — say so, or the platform answers "snapshot not
    // found" and the operator tries the same bake again
    if (platform && name === SHARED_BASE_ALIAS) throw new Error(missing(platform));
    return name;
  }
  if (entry.platforms) {
    if (platform) {
      const hit = entry.platforms[platform];
      if (hit?.snapshot) return hit.snapshot;
      throw new Error(missing(platform));
    }
    // no platform: a legacy top-level snapshot is still a safe answer; an
    // entry that only exists per platform cannot resolve without one
    return entry.snapshot || name;
  }
  // A flat entry predates the platforms map: it was written for InstaBox (the
  // only machine lane then). Never hand it to another platform — that is the
  // "snapshot not found" class this schema exists to kill.
  if (platform && platform !== "instabox") throw new Error(missing(platform));
  return entry.snapshot || name;
}

/** Which platforms a base entry names (used by doctor/list/status). */
export function basePlatforms(entry: SharedBaseInfo): MachineMode[] {
  if (entry.platforms) return MACHINE_MODES.filter((m) => !!entry.platforms![m]?.snapshot);
  return [];
}

/** A tiny synchronous sleep for the state-file lock (the caller is a bake
 *  child about to write; there is no event loop to yield to). */
function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Record one platform's physical snapshot under an alias. Read-modify-write
 * of the small state file; preserves every other alias and field. A legacy
 * flat entry gains a `platforms` map while keeping its original `snapshot`
 * as the generic fallback, so old readers and the original instabox config
 * keep working.
 *
 * The write is serialized (a base-snapshot pidfile) and atomic (temp file +
 * rename): two bakes finishing together cannot lose one platform's entry,
 * and a lap reading mid-write sees the old or new file, never a half one.
 * An unparseable existing file is an operator problem — throw instead of
 * silently replacing every alias with the new one.
 */
export function setBasePlatform(
  stateDir: string,
  alias: string,
  platform: MachineMode,
  entry: BaseEntry
): SharedBaseInfo {
  const path = sharedBasePath(stateDir);
  const lockKey = "base-snapshot";
  const deadline = Date.now() + 10_000;
  while (!acquireBakeLock(stateDir, lockKey)) {
    if (Date.now() > deadline) throw new Error("another bake is updating state/base-snapshot.json — retry in a moment");
    sleepSync(100);
  }
  try {
    let raw: any = {};
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      if (text.trim()) {
        try {
          raw = JSON.parse(text);
        } catch (e: any) {
          throw new Error(`state/base-snapshot.json is unreadable (${e?.message ?? e}); refusing to overwrite it — fix that file first`);
        }
      }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("state/base-snapshot.json must be a JSON object of alias → base entries");
    // normalize the original single-base root shape into an alias map
    if (usableSnapshot(raw?.snapshot) && !raw[alias]) {
      raw = { [SHARED_BASE_ALIAS]: { ...raw } };
    }
    const current: any = raw[alias] ?? {};
    const platforms: Partial<Record<MachineMode, BaseEntry>> = { ...(current.platforms ?? {}) };
    // the pre-platform flat schema was written for InstaBox (the only machine
    // lane then). Keep that snapshot bootable after the map appears, or a repo
    // already on the alias would fail the moment another platform's base is
    // recorded.
    if (!current.platforms && usableSnapshot(current.snapshot) && !platforms.instabox) {
      platforms.instabox = {
        snapshot: current.snapshot,
        ...(current.bakedAt ? { bakedAt: current.bakedAt } : {}),
        ...(current.template ? { template: current.template } : {}),
        ...(current.contents ? { contents: current.contents } : {}),
      };
    }
    platforms[platform] = { ...entry };
    const next: SharedBaseInfo = {
      ...(usableSnapshot(current.snapshot) ? { snapshot: current.snapshot } : {}),
      ...(current.bakedAt ? { bakedAt: current.bakedAt } : {}),
      ...(current.template ? { template: current.template } : {}),
      ...(current.contents ? { contents: current.contents } : {}),
      platforms,
      // the alias map itself carries the freshest summary; per-platform
      // entries keep their own bake metadata
      ...(entry.contents ? { contents: entry.contents } : {}),
      ...(entry.template ? { template: entry.template } : {}),
      ...(entry.bakedAt ? { bakedAt: entry.bakedAt } : {}),
    } as SharedBaseInfo;
    raw[alias] = next;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n");
      renameSync(tmp, path);
    } finally {
      rmSync(tmp, { force: true });
    }
    return next;
  } finally {
    releaseBakeLock(stateDir, lockKey);
  }
}
