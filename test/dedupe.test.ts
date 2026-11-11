import { describe, expect, test } from "bun:test";
import { isDuplicateTitle } from "../src/dedupe";

describe("isDuplicateTitle", () => {
  test("case, punctuation and the [discovery] prefix do not matter", () => {
    expect(isDuplicateTitle("[discovery] Missing auth check on /admin", "missing auth-check on /admin!")).toBe(true);
  });
  test("one word swapped in a six-word title is a duplicate (Jaccard 5/7)", () => {
    expect(isDuplicateTitle("Missing input validation on POST /items", "missing input validation for POST /items")).toBe(true);
  });
  test("different bugs in the same area are not", () => {
    expect(isDuplicateTitle("Missing input validation on POST /items", "Slow pagination on GET /items")).toBe(false);
    expect(isDuplicateTitle("Login form accepts empty password", "Signup form accepts empty email")).toBe(false);
  });
  test("empty titles never match", () => {
    expect(isDuplicateTitle("", "")).toBe(false);
    expect(isDuplicateTitle("[discovery] ", "x")).toBe(false);
  });
});
