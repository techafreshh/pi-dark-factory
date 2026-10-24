import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opsGetConfig, opsLogs, opsScenarioLint, opsScenarioSet, opsStatus, opsUnblock, reapOrphanMachines } from "../src/ops";

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

describe("opsGetConfig (the read verb)", () => {
  test("returns the effective config for an onboarded repo", () => {
    seedConfig();
    const r = opsGetConfig(state, "demo");
    expect(r.slug).toBe("demo");
    expect(r.config.repo).toBe("acme/demo");
    expect(r.config.models.default.provider).toBe("x");
  });

  test("unknown repo is an error", () => {
    expect(() => opsGetConfig(state, "nope")).toThrow(/not onboarded/);
  });
});

describe("opsScenarioLint (dry-run gate)", () => {
  const scenario = (probes: any[]) =>
    JSON.stringify({ name: "runtime", port: 8100, start: "x", probes });

  test("rejects unknown tokens from space-split values", () => {
    seedConfig();
    expect(() => opsScenarioLint(state, "demo", "runtime", scenario([
      { id: "p", description: "x", command: "echo hi", expect: "body_contains:hello world" },
    ]))).toThrow(/unknown token "world"/);
  });

  test("rejects uncompilable body_matches regexes", () => {
    seedConfig();
    expect(() => opsScenarioLint(state, "demo", "runtime", scenario([
      { id: "p", description: "x", command: "echo hi", expect: "body_matches:[unclosed" },
    ]))).toThrow(/does not compile/);
  });

  test("warns on a status: probe whose command never emits the code", () => {
    seedConfig();
    const r = opsScenarioLint(state, "demo", "runtime", scenario([
      { id: "p", description: "x", command: "curl -s http://127.0.0.1:$PORT/health", expect: "status:200" },
    ]));
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w: string) => w.includes("must emit the code"))).toBe(true);
  });

  test("accepts the -w emit form and the combined \\n%{http_code} form without warnings", () => {
    seedConfig();
    const r = opsScenarioLint(state, "demo", "runtime", scenario([
      { id: "a", description: "x", command: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/health", expect: "status:200" },
      { id: "b", description: "x", command: "curl -s -w '\\n%{http_code}' http://127.0.0.1:$PORT/health", expect: "status:200 body_contains:ok" },
    ]));
    expect(r.warnings).toEqual([]);
  });

  test("GOLDEN: the skill's shipped templates lint clean", () => {
    seedConfig();
    const tplDir = join(import.meta.dir, "..", ".agents", "skills", "pi-factory", "templates");
    for (const kind of ["runtime", "holdout"] as const) {
      const content = readFileSync(join(tplDir, `scenario.${kind}.json`), "utf8");
      const r = opsScenarioLint(state, "demo", kind, content);
      expect(r.ok).toBe(true);
      expect(r.warnings).toEqual([]);
    }
  });
});

describe("reapOrphanMachines (guarded janitor)", () => {
  const ibState = mkdtempSync(join(tmpdir(), "pdfib-"));
  let base = "";

  const seedInstabox = () => {
    const dir = join(ibState, "repos", "toy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        repo: "acme/toy",
        slug: "toy",
        default_branch: "main",
        models: { default: { provider: "x", model: "y" } },
        scenario: { ports: [] },
        env: {
          mode: "instabox",
          instabox: { api_base: "", api_key_env: "TEST_IB_KEY", template: "basic", snapshot: "", repo_dir: "/data/repo" },
        },
      })
    );
    return dir;
  };

  // fake InstaBox control plane (same pattern as machine.test.ts)
  const serve = (machines: any[]) => {
    const deleted: string[] = [];
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (req.method === "GET" && u.pathname === "/v1/machines")
          return Response.json({ machines: machines.map((m) => (typeof m === "string" ? { id: "m_" + m, name: m, state: "running" } : m)) });
        if (req.method === "DELETE" && u.pathname.startsWith("/v1/machines/")) {
          deleted.push(u.pathname.split("/")[3]);
          return Response.json({ id: "op", state: "succeeded" }, { status: 202 });
        }
        return new Response("nf", { status: 404 });
      },
    });
    return { srv, deleted };
  };

  test("an in_progress machine survives; merged/blocked/no-row/unknown are reaped", async () => {
    const dir = seedInstabox();
    // point the config's api_base at the fake plane
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    const { srv, deleted } = serve(["pdf-toy-i1", "pdf-toy-i2", "pdf-toy-i3", "pdf-gone-i9"]);
    cfg.env.instabox.api_base = `http://127.0.0.1:${srv.port}`;
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
    process.env.TEST_IB_KEY = "k";

    const rows: Record<string, { state: string }> = {
      "acme/toy#1": { state: "in_progress" }, // live lap — must survive
      "acme/toy#2": { state: "merged" }, // booked out — reap
      "acme/toy#3": { state: "blocked" }, // terminal — reap
      // i9: unknown slug — reap
    };
    const ledger = { getIssue: (repo: string, n: number) => rows[`${repo}#${n}`] ?? null };
    const log: string[] = [];
    const reaped = await reapOrphanMachines(ibState, ledger as any, (m) => log.push(m));

    expect(reaped).toBe(3);
    expect(log.some((l) => l.includes("pdf-toy-i1"))).toBe(false); // the live lap's machine untouched
    expect(log.filter((l) => l.includes("janitor deleted")).length).toBe(3);
    expect(deleted.length).toBe(3);
    srv.stop(true);
    delete process.env.TEST_IB_KEY;
  });

  test("no instabox repos = no-op", async () => {
    const empty = mkdtempSync(join(tmpdir(), "pdfib2-"));
    const reaped = await reapOrphanMachines(empty, { getIssue: () => null } as any, () => {});
    expect(reaped).toBe(0);
  });
});
