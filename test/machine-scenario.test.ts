import { afterAll, describe, expect, test } from "bun:test";
import { runScenarioInMachine, type ScenarioSpec } from "../src/scenario";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratchRoot = mkdtempSync(join(tmpdir(), "pdfscnm-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

describe("runScenarioInMachine (in-box exec channel — no ssh -L, bi-ai-ui 2026-10-26)", () => {
  test("readiness + probes + teardown all run over the exec channel: green path", async () => {
    const dir = mkdtempSync(join(scratchRoot, "machine-"));
    // fake ssh: runs the "remote" command locally (the machine-mode tick
    // tests use the same pattern) — the exec channel becomes local bash
    const sshPath = join(dir, "fake-ssh");
    writeFileSync(sshPath, '#!/usr/bin/env bash\nfor a in "$@"; do CMD="$a"; done\nexec bash -c "$CMD"\n');
    chmodSync(sshPath, 0o755);
    const oldSsh = process.env.PDF_SSH_BIN;
    process.env.PDF_SSH_BIN = sshPath;
    try {
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
        { ssh: async () => ({ host: "127.0.0.1", port: 2222, user: "fake" }), repoDir: dir },
        { readinessSeconds: 20, defaultProbeMs: 8000, key: "testm", reservedPorts: [port] }
      );
      expect(result.pass).toBe(true);
      expect(result.results[0].pass).toBe(true);
    } finally {
      if (oldSsh === undefined) delete process.env.PDF_SSH_BIN;
      else process.env.PDF_SSH_BIN = oldSsh;
    }
  }, 60000);

  test("a server that never comes up reports ITSELF as down — no host mapping exists to blame", async () => {
    const dir = mkdtempSync(join(scratchRoot, "machine-dead-"));
    const sshPath = join(dir, "fake-ssh");
    writeFileSync(sshPath, '#!/usr/bin/env bash\nfor a in "$@"; do CMD="$a"; done\nexec bash -c "$CMD"\n');
    chmodSync(sshPath, 0o755);
    const oldSsh = process.env.PDF_SSH_BIN;
    process.env.PDF_SSH_BIN = sshPath;
    try {
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
        { ssh: async () => ({ host: "127.0.0.1", port: 2222, user: "fake" }), repoDir: dir },
        { readinessSeconds: 6, defaultProbeMs: 4000, key: "testdead", reservedPorts: [port] }
      );
      expect(result.pass).toBe(false);
      expect(result.error).toContain("its OWN loopback inside the machine");
    } finally {
      if (oldSsh === undefined) delete process.env.PDF_SSH_BIN;
      else process.env.PDF_SSH_BIN = oldSsh;
    }
  }, 60000);
});
