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

/** The modes that run agent stages inside a disposable platform machine —
 *  the machine-mode family the slot allocator, the janitor and the runtime
 *  context all branch on (docs/execution-modes.md). */
export const MACHINE_MODES = ["instabox", "boxd", "daytona", "e2b", "instavm"] as const;
export type MachineMode = (typeof MACHINE_MODES)[number];
export const isMachineMode = (mode: string | undefined | null): mode is MachineMode =>
  (MACHINE_MODES as readonly string[]).includes(mode ?? "");

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
   * stage stays host-side (read-only), and every scenario step runs in the
   * box against its own loopback. The host needs no Docker at all.
   * "boxd" = the same lap shape on boxd.sh microVMs (SDK lifecycle, exec
   * transport; see env.boxd below).
   * "daytona" = the same lap shape on Daytona cloud sandboxes
   * (https://daytona.io, SDK lifecycle + toolbox exec; see env.daytona).
   * "e2b" = the same lap shape on E2B Firecracker sandboxes
   * (https://e2b.dev, SDK lifecycle + commands transport; see env.e2b).
   * "instavm" = the same lap shape on InstaVM microVMs
   * (https://instavm.io, raw-REST lifecycle + async exec; see env.instavm).
   */
  env: {
    mode: "host" | "compose" | MachineMode;
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
    /**
     * boxd-mode settings (https://boxd.sh — SDK-driven microVMs, gRPC control
     * plane, exec transport; no ssh anywhere). Machine lifecycle rides the
     * official SDK; in-box scripts ride a hardened exec wrapper that enforces
     * its deadline in-box (setsid process group, TERM→KILL) because the
     * platform's server-side exec timeout never surfaces under Bun.
     */
    boxd?: {
      /** in-machine path the repo is cloned to */
      repo_dir: string;
      /** snapshot machines boot from; default factory-base-boxd-r1 */
      snapshot?: string;
      /** boxd region; default = the org's default region */
      region?: string;
    };
    /** daytona-mode settings (https://daytona.io — SDK lifecycle, toolbox
     *  exec). Auth comes from DAYTONA_API_KEY on the factory host. */
    daytona?: {
      /** in-machine path the repo is cloned to (the sandbox user's home) */
      repo_dir: string;
      /** snapshot sandboxes boot from; default factory-base-daytona-r1 */
      snapshot?: string;
      /** shell run on the bake sandbox after clone; empty = clone-only snapshot */
      bake?: string;
    };
    /** e2b-mode settings (https://e2b.dev — SDK lifecycle, commands
     *  transport). Auth comes from E2B_API_KEY on the factory host. */
    e2b?: {
      /** in-machine path the repo is cloned to (the sandbox user's home) */
      repo_dir: string;
      /** template sandboxes boot from; default factory-base-e2b-r1 */
      snapshot?: string;
      /** shell run in the template build after clone; empty = clone-only */
      bake?: string;
    };
    /** instavm-mode settings (https://instavm.io — raw-REST lifecycle,
     *  async exec). Auth comes from INSTAVM_API_KEY on the factory host. */
    instavm?: {
      /** in-machine path the repo is cloned to (matches the snapshot
       *  builder's fixed /app/repo clone path) */
      repo_dir: string;
      /** snapshot VMs boot from; default factory-base-instavm-r1 */
      snapshot?: string;
      /** shell run in the snapshot build after the platform's clone */
      bake?: string;
      /** REST base; default https://api.instavm.io/v1 */
      api_base?: string;
    };
  };
  skip_labels: string[];
  /**
   * GitHub logins (beyond the repo owner and the factory's own gh account,
   * which are always trusted) whose issues intake may claim. The issue body
   * goes verbatim into agent prompts, and on a public repo anyone can open
   * an issue — so an issue from anyone else is skipped, never planned.
   */
  trusted_authors?: string[];
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
  /** discoveries harvest: auto_file=true files new reviewer discoveries as
   *  `[discovery]` issues straight after each review (title-deduped), so the
   *  factory works future-bug candidates like any backlog item. */
  discoveries?: { auto_file?: boolean };
  /** ui.enabled=false suppresses the pi-skills/ui router for this repo: the
   *  runtime context tells every stage to build frontend from scratch and
   *  never install component libraries. */
  ui?: { enabled?: boolean };
  /** spend ceiling: daily_attempts caps implement attempts per repo per UTC
   *  day (default 60; 0 = no ceiling). It counts the ledger's implement
   *  stage runs, so revives, unblocks and infra deferrals cannot reset it. */
  limits?: { daily_attempts?: number };
  /** machine-slot scheduling (docs/parallel-mode.md). priority orders this
   *  repo's slot requests fleet-wide (aging raises a waiting request one level
   *  per PDF_AGING_MINUTES); spill_over lets a lap run on the other machine
   *  platform when this repo's own pool is full; parallel runs up to
   *  max_lanes laps at once (machine modes only), landing through a per-repo
   *  merge queue. */
  scheduling?: {
    priority?: SchedulingPriority;
    spill_over?: boolean;
    parallel?: boolean;
    max_lanes?: number;
  };
}

export type SchedulingPriority = "high" | "normal" | "low";

export interface IssueLite {
  number: number;
  title: string;
  body: string;
  labels: string[];
  /** login of the account that opened the issue (gh's author object,
   *  normalized at the boundary like labels) */
  author?: string;
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
  /** pi's computed dollar cost for the messages — summed like the tokens */
  cost?: number;
}

export type StageName = "plan" | "implement" | "review";
