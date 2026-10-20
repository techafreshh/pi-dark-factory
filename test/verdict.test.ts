import { describe, expect, test } from "bun:test";
import { parsePlan } from "../src/stages/plan";
import { parseVerdict } from "../src/stages/review";

describe("parsePlan (lenient — no schema demanded from the model)", () => {
  test("plan text passes through", () => {
    const p = parsePlan("# Plan\n1. touch files\n2. write tests");
    expect(p.kind).toBe("plan");
    expect(p.plan).toContain("# Plan");
  });
  test("NO_ACTION first line with reason", () => {
    const p = parsePlan("NO_ACTION: this is roadmap meta-work, no code change needed\n\nextra lines");
    expect(p.kind).toBe("no_action");
    expect(p.reason).toContain("roadmap meta-work");
  });
  test("NO_ACTION without colon still parses", () => {
    expect(parsePlan("no action, tracker only").kind).toBe("no_action");
  });
  test("INSUFFICIENT_CONTEXT first line → question + everything after as assumptions", () => {
    const p = parsePlan(
      "INSUFFICIENT_CONTEXT: which SSO provider should be used?\n\nWould assume: keycloak, org-only login\nmore prose"
    );
    expect(p.kind).toBe("insufficient_context");
    expect(p.question).toContain("SSO provider");
    expect(p.assumptions).toContain("Would assume");
  });
  test("INSUFFICIENT_CONTEXT without colon still parses, with a fallback question", () => {
    const p = parsePlan("insufficient context entirely unclear");
    expect(p.kind).toBe("insufficient_context");
    expect(p.question).toContain("unclear");
  });
  test("a plan mentioning insufficient context in prose is still a plan", () => {
    expect(parsePlan("# Plan\nif this runs out we flag insufficient context later").kind).toBe("plan");
  });
});

describe("parseVerdict (lenient, fail-closed)", () => {
  test("explicit verdict line, case-insensitive", () => {
    expect(parseVerdict("VERDICT: APPROVE\nAll good.").verdict).toBe("approve");
    expect(parseVerdict("verdict: reject\n1. broken test").verdict).toBe("reject");
  });
  test("bare APPROVE/REJECT on the first line", () => {
    expect(parseVerdict("APPROVE\nfindings none").verdict).toBe("approve");
    expect(parseVerdict("Reject\nmissing tests").verdict).toBe("reject");
  });
  test("findings exclude the verdict line", () => {
    const v = parseVerdict("VERDICT: REJECT\n1. auth path untested\n2. no error handling");
    expect(v.verdict).toBe("reject");
    expect(v.findings).toContain("auth path untested");
    expect(v.findings).not.toContain("VERDICT");
  });
  test("prose without a verdict is unparseable (never a silent approve)", () => {
    expect(parseVerdict("I think this looks quite good overall, ship it.").verdict).toBe("unparseable");
  });
});
