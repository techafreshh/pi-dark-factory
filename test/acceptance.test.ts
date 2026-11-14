import { describe, expect, test, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupWorlds, FakeGh, FakeMachine, makeMachineWorld, type World } from "./world";
import { e2eSuiteExists, prdPath, readAcceptanceState, acceptanceRunsToday, recordAcceptanceRun, writeAcceptanceState, readPrd } from "../src/acceptance-state";
import { parseAcceptanceVerdict, parseE2eReport, parseE2eRunOutput, e2eRunCommand, runPrdAcceptance, buildAcceptancePrompt, hostToolchainDir, boxToolchainDir, acceptanceSuiteEnv } from "../src/stages/acceptance";
import { parsePentheraReport, findingsAboveFloor, runSecurityScan, mayFileSecurityFindings, pentheraSpec } from "../src/security";
import { fileFactoryIssues } from "../src/fileissues";
import { maybeDrainAcceptance, openIssuesAllDeferred, runPostMergeExtras } from "../src/postmerge";
import { reapOrphanMachines } from "../src/ops";
import { browserBakeScript, hostToolsScript } from "../src/browserbake";
import { parseRepoConfig } from "../src/config";

/* Real captured shapes (docs/development.md boundary rule): penthera 2.4.0's
 * -o report and e2e 0.23.1's report.json, captured live on 2026-11-13 — the
 * parsers below are judged against THESE, never invented wire shapes. */
const pentheraFixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "penthera-report.json"), "utf8"));
const e2ePassFixture = readFileSync(join(import.meta.dir, "fixtures", "e2e-report-pass.json"), "utf8");
const e2eFailFixture = readFileSync(join(import.meta.dir, "fixtures", "e2e-report-fail.json"), "utf8");

const silence = () => ({ out: () => {}, err: () => {} });

/** the walk tests boot real git + python servers — bun's 5 s default is too tight */
const slowTest = (name: string, fn: () => Promise<void> | void) => test(name, fn, 60_000);

afterAll(() => cleanupWorlds());

// ── verdict + report parsers ────────────────────────────────────────────────

describe("parseAcceptanceVerdict (lenient, fail closed)", () => {
  test("DELIVERED with no GAPS section", () => {
    const v = parseAcceptanceVerdict("I walked every deliverable.\n\nVERDICT: DELIVERED");
    expect(v.delivered).toBe(true);
    expect(v.gaps).toEqual([]);
  });
  test("GAPS lines with severity, default major", () => {
    const v = parseAcceptanceVerdict(
      "GAPS:\n- home page :: /about is missing :: major :: loaded /\n- sort order :: newest first not applied :: minor :: clicked header\nVERDICT: GAPS"
    );
    expect(v.delivered).toBe(false);
    expect(v.gaps.length).toBe(2);
    expect(v.gaps[0].severity).toBe("major");
    expect(v.gaps[1].severity).toBe("minor");
    expect(v.gaps[1].repro).toBe("clicked header");
  });
  test("a missing severity defaults to major (a mislabeled minor would silently defer)", () => {
    const v = parseAcceptanceVerdict("GAPS:\n- thing :: broken\nVERDICT: GAPS");
    expect(v.gaps[0].severity).toBe("major");
  });
  test("a markdown heading ends the GAPS section", () => {
    const v = parseAcceptanceVerdict("GAPS:\n- a :: b :: major\n## Notes\nsome prose\nVERDICT: GAPS");
    expect(v.gaps.length).toBe(1);
  });
  test("neither marker → delivered null (fail closed, nothing filed)", () => {
    expect(parseAcceptanceVerdict("the product seems fine I guess").delivered).toBeNull();
    expect(parseAcceptanceVerdict("").delivered).toBeNull();
  });
  test("gaps listed before a DELIVERED claim stay gaps (fail-safe: a verdict cannot undo filed gaps)", () => {
    const v = parseAcceptanceVerdict("GAPS:\n- old :: thing :: major\nafter a second look:\nVERDICT: DELIVERED");
    expect(v.delivered).toBe(false);
    expect(v.gaps.length).toBe(1);
  });
  test("a verdict line placed FIRST does not hide GAPS bullets that follow it", () => {
    const v = parseAcceptanceVerdict("VERDICT: DELIVERED\n\nGAPS:\n- auth :: login page never built :: major :: POST /login 404s");
    expect(v.delivered).toBe(false);
    expect(v.gaps.length).toBe(1);
  });
  test("VERDICT: GAPS with no parsable bullets fails and files nothing", () => {
    const v = parseAcceptanceVerdict("hard to express\nVERDICT: GAPS");
    expect(v.delivered).toBe(false);
    expect(v.gaps).toEqual([]);
  });
});

