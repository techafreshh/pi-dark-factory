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
    "You are the backlog slicer of an unattended software factory. Slice the product document below into an ordered GitHub backlog.",
    "",
    "PROBLEM: this product needs to be built end-to-end by autonomous implementation laps, each working from exactly one issue.",
    "WHY: the factory claims the oldest unclaimed issue per lap and must always have safe, self-contained work available.",
    "WHY NOW: this slicing runs once per project onboarding; re-runs dedupe by title, so the first cut defines the whole build.",
    "OUTCOME: at most " + maxIssues + " issues, ordered so dependencies come first.",
    "INVARIANTS:",
    "- The FIRST issue must make the product runnable end-to-end from a clean clone (a walking skeleton with the core loop, however minimal).",
    "- Every issue is independently implementable from its own text: files/modules to touch, expected behavior, acceptance criteria.",
    "- An issue must be small enough for one implementation session; split anything bigger.",
    "- Dependencies only reference EARLIER issues, by their 1-based index in your output.",
    "- The final issue delivers the complete product described in the document.",
    "ACCEPTANCE: each issue's text alone lets an engineer implement it correctly without asking questions.",
    "",
    "OUTPUT FORMAT — plain text, no markdown fences, no JSON. Issues separated by a line containing only `---`:",
    "",
    "TITLE: <github issue title>",
    "DEPENDS: <comma-separated indices of earlier issues, omit the line if none>",
    "<issue body markdown>",
    "",
    "PRODUCT DOCUMENT:",
    "",
    prd,
  ].join("\n");
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
