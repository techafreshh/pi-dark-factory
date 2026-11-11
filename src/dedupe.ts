/**
 * Discovery title dedupe (deterministic, no model call). Parallel lanes
 * review sibling issues of the same PRD at the same time, and their reviews
 * report the same bug in slightly different words; exact-title dedupe let
 * those through. Two titles are duplicates when they normalize equal, or when
 * their word sets overlap by Jaccard >= 0.7. Rewordings with different words
 * still pass — an accepted residual.
 */
import { normalizeTitle } from "./slicer";

const PREFIX = /^\s*\[discovery\]\s*/i;
const JACCARD_MIN = 0.7;

const words = (t: string) => new Set(normalizeTitle(t.replace(PREFIX, "")).split(" ").filter(Boolean));

export function isDuplicateTitle(a: string, b: string): boolean {
  const na = normalizeTitle(a.replace(PREFIX, ""));
  const nb = normalizeTitle(b.replace(PREFIX, ""));
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = words(a);
  const wb = words(b);
  let both = 0;
  for (const w of wa) if (wb.has(w)) both++;
  const union = wa.size + wb.size - both;
  return union > 0 && both / union >= JACCARD_MIN;
}