describe("parseE2eReport (captured e2e 0.23.1 shapes)", () => {
  test("passing report", () => {
    const r = parseE2eReport(e2ePassFixture)!;
    expect(r).not.toBeNull();
    expect(r.status).toBe("passed");
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.failures).toEqual([]);
  });
  test("failing report carries the failed test + its error", () => {
    const r = parseE2eReport(e2eFailFixture)!;
    expect(r.status).toBe("blocked"); // e2e's status when the app never came up
    expect(r.failed).toBe(1);
    expect(r.failures.length).toBe(1);
    expect(r.failures[0].file).toBe("tests/example.e2e.ts");
    expect(r.failures[0].testId).toContain("app%20opens");
  });
  test("garbage → null (the runner fails closed too)", () => {
    expect(parseE2eReport("not json")).toBeNull();
    expect(parseE2eReport(JSON.stringify({ run: {} }))).toBeNull();
  });
});

describe("parseE2eRunOutput (the framed in-box report)", () => {
  test("rc line + base64 report", () => {
    const b64 = Buffer.from(e2ePassFixture).toString("base64");
    const out = `some noise\nPDFE2ERC=0\n${b64}\n`;
    const { rc, report } = parseE2eRunOutput(out);
    expect(rc).toBe(0);
    expect(report?.status).toBe("passed");
  });
  test("no report marker → null report", () => {
    const { rc, report } = parseE2eRunOutput("PDFE2ERC=1\nPDFE2ENOREPORT");
    expect(rc).toBe(1);
    expect(report).toBeNull();
  });
});

describe("e2eRunCommand (the suite runner both lanes share)", () => {
  test("host lane: APP_URL from $PORT, toolchain symlink, no browsers-path export", () => {
    const cmd = e2eRunCommand({ suiteDir: "/state/repos/t/e2e", toolchainDir: hostToolchainDir(), inBox: false });
    expect(cmd).toContain('export APP_URL="http://127.0.0.1:$PORT"');
    expect(cmd).toContain("ln -sfn");
    expect(cmd).toContain("npx --no-install e2e run");
    expect(cmd).not.toContain("PLAYWRIGHT_BROWSERS_PATH");
    expect(cmd).toContain("PDFE2ERC=");
  });
  test("in-box lane: browsers path rides explicitly", () => {
    const cmd = e2eRunCommand({ suiteDir: "/tmp/pdf-e2e-suite", toolchainDir: boxToolchainDir(), inBox: true });
    expect(cmd).toContain(`PLAYWRIGHT_BROWSERS_PATH=${boxToolchainDir()}-browsers`);
  });
});

describe("acceptanceSuiteEnv (agent-authored code runs under the allowlist)", () => {
  test("a factory service secret never reaches the suite's environment", () => {
    process.env.PDF_SENTINEL_FACTORY_SECRET = "topsecret";
    process.env.PDF_SENTINEL_PASS_RIDES = "explicitly-forwarded";
    try {
      const cfg = parseRepoConfig({ repo: "acme/toy", models: { default: { provider: "x", model: "y" } }, env: { pass_env: ["PDF_SENTINEL_PASS_RIDES"] } }, "t");
      const env = acceptanceSuiteEnv(cfg);
      expect(env.PDF_SENTINEL_FACTORY_SECRET).toBeUndefined();
      expect(env.PDF_SENTINEL_PASS_RIDES).toBe("explicitly-forwarded");
      expect(env.PATH).toBeTruthy();
      expect(env.HOME).toBeTruthy();
    } finally {
      delete process.env.PDF_SENTINEL_FACTORY_SECRET;
      delete process.env.PDF_SENTINEL_PASS_RIDES;
    }
  });
});

// ── factory-side state ──────────────────────────────────────────────────────

