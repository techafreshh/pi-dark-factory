import { describe, expect, test } from "bun:test";
import { buildSlicerPrompt, filterNew, normalizeTitle, parseSlicerOutput } from "../src/slicer";

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
});
