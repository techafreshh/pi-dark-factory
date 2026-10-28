import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoConfig } from "../src/config";
import { extensionPresent, stageTools, webToggle, webPromptNote } from "../src/webtools";
import type { RepoConfig } from "../src/types";

/** the real checkout always carries the extension pair */
const HAS_EXT = extensionPresent();

function cfg(over: any = {}): RepoConfig {
  return {
    repo: "o/r",
    slug: "r",
    default_branch: "main",
    attempts: 3,
    merge: { method: "squash", required_checks: [], delete_branch: true },
    models: { default: { provider: "p", model: "m" } },
    timeouts: { stage_minutes: 10, checks_minutes: 10, readiness_seconds: 60, probe_ms: 1000 },
    scenario: { ports: [] },
    skip_labels: [],
    pi: {
      binary: "pi",
      tools: ["read", "bash", "edit", "write"],
      plan_tools: ["read", "grep"],
      extra_args: [],
    },
    env: {
      mode: "host",
      compose_file: "docker-compose.yml",
      service: "worker",
      image: "ubuntu:24.04",
      pass_env: [],
      instabox: {
        api_base: "https://api.instabox.sh",
        api_key_env: "INSTABOX_API_KEY",
        template: "basic",
        snapshot: "",
        repo_dir: "/data/repo",
        bake: "",
      },
    },
    ...over,
  } as RepoConfig;
}

describe("stageTools", () => {
  test("no extension → the stage's exact base list (today's argv unchanged)", () => {
    expect(stageTools(cfg(), "plan", false)).toEqual(["read", "grep"]);
    expect(stageTools(cfg(), "implement", false)).toEqual(["read", "bash", "edit", "write"]);
    expect(stageTools(cfg(), "review", false)).toEqual(["read", "grep"]);
  });

  test("extension + default config → web tools appended to every stage", () => {
    const withExt = stageTools(cfg(), "plan", true);
    expect(withExt.slice(0, 2)).toEqual(["read", "grep"]);
    expect(withExt).toContain("web_search");
    expect(withExt).toContain("web_fetch");
    expect(stageTools(cfg(), "implement", true)).toContain("web_search");
    expect(stageTools(cfg(), "review", true)).toContain("web_fetch");
  });

  test("search=false drops only web_search; fetch=false drops only web_fetch", () => {
    const c = cfg();
    c.pi.web = { search: false, fetch: true };
    const plan = stageTools(c, "plan", true);
    expect(plan).not.toContain("web_search");
    expect(plan).toContain("web_fetch");
    const c2 = cfg();
    c2.pi.web = { search: true, fetch: false };
    expect(stageTools(c2, "plan", true)).toContain("web_search");
    expect(stageTools(c2, "plan", true)).not.toContain("web_fetch");
  });

  test("both flags off → exactly the base list, no web names", () => {
    const c = cfg();
    c.pi.web = { search: false, fetch: false };
    expect(stageTools(c, "plan", true)).toEqual(["read", "grep"]);
    expect(stageTools(c, "implement", true)).toEqual(["read", "bash", "edit", "write"]);
  });

  test("webToggle defaults to both-on when pi.web is absent", () => {
    expect(webToggle(cfg())).toEqual({ search: true, fetch: true });
  });
});

describe("webPromptNote", () => {
  test("names the enabled tools and the untrusted-data rule", () => {
    const note = webPromptNote(cfg());
    expect(note).toContain("web_search");
    expect(note).toContain("web_fetch");
    expect(note).toMatch(/untrusted/i);
  });
  test("empty when both disabled", () => {
    const c = cfg();
    c.pi.web = { search: false, fetch: false };
    expect(webPromptNote(c)).toBe("");
  });
});

describe("loadRepoConfig web defaults + validation", () => {
  test("a config without pi.web gains the both-on default at load", () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfweb-"));
    try {
      const p = join(dir, "config.json");
      writeFileSync(p, JSON.stringify({ repo: "o/r", models: { default: { provider: "p", model: "m" } } }));
      const loaded = loadRepoConfig(p);
      expect(loaded.pi.web).toEqual({ search: true, fetch: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a partial web patch keeps the other flag at default (nested merge)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfweb-"));
    try {
      const p = join(dir, "config.json");
      writeFileSync(
        p,
        JSON.stringify({
          repo: "o/r",
          models: { default: { provider: "p", model: "m" } },
          pi: { web: { search: false } },
        })
      );
      const loaded = loadRepoConfig(p);
      expect(loaded.pi.web).toEqual({ search: false, fetch: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-boolean web flag is rejected at load time (422 at the config write)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfweb-"));
    try {
      const p = join(dir, "config.json");
      writeFileSync(
        p,
        JSON.stringify({
          repo: "o/r",
          models: { default: { provider: "p", model: "m" } },
          pi: { web: { search: "false" } },
        })
      );
      expect(() => loadRepoConfig(p)).toThrow(/pi\.web\.search/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extensionPresent", () => {
  test("the checkout ships the pair → stages get web tools by default", () => {
    expect(HAS_EXT).toBe(true);
  });
});