describe("acceptance state (prd.md, generation, daily cap, suite detection)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdfacc-"));

  test("opsPrdSet-backed helpers: store, read, gen bump", () => {
    expect(readPrd(dir, "toy")).toBeNull();
    expect(e2eSuiteExists(dir, "toy")).toBe(false);
    writeAcceptanceState(dir, "toy", { gen: 3 });
    const st = readAcceptanceState(dir, "toy");
    expect(st.gen).toBe(3);
    // prd.md stored under repos/<slug>/ — outside the repo by contract
    mkdirSync(join(dir, "repos", "toy"), { recursive: true });
    writeFileSync(prdPath(dir, "toy"), "# PRD\n\nDeliverable one.\n");
    expect(readPrd(dir, "toy")!.startsWith("# PRD")).toBe(true);
  });

  test("suite detection: config alone is not a suite", () => {
    const suiteDir = join(dir, "repos", "toy", "e2e");
    mkdirSync(suiteDir, { recursive: true });
    writeFileSync(join(suiteDir, "e2e.config.ts"), "export default {};");
    expect(e2eSuiteExists(dir, "toy")).toBe(false); // zero tests = vacuous pass, refused
    writeFileSync(join(suiteDir, "home.e2e.ts"), "test('home', async () => {});");
    expect(e2eSuiteExists(dir, "toy")).toBe(true);
    // nested test dirs count too
    rmSync(join(suiteDir, "home.e2e.ts"));
    mkdirSync(join(suiteDir, "tests"), { recursive: true });
    writeFileSync(join(suiteDir, "tests", "home.e2e.ts"), "test('home', async () => {});");
    expect(e2eSuiteExists(dir, "toy")).toBe(true);
  });

  test("daily run counter: records per UTC day, the trigger reads it", () => {
    expect(acceptanceRunsToday(dir, "toy")).toBe(0);
    recordAcceptanceRun(dir, "toy");
    recordAcceptanceRun(dir, "toy");
    expect(acceptanceRunsToday(dir, "toy")).toBe(2);
    // surviving a corrupted state file must not freeze the trigger
    writeFileSync(join(dir, "repos", "toy", "acceptance.json"), "{oops");
    expect(readAcceptanceState(dir, "toy").gen).toBe(0);
  });
});

// ── security scan (penthera) ────────────────────────────────────────────────

describe("penthera report parsing (captured 2.4.0 shape)", () => {
  test("the fixture's findings and brief", () => {
    const r = parsePentheraReport(JSON.stringify(pentheraFixture))!;
    expect(r).not.toBeNull();
    expect(r.findings!.length).toBe(7);
    expect(r.brief?.verdict).toBe("Fix now");
    expect(r.brief?.counts?.total).toBe(7);
    const inj = r.findings!.find((f) => f.title.includes("command-injection"));
    expect(inj?.severity).toBe("critical");
    expect(inj?.fid).toBeTruthy();
  });
  test("garbage → null → the scan files NOTHING (fail closed)", () => {
    expect(parsePentheraReport("")).toBeNull();
    expect(parsePentheraReport("Penthera: Fix now. 6 problems")).toBeNull();
  });
  test("severity floor filter: worst-first, info never files", () => {
    const all = pentheraFixture.findings;
    expect(findingsAboveFloor(all, "critical").map((f: any) => f.severity)).toEqual(["critical"]);
    expect(findingsAboveFloor(all, "medium").map((f: any) => f.severity)).toEqual(["critical", "high", "medium"]);
    expect(findingsAboveFloor(all, "low").some((f: any) => f.severity === "info")).toBe(false);
    // an unknown floor word degrades to medium, never to "file everything"
    expect(findingsAboveFloor(all, "cosmic").map((f: any) => f.severity)).toEqual(["critical", "high", "medium"]);
  });
  test("publish gate: a PUBLIC tracker files nothing without the explicit opt-in", () => {
    const cfg = (over: any) => parseRepoConfig({ repo: "acme/toy", models: { default: { provider: "x", model: "y" } }, ...over }, "t");
    expect(mayFileSecurityFindings("PUBLIC", cfg({}))).toBe(false);
    expect(mayFileSecurityFindings("PUBLIC", cfg({ acceptance: { security_public: true } }))).toBe(true);
    expect(mayFileSecurityFindings("PRIVATE", cfg({}))).toBe(true);
    expect(mayFileSecurityFindings(null, cfg({}))).toBe(true); // gh broke — the receipt names it
  });
  test("the scanner spec is PINNED to the version the fixture was captured against", () => {
    delete process.env.PDF_PENTHERA_SPEC;
    expect(pentheraSpec()).toBe("penthera@2.4.0");
  });
});

