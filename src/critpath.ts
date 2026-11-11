/**
 * Critical-path order for parallel mode (docs/parallel-mode.md). The time to
 * finish a PRD is bounded by its longest chain of dependent issues, so with
 * several lanes the issue to start first is the one with the longest chain of
 * OPEN issues waiting on it — oldest-first can start a dead-end leaf while
 * the long chain sits idle. Serial mode keeps oldest-first: with one lane the
 * order does not change the total time.
 *
 * Edges come from the same `Depends on: #n` lines intake gates on. Only open
 * issues count: a closed issue no longer waits on anything.
 */
import { parseDepends } from "./stages/intake";
import type { IssueLite } from "./types";

export interface CriticalPathRank {
  issue: IssueLite;
  /** 1 + the longest chain of open issues that depend on this one */
  depth: number;
  /** open issues that depend on this one, directly or transitively */
  dependents: number;
}

/** claimable issues ranked: deepest chain first, then most dependents, then
 *  issue number (deterministic). A dependency cycle cannot hang the ranking:
 *  a node met again on its own path counts as a leaf. */
export function rankByCriticalPath(claimable: IssueLite[], open: IssueLite[]): CriticalPathRank[] {
  const openNums = new Set(open.map((i) => i.number));
  for (const c of claimable) openNums.add(c.number);
  // dependents[n] = open issues whose body says Depends on: #n
  const dependents = new Map<number, number[]>();
  for (const i of [...open, ...claimable]) {
    for (const d of parseDepends(i.body ?? "")) {
      if (!openNums.has(d) || d === i.number) continue;
      const list = dependents.get(d) ?? [];
      if (!list.includes(i.number)) list.push(i.number);
      dependents.set(d, list);
    }
  }
  const depthMemo = new Map<number, number>();
  const depth = (n: number, path: Set<number>): number => {
    const hit = depthMemo.get(n);
    if (hit !== undefined) return hit;
    if (path.has(n)) return 0; // cycle: stop here
    path.add(n);
    let best = 0;
    for (const m of dependents.get(n) ?? []) best = Math.max(best, depth(m, path));
    path.delete(n);
    const d = 1 + best;
    depthMemo.set(n, d);
    return d;
  };
  const reach = (n: number): number => {
    const seen = new Set<number>();
    const stack = [...(dependents.get(n) ?? [])];
    while (stack.length) {
      const m = stack.pop()!;
      if (seen.has(m) || m === n) continue;
      seen.add(m);
      stack.push(...(dependents.get(m) ?? []));
    }
    return seen.size;
  };
  return claimable
    .map((issue) => ({ issue, depth: depth(issue.number, new Set()), dependents: reach(issue.number) }))
    .sort((a, b) => b.depth - a.depth || b.dependents - a.dependents || a.issue.number - b.issue.number);
}
