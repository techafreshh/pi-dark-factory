import { afterAll, describe, expect, test } from "bun:test";
import { evalExpects, parseMaxMs, portBusy, runScenario, type ScenarioSpec } from "../src/scenario";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratchRoot = mkdtempSync(join(tmpdir(), "pdfscn-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

describe("evalExpects (probe language)", () => {
  test("status compares the last stdout line", () => {
    expect(evalExpects("junk\n200", 0, "status:200").pass).toBe(true);
    expect(evalExpects("404", 0, "status:200").pass).toBe(false);
  });
  test("json walks paths incl array indices; values lenient", () => {
    const out = JSON.stringify({ data: [{ name: "ok" }], live: true, count: 3 });
    expect(evalExpects(out, 0, "json:data[0].name=ok").pass).toBe(true);
    expect(evalExpects(out, 0, "json:live=true").pass).toBe(true);
    expect(evalExpects(out, 0, "json:count=3").pass).toBe(true);
    expect(evalExpects(out, 0, "json:count=4").pass).toBe(false);
    expect(evalExpects("not json", 0, "json:count=3").pass).toBe(false);
  });
  test("body_contains / body_matches", () => {
    expect(evalExpects("hello world", 0, "body_contains:world").pass).toBe(true);
    expect(evalExpects("hello world", 0, "body_contains:moon").pass).toBe(false);
    // token values are space-delimited — patterns must be space-free
    expect(evalExpects("404", 0, "body_matches:^[0-9]{3}$").pass).toBe(true);
    expect(evalExpects("500", 0, "body_matches:^[0-9]{3}$").pass).toBe(true);
    expect(evalExpects("x1", 0, "body_matches:^[0-9]{3}$").pass).toBe(false);
    expect(evalExpects("x", 0, "body_matches:[bad-regex").pass).toBe(false);
  });
  test("exit is implicit 0 and explicit overrides", () => {
    expect(evalExpects("200", 0, "status:200").pass).toBe(true);
    expect(evalExpects("200", 1, "status:200").pass).toBe(false);
    expect(evalExpects("x", 3, "exit:3").pass).toBe(true);
  });
  test("unknown tokens fail closed", () => {
    const r = evalExpects("x", 0, "wat:1");
    expect(r.pass).toBe(false);
    expect(r.failed).toContain("unknown expect token");
  });
  test("max_ms is parsed for the runner", () => {
    expect(parseMaxMs("status:200 max_ms:3000")).toBe(3000);
    expect(parseMaxMs("status:200")).toBeNull();
  });
});

describe("portBusy", () => {
  test("detects a live listener and a free port", async () => {
    const busyServer = Bun.serve({ port: 0, fetch: () => new Response("x") });
    expect(await portBusy(busyServer.port)).toBe(true);
    const probeServer = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const freePort = probeServer.port;
    probeServer.stop(true);
    expect(await portBusy(freePort)).toBe(false);
    busyServer.stop(true);
  });
});

describe("runScenario (real harness, python3 http server)", () => {
  test("green scenario: readiness + probes + authoritative teardown", async () => {
    const probeServer = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = probeServer.port;
    probeServer.stop(true);
    const spec: ScenarioSpec = {
      name: "runtime-test",
      port,
      start: "python3 -m http.server $PORT --bind 127.0.0.1",
      readiness_path: "/",
      probes: [
        {
          id: "root-200",
          description: "root answers 200",
          command: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/",
          expect: "status:200 max_ms:3000",
        },
        {
          id: "missing-404",
          description: "unknown path answers 404",
          command: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/nope",
          expect: "status:404",
        },
      ],
    };
    const result = await runScenario(spec, join(scratchRoot, "green"), {
      readinessSeconds: 15,
      defaultProbeMs: 5000,
    });
    expect(result.pass).toBe(true);
    expect(result.results.length).toBe(2);
    // authoritative teardown: the server's port is free again
    expect(await portBusy(port)).toBe(false);
  }, 30000);

  test("failing probes report details", async () => {
    const probeServer = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = probeServer.port;
    probeServer.stop(true);
    const spec: ScenarioSpec = {
      name: "fail-test",
      port,
      start: "python3 -m http.server $PORT --bind 127.0.0.1",
      readiness_path: "/",
      probes: [
        {
          id: "impossible",
          description: "expects a 999",
          command: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/",
          expect: "status:999",
        },
      ],
    };
    const result = await runScenario(spec, join(scratchRoot, "red"), {
      readinessSeconds: 15,
      defaultProbeMs: 5000,
    });
    expect(result.pass).toBe(false);
    expect(result.results[0].pass).toBe(false);
    expect(result.results[0].detail).toContain("status");
    expect(await portBusy(port)).toBe(false);
  }, 30000);

  test("busy port fails the scenario without running probes", async () => {
    const hog = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const spec: ScenarioSpec = {
      name: "busy-test",
      port: hog.port,
      start: "python3 -m http.server $PORT --bind 127.0.0.1",
      probes: [{ id: "p", description: "x", command: "echo 200", expect: "status:200" }],
    };
    const result = await runScenario(spec, join(scratchRoot, "busy"), {
      readinessSeconds: 5,
      defaultProbeMs: 2000,
    });
    expect(result.pass).toBe(false);
    expect(result.error).toContain("busy");
    hog.stop(true);
  });

  test("failing setup fails the scenario", async () => {
    const probeServer = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = probeServer.port;
    probeServer.stop(true);
    const spec: ScenarioSpec = {
      name: "setup-fail",
      port,
      setup: "exit 3",
      start: "python3 -m http.server $PORT --bind 127.0.0.1",
      probes: [{ id: "p", description: "x", command: "echo 200", expect: "status:200" }],
    };
    const result = await runScenario(spec, join(scratchRoot, "setup-fail"), {
      readinessSeconds: 5,
      defaultProbeMs: 2000,
    });
    expect(result.pass).toBe(false);
    expect(result.error).toContain("setup failed");
  });
});
