import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeVerifyEvidence } from "../src/stages/verify";

let dir: string | null = null;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe("writeVerifyEvidence (provenance sidecars, archon-steal #6)", () => {
  test("records shas, issue, and full probe evidence as JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "pdfev-"));
    const p = writeVerifyEvidence(dir, "toy", 3, {
      attempt: 1,
      pr: 7,
      worktreeHead: "a".repeat(40),
      prHead: "b".repeat(40),
      failures: [{ gate: "runtime", detail: "probe x failed" }],
      scenarios: [{ name: "runtime", pass: false, error: undefined, results: [{ id: "x", description: "d", pass: false, detail: "no match", command: "curl", body: "bad" }] }],
    });
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    expect(parsed.prHead).toBe("b".repeat(40));
    expect(parsed.worktreeHead).toBe("a".repeat(40));
    expect(parsed.issue).toBe(3);
    expect(parsed.pr).toBe(7);
    expect(parsed.failures[0].gate).toBe("runtime");
    expect(parsed.scenarios[0].results[0].body).toBe("bad");
    expect(parsed.recordedAt).toBeTruthy();
  });

  test("paths are unique per attempt AND per write — first failure evidence survives retries", () => {
    dir = mkdtempSync(join(tmpdir(), "pdfev-"));
    const data = { attempt: 1, pr: null, worktreeHead: null, prHead: null, failures: [], scenarios: [] } as const;
    const p1 = writeVerifyEvidence(dir, "toy", 1, { ...data, attempt: 1 });
    const p2 = writeVerifyEvidence(dir, "toy", 1, { ...data, attempt: 2 });
    const p3 = writeVerifyEvidence(dir, "toy", 1, { ...data, attempt: 1 });
    expect(new Set([p1, p2, p3]).size).toBe(3);
    expect(existsSync(p1) && existsSync(p2) && existsSync(p3)).toBe(true);
  });
});
