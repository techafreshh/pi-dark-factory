import { afterAll, describe, expect, test } from "bun:test";
import { evalExpects, parseMaxMs, portBusy, runScenario, runScenarioInMachine, type ScenarioSpec } from "../src/scenario";
import { killTree } from "../src/sh";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratchRoot = mkdtempSync(join(tmpdir(), "pdfscn-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

/** wait for a spawned hog process to actually hold its port */
async function hogListen(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await portBusy(port)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`hog never bound port ${port}`);
}

describe("evalExpects (probe language)", () => {
  test("status compares the last stdout line", () => {
    expect(evalExpects("junk\n200", 0, "status:200").pass).toBe(true);
    expect(evalExpects("404", 0, "status:200").pass).toBe(false);
  });
  test("status_in accepts a one-of code set — '200 or 404, never 5xx'", () => {
    expect(evalExpects("200", 0, "status_in:200,404").pass).toBe(true);
    expect(evalExpects("404", 0, "status_in:200,404").pass).toBe(true);
    expect(evalExpects("500", 0, "status_in:200,404").pass).toBe(false);
    // the failed verdict names the alternatives
    const r = evalExpects("500", 0, "status_in:200,404");
    expect(r.failed).toContain("want one of 200|404");
    // junk stdout is still junk
    expect(evalExpects("{body}", 0, "status_in:200,404").pass).toBe(false);
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

  // Both hog tests spawn their listener OUTSIDE the test process: the
  // harness's stray-port reclaim (fuser -k) kills socket owners by pid, so an
  // in-process Bun.serve hog would make the reclaim SIGKILL the test runner
  // itself (the old in-process hog test died exactly that way, exit 137).

  test("a reclaimable stray on the port is killed and the scenario still runs", async () => {
    const probeServer = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = probeServer.port;
    probeServer.stop(true);
    const hog = Bun.spawn(["python3", "-m", "http.server", String(port), "--bind", "127.0.0.1"], {
      cwd: scratchRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    await hogListen(port);
    const spec: ScenarioSpec = {
      name: "reclaim-test",
      port,
      start: "python3 -m http.server $PORT --bind 127.0.0.1",
      readiness_path: "/",
      probes: [
        {
          id: "root-200",
          description: "root answers 200",
          command: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/",
          expect: "status:200",
        },
      ],
    };
    try {
      const result = await runScenario(spec, join(scratchRoot, "reclaim"), {
        readinessSeconds: 15,
        defaultProbeMs: 5000,
      });
      // the reclaim fuser -k'd the stray, so the scenario's own server took the port
      expect(result.pass).toBe(true);
      expect(result.results[0].pass).toBe(true);
      expect(hog.exitCode !== null || hog.signalCode !== null).toBe(true);
    } finally {
      try { hog.kill(9); } catch {}
    }
  }, 30000);

  test("an unreclaimable listener fails the scenario without running probes", async () => {
    const probeServer = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = probeServer.port;
    probeServer.stop(true);
    // a supervisor that respawns the server after every kill: the closest
    // thing to a foreign process the reclaim cannot put down
    const hog = Bun.spawn(
      ["setsid", "bash", "-c", `while true; do python3 -m http.server ${port} --bind 127.0.0.1 2>/dev/null; sleep 0.1; done`],
      { cwd: scratchRoot, stdout: "ignore", stderr: "ignore" }
    );
    await hogListen(port);
    const spec: ScenarioSpec = {
      name: "busy-test",
      port,
      start: "python3 -m http.server $PORT --bind 127.0.0.1",
      probes: [{ id: "p", description: "x", command: "echo 200", expect: "status:200" }],
    };
    try {
      const result = await runScenario(spec, join(scratchRoot, "busy"), {
        readinessSeconds: 5,
        defaultProbeMs: 2000,
      });
      expect(result.pass).toBe(false);
      expect(result.error).toContain("busy");
      // probes never ran
      expect(result.results[0].detail).toBe("not run");
    } finally {
      killTree(hog.pid!); // setsid: the whole respawn group dies with it
    }
  }, 30000);

  test("container wrap: setup/start/teardown run through the prefix, cleanup runs", async () => {
    const probeServer = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = probeServer.port;
    probeServer.stop(true);
    // passthrough wrapper stands in for a `docker compose run` prefix
    const wrapBin = join(scratchRoot, "wrap-exec.sh");
    writeFileSync(wrapBin, "#!/usr/bin/env bash\nexec \"$@\"\n");
    chmodSync(wrapBin, 0o755);
    let cleanedUp = false;
    const spec: ScenarioSpec = {
      name: "wrap-test",
      port,
      start: "python3 -m http.server $PORT --bind 127.0.0.1",
      readiness_path: "/",
      probes: [
        {
          id: "root-200",
          description: "root 200",
          command: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/",
          expect: "status:200 max_ms:3000",
        },
      ],
    };
    const result = await runScenario(spec, join(scratchRoot, "wrapped"), {
      readinessSeconds: 15,
      defaultProbeMs: 5000,
      wrap: {
        argvPrefix: [wrapBin],
        cleanup: async () => {
          cleanedUp = true;
        },
      },
    });
    expect(result.pass).toBe(true);
    expect(cleanedUp).toBe(true); // authoritative teardown in container mode
    expect(await portBusy(port)).toBe(false);
  }, 30000);

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
