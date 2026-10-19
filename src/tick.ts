import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRepoConfig, resolveModels } from "./config";
import { Gh, type GhApi } from "./gh";
import { issueDir, sessionDir as sessionDirOf, branchName, addWorktree, commitsAhead, changedPaths, ensureSource, lockfileOnly, pushBranch, removeWorktree, uncommitted } from "./gitws";
import { Ledger } from "./ledger";
import { blockedComment, mergedComment, noActionComment } from "./notify";
import { callPiWithFallback, type PiStageResult } from "./pi";
import { receipt } from "./receipts";
import { scenarioSummary, runVerify } from "./stages/verify";
import { pickClaimable } from "./stages/intake";
import { buildPlanPrompt, parsePlan, PLANNER_SYSTEM } from "./stages/plan";
import { buildImplementPrompt, IMPLEMENTER_SYSTEM } from "./stages/implement";
import { scenarioSummary, runVerify } from "./stages/verify";
import { buildReviewPrompt, parseVerdict, REVIEWER_SYSTEM } from "./stages/review";
import type { IssueLite, ModelSpec, RepoConfig, StageModels, StageName } from "./types";

export interface CallStageArgs {
  models: StageModels;
  prompt: string;
  systemPrompt: string;
  cwd: string;
  tools: string[];
  sessionDir: string;
}

export type CallStageFn = (
  stage: StageName,
  args: CallStageArgs
) => Promise<PiStageResult>;

export function makeCallStage(cfg: RepoConfig): CallStageFn {
  return (stage, a) =>
    callPiWithFallback(
      {
        binary: cfg.pi.binary,
        prompt: a.prompt,
        cwd: a.cwd,
        tools: a.tools,
        sessionDir: a.sessionDir,
        systemPrompt: a.systemPrompt,
        extraArgs: cfg.pi.extra_args,
        timeoutMs: cfg.timeouts.stage_minutes * 60_000,
      },
      a.models
    );
}

const modelStr = (m: ModelSpec) => `${m.provider}/${m.model}${m.thinking ? `:${m.thinking}` : ""}`;

export interface TickDeps {
  ledger: Ledger;
  gh: GhApi;
  callStage: CallStageFn;
}

function prBody(cfg: RepoConfig, issue: IssueLite, plan: string): string {
  return [
    `Closes #${issue.number}`,
    "",
    "🤖 pi-dark-factory lap — planned, implemented, verified, reviewed, and merged unattended.",
    "",
    "## Plan",
    plan.slice(0, 4000),
  ].join("\n");
}

/**
 * Crash reconciliation — the anti-wedge pass. Laps are serialized, so at
 * tick start ANY in_progress row is by definition an interrupted lap:
 *  - issue already closed or a PR already merged → the delivery landed; close the books
 *  - attempts at cap → mark blocked and notify (the crash ate the notification)
 *  - otherwise the row stays reclaimable by intake with attempts carried over
 */
async function reconcile(cfg: RepoConfig, deps: TickDeps, stateDir: string) {
  const rows = deps.ledger.listIssues(cfg.repo).filter((r) => r.state === "in_progress");
  if (rows.length === 0) return;
  const mergedPrs = await deps.gh.prListMerged(50);
  for (const row of rows) {
    const claimed = (p: { body: string; headRefName: string }) =>
      p.headRefName === branchName(row.issue_number) ||
      new RegExp(`(?:closes?|fixes?|resolves?|implements?)\\s+#?${row.issue_number}\\b`, "i").test(p.body ?? "");
    const delivered = mergedPrs.some(claimed);
    let issueClosed = false;
    try {
      issueClosed = (await deps.gh.issueView(row.issue_number)).state?.toLowerCase() === "closed";
    } catch {
      // unreadable issue — leave the row alone for intake's rules to decide
    }
    if (delivered || issueClosed) {
      if (!issueClosed && delivered) {
        try { await deps.gh.issueClose(row.issue_number); } catch {}
      }
      deps.ledger.setIssue(cfg.repo, row.issue_number, { state: "merged", last_error: null });
      receipt(stateDir, `NOTE: reconciled #${row.issue_number} — a crashed lap's delivery had landed; ledger set merged`);
      continue;
    }
    if (row.attempts >= cfg.attempts) {
      deps.ledger.setIssue(cfg.repo, row.issue_number, { state: "blocked" });
      try {
        await deps.gh.issueComment(
          row.issue_number,
          blockedComment(cfg, row.issue_number, row.attempts, row.last_error ?? "unknown (crashed lap)", [])
        );
      } catch {}
      receipt(stateDir, `NOTE: reconciled #${row.issue_number} — crashed lap had exhausted attempts; marked blocked and notified`);
    }
    // else: in_progress + attempts < cap stays reclaimable; intake will pick it up
  }
}