describe("fileFactoryIssues (the generic filer)", () => {
  test("dedupes against open titles and inside the batch; labels land", async () => {
    const gh = new FakeGh();
    gh.issues = [{ number: 1, title: "[security] known one (fid abc)", body: "", labels: [] }];
    const filed = await fileFactoryIssues(
      mkdtempSync(join(tmpdir(), "pdffile-")),
      "toy",
      gh,
      [
        { title: "[security] known one (fid abc)", body: "x", labels: ["security"] },
        { title: "[security] fresh (fid def)", body: "y", labels: ["security"] },
        { title: "[security] fresh (fid def)", body: "y2", labels: ["security"] },
      ],
      { via: "test" }
    );
    expect(filed.length).toBe(1);
    expect(filed[0].title).toBe("[security] fresh (fid def)");
    expect(gh.created.length).toBe(1);
    expect(gh.issues.find((i) => i.number === filed[0].issue)?.labels).toContain("security");
  });

  test("a create failure skips the item without losing the batch", async () => {
    const gh = new FakeGh();
    let n = 0;
    gh.issueCreate = (title: string, body: string) => {
      if (n++ === 0) return Promise.reject(new Error("gh exploded"));
      return FakeGh.prototype.issueCreate.call(gh, title, body);
    };
    const filed = await fileFactoryIssues(mkdtempSync(join(tmpdir(), "pdffile2-")), "toy", gh, [
      { title: "[prd-gap] a", body: "x", labels: ["prd-gap"] },
      { title: "[prd-gap] b", body: "y", labels: ["prd-gap"] },
    ]);
    expect(filed.length).toBe(1);
    expect(filed[0].title).toBe("[prd-gap] b");
  });
});

// ── config validation ───────────────────────────────────────────────────────

describe("acceptance config block", () => {
  const base = { repo: "acme/toy", models: { default: { provider: "x", model: "y" } } };
  test("defaults: every capability off, caps present", () => {
    const cfg = parseRepoConfig(base, "t");
    expect(cfg.acceptance!.e2e).toBe(false);
    expect(cfg.acceptance!.prd_check).toBe(false);
    expect(cfg.acceptance!.security).toBe(false);
    expect(cfg.acceptance!.security_public).toBe(false);
    expect(cfg.acceptance!.severity_floor).toBe("medium");
    expect(cfg.acceptance!.e2e_minutes).toBe(10);
    expect(cfg.acceptance!.prd_minutes).toBe(25);
  });
  test("a string flag from a hand edit is rejected at parse time", () => {
    expect(() => parseRepoConfig({ ...base, acceptance: { e2e: "yes" } }, "t")).toThrow(/acceptance\.e2e must be true or false/);
  });
  test("an unknown severity floor and a bad cap are rejected", () => {
    expect(() => parseRepoConfig({ ...base, acceptance: { severity_floor: "cosmic" as any } }, "t")).toThrow(/severity_floor/);
    expect(() => parseRepoConfig({ ...base, acceptance: { e2e_minutes: 0 } }, "t")).toThrow(/e2e_minutes/);
  });
  test("a valid patch keeps sibling defaults (nested merge)", () => {
    const cfg = parseRepoConfig({ ...base, acceptance: { security: true } }, "t");
    expect(cfg.acceptance!.security).toBe(true);
    expect(cfg.acceptance!.e2e).toBe(false);
    expect(cfg.acceptance!.severity_floor).toBe("medium");
  });
});

// ── bake toolchain ──────────────────────────────────────────────────────────

describe("browser toolchain scripts (text invariants)", () => {
  test("the bake script installs node+chromium+e2e, smokes the browser, fails loudly", () => {
    const s = browserBakeScript();
    expect(s).toContain("/opt/pdf-e2e");
    expect(s).toContain("apt-get install -y chromium");
    expect(s).toContain("npm install");
    expect(s).toContain("e2e @e2e-dev/web playwright-core");
    // the smoke is the egress verdict: no launchable Chromium exits 31
    expect(s).toContain("BROWSER_SMOKE_FAILED");
    expect(s).toContain("exit 31");
    expect(s).toContain("TOOLCHAIN_OK");
    expect(s).toContain("npx --no-install e2e --version");
  });
  test("the host script covers penthera too", () => {
    const s = hostToolsScript();
    expect(s).toContain("penthera");
    expect(s).toContain("e2e");
    expect(s).toContain("agent-browser");
    expect(s).toContain("HOSTTOOLS_OK");
  });
});

// ── the janitor carve-out ───────────────────────────────────────────────────

