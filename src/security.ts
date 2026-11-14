import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readAcceptanceState, writeAcceptanceState, type AcceptanceLast } from "./acceptance-state";
import { ensureSource } from "./gitws";
import { fileFactoryIssues } from "./fileissues";
import type { GhApi } from "./gh";
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

import { SECURITY_LABEL, PRD_GAP_LABEL, E2E_REGRESSION_LABEL } from "./stages/intake";
export { SECURITY_LABEL, PRD_GAP_LABEL, E2E_REGRESSION_LABEL };

/** npx spec override — pin or downgrade from factoryd.env without a deploy
 *  (e.g. PDF_PENTHERA_SPEC=penthera@2.4.0 when a release misbehaves). */
const pentheraSpec = () => process.env.PDF_PENTHERA_SPEC ?? "penthera@latest";

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
}

/** Scan merged main and file the findings above the floor. Never throws on
 *  scanner trouble — the post-merge hook is report-only by contract; it
 *  returns a result whose `note` explains what went wrong. Issue filing
 *  failures do throw (the caller receipts them). */
export async function runSecurityScan(
  cfg: RepoConfig,
  gh: GhApi,
  opts: { stateDir: string; pr?: number; atDrain?: boolean }
): Promise<SecurityScanResult> {
  const floor = floorRank(cfg.acceptance?.severity_floor ?? "medium");
  const src = await ensureSource(opts.stateDir, cfg); // fetch + reset, throws on transport failure
  const rev = await sh(["git", "-C", src, "rev-parse", `origin/${cfg.default_branch}`], { timeoutMs: 30_000 });
  const mainHead = rev.stdout.trim();
  const scanRoot = join(opts.stateDir, "repos", cfg.slug, "issues", "security");
  rmSync(scanRoot, { recursive: true, force: true });
  mkdirSync(scanRoot, { recursive: true });
  const wt = join(scanRoot, "wt");
  const added = await sh(["git", "-C", src, "worktree", "add", "--detach", wt, `origin/${cfg.default_branch}`], { timeoutMs: 120_000 });
  if (added.code !== 0) {
    return { pass: false, summary: "worktree add failed", note: added.stderr.trim().slice(0, 300), filed: [] };
  }
  const reportPath = join(scanRoot, "penthera-report.json");
  try {
    const res = await sh(
      ["npx", "-y", pentheraSpec(), "--repo", wt, "-o", reportPath, "--no-footer"],
      { cwd: opts.stateDir, timeoutMs: SCAN_TIMEOUT_MS, killGroup: true }
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
        note: `${res.stderr.trim().slice(0, 300) || res.stdout.trim().slice(0, 300)}`,
        filed: [],
      };
    }
    const all = report.findings ?? [];
    const above = findingsAboveFloor(all, cfg.acceptance?.severity_floor ?? "medium");
    const summary = `${above.length} finding(s) at or above ${cfg.acceptance?.severity_floor ?? "medium"} (of ${all.length} scanned) — ${report.brief?.verdict ?? "unknown verdict"}`;

    // record the scan on its own verdict key — the PRD-acceptance verdict
    // (state.last) is a different gate and must not be clobbered by it
    const st = readAcceptanceState(opts.stateDir, cfg.slug);
    const lastSecurity: AcceptanceLast = {
      status: above.length === 0 ? "pass" : "fail",
      main_head: mainHead,
      at: new Date().toISOString(),
      summary: `security: ${summary}`,
    };
    writeAcceptanceState(opts.stateDir, cfg.slug, { ...st, last_security: lastSecurity });

    if (above.length === 0) return { pass: true, summary, filed: [] };

    // cap the batch: a misconfigured repo with hundreds of matches must not
    // open a hundred issues in one merge — the overflow rides the last issue
    const MAX = 10;
    const batch = above.slice(0, MAX);
    const overflow = above.slice(MAX);
    const provenance = opts.atDrain
      ? `Drain-time security audit of \`origin/${cfg.default_branch}\` (${mainHead.slice(0, 12)}) — penthera ${pentheraSpec().replace("penthera@", "v")}`
      : `Per-merge security audit of \`origin/${cfg.default_branch}\` after PR #${opts.pr} (${mainHead.slice(0, 12)}) — penthera ${pentheraSpec().replace("penthera@", "v")}`;
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
    const filed = await fileFactoryIssues(opts.stateDir, cfg.slug, gh, items, { via: "security scan" });
    receipt(opts.stateDir, `security scan on main: ${summary}, filed ${filed.length}`, cfg.slug);
    return { pass: false, summary, filed };
  } finally {
    await sh(["git", "-C", src, "worktree", "remove", "--force", wt], { timeoutMs: 30_000 });
    rmSync(scanRoot, { recursive: true, force: true });
  }
}
