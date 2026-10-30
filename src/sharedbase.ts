import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The shared golden base resolves through ONE indirection so "the box starts
 * with whatever base we last baked" is a fact, not a memory exercise.
 *
 * Configs, templates, and skills say the token `shared-base`; a single state
 * file (`state/base-snapshot.json`) maps it to the current physical platform
 * snapshot. A base re-bake saves a NEW versioned platform name
 * (factory-base-r4, …) and flips that one file — per-repo configs, docs, and
 * skills never mention versions again, and the old physical snapshot stays
 * on the platform as a rollback alias.
 *
 * A config value that is not the token passes through untouched, so a repo
 * pointing at a literal snapshot (a per-repo fork) keeps working.
 */
export const SHARED_BASE_ALIAS = "shared-base";

export interface SharedBaseInfo {
  snapshot: string;
  bakedAt?: string;
  template?: string;
  contents?: string;
}

export function sharedBasePath(stateDir: string): string {
  return join(stateDir, "base-snapshot.json");
}

export function readSharedBase(stateDir: string): SharedBaseInfo | null {
  try {
    const j = JSON.parse(readFileSync(sharedBasePath(stateDir), "utf8"));
    return typeof j?.snapshot === "string" && j.snapshot ? (j as SharedBaseInfo) : null;
  } catch {
    return null;
  }
}

/**
 * The physical snapshot name for a config value: the token resolves through
 * the state file; anything else is already physical. A missing or unreadable
 * state file fails through with the token itself, so the caller's
 * "snapshot not found" error names the real problem (write the state file).
 */
export function resolveSnapshotName(stateDir: string, name: string): string {
  if (name !== SHARED_BASE_ALIAS) return name;
  return readSharedBase(stateDir)?.snapshot ?? name;
}