export async function tickRepo(cfg: RepoConfig, stateDir: string, deps: TickDeps): Promise<string> {
  await ensureSource(stateDir, cfg);
  await reconcile(cfg, deps, stateDir);

  const pick = await pickClaimable(cfg, deps.ledger, deps.gh);
  if (!pick.issue) {
    const lapId = deps.ledger.startLap(cfg.repo, null);
    deps.ledger.endLap(lapId, "idle", pick.reason);
    receipt(stateDir, `idle: ${pick.reason}`);
    return "idle";
  }
  const issue = pick.issue;
  const n = issue.number;
  const priorRow = deps.ledger.getIssue(cfg.repo, n);
  if (!priorRow) {
    if (!deps.ledger.claim(cfg.repo, n)) return "idle"; // race with another surface
  } // else: reclaim of an interrupted lap — attempts carry over
  const lapId = deps.ledger.startLap(cfg.repo, n);
  const startAttempt = (priorRow?.attempts ?? 0) + 1;
  receipt(stateDir, `lap #${n} "${issue.title}" (attempt base ${startAttempt}, PR: ${priorRow?.pr ?? "none"})`);

  mkdirSync(issueDir(stateDir, cfg.slug, n), { recursive: true });
  mkdirSync(sessionDirOf(stateDir, cfg.slug, n), { recursive: true });
  const sessDir = sessionDirOf(stateDir, cfg.slug, n);

  // a reclaimed (interrupted) lap reuses its persisted plan instead of re-planning
  let plan: string | null = null;
  const planPath = join(issueDir(stateDir, cfg.slug, n), "plan.md");
  if (existsSync(planPath)) {
    try {
      plan = readFileSync(planPath, "utf8");
    } catch {}
  }
  let pr: number | null = priorRow?.pr ?? null;
  let findings: string | null = null;
  let lastError = "attempts exhausted";

  const recordStage = (
    stage: StageName,
    attempt: number,
    models: StageModels,
    res: PiStageResult
  ) => {
    const id = deps.ledger.startStage(cfg.repo, n, lapId, stage, attempt, modelStr(models.base));
    const outcome = res.outcome;
    deps.ledger.endStage(
      id,
      outcome.kind,
      outcome.kind === "ok" ? outcome.usage : null,
      outcome.kind === "ok" ? null : "error" in outcome ? outcome.error : outcome.kind
    );
  };

  let outcome: string | null = null;

  outer: for (let attempt = startAttempt; attempt <= cfg.attempts; attempt++) {
    deps.ledger.setIssue(cfg.repo, n, { attempts: attempt });
    receipt(stateDir, `lap #${n} attempt ${attempt}/${cfg.attempts}${findings ? " (repair)" : ""}`);

    // ---- PLAN (once per issue; retries on later attempts if it failed)
    if (plan === null) {
      const models = resolveModels(cfg, "plan");
      const res = await deps.callStage("plan", {
        models,
        prompt: buildPlanPrompt(cfg, issue),
        systemPrompt: PLANNER_SYSTEM,
        cwd: join(stateDir, "repos", cfg.slug, "source"),
        tools: cfg.pi.plan_tools,
        sessionDir: sessDir,
      });
      recordStage("plan", attempt, models, res);
      if (res.outcome.kind !== "ok") {
        lastError = `plan stage failed: ${"error" in res.outcome ? res.outcome.error : res.outcome.kind}`;
        deps.ledger.setIssue(cfg.repo, n, { last_error: lastError });
        receipt(stateDir, `attempt ${attempt} failed at plan: ${lastError}`);
        continue outer;
      }
      const parsed = parsePlan(res.outcome.text);
      if (parsed.kind === "no_action") {
        deps.ledger.setIssue(cfg.repo, n, { state: "no_action", last_error: null });
        try { await deps.gh.issueComment(n, noActionComment(parsed.reason ?? "")); } catch {}
        deps.ledger.endLap(lapId, "no_action", parsed.reason);
        receipt(stateDir, `lap #${n} → NO_ACTION: ${parsed.reason}`);
        outcome = "no_action";
        break outer;
      }
      plan = parsed.plan!;
      writeFileSync(join(issueDir(stateDir, cfg.slug, n), "plan.md"), plan);
    }

    // ---- IMPLEMENT (worktree is created once, reused across repairs of this issue)
    const worktree = await addWorktree(stateDir, cfg, n);
    const implModels = resolveModels(cfg, "implement");
    const implRes = await deps.callStage("implement", {
      models: implModels,
      prompt: buildImplementPrompt(cfg, issue, plan, { attempt, findings }),
      systemPrompt: IMPLEMENTER_SYSTEM,
      cwd: worktree,
      tools: cfg.pi.tools,
      sessionDir: sessDir,
    });
    recordStage("implement", attempt, implModels, implRes);
    if (implRes.outcome.kind !== "ok") {
      lastError = `implement stage failed: ${"error" in implRes.outcome ? implRes.outcome.error : implRes.outcome.kind}`;
      deps.ledger.setIssue(cfg.repo, n, { last_error: lastError });
      receipt(stateDir, `attempt ${attempt} failed at implement: ${lastError}`);
      continue outer;
    }

    // deterministic post-gates — self-report is never trusted
    const dirty = await uncommitted(worktree);
    if (dirty.length > 0) {
      lastError = `implementer left ${dirty.length} uncommitted change(s): ${dirty.slice(0, 5).join(" | ")}`;
      deps.ledger.setIssue(cfg.repo, n, { last_error: lastError });
      receipt(stateDir, `attempt ${attempt} failed at changed gate: ${lastError}`);
      continue outer;
    }
    const ahead = await commitsAhead(worktree, cfg.default_branch);
    if (ahead === 0) {
      lastError = "no commits ahead of base — nothing was implemented";
      deps.ledger.setIssue(cfg.repo, n, { last_error: lastError });
      receipt(stateDir, `attempt ${attempt} failed at changed gate: ${lastError}`);
      continue outer;
    }
    const paths = await changedPaths(worktree, cfg.default_branch);
    if (lockfileOnly(paths)) {
      lastError = `only lockfiles changed (${paths.join(", ")})`;
      deps.ledger.setIssue(cfg.repo, n, { last_error: lastError });
      receipt(stateDir, `attempt ${attempt} failed at changed gate: ${lastError}`);
      continue outer;
    }

    await pushBranch(worktree, n);
    if (pr === null) {
      pr = await deps.gh.prCreate(branchName(n), cfg.default_branch, `[#${n}] ${issue.title}`, prBody(cfg, issue, plan));
      deps.ledger.setIssue(cfg.repo, n, { branch: branchName(n), pr });
      receipt(stateDir, `lap #${n} opened PR #${pr}`);
    }

    // ---- VERIFY (all deterministic)
    const v = await runVerify(cfg, deps.gh, { stateDir, issue: n, worktree, pr });
    if (!v.pass) {
      findings = v.failures.map((f) => `[${f.gate}] ${f.detail}`).join("\n");
      lastError = `verification failed:\n${findings}`;
      deps.ledger.setIssue(cfg.repo, n, { last_error: lastError });
      receipt(stateDir, `attempt ${attempt} failed at verify: ${findings.replace(/\n/g, " ; ")}`);
      continue outer;
    }

    // ---- REVIEW (independent, read-only; unparseable → one re-ask → fail closed as REJECT)
    const revModels = resolveModels(cfg, "review");
    const callReview = () =>
      deps.callStage("review", {
        models: revModels,
        prompt: buildReviewPrompt(cfg, issue, { plan, scenarioSummary: scenarioSummary(v.scenarios), attempt }),
        systemPrompt: REVIEWER_SYSTEM,
        cwd: worktree,
        tools: cfg.pi.plan_tools,
        sessionDir: sessDir,
      });
    let revRes = await callReview();
    recordStage("review", attempt, revModels, revRes);
    if (revRes.outcome.kind === "ok" && parseVerdict(revRes.outcome.text).verdict === "unparseable") {
      receipt(stateDir, `lap #${n} review verdict unparseable — re-asking once`);
      revRes = await callReview();
    }
    if (revRes.outcome.kind !== "ok") {
      lastError = `review stage failed: ${"error" in revRes.outcome ? revRes.outcome.error : revRes.outcome.kind}`;
      deps.ledger.setIssue(cfg.repo, n, { last_error: lastError });
      receipt(stateDir, `attempt ${attempt} failed at review: ${lastError}`);
      continue outer;
    }
    const verdict = parseVerdict(revRes.outcome.text);
    if (verdict.verdict === "unparseable") {
      verdict.verdict = "reject";
      verdict.findings = "review verdict unparseable after re-ask — failing closed:\n" + revRes.outcome.text.slice(0, 1500);
    }
    if (verdict.verdict === "reject") {
      findings = verdict.findings;
      lastError = `review rejected:\n${findings}`;
      deps.ledger.setIssue(cfg.repo, n, { last_error: lastError });
      receipt(stateDir, `attempt ${attempt} failed at review: REJECT — ${findings.replace(/\n/g, " ; ").slice(0, 300)}`);
      continue outer;
    }

    // ---- MERGE (all gates green + APPROVE)
    await deps.gh.prMerge(pr, cfg.merge.method, cfg.merge.delete_branch);
    try {
      const iv = await deps.gh.issueView(n);
      if (iv.state?.toLowerCase() === "open") await deps.gh.issueClose(n);
    } catch {}
    await removeWorktree(stateDir, cfg, n, { deleteBranch: true });
    deps.ledger.setIssue(cfg.repo, n, { state: "merged", last_error: null });
    deps.ledger.endLap(lapId, "merged", `PR #${pr}`);
    receipt(stateDir, `lap #${n} MERGED via PR #${pr} (squash) — ledger closed`);
    try { await deps.gh.issueComment(n, mergedComment(cfg, pr, n)); } catch {}
    outcome = "merged";
    break outer;
  }

  if (outcome === null) {
    // attempts exhausted — blocked, notified, and never auto-re-picked
    deps.ledger.setIssue(cfg.repo, n, { state: "blocked", last_error: lastError });
    try {
      await deps.gh.issueComment(n, blockedComment(cfg, n, cfg.attempts, lastError, []));
    } catch {}
    deps.ledger.endLap(lapId, "blocked", lastError);
    receipt(stateDir, `lap #${n} BLOCKED after ${cfg.attempts} attempts: ${lastError.replace(/\n/g, " ; ").slice(0, 300)}`);
    outcome = "blocked";
  }
  return outcome;
}

