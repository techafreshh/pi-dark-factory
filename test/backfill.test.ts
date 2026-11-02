import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger";
import { backfill } from "../bin/backfill-usage";

describe("backfill (re-parse raw sessions, cache + cost aware)", () => {
  test("corrects input with cache, records cost, skips missing files and plan rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfbf-"));
    const R = "techafreshh/alpha";
    mkdirSync(join(dir, "repos", "alpha", "issues", "5"), { recursive: true });
    writeFileSync(join(dir, "repos", "alpha", "config.json"), JSON.stringify({ repo: R }));

    const led = new Ledger(join(dir, "factory.db")); // real schema + cost migration
    led.claim(R, 5);
    const lap = led.startLap(R, 5);
    // implement: has a raw file with the real muse shape (cache-dominant)
    const impl = led.startStage(R, 5, lap, "implement", 1, "m/x");
    led.endStage(impl, "ok", { input_tokens: 53313, output_tokens: 25355 }); // the old uncached value
    writeFileSync(
      join(dir, "repos", "alpha", "issues", "5", "implement-1.jsonl"),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input: 53313, output: 25355, cacheRead: 1105327, cacheWrite: 0, reasoning: 8973, cost: 0.42, totalTokens: 1185 },
        },
      }) + "\n"
    );
    // review: no raw file on disk → left as-is
    const rev = led.startStage(R, 5, lap, "review", 1, "m/x");
    led.endStage(rev, "ok", { input_tokens: 999, output_tokens: 111 });
    // plan: excluded from the backfill by design (no raw event file)
    const plan = led.startStage(R, 5, lap, "plan", 1, "m/x");
    led.endStage(plan, "ok", { input_tokens: 1, output_tokens: 2 });

    const res = backfill(led.db, dir);
    expect(res).toEqual({ total: 2, fixed: 1, unchanged: 0, missing: 1, nousage: 0, norepo: 0 });

    const rows = led.recentStages(R, 10);
    const byStage = new Map(rows.map((r) => [r.stage, r]));
    expect(byStage.get("implement")!.input_tokens).toBe(53313 + 1105327); // cache folded in
    expect(byStage.get("implement")!.cost).toBeCloseTo(0.42);
    expect(byStage.get("review")!.input_tokens).toBe(999); // untouched
    expect(byStage.get("plan")!.input_tokens).toBe(1); // plan is out of scope
  });

  test("a row already matching its raw file reports unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfbf2-"));
    const R = "techafreshh/beta";
    mkdirSync(join(dir, "repos", "beta", "issues", "2"), { recursive: true });
    writeFileSync(join(dir, "repos", "beta", "config.json"), JSON.stringify({ repo: R }));
    const led = new Ledger(join(dir, "factory.db"));
    led.claim(R, 2);
    const lap = led.startLap(R, 2);
    const s = led.startStage(R, 2, lap, "implement", 1, "m/x");
    led.endStage(s, "ok", { input_tokens: 100, output_tokens: 10, cost: 0.01 });
    writeFileSync(
      join(dir, "repos", "beta", "issues", "2", "implement-1.jsonl"),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [], usage: { input: 100, output: 10, cacheRead: 0, cost: 0.01 } },
      }) + "\n"
    );
    const res = backfill(led.db, dir);
    expect(res.fixed).toBe(0);
    expect(res.unchanged).toBe(1);
  });
});
