import { afterAll, describe, expect, test } from "bun:test";
import { runScenarioInMachine, type ScenarioSpec, type MachineScenarioTarget } from "../src/scenario";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "../src/sh";

const scratchRoot = mkdtempSync(join(tmpdir(), "pdfscnm-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

/** The transport seam as the lap machine now presents it: bash(script, ms).
 *  The fake runs the "remote" script locally — the same pattern the
 *  machine-mode tick tests use via PDF_SSH_BIN, but through the new seam. */
function localBashTarget(repoDir: string): MachineScenarioTarget {
  return {
    bash: async (script: string, timeoutMs?: number) => {
      const res = await sh(["bash", "-c", script], { input: "", timeoutMs: timeoutMs ?? 600000 });
      return { code: res.code, stdout: res.stdout, stderr: res.stderr, timedOut: res.timedOut };
    },
    repoDir,
  };
}

describe("runScenarioInMachine (in-box exec channel — no ssh -L, bi-ai-ui 2026-10-26)", () => {
  test("readiness + probes + teardown all run over the bash seam: green path", async () => {
    const dir = mkdtempSync(join(scratchRoot, "machine-"));
    const picker = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = picker.port;
    picker.stop(true);
    const spec: ScenarioSpec = {
      name: "runtime-machine",
      port,
      start: "python3 -m http.server $PORT --bind 127.0.0.1",
      readiness_path: "/",
      probes: [
        {
          id: "root-200",
          description: "root answers 200",
          command: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/",
          expect: "status:200 max_ms:8000",
        },
      ],
    };
    const result = await runScenarioInMachine(
      spec,
      localBashTarget(dir),
      { readinessSeconds: 20, defaultProbeMs: 8000, key: "testm", reservedPorts: [port] }
    );
    expect(result.pass).toBe(true);
    expect(result.results[0].pass).toBe(true);
  }, 60000);

  test("a server that never comes up reports ITSELF as down — no host mapping exists to blame", async () => {
    const dir = mkdtempSync(join(scratchRoot, "machine-dead-"));
    const picker = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = picker.port;
    picker.stop(true);
    const spec: ScenarioSpec = {
      name: "runtime-machine",
      port,
      start: "sleep 300", // listens on nothing
      probes: [],
    };
    const result = await runScenarioInMachine(
      spec,
      localBashTarget(dir),
      { readinessSeconds: 6, defaultProbeMs: 4000, key: "testdead", reservedPorts: [port] }
    );
    expect(result.pass).toBe(false);
    expect(result.error).toContain("its OWN loopback inside the machine");
  }, 60000);
});
