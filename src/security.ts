import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readAcceptanceState, writeAcceptanceState, type AcceptanceLast } from "./acceptance-state";
import { ensureSource, withSourceLock } from "./gitws";
import { fileFactoryIssues, WONTFIX_LABEL } from "./fileissues";
import { repoVisibility, type GhApi } from "./gh";
import { agentEnv } from "./agentenv";
import { receipt } from "./receipts";
import { sh } from "./sh";
import { SECURITY_SEVERITIES, type RepoConfig, type SecuritySeverity } from "./types";

/**
 * Per-merge security audit (docs/acceptance.md) — `npx penthera --repo` over
 * a detached worktree of merged main. Penthera (https://penthera.org, MIT)
 * is a static scanner: secrets, risky routes, dependency behaviour, AI-setup
 * rules. It runs OFFLINE host-side for every execution mode — no product
 * code executes, no box is needed, so unlike the scenario regression this
 * hook is not host/compose-gated.
 *
 * Fail-closed contract: a scan whose JSON report cannot be parsed files
 * NOTHING (a misread scanner must not invent issues); the raw output lands
 * in the receipt instead. Findings at or above the repo's severity_floor
 * become deduped [security] issues the laps then fix through the normal
 * loop; penthera's own fix diffs are deliberately NOT applied — a fix is
 * work, and work goes through plan/implement/verify/review like everything
 * else.
 */

import { SECURITY_LABEL, PRD_GAP_LABEL } from "./stages/intake";
export { SECURITY_LABEL, PRD_GAP_LABEL };

/** npx spec for the scanner — PINNED to the version the parsers' captured
 *  fixture (test/fixtures/penthera-report.json) was recorded against, and
 *  bumped deliberately. `latest` would download and execute whatever the
 *  registry serves at merge time, on a schedule nobody controls.
 *  Overridable from factoryd.env without a deploy (PDF_PENTHERA_SPEC). */
export const pentheraSpec = () => process.env.PDF_PENTHERA_SPEC ?? "penthera@2.4.0";

const SCAN_TIMEOUT_MS =
  (Number(process.env.PDF_SECURITY_SCAN_MINUTES) > 0 ? Number(process.env.PDF_SECURITY_SCAN_MINUTES) : 10) * 60_000;

/** penthera's severity axis is low|medium|high|critical; "info" findings and
 *  anything unknown stay receipt-only whatever the floor. */
function severityRank(s: string): number {
  const i = (SECURITY_SEVERITIES as readonly string[]).indexOf(s);
  return i;
}

function floorRank(floor: string): number {
  const i = (SECURITY_SEVERITIES as readonly string[]).indexOf(floor);
  return i >= 0 ? i : severityRank("medium");
}

/** The publish gate for [security] findings, pure for the tests: findings
 *  are VISIBLE by default (security_public defaults true — operator call,
 *  2026-11-16: the factory's own smoke repos publish their findings on
 *  purpose). A repo that treats its tracker as sensitive opts OUT with an
 *  explicit security_public: false — and for THOSE repos an unreadable
 *  visibility still fails closed (null → do not file), because the opt-out's
 *  whole point is to prevent a one-way disclosure. */
export function mayFileSecurityFindings(visibility: string | null, cfg: RepoConfig): boolean {
  if (cfg.acceptance?.security_public === false) return visibility !== null && visibility !== "PUBLIC";
  return true;
}

/** The findings the scan would file: severity at or above the floor, ordered
 *  worst-first, "info"/unknown severities always dropped. Pure — the filing
 *  tests run this against the captured penthera fixture. */
export function findingsAboveFloor(findings: PentheraFinding[], floor: string): PentheraFinding[] {
  const f = floorRank(floor);
  return findings
    .filter((x) => severityRank(String(x.severity)) >= f)
    .sort((a, b) => severityRank(String(b.severity)) - severityRank(String(a.severity)));
}

/** The raw shape of penthera's `-o` JSON report, typed from the captured
 *  fixture (test/fixtures/penthera-report.json — penthera 2.4.0, standard
 *  profile). Parsed defensively: the scanner may add fields; we read only
 *  what we file. */
export interface PentheraFinding {
  severity: string;
  title: string;
  description?: string;
  path?: string;
  line?: number;
  category?: string;
  confidence?: string;
  fid?: string;
}

export interface PentheraReport {
  findings?: PentheraFinding[];
  brief?: {
    verdict?: string;
    counts?: { total?: number };
  };
}

export function parsePentheraReport(text: string): PentheraReport | null {
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || !Array.isArray(j.findings)) return null;
    return j as PentheraReport;
  } catch {
    return null;
  }
}

