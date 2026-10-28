export interface ModelSpec {
  provider: string;
  model: string;
  thinking?: string;
}

export interface StageModels {
  base: ModelSpec;
  /** tried in order when the base model fails with a provider error; never on timeout */
  fallback: ModelSpec[];
}

export interface ModelEntry extends Partial<ModelSpec> {
  /** "provider/model[:thinking]" strings */
  fallback?: string[];
}

export interface RepoConfig {
  repo: string;
  slug: string;
  default_branch: string;
  /** override the clone URL (private repos with a token, or test fixtures) */
  origin_url?: string;
  attempts: number;
  merge: {
    method: "squash" | "merge" | "rebase";
    required_checks: string[];
    delete_branch: boolean;
  };
  models: {
    default: ModelEntry;
    [stage: string]: ModelEntry | undefined;
  };
  timeouts: {
    /** default wall-clock limit for any stage without a per-stage override */
    stage_minutes: number;
    /** optional per-stage overrides: plan_minutes / implement_minutes / review_minutes */
    plan_minutes?: number;
    implement_minutes?: number;
    review_minutes?: number;
    checks_minutes: number;
    readiness_seconds: number;
    probe_ms: number;
  };
  scenario: {
    ports: number[];
    runtime?: string;
    holdout?: string;
  };
  /**
   * Execution environment for agent stages. "host" = plain processes.
   * "compose" = every stage runs via `docker compose run --rm <service>`
   * (product-owned compose file in the worktree) or a fallback `docker run`
   * image until the repo ships one — root inside, so pip/apt/go/npm install
   * anything freely; the host stays clean.
   * "instabox" = implement+review run inside a disposable InstaBox microVM
   * (https://instabox.sh) booted from the repo's golden snapshot; the plan
   * stage stays host-side (read-only), probes stay host-side through SSH
   * port forwards. The host needs no Docker at all.
   */
  env: {
    mode: "host" | "compose" | "instabox";
    /** repo-relative path of the product-owned compose file */
    compose_file: string;
    /** service in that compose file the factory runs stages in */
    service: string;
    /** fallback image when the repo has no compose file yet */
    image: string;
    /** host env vars forwarded into the container/machine when present */
    pass_env: string[];
    /** instabox-mode settings */
    instabox: {
      api_base: string;
      /** name of the env var on the factory host holding the X-API-Key */
      api_key_env: string;
      /** template machines boot from when no snapshot exists yet */
      template: string;
      /** per-repo golden snapshot name (built by `foreman bake`); empty = template */
      snapshot: string;
      /** in-machine path the repo is cloned to */
      repo_dir: string;
      /** shell run on the bake machine after clone; empty = clone-only snapshot */
      bake: string;
    };
  };
  skip_labels: string[];
  pi: {
    binary: string;
    tools: string[];
    plan_tools: string[];
    extra_args: string[];
    /**
     * Web-grounding tools for the lap agents (TinyFish-backed web_search /
     * web_fetch pi extension, read-only network calls). Defaults both on;
     * a repo opts out with {"pi": {"web": {"search": false, "fetch": false}}}.
     * The tools only activate when the extension is actually deliverable —
     * a missing extension file degrades to the repo's plain tool list.
     */
    web?: {
      search?: boolean;
      fetch?: boolean;
    };
  };
}

export interface IssueLite {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt?: string;
  state?: string;
}

export interface PrLite {
  number: number;
  title: string;
  body: string;
  headRefName: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export type StageName = "plan" | "implement" | "review";
