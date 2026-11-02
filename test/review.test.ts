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

  test("DISCOVERIES contract carries the severity axis and the sibling rule", () => {
    const p = buildReviewPrompt(cfg, { number: 1, title: "t", body: "b" }, { plan: "p", scenarioSummary: "s", attempt: 1 });
    expect(p).toContain("- <short title> :: <one-line claim> :: <why it matters later> :: <major|minor>");
    expect(p).toContain("a bug a player/user of the CURRENT build can hit");
    expect(p).toContain("the same class of issue at an adjacent call site");
    expect(p).toContain("the Nth sibling of a class a previous fix already addressed, file it minor");
    expect(p).toContain("Pure observations with nothing to fix stay in your prose");
    expect(p).toContain("The cap is a ceiling, never a quota");
  });
});

describe("parseDiscoveries (archon-steal #4)", () => {
  test("parses the DISCOVERIES section into title/claim/why, max 10", () => {
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
    expect(d.length).toBe(4); // the "none" line drops
    expect(d[0]).toEqual({ title: "Cache the catalog", claim: "/api/catalog re-queries the DB per request", why: "will hurt once issue #4 adds filters", severity: "major" });
  });

  test("cap is 10: eleven items keep ten", () => {
    const items = Array.from({ length: 11 }, (_, i) => `- Item ${i + 1} :: claim ${i + 1} :: why ${i + 1}`);
    const d = parseDiscoveries("## DISCOVERIES (real, out-of-scope)\n" + items.join("\n"));
    expect(d.length).toBe(10);
    expect(d[9].title).toBe("Item 10");
  });

  test("bare header without ## hashes still parses (the jetpack #23–26 shape)", () => {
    const text = [
      "VERDICT: APPROVE",
      "",
      "What's good: minimal plain-text files exactly per plan.",
      "",
      "Acceptance coverage:",
      "- MET — boot scene exists.",
      "",
      "DISCOVERIES (real, out-of-scope):",
      "- Probe answers only GET, HEAD/POST get 501 :: only `do_GET` is defined in probe_server.py:22 :: matters if verification ever uses HEAD checks.",
      "- Probe crashes with traceback on occupied port :: ThreadingHTTPServer has no EADDRINUSE handling :: matters for parallel laps sharing the port.",
      "- Generated boot.gd.uid is untracked noise :: git status shows ?? jetpack/scripts/boot.gd.uid :: matters for keeping future diffs clean.",
      "",
      "",
    ].join("\n");
    const d = parseDiscoveries(text);
    expect(d.length).toBe(3);
    // recorded real reviewer shape (jetpack #23–26): 3-part bullets with no
    // severity field — those predate the severity axis and must keep parsing,
    // defaulting to major (the old behavior) rather than deferring to the tail
    expect(d[0]).toEqual({ title: "Probe answers only GET, HEAD/POST get 501", claim: "only `do_GET` is defined in probe_server.py:22", why: "matters if verification ever uses HEAD checks.", severity: "major" });
    expect(d[2].title).toBe("Generated boot.gd.uid is untracked noise");
  });

  test("severity rides the 4th :: field — minor and major", () => {
    const text = [
      "VERDICT: APPROVE",
      "DISCOVERIES (real, out-of-scope)",
      "- Dead-dummy corpses linger in group :: blast iterates them :: waste :: minor",
      "- Player motion unfrozen after end_run :: no run-active gate in _physics_process :: the run never freezes :: major",
    ].join("\n");
    const d = parseDiscoveries(text);
    expect(d.map((x) => x.severity)).toEqual(["minor", "major"]);
  });

  test("unparseable or missing severity fails OPEN to major (never silently defers a find)", () => {
    const text = [
      "VERDICT: APPROVE",
      "DISCOVERIES (real, out-of-scope)",
      "- One :: claim :: why :: severe",
      "- Two :: claim :: why ::",
      "- Three :: claim :: why",
    ].join("\n");
    const d = parseDiscoveries(text);
    expect(d.map((x) => x.severity)).toEqual(["major", "major", "major"]);
  });

  test("trailing flush-left prose after the bullets cannot leak into the harvest", () => {
    const text = [
      "DISCOVERIES (real, out-of-scope)",
      "- Real one :: claim :: why",
      "Notes: the section above ends here — the dashes in this prose",
      "- if a line below Notes started with a dash it must NOT be harvested",
    ].join("\n");
    const d = parseDiscoveries(text);
    expect(d.length).toBe(1);
    expect(d[0].title).toBe("Real one");
  });

  test("missing or empty section yields nothing", () => {
    expect(parseDiscoveries("VERDICT: APPROVE\njust findings")).toEqual([]);
    expect(parseDiscoveries("## DISCOVERIES (real, out-of-scope)\nnone")).toEqual([]);
    expect(parseDiscoveries("DISCOVERIES (real, out-of-scope)\n- none")).toEqual([]);
  });
});
