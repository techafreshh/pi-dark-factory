import { describe, expect, test } from "bun:test";
import { Ledger } from "../src/ledger";

describe("Ledger (claim ledger — the anti-wedge source of truth)", () => {
  test("claim is once-only; re-claim impossible while a row exists", () => {
    const l = new Ledger(":memory:");
    expect(l.claim("acme/app", 5)).toBe(true);
    expect(l.claim("acme/app", 5)).toBe(false);
    expect(l.getIssue("acme/app", 5)?.state).toBe("in_progress");
  });

  test("rows are keyed per repo", () => {
    const l = new Ledger(":memory:");
    l.claim("acme/app", 5);
    expect(l.claim("other/tool", 5)).toBe(true);
    expect(l.listIssues().length).toBe(2);
  });

  test("patching and dropping", () => {
    const l = new Ledger(":memory:");
    l.claim("r", 1);
    l.setIssue("r", 1, { attempts: 2, last_error: "boom", pr: 7, branch: "factory/issue-1" });
    const row = l.getIssue("r", 1)!;
    expect(row.attempts).toBe(2);
    expect(row.last_error).toBe("boom");
    expect(row.pr).toBe(7);
    l.setIssue("r", 1, { state: "blocked" });
    expect(l.getIssue("r", 1)!.state).toBe("blocked");
    l.dropIssue("r", 1);
    expect(l.getIssue("r", 1)).toBeNull();
    expect(l.claim("r", 1)).toBe(true); // unblock → claimable again, fresh
  });

  test("laps and stage runs are recorded", () => {
    const l = new Ledger(":memory:");
    l.claim("r", 3);
    const lapId = l.startLap("r", 3);
    const stageId = l.startStage("r", 3, lapId, "implement", 1, "zai/glm");
    l.endStage(stageId, "ok", { input_tokens: 100, output_tokens: 50 });
    l.endLap(lapId, "merged", "PR #9");
    const lap = l.recentLaps("r", 5)[0];
    expect(lap.outcome).toBe("merged");
    expect(lap.detail).toBe("PR #9");
    const stage = l.recentStages("r", 5)[0];
    expect(stage.exit).toBe("ok");
    expect(stage.input_tokens).toBe(100);
    expect(stage.output_tokens).toBe(50);
  });
});
