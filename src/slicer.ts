export interface SlicedIssue {
  title: string;
  body: string;
  /** 1-based indices of EARLIER entries this one depends on */
  dependsOn: number[];
}

export function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Lenient line-based slicer output — no schema-valid JSON demanded from the
 * model. Blocks separated by a bare `---` line:
 *
 *   TITLE: Add login endpoint
 *   DEPENDS: 1
 *   BODY...
 *   ---
 *   TITLE: ...
 */
export function parseSlicerOutput(text: string): SlicedIssue[] {
  const blocks = text
    .split(/^\s*---+\s*$/m)
    .map((b) => b.trim())
    .filter(Boolean);
  const out: SlicedIssue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const titleLine = lines.find((l) => /^title\s*:/i.test(l.trim()));
    if (!titleLine) continue; // tolerate preamble/prose blocks
    const title = titleLine.replace(/^title\s*:\s*/i, "").trim();
    if (!title) continue;
    const dependsLine = lines.find((l) => /^depends\s*:/i.test(l.trim()));
    const dependsOn = dependsLine
      ? (dependsLine.replace(/^depends\s*:\s*/i, "").match(/\d+/g) ?? []).map(Number)
      : [];
    const body = lines
      .filter((l) => l !== titleLine && l !== dependsLine)
      .join("\n")
      .trim();
    out.push({ title, body, dependsOn });
  }
  return out;
}

export function buildSlicerPrompt(prd: string, maxIssues: number): string {
  return [
    "You are the backlog slicer of an unattended software factory — an engineering lead decomposing the product document below into a build order that autonomous implementation laps can execute one issue at a time.",
    "",
    "PROBLEM: this product needs to be built end-to-end by autonomous laps, each working from exactly one issue, with no human available to answer questions mid-build.",
    "WHY: the factory claims the oldest unclaimed issue per lap and must always have safe, self-contained work available.",
    "WHY NOW: this slicing runs once per project onboarding; re-runs dedupe by title, so the first cut defines the whole build.",
    "OUTCOME: at most " + maxIssues + " issues, ordered so dependencies come first.",
    "",
    "INVARIANTS:",
    "- The FIRST issue must make the product runnable end-to-end from a clean clone (a walking skeleton with the core loop, however minimal — real server, real health endpoint, no stubs and no invented external services).",
    "- Every issue is independently implementable from its own text alone: its body carries the full context.",
    "- An issue must be small enough for one implementation session; split anything bigger.",
    "- Dependencies only reference EARLIER issues, by their 1-based index in your output. Dependency honesty: list a DEPENDS only when this issue cannot be implemented or demonstrated without an earlier one — wanting a tidy build order is not a dependency.",
    "- The final issue delivers the complete product described in the document.",
    "- Nothing new is a valid slice: only what the product document asks for.",
    "",
    "ISSUE BODY CONTRACT — every issue body must contain these sections:",
    "## Problem — what and why, in two sentences.",
    "## Behavior — the user-visible behavior, concretely.",
    "## Acceptance — 2–5 Given/When/Then bullets that are mechanically checkable: status codes, exact strings, file paths, counts, timings. Ban the vague: `works correctly`, `handles errors`, `etc.`, `as appropriate`.",
    "## Notes — files/modules likely touched and integration points (optional).",
    "An acceptance bullet must be specific enough to become an automated black-box probe — the factory verifies every delivery with real HTTP probes.",
    "",
    "ACCEPTANCE: each issue's text alone lets an engineer implement it correctly without asking questions; every `Depends on` is real; every acceptance criterion is probe-able.",
    "",
    "OUTPUT FORMAT — plain text, no markdown fences, no JSON. Issues separated by a line containing only `---`:",
    "",
    "TITLE: <github issue title>",
    "DEPENDS: <comma-separated indices of earlier issues, omit the line if none>",
    "<issue body markdown with the sections above>",
    "",
    "PRODUCT DOCUMENT:",
    "",
    prd,
  ].join("\n");
}

/** Graph check the slicer can't run for itself: DEPENDS entries are 1-based
 * indices of EARLIER issues, so a self-reference, forward reference, or
 * out-of-range index can never be satisfied. The create loop used to drop
 * these silently — the dependency vanished and the chain claimed the issue
 * before the thing it needed existed (magpie postmortem 2026-10-25,
 * incidents 13/14: preview showed 8→8 and 13→13, caught only by hand). */
export function graphProblems(sliced: SlicedIssue[]): string[] {
  const out: string[] = [];
  sliced.forEach((s, i) => {
    const own = i + 1;
    for (const d of s.dependsOn) {
      if (d === own) out.push(`issue ${own} ("${s.title}") depends on itself`);
      else if (d > sliced.length) out.push(`issue ${own} ("${s.title}") depends on out-of-range index ${d} (only ${sliced.length} issues)`);
      else if (d > own) out.push(`issue ${own} ("${s.title}") forward-references issue ${d} — dependencies must come EARLIER`);
      else if (d < 1) out.push(`issue ${own} ("${s.title}") depends on out-of-range index ${d}`);
    }
  });
  return out;
}

/** Dedupe against existing issues by normalized title (re-runs never duplicate). */
export function filterNew(sliced: SlicedIssue[], existingTitles: string[]): SlicedIssue[] {
  const seen = new Set(existingTitles.map(normalizeTitle));
  return sliced.filter((s) => {
    const key = normalizeTitle(s.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