describe("acceptance-machine janitor guard", () => {
  const st = mkdtempSync(join(tmpdir(), "pdfguard-"));
  mkdirSync(join(st, "repos", "toy"), { recursive: true });

  test("i0 machines are protected ONLY by a live walker's marker", () => {
    expect(require("../src/ops").acceptanceMachineLive(st, "pdf-toy-i0-g0")).toBe(false); // no marker
    writeFileSync(join(st, "repos", "toy", "acceptance.running"), JSON.stringify({ pid: process.pid }));
    expect(require("../src/ops").acceptanceMachineLive(st, "pdf-toy-i0-g0")).toBe(true); // live walker
    expect(require("../src/ops").acceptanceMachineLive(st, "pdf-toy-i0-g7")).toBe(true); // any generation
    expect(require("../src/ops").acceptanceMachineLive(st, "pdf-toy-i1")).toBe(false); // lap machines never match
    expect(require("../src/ops").acceptanceMachineLive(st, "pdf-toy-scen-test")).toBe(false);
    writeFileSync(join(st, "repos", "toy", "acceptance.running"), JSON.stringify({ pid: 2 ** 22 }));
    expect(require("../src/ops").acceptanceMachineLive(st, "pdf-toy-i0")).toBe(false); // crashed walker
  });

  test("reapOrphanMachines honors the guard (instabox lane)", async () => {
    const dir = join(st, "repos", "toy");
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        repo: "acme/toy",
        slug: "toy",
        models: { default: { provider: "x", model: "y" } },
        scenario: { ports: [] },
        env: { mode: "instabox", instabox: { api_base: "", api_key_env: "TEST_IB_KEY", template: "basic", snapshot: "", repo_dir: "/data/repo" } },
      })
    );
    process.env.TEST_IB_KEY = "k";
    const deleted: string[] = [];
    const serve = (names: string[]) => {
      const srv = Bun.serve({
        port: 0,
        fetch(req) {
          const u = new URL(req.url);
          if (req.method === "GET" && u.pathname === "/v1/machines")
            return Response.json({ machines: names.map((n) => ({ id: "m_" + n, name: n, state: "running" })) });
          if (req.method === "DELETE" && u.pathname.startsWith("/v1/machines/")) {
            deleted.push(u.pathname.split("/")[3]);
            return Response.json({ id: "op", state: "succeeded" }, { status: 202 });
          }
          return new Response("nf", { status: 404 });
        },
      });
      const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      cfg.env.instabox.api_base = `http://127.0.0.1:${srv.port}`;
      writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
      return srv;
    };
    const ledger = { getIssue: () => null } as any; // issue 0 has no lap row by definition
    try {
      // a LIVE walker protects its machine; a dead one loses it
      const srvA = serve(["pdf-toy-i0-g0"]);
      writeFileSync(join(dir, "acceptance.running"), JSON.stringify({ pid: process.pid }));
      expect(await reapOrphanMachines(st, ledger, () => {})).toBe(0);
      writeFileSync(join(dir, "acceptance.running"), JSON.stringify({ pid: 2 ** 22 }));
      expect(await reapOrphanMachines(st, ledger, () => {})).toBe(1);
      expect(deleted).toEqual(["m_pdf-toy-i0-g0"]);
      srvA.stop(true);
    } finally {
      delete process.env.TEST_IB_KEY;
    }
  });
});

// ── the drain-time walk (full integration over the fake machine lane) ───────