export function discoverConfigs(stateDir: string, slug?: string): RepoConfig[] {
  const reposDir = join(stateDir, "repos");
  let entries: string[] = [];
  try {
    entries = readdirSync(reposDir);
  } catch {
    throw new Error(`no repos configured — nothing at ${reposDir}. Run: foreman onboard <owner/name>`);
  }
  if (slug) return [loadRepoConfig(join(reposDir, slug, "config.json"))];
  return entries
    .filter((e) => e !== "source")
    .map((e) => loadRepoConfig(join(reposDir, e, "config.json")))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function runTick(opts: { stateDir: string; repoSlug?: string }) {
  mkdirSync(opts.stateDir, { recursive: true });
  const { acquireTickLock, releaseTickLock } = await import("./lock");
  if (!acquireTickLock(opts.stateDir)) {
    receipt(opts.stateDir, "tick skipped: another tick is live (pidfile)");
    return;
  }
  try {
    const ledger = new Ledger(join(opts.stateDir, "factory.db"));
    for (const cfg of discoverConfigs(opts.stateDir, opts.repoSlug)) {
      try {
        await tickRepo(cfg, opts.stateDir, { ledger, gh: new Gh(cfg.repo), callStage: makeCallStage(cfg) });
      } catch (e: any) {
        // infra failure (git/gh/network) — receipt and move on; in_progress
        // rows are reconciled next tick, never lost
        receipt(opts.stateDir, `tick error on ${cfg.slug}: ${e.message?.slice(0, 300)}`);
      }
    }
  } finally {
    releaseTickLock(opts.stateDir);
  }
}
