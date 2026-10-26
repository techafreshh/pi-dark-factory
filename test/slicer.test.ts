import { describe, expect, test } from "bun:test";
import { buildSlicerPrompt, filterNew, graphProblems, normalizeTitle, parseSlicerOutput } from "../src/slicer";

const RAW = [
  "Some preamble prose from the model that must be ignored.",
  "",
  "TITLE: Make the product runnable end-to-end",
  "BODY: walking skeleton: clone → install → serve on PORT with a /healthz endpoint.",
  "",
  "---",
  "",
  "TITLE: Add login endpoint",
  "DEPENDS: 1",
  "POST /login with email+password; 200 with token; 401 on bad creds.",
  "",
  "---",
  "TITLE: Add rate limiting",
  "DEPENDS: 1, 2",
  "Token bucket, 429 after the limit.",
].join("\n");

describe("parseSlicerOutput", () => {
  test("parses blocks, depends, and skips prose preamble", () => {
    const sliced = parseSlicerOutput(RAW);
    expect(sliced.length).toBe(3);
    expect(sliced[0].title).toBe("Make the product runnable end-to-end");
    expect(sliced[0].dependsOn).toEqual([]);
    expect(sliced[1].dependsOn).toEqual([1]);
    expect(sliced[2].dependsOn).toEqual([1, 2]);
    expect(sliced[1].body).toContain("POST /login");
    // the DEPENDS line must not leak into the body
    expect(sliced[1].body).not.toContain("DEPENDS");
  });
  test("empty output parses to zero issues", () => {
    expect(parseSlicerOutput("no issues here")).toEqual([]);
  });
});

describe("graphProblems (create-time graph gate — magpie 8→8 / 13→13)", () => {
  test("a clean backward-only graph has no problems", () => {
    expect(graphProblems(parseSlicerOutput(RAW))).toEqual([]);
  });
  test("self-dependency is named", () => {
    const sliced = parseSlicerOutput("TITLE: A\nBODY x\n---\nTITLE: B\nDEPENDS: 2\nbody");
    const problems = graphProblems(sliced);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("issue 2");
    expect(problems[0]).toContain("depends on itself");
  });
  test("forward reference is named — deps must come EARLIER", () => {
    const sliced = parseSlicerOutput("TITLE: A\nDEPENDS: 2\nbody\n---\nTITLE: B\nbody");
    expect(graphProblems(sliced)[0]).toContain("forward-references issue 2");
  });
  test("out-of-range index is named", () => {
    const sliced = parseSlicerOutput("TITLE: A\nDEPENDS: 9\nbody");
    expect(graphProblems(sliced)[0]).toContain("out-of-range index 9");
  });
  test("multiple offenders are all reported, not just the first", () => {
    const sliced = [
      "TITLE: A", "DEPENDS: 4", "x", "---",
      "TITLE: B", "DEPENDS: 2", "x", "---",
      "TITLE: C", "x", "---",
      "TITLE: D", "DEPENDS: 3, 0", "x",
    ].join("\n");
    const slicedIssues = parseSlicerOutput(sliced);
    const problems = graphProblems(slicedIssues);
    expect(problems.length).toBe(3); // A→4 forward, B→2 self, D→0 below range
  });
});

describe("filterNew (dedup by normalized title)", () => {
  test("re-runs never duplicate", () => {
    const sliced = parseSlicerOutput(RAW);
    const existing = ["make the product runnable  end-to-end", "Add Login Endpoint"];
    const fresh = filterNew(sliced, existing);
    expect(fresh.map((s) => s.title)).toEqual(["Add rate limiting"]);
  });
  test("normalizeTitle collapses case and punctuation", () => {
    expect(normalizeTitle("Add Login-Endpoint!")).toBe(normalizeTitle("add login endpoint"));
  });
});

describe("buildSlicerPrompt", () => {
  test("carries the six brief elements and the bootstrap invariant", () => {
    const p = buildSlicerPrompt("MY PRD", 25);
    expect(p).toContain("PROBLEM:");
    expect(p).toContain("WHY NOW:");
    expect(p).toContain("INVARIANTS:");
    expect(p).toContain("ACCEPTANCE:");
    expect(p).toContain("runnable end-to-end");
    expect(p).toContain("MY PRD");
    expect(p).toContain("25");
  });
  test("demands Given/When/Then acceptance and honest dependencies", () => {
    const p = buildSlicerPrompt("MY PRD", 25);
    expect(p).toContain("Given/When/Then");
    expect(p).toContain("is not a dependency");
    expect(p).toContain("## Acceptance");
    expect(p).toContain("TITLE:");
    expect(p).toContain("DEPENDS:");
  });
});
