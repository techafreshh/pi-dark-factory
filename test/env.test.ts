import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStageCmd } from "../src/env";
import type { RepoConfig } from "../src/types";

const cfg = (env: any, ports: number[] = []): RepoConfig => ({
  repo: "acme/app",
  slug: "app",
  default_branch: "main",
  attempts: 3,
  merge: { method: "squash", required_checks: [], delete_branch: true },
  models: { default: { provider: "x", model: "y" } },
  timeouts: { stage_minutes: 30, checks_minutes: 30, readiness_seconds: 10, probe_ms: 1000 },
  scenario: { ports },
  skip_labels: [],
  pi: { binary: "pi", tools: ["read"], plan_tools: ["read"], extra_args: [] },
  env: {
    mode: "host",
    compose_file: "docker-compose.yml",
    service: "worker",
    image: "ubuntu:24.04",
    pass_env: [],
    ...env,
  },
});

describe("buildStageCmd (container execution environment)", () => {
  test("host mode is a no-op wrapper", () => {
    const s = buildStageCmd(cfg({ mode: "host" }), "/wt", "/state", "n1");
    expect(s.argvPrefix).toEqual([]);
    expect(s.containerized).toBe(false);
    expect(s.cleanup).toBeUndefined();
  });

  test("fallback image mode: docker run with mirrored mounts, caches, ports, env", () => {
    const wt = mkdtempSync(join(tmpdir(), "pdfenv-")); // no compose file inside
    const s = buildStageCmd(cfg({ mode: "compose", image: "ubuntu:24.04" }, [8100, 8102]), wt, "/state", "lap-1", {
      extraEnv: { PORT: "8100" },
    });
    expect(s.containerized).toBe(true);
    expect(s.argvPrefix[0]).toBe("docker");
    expect(s.argvPrefix[1]).toBe("run");
    const args = s.argvPrefix.join(" ");
    expect(args).toContain(`--name lap-1`);
    expect(args).toContain(`-w ${wt}`);
    expect(args).toContain(`-v ${wt}:${wt}`);       // same-path mirroring
    expect(args).toContain("-v /state:/state");
    expect(args).toContain("pdf-uv:/root/.cache/uv"); // cache volumes
    expect(args).toContain("-p 127.0.0.1:8100:8100"); // scenario ports published
    expect(args).toContain("-p 127.0.0.1:8102:8102");
    expect(args).toContain("-e PORT=8100");           // docker does not inherit client env
    expect(args).toContain("GIT_CONFIG_VALUE_0=*");   // cross-uid git safety
    expect(s.argvPrefix[s.argvPrefix.length - 1]).toBe("ubuntu:24.04"); // image last, inner cmd appended by caller
    expect(s.cleanup).toEqual(["docker", "rm", "-f", "lap-1"]);
  });

  test("compose mode: docker compose -f <worktree file> run <service>, workdir set", () => {
    const wt = mkdtempSync(join(tmpdir(), "pdfenv-"));
    writeFileSync(join(wt, "docker-compose.yml"), "services:\n  worker:\n    image: python:3.12\n");
    const s = buildStageCmd(cfg({ mode: "compose", service: "worker" }), wt, "/state", "lap-2");
    expect(s.containerized).toBe(true);
    expect(s.argvPrefix[1]).toBe("compose");
    const args = s.argvPrefix.join(" ");
    expect(args).toContain(`-f ${join(wt, "docker-compose.yml")}`);
    expect(args).not.toContain("-p 127.0.0.1:"); // absent — product compose owns port publishing
    expect(args).not.toContain("pdf-uv:");   // no factory caches in product compose mode
    expect(args).toContain(`--workdir ${wt}`);
    expect(s.argvPrefix[s.argvPrefix.length - 1]).toBe("worker");
  });

  test("pass_env forwards only vars that exist on the host", () => {
    const wt = mkdtempSync(join(tmpdir(), "pdfenv-"));
    process.env.PDF_TEST_PRESENT = "yes";
    const s = buildStageCmd(
      cfg({ mode: "compose", pass_env: ["PDF_TEST_PRESENT", "PDF_TEST_DEFINITELY_ABSENT"] }),
      wt,
      "/state",
      "n"
    );
    const args = s.argvPrefix.join(" ");
    expect(args).toContain("-e PDF_TEST_PRESENT");
    expect(args).not.toContain("PDF_TEST_DEFINITELY_ABSENT");
    delete process.env.PDF_TEST_PRESENT;
  });
});
