import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Base snapshots resolve through named aliases so "the box starts with
 * whatever base we last baked for this stack" is a fact, not a memory
 * exercise. One state file (`state/base-snapshot.json`) maps alias tokens →
 * physical platform snapshots:
 *
 *   {
 *     "shared-base":  { "snapshot": "factory-base-r3", "bakedAt": "...", ... },
 *     "godot-base":   { "snapshot": "factory-godot-r1", "bakedAt": "...", ... }
 *   }
 *
 * A base re-bake saves a NEW versioned platform name and flips its entry —
 * configs, templates, and skills only ever say the token, so the flip is the
 * entire rollout and the old physical snapshot stays as a rollback alias.
 * Stack bases (godot-base, …) are baked the same way as the shared base:
 * fresh template → tooling → stack install → verify → new versioned name.
 *
 * A config value that is not a known alias passes through untouched, so a
 * repo pointing at a literal snapshot (a per-repo fork) keeps working.
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

/**
 * All alias mappings. Backward compatible with the original single-base flat
 * file (`{"snapshot": …}` → an implicit shared-base entry).
 */
export function readBases(stateDir: string): Record<string, SharedBaseInfo> {
  try {
    const j = JSON.parse(readFileSync(sharedBasePath(stateDir), "utf8"));
    if (typeof j?.snapshot === "string" && j.snapshot) return { [SHARED_BASE_ALIAS]: j as SharedBaseInfo };
    const out: Record<string, SharedBaseInfo> = {};
    for (const [k, v] of Object.entries(j ?? {})) {
      if (typeof (v as SharedBaseInfo)?.snapshot === "string" && (v as SharedBaseInfo).snapshot)
        out[k] = v as SharedBaseInfo;
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
 * The physical snapshot name for a config value: a known alias resolves
 * through the state file; anything else is already physical. An unknown
 * alias or missing state file fails through with the token itself, so the
 * caller's "snapshot not found" error names the real problem.
 */
export function resolveSnapshotName(stateDir: string, name: string): string {
  return readBases(stateDir)[name]?.snapshot ?? name;
}
