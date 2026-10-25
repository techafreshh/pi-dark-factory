import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoReviveBlocked, bumpInputsEpoch } from "../src/tick";
import type { RepoConfig } from "../src/types";

interface Row {
  issue_number: number;
  state: string;
  attempts: number;
  last_error: string | null;
}

function fakeLedger(rows: Row[]) {
  const patches: { repo: string; n: number; patch: any }[] = [];
  return {
    rows,
    patches,
    listIssues(_repo: string) {
      return rows as any;
    },
    setIssue(repo: string, n: number, patch: any) {
      patches.push({ repo, n, patch });
      const r = rows.find((x) => x.issue_number === n);
      if (r) Object.assign(r, patch);
    },
  };
}

const cfg: RepoConfig = {
  repo: "acme/app",
  slug: "app",
  default_branch: "main",
  attempts: 3,
  merge: { method: "squash", required_checks: [], delete_branch: true },
  models: { default: { provider: "x", model: "y" } },
  timeouts: { stage_minutes: 30, checks_minutes: 30, readiness_seconds: 10, probe_ms: 1000 },
  scenario: { ports: [] },
  skip_labels: [],
  env: { mode: "host" },
  pi: { binary: "pi", tools: [], plan_tools: [], extra_args: [] },
} as any;

const blocked = (last_error: string): Row => ({
  issue_number: 1,
  state: "blocked",
  attempts: 3,
  last_error,
});

describe("autoReviveBlocked (bounded self-heal of exhausted laps)", () => {
  test("a fresh blocker revives: row back to open lane, receipts explain", () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfrev-"));
    const led = fakeLedger([blocked("review rejected: findings A")]);
    autoReviveBlocked(cfg, dir, led as any);
    expect(led.patches).toEqual([{ repo: "acme/app", n: 1, patch: { state: "in_progress", attempts: 0 } }]);
    expect(led.rows[0].state).toBe("in_progress");
  });

  test("identical failure signature twice in a row → third round refuses (stagnation)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfrev-"));
    const led = fakeLedger([blocked("implement stage failed: model produced no final text: Connection error.")]);
    autoReviveBlocked(cfg, dir, led as any); // revive 1
    led.rows[0] = blocked("implement stage failed: model produced no final text: Connection error.");
    autoReviveBlocked(cfg, dir, led as any); // revive 2 (signature repeats once)
    led.rows[0] = blocked("implement stage failed: model produced no final text: Connection error.");
    autoReviveBlocked(cfg, dir, led as any); // stagnation → refuse
    const revives = led.patches.filter((p: any) => p.patch?.state === "in_progress").length;
    expect(revives).toBe(2);
    expect(led.rows[0].state).toBe("blocked");
  });

  test("evolving failure signatures keep reviving until the daily cap, then refuse", () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfrev-"));
    const led = fakeLedger([blocked("gate A")]);
    for (let i = 0; i < 5; i++) {
      led.rows[0] = blocked(`gate finds ${i}`); // every round fails differently
      autoReviveBlocked(cfg, dir, led as any);
    }
    const revives = led.patches.filter((p: any) => p.patch?.state === "in_progress").length;
    expect(revives).toBe(3); // AUTO_REVIVE_DAILY_CAP
    expect(led.rows[0].state).toBe("blocked");
  });

  test("inputs-epoch: a scenario/config write resets the fuses — the world changed (P0-7)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfrev-"));
    const led = fakeLedger([blocked("holdout probe demands 404 for POST /api/rooms")]);
    for (let i = 0; i < 4; i++) {
      led.rows[0] = blocked(`gate finds ${i}`);
      autoReviveBlocked(cfg, dir, led as any);
    }
    // cap spent — tic-tac-toe #11 2026-10-25 sat here refusing identically
    let revives = led.patches.filter((p: any) => p.patch?.state === "in_progress").length;
    expect(revives).toBe(3);
    expect(led.rows[0].state).toBe("blocked");
    // the operator fixes the scenario → epoch bump → fresh budget + clean
    // stagnation history: the past no longer predicts the changed world
    bumpInputsEpoch(dir, "app");
    led.rows[0] = blocked("holdout probe demands 404 for POST /api/rooms");
    autoReviveBlocked(cfg, dir, led as any);
    revives = led.patches.filter((p: any) => p.patch?.state === "in_progress").length;
    expect(revives).toBe(4);
    expect(led.rows[0].state).toBe("in_progress");
  });
});
