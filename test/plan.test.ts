import { describe, expect, test } from "bun:test";
import { parseRepoConfig } from "../src/config";
import { buildPlanPrompt } from "../src/stages/plan";
import { buildImplementPrompt } from "../src/stages/implement";

const cfg = parseRepoConfig({ repo: "acme/app", models: { default: { provider: "x", model: "y" } } }, "t");
const issue = { number: 7, title: "Add export", body: "## Problem\nx", labels: [] as string[] };

describe("buildPlanPrompt siblings (parallel lanes)", () => {
  test("serial prompts carry no sibling section and keep the oldest-first WHY", () => {
    const p = buildPlanPrompt(cfg, issue);
    expect(p).not.toContain("IN FLIGHT IN PARALLEL LANES");
    expect(p).toContain("oldest unclaimed issue");
    expect(buildPlanPrompt(cfg, issue, { siblings: [] })).not.toContain("IN FLIGHT");
  });
  test("parallel prompts list the in-flight siblings and the NO_ACTION escape for covered work", () => {
    const p = buildPlanPrompt(cfg, issue, { siblings: [{ number: 3, title: "Add import" }, { number: 4, title: "Add search" }] });
    expect(p).toContain("## IN FLIGHT IN PARALLEL LANES");
    expect(p).toContain("- #3 Add import");
    expect(p).toContain("- #4 Add search");
    expect(p).toContain("answer NO_ACTION and name it");
    expect(p).not.toContain("oldest unclaimed issue");
  });
});

describe("buildImplementPrompt", () => {
  test("rebasing is allowed only when the findings ask for it", () => {
    const p = buildImplementPrompt(cfg, issue, "PLAN", { attempt: 1, findings: null });
    expect(p).toContain("Do not rewrite history, except a rebase onto origin/main when the findings ask for one.");
    expect(p).toContain("the factory rebases your branch onto it before merging");
  });
});
