import { describe, expect, test } from "bun:test";
import { buildRuntimeContext } from "../src/runtime-context";
import { machineNameFor } from "../src/instabox";
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
  test("machine name is stable per lap", () => {
    expect(machineNameFor("mdrender", 3)).toBe("pdf-mdrender-i3");
  });

  test("stages without a machine bridge run host-side in instabox mode", () => {
    // the CLI-bridge design that prefixed stages with `instabox ssh <machine>`
    // lost to machine.callStage — and that binary was never installed
    // host-side, so the old name derivation turned every plan spawn into an
    // empty "pi exited 127" (spawn ENOENT). Plan is host-side by design; the
    // in-box stages (implement/review/scenarios) never reach buildStageCmd.
    const s = buildStageCmd(cfg("instabox"), "/wt", "/state", "pdf-app-9-plan-1-x");
    expect(s.containerized).toBe(false);
    expect(s.argvPrefix).toEqual([]);
    expect(s.cleanup).toBeUndefined();
  });
});
