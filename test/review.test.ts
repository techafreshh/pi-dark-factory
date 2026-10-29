import { describe, expect, test } from "bun:test";
import { buildReviewPrompt, parseDiscoveries } from "../src/stages/review";

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

describe("parseDiscoveries (archon-steal #4)", () => {
  test("parses the DISCOVERIES section into title/claim/why, max 5", () => {
    const text = [
      "VERDICT: APPROVE",
      "reasoning here",
      "## DISCOVERIES (real, out-of-scope)",
      "- Cache the catalog :: /api/catalog re-queries the DB per request :: will hurt once issue #4 adds filters",
      "- Dup helper :: escapeText exists twice in src/render.ts :: merge them",
      "- none",
      "- Fifth :: too many :: ignored",
      "- Sixth :: over the cap :: dropped",
    ].join("\n");
    const d = parseDiscoveries(text);
    expect(d.length).toBe(4); // the "none" line drops, cap 5 applies after filtering
    expect(d[0]).toEqual({ title: "Cache the catalog", claim: "/api/catalog re-queries the DB per request", why: "will hurt once issue #4 adds filters" });
  });

  test("missing or empty section yields nothing", () => {
    expect(parseDiscoveries("VERDICT: APPROVE\njust findings")).toEqual([]);
    expect(parseDiscoveries("## DISCOVERIES (real, out-of-scope)\nnone")).toEqual([]);
  });
});
