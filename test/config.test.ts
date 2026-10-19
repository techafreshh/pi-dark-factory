import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoConfig, parseModelString, resolveModels } from "../src/config";
import type { RepoConfig } from "../src/types";

const cfg = (models: any): RepoConfig => ({
  repo: "acme/app",
  slug: "app",
  default_branch: "main",
  attempts: 3,
  merge: { method: "squash", required_checks: [], delete_branch: true },
  models,
  timeouts: { stage_minutes: 30, checks_minutes: 30, readiness_seconds: 120, probe_ms: 10000 },
  scenario: { ports: [] },
  skip_labels: [],
  pi: {
    binary: "pi",
    tools: ["read"],
    plan_tools: ["read"],
    extra_args: [],
  },
});

describe("parseModelString", () => {
  test("parses provider/model:thinking", () => {
    expect(parseModelString("zai/glm-5.3:high")).toEqual({
      provider: "zai",
      model: "glm-5.3",
      thinking: "high",
    });
  });
  test("parses provider/model", () => {
    expect(parseModelString("deepseek/deepseek-flash")).toEqual({
      provider: "deepseek",
      model: "deepseek-flash",
    });
  });
  test("rejects strings without a provider", () => {
    expect(() => parseModelString("glm-5.3")).toThrow();
    expect(() => parseModelString("/glm")).toThrow();
    expect(() => parseModelString("zai/")).toThrow();
  });
});

describe("resolveModels", () => {
  test("stage entries inherit unspecified fields from default", () => {
    const models = resolveModels(
      cfg({ default: { provider: "zai", model: "glm-5.3", thinking: "high" }, implement: { provider: "deepseek" } }),
      "implement"
    );
    expect(models.base).toEqual({ provider: "deepseek", model: "glm-5.3", thinking: "high" });
  });
  test("stage fallback overrides default fallback", () => {
    const models = resolveModels(
      cfg({
        default: { provider: "a", model: "m", fallback: ["x/y"] },
        implement: { fallback: ["p/q:low", "r/s"] },
      }),
      "implement"
    );
    expect(models.fallback.map((m) => `${m.provider}/${m.model}`)).toEqual(["p/q", "r/s"]);
  });
  test("throws when the base model is undefined", () => {
    expect(() => resolveModels(cfg({ default: { thinking: "low" } }), "plan")).toThrow(/provider and model/);
  });
});

describe("loadRepoConfig", () => {
  test("fills defaults and validates", () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfcfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ repo: "acme/app", models: { default: { provider: "zai", model: "glm" } } }));
    const loaded = loadRepoConfig(path);
    expect(loaded.slug).toBe("app");
    expect(loaded.attempts).toBe(3);
    expect(loaded.merge.method).toBe("squash");
    expect(loaded.timeouts.stage_minutes).toBe(60);
    expect(loaded.pi.tools.length).toBeGreaterThan(3);
  });
  test("rejects a malformed repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfcfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ repo: "not-a-repo" }));
    expect(() => loadRepoConfig(path)).toThrow(/owner\/name/);
  });
});
