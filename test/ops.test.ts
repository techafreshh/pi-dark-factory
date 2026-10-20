import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opsLogs, opsScenarioSet, opsStatus, opsUnblock } from "../src/ops";

const state = mkdtempSync(join(tmpdir(), "pdfops-"));

const seedConfig = () => {
  const dir = join(state, "repos", "demo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      repo: "acme/demo",
      slug: "demo",
      default_branch: "main",
      models: { default: { provider: "x", model: "y" } },
      scenario: { ports: [] },
      env: { mode: "host" },
    })
  );
  return dir;
};

describe("ops core (shared by foreman CLI and factoryd)", () => {
  test("status tolerates an empty state dir", async () => {
    const s = await opsStatus(state);
    expect(s.repos).toEqual([]);
    expect(s.issues).toEqual([]);
    expect(Array.isArray(s.worktrees)).toBe(true);
  });

  test("logs on a fresh state reports a friendly note", () => {
    expect(opsLogs(state).note).toContain("no laps.log");
  });

  test("scenario set validates before committing", () => {
    seedConfig();
    const good = JSON.stringify({
      name: "runtime",
      port: 8100,
      start: "python3 -m http.server $PORT --bind 127.0.0.1",
      probes: [{ id: "p", description: "x", command: "echo 200", expect: "status:200" }],
    });
    const r = opsScenarioSet(state, "demo", "runtime", good);
    expect(r.ok).toBe(true);
    expect(existsSync(r.path)).toBe(true);

    expect(() =>
      opsScenarioSet(state, "demo", "holdout", JSON.stringify({ port: 8102, start: "x", probes: [] }))
    ).toThrow(/rejected holdout\.json/);
    // the rejected file never landed
    expect(existsSync(join(state, "repos", "demo", "holdout.json"))).toBe(false);
  });

  test("unblock on a rowless issue is a friendly no-op", async () => {
    const r = await opsUnblock(state, "demo", 42, false);
    expect(r.dropped).toBe(false);
  });
});
