import { describe, expect, test } from "bun:test";
import { labelNames } from "../src/gh";

describe("labelNames (gh boundary normalization)", () => {
  test("the real gh shape — label objects — normalizes to names", () => {
    // verbatim from `gh issue list --json labels` (sigkill, 2026-11-01):
    // before this fix, .includes("discovery") against these objects never
    // matched, so discovery promotion, skip_labels, and needs-info were all
    // silently dead in production
    const real = [
      { id: "LA_kwDOVfFmqc8AAAADAgm0Kw", name: "discovery", description: "", color: "5319e5" },
    ];
    expect(labelNames(real)).toEqual(["discovery"]);
  });

  test("string entries (test fakes) pass through", () => {
    expect(labelNames(["discovery", "held"])).toEqual(["discovery", "held"]);
  });

  test("mixed shapes, junk, and non-arrays never explode", () => {
    expect(labelNames([{ name: "a" }, "b", { id: "no-name" }, null, 42])).toEqual(["a", "b"]);
    expect(labelNames(undefined)).toEqual([]);
    expect(labelNames("discovery")).toEqual([]);
    expect(labelNames([])).toEqual([]);
  });
});