export interface SecurityScanResult {
  pass: boolean;
  /** counts line for the receipt ("3 findings above floor (of 7)") */
  summary: string;
  filed: { issue: number; title: string }[];
  /** scan errors / unparsable output — never an issue, always a receipt */
  note?: string;
  /** "error" = the scan itself failed (unparsable, worktree, transport);
   *  "findings" = the scan ran and this is its verdict. The PR evidence
   *  comment words the two differently (an error has no findings to file). */
  kind?: "findings" | "error";
}

/** Scan merged main and file the findings above the floor. Never throws on
 *  scanner trouble — the post-merge hook is report-only by contract; it
 *  returns a result whose `note` explains what went wrong. Issue filing
 *  failures do throw (the caller receipts them). */
export async function runSecurityScan(
  cfg: RepoConfig,
  gh: GhApi,
  opts: { stateDir: string; pr?: number; atDrain?: boolean; ref?: string; reportOnly?: boolean }
): Promise<SecurityScanResult> {
  // ref: the post-merge/drain scans default to merged main; the verify-time
  // evidence scan passes the lap's branch (report-only — see below)
  const ref = opts.ref ?? `origin/${cfg.default_branch}`;
  const scanRoot = join(opts.stateDir, "repos", cfg.slug, "issues", "security");
  mkdirSync(scanRoot, { recursive: true });
  // a UNIQUE worktree per scan: the verify-time branch scan now runs inside
  // laps (parallel lanes + the merge queue), so a shared `wt` let two scans
  // delete each other's worktree mid-scan (PR #16 review, H2)
  const wt = mkdtempSync(join(scanRoot, "wt-"));
  const reportPath = join(wt, "penthera-report.json");
  // hoisted: the cleanup finally runs outside the try that fills it
  let src = "";
  try {
    // round-2 suggestion: a killed scan leaves its wt-* dir and a stale
    // .git/worktrees entry behind — sweep + prune the orphans at scan start
    // (the prune touches the shared .git, so it rides the lock below)
    try {
      for (const e of readdirSync(scanRoot, { withFileTypes: true })) {
        if (e.isDirectory() && e.name.startsWith("wt-")) rmSync(join(scanRoot, e.name), { recursive: true, force: true });
      }
    } catch {}
    // the source checkout is SHARED (gitws.ts: parallel lanes + the merge
    // queue read one .git): fetch/reset/clean and worktree add take the
    // per-repo lock, exactly like every other source user. The scanner run
    // itself stays OUTSIDE the lock — it touches only its own worktree.
    const prepared = await withSourceLock(cfg.slug, async () => {
      await sh(["git", "worktree", "prune"], { timeoutMs: 30_000, cwd: opts.stateDir });
      const inner = await ensureSource(opts.stateDir, cfg); // fetch + reset, throws on transport failure
      const rev = await sh(["git", "-C", inner, "rev-parse", ref], { timeoutMs: 30_000 });
      const added = await sh(["git", "-C", inner, "worktree", "add", "--detach", wt, ref], { timeoutMs: 120_000 });
      return { src: inner, head: rev.stdout.trim(), addedCode: added.code, addedErr: added.stderr.trim().slice(0, 300) };
    });
    src = prepared.src;
    const mainHead = prepared.head;
    if (prepared.addedCode !== 0) {
      return { pass: false, summary: "worktree add failed", note: prepared.addedErr, filed: [], kind: "error" };
    }
    // publish gate: on a PUBLIC repo, a filed finding is a live disclosure
    // (file, line, sink) minutes after the merge that introduced it — the scan
    // runs and receipts either way; filing needs a private repo or an explicit
    // acceptance.security_public
    const visibility = opts.reportOnly ? null : await repoVisibility(cfg.repo);
    const mayFile = mayFileSecurityFindings(visibility, cfg);
    // the scanner is downloaded code running as the factory user: it gets
    // the agentEnv allowlist, never the service environment with the
    // factory's keys (PATH/HOME ride the allowlist base; npx needs both)
    const res = await sh(
      ["npx", "-y", pentheraSpec(), "--repo", wt, "-o", reportPath, "--no-footer"],
      { cwd: opts.stateDir, env: agentEnv([], undefined, { always: false }), inheritEnv: false, timeoutMs: SCAN_TIMEOUT_MS, killGroup: true }
    );
    const raw = (() => {
      try {
        return readFileSync(reportPath, "utf8");
      } catch {
        return "";
      }
    })();
    const report = parsePentheraReport(raw);
    if (!report) {
      // fail closed: unparsable output files nothing — the receipt carries
      // the scanner's own words so a human can see why
      return {
        pass: false,
        summary: `unparsable report (exit ${res.code})`,
        kind: "error",
        note: `${res.stderr.trim().slice(0, 300) || res.stdout.trim().slice(0, 300)}`,
        filed: [],
      };
    }
    const all = report.findings ?? [];
    const above = findingsAboveFloor(all, cfg.acceptance?.severity_floor ?? "medium");
    const summary = `${above.length} finding(s) at or above ${cfg.acceptance?.severity_floor ?? "medium"} (of ${all.length} scanned) — ${report.brief?.verdict ?? "unknown verdict"}`;

    // record the scan on its own verdict key — the PRD-acceptance verdict
    // (state.last) is a different gate and must not be clobbered by it.
    // ONLY main scans record: a verify-time branch scan is report-only
    // evidence and must never overwrite the merged-main verdict.
    if (!opts.ref) {
      const st = readAcceptanceState(opts.stateDir, cfg.slug);
      const lastSecurity: AcceptanceLast = {
        status: above.length === 0 ? "pass" : "fail",
        main_head: mainHead,
        at: new Date().toISOString(),
        summary: `security: ${summary}`,
      };
      writeAcceptanceState(opts.stateDir, cfg.slug, { ...st, last_security: lastSecurity });
    }

    if (above.length === 0) return { pass: true, summary, filed: [], kind: "findings" };

    if (opts.reportOnly) {
      // the verify-time branch scan: evidence for the PR comment, never a
      // filer — inherited findings especially are the post-merge scan's job
      return { pass: false, summary, note: "report-only (branch evidence)", filed: [], kind: "findings" };
    }

    if (!mayFile) {
      // public repo + no explicit opt-in: the scan's facts stay in the
      // receipt and the acceptance-state verdict, never on the tracker
      const why =
        visibility === null
          ? `repo visibility unreadable (gh failed) — failing closed; the next merge's scan retries`
          : `filing on a ${visibility} repo needs acceptance.security_public (a public issue would disclose the finding live)`;
      const note = `${summary} — findings NOT filed: ${why}`;
      receipt(opts.stateDir, `security scan on main: ${note}`, cfg.slug);
      return { pass: false, summary: note, note, filed: [], kind: "findings" };
    }

    // cap the batch: a misconfigured repo with hundreds of matches must not
    // open a hundred issues in one merge — the overflow rides the last issue
    const MAX = 10;
    const batch = above.slice(0, MAX);
    const overflow = above.slice(MAX);
    const provenance = opts.atDrain
      ? `Drain-time security audit of \`origin/${cfg.default_branch}\` (${mainHead.slice(0, 12)}) — penthera ${pentheraSpec().replace("penthera@", "v")}`
      : opts.pr != null
        ? `Per-merge security audit of \`origin/${cfg.default_branch}\` after PR #${opts.pr} (${mainHead.slice(0, 12)}) — penthera ${pentheraSpec().replace("penthera@", "v")}`
        : `Security audit of \`origin/${cfg.default_branch}\` (${mainHead.slice(0, 12)}) — penthera ${pentheraSpec().replace("penthera@", "v")}`;
    const items = batch.map((f) => {
      const minor = severityRank(String(f.severity)) <= severityRank("low");
      const where = f.path ? [`${f.path}${f.line != null ? `:${f.line}` : ""}`] : [];
      const body = [
        f.description ?? f.title,
        "",
        `Severity: ${f.severity}${f.confidence ? ` (${f.confidence})` : ""}${f.category ? `, category ${f.category}` : ""}${where.length ? `, in ${where.join(" ")}` : ""}`,
        "",
        provenance,
        "",
        overflow.length && f === batch[batch.length - 1]
          ? `Also above the floor but not filed individually (${overflow.length}): ${overflow.map((o) => `[${o.severity}] ${o.title}`).join("; ")}`
          : "",
        "",
        "This issue is a fix order for the normal lap loop: plan the fix, implement it, keep the scenario and e2e gates green. The scanner's own diff suggestions were not applied — any fix must go through review.",
        "",
        `Not fixing this? Close it with the \`${WONTFIX_LABEL}\` label — the scan will not re-file the finding. A close without the label suppresses nothing (an incomplete fix or a regression comes back).`,
      ]
        .filter((s) => s !== "")
        .join("\n");
      return {
        title: `[security] ${f.title}${f.fid ? ` (fid ${f.fid})` : ""}`,
        body,
        labels: [SECURITY_LABEL, ...(minor ? ["minor"] : [])],
        labelDescriptions: {
          [SECURITY_LABEL]: "penthera security finding on merged main",
          minor: "low-severity — deferred until the product backlog drains",
        },
      };
    });
    const filed = await fileFactoryIssues(opts.stateDir, cfg.slug, gh, items, { via: "security scan", dedupeWontfix: true });
    receipt(opts.stateDir, `security scan on main: ${summary}, filed ${filed.length}`, cfg.slug);
    return { pass: false, summary, filed, kind: "findings" };
  } finally {
    // round-2 suggestion: src is "" when ensureSource threw — git -C "" would
    // run the removal in whatever cwd the process has; skip it instead
    if (src) {
      await withSourceLock(cfg.slug, async () => {
        await sh(["git", "-C", src, "worktree", "remove", "--force", wt], { timeoutMs: 30_000 });
      });
    }
    rmSync(wt, { recursive: true, force: true });
  }
}
