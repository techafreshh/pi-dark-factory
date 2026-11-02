import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger";

// the dashboard module reads STATE_DIR at import — point it at a tmp dir
process.env.DASHBOARD_STATE_DIR = mkdtempSync(join(tmpdir(), "pdfdash-"));
const { computeSummary } = await import("../bin/dashboard");

describe("computeSummary (read-only telemetry)", () => {
  const led = new Ledger(":memory:");
  const R1 = "techafreshh/alpha";
  const R2 = "techafreshh/beta";

  // in-progress lap with stages (one running, one done)
  led.claim(R1, 5); // claim creates the ledger row; setIssue patches it
  led.setIssue(R1, 5, { state: "in_progress", attempts: 2, pr: 12 });
  const lap1 = led.startLap(R1, 5);
  const s1 = led.startStage(R1, 5, lap1, "implement", 1, "m/x");
  led.endStage(s1, "ok", { input_tokens: 1000, output_tokens: 500 });
  led.startStage(R1, 5, lap1, "review", 1, "m/y"); // left open = currently running

  // merged lap with tokens
  led.claim(R2, 9);
  led.setIssue(R2, 9, { state: "merged", attempts: 1 });
  const lap2 = led.startLap(R2, 9);
  const s2 = led.startStage(R2, 9, lap2, "plan", 1, "m/x");
  led.endStage(s2, "ok", { input_tokens: 2000, output_tokens: 800 });
  led.endLap(lap2, "merged", "PR #1");

  // blocked row with an error signature
  led.claim(R2, 11);
  led.setIssue(R2, 11, { state: "blocked", attempts: 3, last_error: "no commits ahead of base" });

  const dir = process.env.DASHBOARD_STATE_DIR!;
  mkdirSync(join(dir, "repos", "alpha"), { recursive: true });
  writeFileSync(join(dir, "repos", "alpha", "config.json"), JSON.stringify({ repo: R1 }));
  writeFileSync(join(dir, "repos", "alpha", "paused"), "");

  const s = computeSummary(led.db);

  test("in-progress lap shows its issue, PR, and the currently-running stage", () => {
    expect(s.in_progress.length).toBe(1);
    const lap = s.in_progress[0];
    expect(lap.repo).toBe(R1);
    expect(lap.issue_number).toBe(5);
    expect(lap.pr).toBe(12);
    expect(lap.last_stage.stage).toBe("review");
    expect(lap.last_stage.ended_at).toBeNull(); // still running ▸
  });

  test("tokens aggregate by project across stages", () => {
    const byRepo = new Map(s.tokens_by_project.map((r) => [r.repo, r]));
    expect(byRepo.get(R1).i).toBe(1000);
    expect(byRepo.get(R1).o).toBe(500);
    expect(byRepo.get(R2).o).toBe(800);
  });

  test("tokens roll up per lap with stage counts", () => {
    const byLap = new Map(s.tokens_by_lap.map((r) => [r.lap_id, r]));
    expect(byLap.get(lap1).stages).toBe(2);
    expect(byLap.get(lap2).o).toBe(800);
  });

  test("blocked rows surface their error signature; paused slugs come from the state dir", () => {
    expect(s.blocked.length).toBe(1);
    expect(s.blocked[0].last_error).toBe("no commits ahead of base");
    expect(s.paused).toEqual(["alpha"]);
    expect(Object.keys(s.slugs)).toContain(R1);
  });

  test("daily trend and throughput cover today", () => {
    const today = new Date().toISOString().slice(0, 10);
    const day = s.tokens_by_day.find((r) => r.day === today);
    expect(day.i).toBe(3000);
    const merged = s.merges_per_day.find((r) => r.repo === R2);
    expect(merged.n).toBe(1);
  });
});
