import { readFileSync } from "node:fs";
import type { ModelEntry, ModelSpec, RepoConfig, StageModels } from "./types";

const DEFAULTS = {
  attempts: 3,
  merge: { method: "squash" as const, required_checks: [] as string[], delete_branch: true },
  timeouts: { stage_minutes: 60, checks_minutes: 30, readiness_seconds: 120, probe_ms: 10000 },
  skip_labels: [] as string[],
  pi: {
    binary: "pi",
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    plan_tools: ["read", "bash", "grep", "find", "ls"],
    extra_args: [] as string[],
  },
};

export function parseModelString(s: string): ModelSpec {
  const [id, thinking] = s.split(":");
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) {
    throw new Error(`bad model string "${s}" — expected provider/model[:thinking]`);
  }
  return {
    provider: id.slice(0, slash),
    model: id.slice(slash + 1),
    ...(thinking ? { thinking } : {}),
  };
}

function baseSpec(entry: ModelEntry, where: string): ModelSpec {
  if (!entry.provider || !entry.model) {
    throw new Error(`models.${where} must define provider and model (stage entries inherit from models.default)`);
  }
  return {
    provider: entry.provider,
    model: entry.model,
    ...(entry.thinking ? { thinking: entry.thinking } : {}),
  };
}

/** A stage entry overrides the default entry; unspecified fields inherit. */
export function resolveModels(cfg: RepoConfig, stage: string): StageModels {
  const merged: ModelEntry = { ...cfg.models.default, ...cfg.models[stage] };
  const base = baseSpec(merged, stage);
  const fallback = (merged.fallback ?? []).map(parseModelString);
  return { base, fallback };
}

export function loadRepoConfig(path: string): RepoConfig {
  const raw: any = JSON.parse(readFileSync(path, "utf8"));
  if (!raw.repo || !/^[^/\s]+\/[^/\s]+$/.test(raw.repo)) {
    throw new Error(`config at ${path}: "repo" must be owner/name`);
  }
  const cfg: RepoConfig = {
    repo: raw.repo,
    slug: raw.slug ?? raw.repo.split("/")[1],
    default_branch: raw.default_branch ?? "main",
    origin_url: raw.origin_url,
    attempts: raw.attempts ?? DEFAULTS.attempts,
    merge: { ...DEFAULTS.merge, ...raw.merge },
    models: raw.models ?? { default: {} },
    timeouts: { ...DEFAULTS.timeouts, ...raw.timeouts },
    scenario: {
      ports: raw.scenario?.ports ?? [],
      runtime: raw.scenario?.runtime,
      holdout: raw.scenario?.holdout,
    },
    skip_labels: raw.skip_labels ?? DEFAULTS.skip_labels,
    pi: { ...DEFAULTS.pi, ...raw.pi },
  };
  if (!cfg.models.default) cfg.models.default = {};
  // fail fast on a missing base model rather than at lap time
  resolveModels(cfg, "implement");
  return cfg;
}
