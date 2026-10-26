import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opsGetConfig, opsLogs, opsPause, opsScenarioLint, opsScenarioSet, opsScenarioTest, opsStatus, opsUnblock, reapOrphanMachines } from "../src/ops";
import { Ledger } from "../src/ledger";
import { receipt } from "../src/receipts";
import { execSync } from "node:child_process";

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

  test("logs --repo filters on the [slug] tag; untagged history falls back (P0-2)", () => {
    const st = mkdtempSync(join(tmpdir(), "pdfopslogs-"));
    receipt(st, `lap #1 attempt 1/3`, "demo");
    receipt(st, `lap #2 attempt 1/3`, "other");
    receipt(st, `tick skipped (demo): another tick is live (pidfile)`); // pre-tagging era line
    const lines = opsLogs(st, { slug: "demo" }).lines;
    expect(lines.some((l) => l.includes("lap #1") && l.includes("[demo]"))).toBe(true);
    expect(lines.every((l) => !l.includes("[other]"))).toBe(true); // no multi-tenant flood
    expect(lines.some((l) => l.includes("tick skipped (demo)"))).toBe(true); // legacy substring fallback
  });

  test("unblock refuses an in_progress row — a live lap — unless --force (P0-6)", async () => {
    seedConfig();
    const ledger = new Ledger(join(state, "factory.db"));
    ledger.claim("acme/demo", 7); // in_progress row = possibly a live lap
    const refused = await opsUnblock(state, "demo", 7, false);
    expect(refused.refused).toBe("in_progress");
    expect(refused.dropped).toBe(false);
    expect(refused.note).toContain("--force");
    expect(ledger.getIssue("acme/demo", 7)!.state).toBe("in_progress"); // row intact
    const forced = await opsUnblock(state, "demo", 7, false, true); // verified-dead override
    expect(forced.dropped).toBe(true);
    expect(ledger.getIssue("acme/demo", 7)).toBeNull();
  });

  test("status --repo scopes ledger rows to that repo; unknown slug is empty (P1-15a)", async () => {
    seedConfig();
    const ledger = new Ledger(join(state, "factory.db"));
    ledger.claim("acme/demo", 9);
    const all = await opsStatus(state);
    expect(all.issues.length).toBeGreaterThan(0);
    const scoped = await opsStatus(state, "demo");
    expect(scoped.issues.length).toBeGreaterThan(0);
    expect(scoped.issues.every((i) => i.repo === "acme/demo")).toBe(true);
    expect(scoped.issues.some((i) => i.issue_number === 9)).toBe(true);
    const unknown = await opsStatus(state, "no-such-repo");
    expect(unknown.issues).toEqual([]);
  }, 30000);
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

  test("rejects '$PORT' in single quotes — it never expands (magpie incident 10)", () => {
    seedConfig();
    expect(() => opsScenarioLint(state, "demo", "runtime", scenario([
      { id: "p", description: "x", command: "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$PORT/health'", expect: "status:200" },
    ]))).toThrow(/single quotes never expands/);
  });

  test("rejects bare parens in URLs — shell syntax error before curl runs", () => {
    seedConfig();
    expect(() => opsScenarioLint(state, "demo", "runtime", scenario([
      { id: "p", description: "x", command: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/check?x=(1)", expect: "status:200" },
    ]))).toThrow(/unencoded \( or \)/);
  });

  test("status_in is a known token and rides the same emit-the-code warning", () => {
    seedConfig();
    const good = opsScenarioLint(state, "demo", "runtime", scenario([
      { id: "p", description: "x", command: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/maybe", expect: "status_in:200,404" },
    ]));
    expect(good.ok).toBe(true);
    expect(good.warnings).toEqual([]);
    const trap = opsScenarioLint(state, "demo", "runtime", scenario([
      { id: "p", description: "x", command: "curl -s http://127.0.0.1:$PORT/maybe", expect: "status_in:200,404" },
    ]));
    expect(trap.warnings.some((w: string) => w.includes("must emit the code"))).toBe(true);
  });

  test("the UPLOAD path rejects the same hazards --lint rejects (no burn-a-lap gap)", () => {
    seedConfig();
    expect(() => opsScenarioSet(state, "demo", "holdout", scenario([
      { id: "p", description: "x", command: "curl -s 'http://127.0.0.1:$PORT/x'", expect: "status:200" },
    ]))).toThrow(/rejected holdout\.json: .*single quotes never expands/);
    expect(existsSync(join(state, "repos", "demo", "holdout.json"))).toBe(false);
    // and a clean one still lands
    const r = opsScenarioSet(state, "demo", "holdout", scenario([
      { id: "p", description: "x", command: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/x", expect: "status_in:200,404" },
    ]));
    expect(r.ok).toBe(true);
    expect(existsSync(r.path)).toBe(true);
  });
});

describe("opsPause (the wheel lever — magpie incident 21)", () => {
  test("pause writes the flag and receipts; unpause clears it", () => {
    seedConfig();
    const r1 = opsPause(state, "demo", true);
    expect(r1.paused).toBe(true);
    expect(existsSync(join(state, "repos", "demo", "paused"))).toBe(true);
    const r2 = opsPause(state, "demo", false);
    expect(r2.paused).toBe(false);
    expect(existsSync(join(state, "repos", "demo", "paused"))).toBe(false);
    // unpause when not paused is a no-op, not an error
    expect(() => opsPause(state, "demo", false)).not.toThrow();
  });

  test("pause on an unknown repo is an error", () => {
    expect(() => opsPause(state, "ghost", true)).toThrow(/not onboarded/);
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

  test("an in_progress machine survives; merged/blocked/no-row/unknown are reaped — at ANY generation suffix", async () => {
    const dir = seedInstabox();
    // point the config's api_base at the fake plane
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    const { srv, deleted } = serve(["pdf-toy-i1", "pdf-toy-i2-g41", "pdf-toy-i3-g42", "pdf-gone-i9"]);
    cfg.env.instabox.api_base = `http://127.0.0.1:${srv.port}`;
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
    process.env.TEST_IB_KEY = "k";

    const rows: Record<string, { state: string }> = {
      "acme/toy#1": { state: "in_progress" }, // live lap (old-style name) — must survive
      "acme/toy#2": { state: "merged" }, // booked out, generation-suffixed — reap
      "acme/toy#3": { state: "blocked" }, // terminal, generation-suffixed — reap
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

  test("scenario-test machines: reaped when unmarked or dead-runner; survive their live runner", async () => {
    const dir = seedInstabox();
    const repoint = (srv: any) => {
      const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      cfg.env.instabox.api_base = `http://127.0.0.1:${srv.port}`;
      writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
    };
    process.env.TEST_IB_KEY = "k";
    const ledger = { getIssue: () => null } as any;

    const a = serve(["pdf-toy-scen-test"]);
    repoint(a.srv);
    expect(await reapOrphanMachines(ibState, ledger, () => {})).toBe(1); // no marker — stray

    const b = serve(["pdf-toy-scen-test"]);
    repoint(b.srv);
    writeFileSync(join(dir, "scen-test.running"), JSON.stringify({ pid: process.pid, machine: "pdf-toy-scen-test" }));
    expect(await reapOrphanMachines(ibState, ledger, () => {})).toBe(0); // live runner — protected

    writeFileSync(join(dir, "scen-test.running"), JSON.stringify({ pid: 2 ** 22, machine: "pdf-toy-scen-test" }));
    expect(await reapOrphanMachines(ibState, ledger, () => {})).toBe(1); // crashed runner — reap

    a.srv.stop(true);
    b.srv.stop(true);
    delete process.env.TEST_IB_KEY;
  });

  test("no instabox repos = no-op", async () => {
    const empty = mkdtempSync(join(tmpdir(), "pdfib2-"));
    const reaped = await reapOrphanMachines(empty, { getIssue: () => null } as any, () => {});
    expect(reaped).toBe(0);
  });
});

describe("opsScenarioTest (host mode — the verifier's own test bench)", () => {
  const GIT_ID = "-c user.email=t@t.io -c user.name=Test";
  const st = mkdtempSync(join(tmpdir(), "pdfscenops-"));
  const origin = join(st, "origin.git");

  test("executes the stored scenario against main without a lap; failing probes name themselves", async () => {
    execSync(`git init --bare ${origin}`);
    execSync(`git --git-dir=${origin} symbolic-ref HEAD refs/heads/main`);
    const seed = join(st, "seed");
    execSync(`git clone ${origin} ${seed}`);
    execSync(`git -C ${seed} checkout -b main`);
    writeFileSync(join(seed, "hello.txt"), "hello product\n");
    execSync(`git -C ${seed} ${GIT_ID} add -A`);
    execSync(`git -C ${seed} ${GIT_ID} commit -m init`);
    execSync(`git -C ${seed} push origin main`);
    execSync(`rm -rf ${seed}`);

    const picker = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = picker.port;
    picker.stop(true);

    const dir = join(st, "repos", "demo");
    mkdirSync(dir, { recursive: true });
    const writeScenario = (expect: string) =>
      writeFileSync(
        join(dir, "runtime.json"),
        JSON.stringify({
          name: "runtime",
          port,
          start: "python3 -m http.server $PORT --bind 127.0.0.1 --directory $WORKTREE",
          readiness_path: "/",
          probes: [
            {
              id: "hello-served",
              description: "hello.txt is served from the branch under test",
              command: "curl -s http://127.0.0.1:$PORT/hello.txt",
              expect,
            },
          ],
        })
      );
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        repo: "acme/demo",
        slug: "demo",
        default_branch: "main",
        origin_url: origin,
        attempts: 2,
        models: { default: { provider: "x", model: "y" } },
        timeouts: { stage_minutes: 5, checks_minutes: 1, readiness_seconds: 15, probe_ms: 4000 },
        scenario: { ports: [], runtime: "runtime.json", holdout: "holdout.json" },
        skip_labels: [],
        env: { mode: "host" },
      })
    );

    writeScenario("body_contains:hello");
    const green = await opsScenarioTest(st, "demo", "runtime");
    expect(green.branch).toBe("main");
    expect(green.result.pass).toBe(true);
    expect(green.result.results[0].pass).toBe(true);

    // the operator's actual workflow: verifier bug suspected → point the
    // probe at the wrong thing → --test shows WHICH probe fails, no lap spent
    writeScenario("body_contains:nope");
    const red = await opsScenarioTest(st, "demo", "runtime");
    expect(red.result.pass).toBe(false);
    expect(red.result.results[0].pass).toBe(false);
    expect(red.result.results[0].detail).toBeTruthy();
  }, 60000);
});

describe("beginTick (per-repo locks + honest refusals)", () => {
  test("a slug tick refused while its repo lock is held; neighbor repo free; global lock untouched", async () => {
    const { beginTick } = await import("../src/tick");
    const { acquireTickLock, releaseTickLock } = await import("../src/lock");
    const st = mkdtempSync(join(tmpdir(), "pdflock-"));
    mkdirSync(join(st, "repos"), { recursive: true }); // configured factory, zero repos processed
    // minimal onboarding for the two slugs the test ticks (their lap intake
    // fails inside the per-repo try — receipted, body completes cleanly)
    for (const s of ["other", "third"]) {
      const d = join(st, "repos", s);
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, "config.json"),
        JSON.stringify({
          repo: `acme/${s}`, slug: s, default_branch: "main",
          models: { default: { provider: "x", model: "y" } },
          scenario: { ports: [] }, env: { mode: "host" },
        })
      );
    }
    // a LIVE holder whose cmdline looks like the factory (exec -a rewrites argv[0])
    const holder = Bun.spawn(["bash", "-c", "exec -a foreman-tick-holder sleep 30"]);
    await new Promise((r) => setTimeout(r, 300)); // let it exec
    writeFileSync(join(st, "tick-demo.lock"), `${holder.pid}\n`);

    const refused = beginTick({ stateDir: st, repoSlug: "demo" });
    expect(refused.started).toBe(false);
    expect(refused.reason).toContain("demo");

    // a different repo is NOT blocked by demo's lock, and the run completes
    const other = beginTick({ stateDir: st, repoSlug: "other" });
    expect(other.started).toBe(true);
    await other.run;

    // a slug lock never takes the GLOBAL tick lock
    const third = beginTick({ stateDir: st, repoSlug: "third" });
    expect(third.started).toBe(true);
    expect(acquireTickLock(st)).toBe(true); // global still free while third runs
    releaseTickLock(st);
    await third.run;

    // a bare daemon-shaped holder ("bun src/factoryd.ts", repo only as cwd)
    // was once judged not-factory and stolen — add that shape to the holder
    const holder2 = Bun.spawn(["bash", "-c", "exec -a 'bun src/factoryd.ts' sleep 30"], { cwd: import.meta.dir + "/../.." });
    await new Promise((r) => setTimeout(r, 300)); // let it exec
    writeFileSync(join(st, "tick-daemonish.lock"), `${holder2.pid}\n`);
    const { acquireRepoLock, releaseRepoLock } = await import("../src/lock");
    expect(acquireRepoLock(st, "daemonish")).toBe(false); // alive + factory-cwd = NOT stealable

    holder.kill();
    holder2.kill();
    await holder.exited;
    await holder2.exited;
  });
});
