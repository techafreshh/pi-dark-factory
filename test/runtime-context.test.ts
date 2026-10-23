import { describe, expect, test } from "bun:test";
import { buildRuntimeContext } from "../src/runtime-context";
import { machineName } from "../src/instabox";
import { buildStageCmd } from "../src/env";
import type { RepoConfig } from "../src/types";

const cfg = (mode: "host" | "compose" | "instabox"): RepoConfig =>
  ({
    repo: "acme/app",
    slug: "app",
    default_branch: "main",
    attempts: 3,
    merge: { method: "squash", required_checks: [], delete_branch: true },
    models: { default: { provider: "x", model: "y" } },
    timeouts: { stage_minutes: 30, checks_minutes: 30, readiness_seconds: 10, probe_ms: 1000 },
    scenario: { ports: [8100, 8102] },
    skip_labels: [],
    pi: { binary: "pi", tools: ["read"], plan_tools: ["read"], extra_args: [] },
    env: { mode, compose_file: "docker-compose.yml", service: "worker", image: "ubuntu:24.04", pass_env: [] },
  }) as any;

describe("buildRuntimeContext (the where-am-I brief)", () => {
  const ctx = buildRuntimeContext(cfg("compose"), {
    repo: "acme/app",
    slug: "app",
    issue: 3,
    issueTitle: "Inline rules: bold, italic",
    stage: "implement",
    attempt: 2,
    attemptsMax: 3,
    branch: "factory/issue-3",
    base: "main",
    mode: "compose",
    where: "inside the product's own docker compose worker service",
    cwd: "/home/factory/state/worktrees/app/issue-3",
    toolchain: "the worker image provides the runtime",
  });

  test("carries the identity facts", () => {
    expect(ctx).toContain("acme/app");
    expect(ctx).toContain("#3");
    expect(ctx).toContain("Inline rules");
    expect(ctx).toContain("attempt 2/3");
    expect(ctx).toContain("factory/issue-3 (base: main)");
    expect(ctx).toContain("Execution mode: compose");
  });

  test("states the gates and the commit discipline", () => {
    expect(ctx).toContain("changed");
    expect(ctx).toContain("black-box scenario probes");
    expect(ctx).toContain("review");
    expect(ctx).toContain("git add -A && git commit");
  });

  test("declares the boundaries that laps keep tripping on", () => {
    expect(ctx).toContain("Never edit git config");
    expect(ctx).toContain("OUTSIDE this repo");
    expect(ctx).toContain("English only");
  });
});

describe("instabox mode plumbing", () => {
  test("machine name is stable per lap and matches the env.ts derivation", () => {
    expect(machineName("mdrender", 3)).toBe("pdf-mdrender-3");
    // stage env bridges over the same name when the caller passes it
    const s = buildStageCmd(cfg("instabox"), "/any/worktree", "/state", "pdf-app-7-impl-1-mvkt", { machine: machineName("app", 7) });
    expect(s.containerized).toBe(true);
    expect(s.argvPrefix.slice(0, 3)).toEqual(["instabox", "ssh", "pdf-app-7"]);
    expect(s.argvPrefix).toContain("--");
    expect(s.cleanup).toEqual([]);
  });

  test("box_dir default and override both reach the remote cd", () => {
    const def = buildStageCmd(cfg("instabox"), "/wt", "/state", "pdf-app-2-plan-1-x", { machine: machineName("app", 2) });
    const joined = def.argvPrefix.join(" ");
    expect(joined).toContain("/data/workspace/app");
    const custom = buildStageCmd(
      { ...cfg("instabox"), env: { ...cfg("instabox").env, instabox: { box_dir: "/data/ws/elsewhere" } } } as any,
      "/wt", "/state", "pdf-app-2-plan-1-x", { machine: machineName("app", 2) }
    );
    expect(custom.argvPrefix.join(" ")).toContain("/data/ws/elsewhere");
  });

  test("without machine the instabox branch still produces a safe bridge", () => {
    const s = buildStageCmd(cfg("instabox"), "/wt", "/state", "pdf-app-9-impl-1-x");
    expect(s.containerized).toBe(true);
    expect(s.argvPrefix[2]).toBe("pdf-app-9");
  });
});
