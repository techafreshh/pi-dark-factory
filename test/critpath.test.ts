import { describe, expect, test } from "bun:test";
import { rankByCriticalPath } from "../src/critpath";
import type { IssueLite } from "../src/types";

// the shape intake hands over after the gh boundary (labels normalized to
// strings, author login) — bodies carry the slicer's `Depends on: #n` lines
const i = (number: number, deps: number[] = []): IssueLite => ({
  number,
  title: `issue ${number}`,
  body: ["## Problem\nx", ...deps.map((d) => `Depends on: #${d}`)].join("\n\n"),
  labels: [],
  author: "acme",
});
const order = (claimable: IssueLite[], open: IssueLite[]) => rankByCriticalPath(claimable, open).map((r) => r.issue.number);

describe("rankByCriticalPath", () => {
  test("the head of the longest open chain goes first, not the oldest issue", () => {
    // 1 is a dead-end leaf; 2 → 3 → 4 is a chain; only 1 and 2 are claimable
    const open = [i(1), i(2), i(3, [2]), i(4, [3])];
    expect(order([i(1), i(2)], open)).toEqual([2, 1]);
    const ranks = rankByCriticalPath([i(1), i(2)], open);
    expect(ranks.find((r) => r.issue.number === 2)).toMatchObject({ depth: 3, dependents: 2 });
    expect(ranks.find((r) => r.issue.number === 1)).toMatchObject({ depth: 1, dependents: 0 });
  });

  test("equal depth: more transitive dependents wins; then the lower number", () => {
    // 5 fans out to 6, 7, 8; 9 has one dependent; both depth 2
    const open = [i(5), i(6, [5]), i(7, [5]), i(8, [5]), i(9), i(10, [9]), i(11), i(12, [11])];
    expect(order([i(9), i(5), i(11)], open)).toEqual([5, 9, 11]);
  });

  test("closed dependents no longer count", () => {
    // 3 depended on 2 but is closed (absent from the open list)
    expect(order([i(1), i(2)], [i(1), i(2), i(4, [1])])).toEqual([1, 2]);
  });

  test("a dependency cycle cannot hang the ranking", () => {
    const open = [i(1, [3]), i(2, [1]), i(3, [2])];
    expect(order([i(1)], open).length).toBe(1);
  });

  test("an issue that names itself or an unknown number is ignored safely", () => {
    expect(order([i(1, [1, 99])], [i(1, [1, 99])])).toEqual([1]);
  });
});
