import { describe, expect, test } from "bun:test";
import { buildReviewPrompt } from "../src/stages/review";

const cfg = { default_branch: "main", pi: { web: { search: false, fetch: false } } } as any;

describe("review prompt (archon-steal #5 simplify lens)", () => {
  test("lens present, must name the smaller shape, and is calibrated to decline", () => {
    const p = buildReviewPrompt(cfg, { number: 1, title: "t", body: "b" }, { plan: "p", scenarioSummary: "s", attempt: 1 });
    expect(p).toContain("Simplify lens");
    expect(p).toContain("NAMES the smaller shape");
    expect(p).toContain("decline to flag when the structure is already earning its keep");
  });

  test("simplify findings never justify a REJECT on their own", () => {
    const p = buildReviewPrompt(cfg, { number: 1, title: "t", body: "b" }, { plan: "p", scenarioSummary: "s", attempt: 1 });
    expect(p).toContain("quality signals, never gates");
    expect(p).toContain("APPROVE and attach the MEDIUM findings");
  });

  test("verdict grammar untouched (first line still APPROVE|REJECT)", () => {
    const p = buildReviewPrompt(cfg, { number: 1, title: "t", body: "b" }, { plan: "p", scenarioSummary: "s", attempt: 1 });
    expect(p).toContain("First line exactly `VERDICT: APPROVE` or `VERDICT: REJECT`");
  });
});
