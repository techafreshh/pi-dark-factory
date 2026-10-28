import { readFileSync } from "node:fs";
import type { ModelEntry, ModelSpec, RepoConfig, StageModels } from "./types";

const DEFAULTS = {
  attempts: 3,
  merge: { method: "squash" as const, required_checks: [] as string[], delete_branch: true },
  timeouts: { stage_minutes: 60, checks_minutes: 30, readiness_seconds: 120, probe_ms: 10000 },
  skip_labels: [] as string[],
  env: {
    mode: "host" as const,
    compose_file: "docker-compose.yml",
    service: "worker",
    image: "ubuntu:24.04",
    pass_env: [
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
      "ZAI_API_KEY",
      "DEEPSEEK_API_KEY",
      "GITHUB_TOKEN",
      // TinyFish web grounding (the pdf-tinyfish pi extension reads this in
      // every mode: host env, compose -e flags, instabox stage env.sh)
      "TINYFISH_API_KEY",
    ],
    instabox: {
      api_base: "https://api.instabox.sh",
      api_key_env: "INSTABOX_API_KEY",
      template: "basic",
      snapshot: "",
      repo_dir: "/data/repo",
      bake: "",
    },
  },
  pi: {
    binary: "pi",
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    plan_tools: ["read", "bash", "grep", "find", "ls"],
    extra_args: [] as string[],
    // web-grounding tools ON for every stage by default (web_search/web_fetch,
    // read-only); a repo opts out via config patch {"pi":{"web":{...}}}
    web: { search: true, fetch: true },
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
  if (!entry.provider || typeof entry.model !== "string" || !entry.model) {
    throw new Error(
      `models.${where} must define provider and model as an OBJECT {provider, model, thinking?, fallback?} — ` +
        `stage entries inherit from models.default, and a dotted string ("provider/model:thinking") belongs in fallback arrays only`
    );
  }
  // normalize a thinking level baked into the model field ("acme/glm:high"):
  // the raw string goes onto the wire as the model id, so a suffix silently
  // produced an invalid-model failure at the provider (kvstore onboarding
  // 2026-10-23 — the slicer showed it as "empty streamed completion")
  let model = entry.model;
  let thinking = entry.thinking;
  const baked = model.match(/^(.+):(\w+)$/);
  if (baked && /^(low|medium|high|max|xhigh)$/i.test(baked[2])) {
    model = baked[1];
    thinking = thinking ?? baked[2].toLowerCase();
  }
  return {
    provider: entry.provider,
    model,
    ...(thinking ? { thinking } : {}),
  };
}

/** A stage entry overrides the default entry; unspecified fields inherit. */
export function resolveModels(cfg: RepoConfig, stage: string): StageModels {
  // dotted-string entries degrade silently through the spread ({...string}
  // only sets index keys) — reject them with the object-form hint instead
  const entry = (cfg.models as any)[stage];
  if (entry !== undefined && (typeof entry !== "object" || Array.isArray(entry)))
    throw new Error(
      `models.${stage} must be an object {provider, model, thinking?, fallback?} — ` +
        `a dotted string ("provider/model:thinking") is valid only in fallback arrays`
    );
  if (typeof (cfg.models as any).default === "string")
    throw new Error(
      `models.default must be an object {provider, model, thinking?, fallback?} — ` +
        `a dotted string ("provider/model:thinking") is valid only in fallback arrays`
    );
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
    pi: {
      ...DEFAULTS.pi,
      ...raw.pi,
      // nested merge so a repo patching {"pi":{"web":{"search":false}}} keeps
      // the other flag at its default instead of silently re-enabling it
      web: { ...DEFAULTS.pi.web, ...(raw.pi?.web ?? {}) },
    },
    env: {
      ...DEFAULTS.env,
      ...raw.env,
      instabox: { ...DEFAULTS.env.instabox, ...(raw.env?.instabox ?? {}) },
    },
  };
  // web flags must be booleans — a string "false" from a bad remote patch
  // would otherwise truthy through and flip the toggle the operator meant
  // to close (same fail-fast rule as the roster checks: reject at write time)
  const web = cfg.pi.web!;
  for (const k of ["search", "fetch"] as const) {
    if (web[k] !== undefined && typeof web[k] !== "boolean")
      throw new Error(`config pi.web.${k} must be true or false (got ${JSON.stringify(web[k])})`);
  }
  if (!cfg.models.default) cfg.models.default = {};
  // fail fast on a missing base model rather than at lap time
  resolveModels(cfg, "implement");
  return cfg;
}
