import { isDuplicateTitle } from "./dedupe";
import { sh } from "./sh";
import { receipt } from "./receipts";
import type { GhApi } from "./gh";

/**
 * The generic factory issue filer — one shape behind every class the factory
 * authors itself: reviewer discoveries (ops.ts fileDiscoveries), per-merge
 * e2e regressions and penthera security findings, drain-time PRD gaps. All
 * of them are GitHub issues opened by the factory's own account, so intake
 * trusts them; dedupe (normalized title + heavy word overlap, src/dedupe.ts)
 * keeps a repeat scan from stacking identical issues.
 */
export interface FactoryIssue {
  /** full title INCLUDING the class prefix ("[security] …") — the prefix is
   *  the dedupe anchor and how humans filter the tracker */
  title: string;
  body: string;
  labels: string[];
  /** label name → description, used when a label has to be created first */
  labelDescriptions?: Record<string, string>;
}

/** best-effort label add with a create-and-retry — a missing label must
 *  never lose a filed issue (the same shape fileDiscoveries shipped with) */
export async function addLabelsWithCreate(gh: GhApi, n: number, labels: string[], descriptions: Record<string, string> = {}): Promise<void> {
  if (labels.length === 0) return;
  try {
    await gh.issueAddLabels(n, labels);
  } catch {
    try {
      for (const l of labels)
        await sh(["gh", "label", "create", l, "--repo", gh.repo, "--description", descriptions[l] ?? l, "--force"]);
      await gh.issueAddLabels(n, labels);
    } catch {}
  }
}

export async function fileFactoryIssues(
  stateDir: string,
  slug: string,
  gh: GhApi,
  items: FactoryIssue[],
  opts: {
    alsoSeen?: string[];
    /** receipt tag recorded per filed issue, e.g. "security scan" */
    via?: string;
    /** also dedupe against CLOSED issues — for classes where a human close
     *  is a standing decision ("won't fix", "false positive"): a closed
     *  [security] finding or [prd-gap] must not come back on the next
     *  merge. Classes whose recurrence IS the evidence ([e2e-regression],
     *  discoveries) stay open-only and leave this unset. */
    dedupeClosed?: boolean;
  } = {}
): Promise<{ issue: number; title: string }[]> {
  const open = await gh.issueList("open", 100);
  const filed: { issue: number; title: string }[] = [];
  const seen = [...open.map((i) => i.title), ...(opts.alsoSeen ?? [])];
  if (opts.dedupeClosed) {
    const all = await gh.issueList("all", 500);
    for (const i of all) {
      if ((i.state ?? "").toLowerCase() === "closed") seen.push(i.title);
    }
  }
  for (const item of items) {
    if (seen.some((t) => isDuplicateTitle(t, item.title))) continue;
    seen.push(item.title);
    let n: number;
    try {
      n = await gh.issueCreate(item.title, item.body);
    } catch (e) {
      // a create failure must not abort the batch — later classes (and the
      // caller's receipt line) still reflect what did land
      receipt(stateDir, `issue create failed for "${item.title.slice(0, 80)}": ${e instanceof Error ? e.message.slice(0, 200) : e}`, slug);
      continue;
    }
    filed.push({ issue: n, title: item.title });
    await addLabelsWithCreate(gh, n, item.labels, item.labelDescriptions);
    if (opts.via) receipt(stateDir, `filed #${n} (${opts.via}): ${item.title.slice(0, 100)}`, slug);
  }
  return filed;
}
