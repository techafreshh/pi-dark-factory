import { describe, expect, test } from "bun:test";
import { authorLogin, labelNames } from "../src/gh";

describe("authorLogin (gh boundary normalization)", () => {
  test("the real gh shape — an author object — normalizes to the login", () => {
    // verbatim from `gh issue list --json number,author` (qed, gh 2.45, 2026-11-09)
    const real = { id: "MDQ6VXNlcjY3NTEyODAx", is_bot: false, login: "techafreshh", name: "Techa" };
    expect(authorLogin(real)).toBe("techafreshh");
  });

  test("string entries (test fakes) pass; anything without a login is undefined", () => {
    expect(authorLogin("acme")).toBe("acme");
    expect(authorLogin({ id: "x", name: "no login" })).toBeUndefined();
    expect(authorLogin({ login: "" })).toBeUndefined();
    expect(authorLogin(null)).toBeUndefined();
    expect(authorLogin(undefined)).toBeUndefined();
    expect(authorLogin("")).toBeUndefined();
  });
});

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