function makeWalkWorld(behavior: { acceptance?: () => string }): { w: World; port: number; openMachineFor: any } {
  const w = makeMachineWorld();
  const port = 18000 + (process.pid % 1500);
  w.cfg.scenario = { ports: [port, port + 1], runtime: "runtime.json", holdout: undefined as any };
  w.cfg.acceptance = { e2e: true, prd_check: true, security: false };
  writeFileSync(
    join(w.stateDir, "repos", "toy", "runtime.json"),
    JSON.stringify({
      name: "runtime",
      port,
      start: "python3 -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1",
      readiness_path: "/",
      probes: [{ id: "root", description: "serves", command: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/", expect: "status:200" }],
    })
  );
  const openMachineFor = (c: any, _log?: any) => new FakeMachine(w, c, 0, 0, behavior); // the constructor registers itself on w.machines
  return { w, port, openMachineFor };
}

describe("runPrdAcceptance (the drain-time walk, fake machine lane)", () => {
  test("no prd.md → the walk refuses with a reason, files nothing", async () => {
    const { w, openMachineFor } = makeWalkWorld({ acceptance: () => "VERDICT: DELIVERED" });
    const r = await runPrdAcceptance(w.cfg, { stateDir: w.stateDir, gh: w.gh, ledger: w.ledger, openMachine: openMachineFor, log: () => {} });
    expect(r.ran).toBe(false);
    expect(r.reason).toContain("no prd.md");
    expect(r.filed).toEqual([]);
  });

  slowTest("a GAPS verdict files [prd-gap] issues, records FAIL, destroys the machine", async () => {
    const { w, openMachineFor } = makeWalkWorld({
      acceptance: () =>
        "I walked the PRD.\n\nGAPS:\n- home page :: the /about page the PRD names is missing :: major :: loaded / and saw no link\n- dark mode :: theme toggle not implemented :: minor :: no toggle visible\nVERDICT: GAPS",
    });
    mkdirSync(join(w.stateDir, "repos", "toy"), { recursive: true });
    writeFileSync(prdPath(w.stateDir, "toy"), "# PRD\n\n- home page with an /about link\n- dark mode toggle\n");
    const r = await runPrdAcceptance(w.cfg, { stateDir: w.stateDir, gh: w.gh, ledger: w.ledger, openMachine: openMachineFor, log: () => {} });
    expect(r.ran).toBe(true);
    expect(r.pass).toBe(false);
    expect(r.filed.length).toBe(2);
    expect(w.gh.created.filter((c) => c.title.startsWith("[prd-gap]")).length).toBe(2);
    const gapIssue = w.gh.created.find((c) => c.title === "[prd-gap] home page");
    expect(gapIssue!.body).toContain("What is missing or wrong");
    expect(w.gh.issues.find((i) => i.number === gapIssue!.number)!.labels).toContain("prd-gap");
    const st = readAcceptanceState(w.stateDir, "toy");
    expect(st.last?.status).toBe("fail");
    expect(st.last?.summary).toContain("2 gap(s)");
    // the ledger recorded the acceptance stage (lap_id 0 sentinel)
    const stages = w.ledger.recentStages("acme/toy", 5).filter((s) => s.stage === "acceptance");
    expect(stages.length).toBe(1);
    expect(stages[0].exit).toBe("ok");
    // lifecycle hygiene: the marker is gone, the machine destroyed
    expect(existsSync(join(w.stateDir, "repos", "toy", "acceptance.running"))).toBe(false);
    expect(w.machines[0].destroyed).toBe(true);
  });

  slowTest("a DELIVERED verdict records a PASS bound to (gen, main head); the next call refuses as already-green", async () => {
    const { w, openMachineFor } = makeWalkWorld({ acceptance: () => "All deliverables verified.\n\nVERDICT: DELIVERED" });
    mkdirSync(join(w.stateDir, "repos", "toy"), { recursive: true });
    writeFileSync(prdPath(w.stateDir, "toy"), "# PRD\n\n- it serves\n");
    const deps = { stateDir: w.stateDir, gh: w.gh, ledger: w.ledger, openMachine: openMachineFor, log: () => {} };
    const r1 = await runPrdAcceptance(w.cfg, deps);
    expect(r1.pass).toBe(true);
    expect(r1.filed).toEqual([]);
    const st = readAcceptanceState(w.stateDir, "toy");
    expect(st.last?.status).toBe("pass");
    expect(st.last?.main_head).toBeTruthy();
    const machinesBefore = w.machines.length;
    const r2 = await runPrdAcceptance(w.cfg, deps);
    expect(r2.ran).toBe(false);
    expect(r2.reason).toContain("already DELIVERED");
    expect(w.machines.length).toBe(machinesBefore); // no second boot
  });

  slowTest("an unparsable walk text fails closed: FAIL recorded, no issues", async () => {
    const { w, openMachineFor } = makeWalkWorld({ acceptance: () => "the app seems mostly there, nice work overall" });
    mkdirSync(join(w.stateDir, "repos", "toy"), { recursive: true });
    writeFileSync(prdPath(w.stateDir, "toy"), "# PRD\n\n- it serves\n");
    const r = await runPrdAcceptance(w.cfg, { stateDir: w.stateDir, gh: w.gh, ledger: w.ledger, openMachine: openMachineFor, log: () => {} });
    expect(r.ran).toBe(true);
    expect(r.pass).toBe(false);
    expect(r.summary).toContain("no parsable verdict");
    expect(w.gh.created.length).toBe(0);
    expect(readAcceptanceState(w.stateDir, "toy").last?.status).toBe("fail");
  });

  slowTest("the daily cap blocks the third automatic run; force bypasses it", async () => {
    const { w, openMachineFor } = makeWalkWorld({ acceptance: () => "nothing parsed here" });
    mkdirSync(join(w.stateDir, "repos", "toy"), { recursive: true });
    writeFileSync(prdPath(w.stateDir, "toy"), "# PRD\n\n- it serves\n");
    const deps = { stateDir: w.stateDir, gh: w.gh, ledger: w.ledger, openMachine: openMachineFor, log: () => {} };
    expect((await runPrdAcceptance(w.cfg, deps)).ran).toBe(true);
    expect((await runPrdAcceptance(w.cfg, deps)).ran).toBe(true);
    const r3 = await runPrdAcceptance(w.cfg, deps);
    expect(r3.ran).toBe(false);
    expect(r3.reason).toContain("daily acceptance cap");
    const r4 = await runPrdAcceptance(w.cfg, deps, { force: true });
    expect(r4.ran).toBe(true); // manual runs bypass the cap
  });
});

describe("maybeDrainAcceptance (the end-of-project gate)", () => {
  test("starved ≠ drained: open product issues stop the walk", async () => {
    const { w, openMachineFor } = makeWalkWorld({ acceptance: () => "VERDICT: DELIVERED" });
    mkdirSync(join(w.stateDir, "repos", "toy"), { recursive: true });
    writeFileSync(prdPath(w.stateDir, "toy"), "# PRD\n\n- it serves\n");
    w.gh.issues = [{ number: 5, title: "future feature", body: "", labels: [] }]; // open product issue
    await maybeDrainAcceptance(w.cfg, w.stateDir, { gh: w.gh, ledger: w.ledger, openMachineFor });
    expect(w.machines.length).toBe(0); // nothing booted
  });

  slowTest("drained + due → the walk runs once; a recorded PASS keeps later ticks quiet", async () => {
    const { w, openMachineFor } = makeWalkWorld({ acceptance: () => "VERDICT: DELIVERED" });
    mkdirSync(join(w.stateDir, "repos", "toy"), { recursive: true });
    writeFileSync(prdPath(w.stateDir, "toy"), "# PRD\n\n- it serves\n");
    const deps = { gh: w.gh, ledger: w.ledger, openMachineFor };
    await maybeDrainAcceptance(w.cfg, w.stateDir, deps);
    expect(w.machines.length).toBe(1);
    expect(readAcceptanceState(w.stateDir, "toy").last?.status).toBe("pass");
    await maybeDrainAcceptance(w.cfg, w.stateDir, deps);
    expect(w.machines.length).toBe(1); // already DELIVERED on this main
  });

  test("deferred-class issues (discovery/security/minor/prd-gap minors) do not block the walk", () => {
    expect(openIssuesAllDeferred([{ labels: ["discovery", "minor"] }, { labels: ["security"] }, { labels: ["prd-gap", "minor"] }, { labels: [] }])).toBe(false); // a bare label-less issue is product work
    expect(
      openIssuesAllDeferred([{ labels: ["discovery", "minor"] }, { labels: ["security"] }, { labels: ["prd-gap", "minor"] }])
    ).toBe(true);
    expect(openIssuesAllDeferred([])).toBe(true);
  });
});

describe("runPostMergeExtras — the per-merge e2e regression (fake machine lane)", () => {
  slowTest("the acceptance machine carries the janitor marker for its whole lifetime", async () => {
    const { w, openMachineFor } = makeWalkWorld({ acceptance: () => "VERDICT: DELIVERED" });
    // an authored suite (the walk normally authors it) — its in-box run will
    // fail here (no toolchain), which is exactly the filing path we exercise
    const suiteDir = join(w.stateDir, "repos", "toy", "e2e");
    mkdirSync(suiteDir, { recursive: true });
    writeFileSync(join(suiteDir, "home.e2e.ts"), "test('home', async () => {});");
    const markerPath = join(w.stateDir, "repos", "toy", "acceptance.running");
    const markerDuringBoot: boolean[] = [];
    const wrapped = (c: any, log?: any) => {
      const m = openMachineFor(c, log) as FakeMachine;
      const orig = m.ensure.bind(m);
      m.ensure = async () => {
        markerDuringBoot.push(existsSync(markerPath));
        return orig();
      };
      return m;
    };
    const lines: string[] = [];
    const extra = await runPostMergeExtras(w.cfg, w.gh, { stateDir: w.stateDir, pr: 42, openMachineFor: wrapped });
    lines.push(extra);
    expect(markerDuringBoot.length).toBeGreaterThan(0);
    expect(markerDuringBoot.every(Boolean)).toBe(true); // protected while booting
    expect(existsSync(markerPath)).toBe(false); // and the marker is gone after
    expect(w.machines.every((m) => m.destroyed)).toBe(true);
    // the failing suite filed its deduped regression issue (report-only)
    expect(w.gh.created.filter((c) => c.title.startsWith("[e2e-regression]")).length).toBe(1);
    expect(extra).toContain("e2e regression");
  });
});

// ── prompts ─────────────────────────────────────────────────────────────────

describe("prioritizeDiscoveries + the acceptance classes", () => {
  const issue = (n: number, labels: string[]) => ({ number: n, title: `issue ${n}`, body: "", labels });
  test("security joins majors at the front; prd-gap majors are product; minors defer", async () => {
    const { prioritizeDiscoveries } = await import("../src/stages/intake");
    const cfg = parseRepoConfig({ repo: "acme/toy", models: { default: { provider: "x", model: "y" } } }, "t");
    const gh = new FakeGh();
    const claimable = [
      issue(1, []), // product
      issue(2, ["security"]), // security major → front
      issue(3, ["discovery"]), // discovery major → front
      issue(4, ["prd-gap"]), // prd-gap major → product class (it IS the roadmap)
      issue(5, ["prd-gap", "minor"]), // minor → deferred
      issue(6, ["security", "minor"]), // minor → deferred
    ];
    const ordered = await prioritizeDiscoveries(cfg, claimable as any, {} as any, gh as any);
    expect(ordered.map((i: any) => i.number)).toEqual([2, 3, 1, 4]); // majors, then product; minors held back
  });
  test("with only deferred-class issues left, they flow (minors after majors)", async () => {
    const { prioritizeDiscoveries } = await import("../src/stages/intake");
    const cfg = parseRepoConfig({ repo: "acme/toy", models: { default: { provider: "x", model: "y" } } }, "t");
    const claimable = [issue(7, ["prd-gap", "minor"]), issue(8, ["security"])];
    const ordered = await prioritizeDiscoveries(cfg, claimable as any, {} as any, {} as any);
    expect(ordered.map((i: any) => i.number)).toEqual([8, 7]);
  });
});

describe("the npm client's acceptance verbs", () => {
  test("registered with usage help and required arity", async () => {
    const { run } = await import("../cli/bin/dark-factory.js");
    const help: string[] = [];
    expect(await run(["acceptance", "--help"], { ...silence(), out: (s) => help.push(String(s)) })).toBe(0);
    expect(help.join("\n")).toContain("prd-gap");
    expect(await run(["acceptance"], silence())).toBe(2); // missing SLUG (usage)
    expect(await run(["prd", "toy"], silence())).toBe(1); // missing --prd-file (error)
    expect(await run(["security-scan"], silence())).toBe(2);
    expect(await run(["host-tools", "--help"], { ...silence(), out: (s) => help.push(String(s)) })).toBe(0);
    expect(help.join("\n")).toContain("penthera");
  });
});

describe("buildAcceptancePrompt", () => {
  test("carries the PRD, the URL, the toolchain symlink line and the output contract", () => {
    const cfg = parseRepoConfig({ repo: "acme/toy", models: { default: { provider: "x", model: "y" } } }, "t");
    const p = buildAcceptancePrompt(cfg, {
      prd: "# PRD\n\n- deliverable",
      url: "http://127.0.0.1:8123",
      suiteSummary: "suite passed: 3 passed, 0 failed",
      outDir: "/tmp/out",
      authoring: false,
      inBox: true,
    });
    expect(p).toContain("# PRD");
    expect(p).toContain("http://127.0.0.1:8123");
    expect(p).toContain("VERDICT: DELIVERED");
    expect(p).toContain("Last deterministic run: suite passed: 3 passed, 0 failed");
    // the authoring branch names the LANE's toolchain path
    const p2 = buildAcceptancePrompt(cfg, { prd: "x", url: "u", suiteSummary: "s", outDir: "/o", authoring: true, inBox: true });
    expect(p2).toContain("AUTHOR one this run");
    expect(p2).toContain(boxToolchainDir());
    const p3 = buildAcceptancePrompt(cfg, { prd: "x", url: "u", suiteSummary: "s", outDir: "/o", authoring: true, inBox: false });
    expect(p3).toContain(hostToolchainDir());
  });
});

// silence the unused import for the security-scan runner (its fail-closed
// path is exercised by the parsers above; a live npx run stays a manual check)
void runSecurityScan;
void silence;
