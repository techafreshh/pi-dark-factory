import { isDuplicateTitle } from "./dedupe";
import { sh } from "./sh";
import { receipt } from "./receipts";
import type { GhApi } from "./gh";

/** The human suppression signal: closing an issue with this label makes the
 *  class sticky — the scanner/walk will not re-file a matching finding. A
 *  close WITHOUT it (the factory's own close-on-merge, a human closing by
 *  accident) suppresses nothing: an incomplete fix or a regression must
 *  re-file. Gh 2.45 cannot read `stateReason`, so the label is the signal. */
export const WONTFIX_LABEL = "wontfix";

/**
 * The generic factory issue filer — one shape behind every class the factory
 * authors itself: reviewer discoveries (ops.ts fileDiscoveries), penthera
 * security findings and drain-time PRD gaps. All
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
    /** also dedupe against CLOSED issues carrying the `wontfix` label — the
     *  explicit human "not fixing this" decision. NOT every closed issue:
     *  the factory closes an issue itself when it merges the fix, and a
     *  finding that survives its own fix (or regresses) MUST re-file.
     *  Classes without human-suppression semantics stay open-only. */
    dedupeWontfix?: boolean;
  } = {}
): Promise<{ issue: number; title: string }[]> {
  const open = await gh.issueList("open", 100);
  const filed: { issue: number; title: string }[] = [];
  const seen = [...open.map((i) => i.title), ...(opts.alsoSeen ?? [])];
  if (opts.dedupeWontfix) {
    const all = await gh.issueList("all", 500);
    for (const i of all) {
      if ((i.state ?? "").toLowerCase() !== "closed") continue;
      if (!(i.labels ?? []).includes(WONTFIX_LABEL)) continue;
      seen.push(i.title);
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
