import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, join } from "node:fs";
import { join } from "node:path";
import { loadRepoConfig, resolveModels } from "./config";
import { buildStageCmd } from "./env";
import { Gh, type GhApi } from "./gh";
import { branchName, issueDir, sessionDir as sessionDirOf, addWorktree, commitsAhead, changedPaths, ensureSource, lockfileOnly, pushBranch, removeWorktree, uncommitted } from "./gitws";
import { Ledger } from "./ledger";
import { blockedComment, mergedComment, needsContextComment, noActionComment } from "./notify";
import { callPiWithFallback, type PiStageResult } from "./pi";
import { receipt } from "./receipts";
import { scenarioSummary, runVerify } from "./stages/verify";
import { listClaimable, NEEDS_INFO_LABEL } from "./stages/intake";
import { buildPlanPrompt, parsePlan, PLANNER_SYSTEM } from "./stages/plan";
import { buildImplementPrompt, IMPLEMENTER_SYSTEM } from "./stages/implement";
import { buildReviewPrompt, parseVerdict, REVIEWER_SYSTEM } from "./stages/review";
import type { IssueLite, ModelSpec, RepoConfig, StageModels, StageName } from "./types";

export interface CallStageArgs {
  models: StageModels;
  prompt: string;
  systemPrompt: string;
  cwd: string;
  tools: string[];
  sessionDir: string;
  /** unique docker --name / receipt key for this stage invocation */
  name: string;
}

export type CallStageFn = (
  stage: StageName,
  args: CallStageArgs
) => Promise<PiStageResult>;

/** per-stage wall-clock minutes; a hung stream is killed, never waited on forever */
const stageMinutes = (cfg: RepoConfig, stage: StageName): number =>
  (cfg.timeouts as any)[`${stage}_minutes`] ?? cfg.timeouts.stage_minutes;

export function makeCallStage(cfg: RepoConfig, stateDir: string): CallStageFn {
  return async (stage, a) => {
    // container mode: pi runs inside the product's worker environment
    const envBuild = buildStageCmd(cfg, a.cwd, stateDir, a.name);
    const base = {
      binary: cfg.pi.binary,
      cwd: a.cwd,
      tools: a.tools,
      sessionDir: a.sessionDir,
      systemPrompt: a.systemPrompt,
      extraArgs: cfg.pi.extra_args,
      timeoutMs: stageMinutes(cfg, stage) * 60_000,
    };
    const runnerPrefix = envBuild.containerized
      ? { argvPrefix: envBuild.argvPrefix, cleanupArgv: envBuild.cleanup }
      : undefined;
    let res = await callPiWithFallback(
      { ...base, prompt: a.prompt, runnerPrefix },
      a.models
    );
    // Stream-death continue: when the model stream is cut or the stage burns
    // its clock, the completed turns already live in the session file (and
    // the worktree files persist) — re-open the SAME session with a continue
    // nudge instead of discarding minutes of tool work on a from-scratch rerun.
    // Continue-gate: progress-based, not count-based — keep resuming while
    // the session keeps growing (the human pattern: press continue as long
    // as something is happening), bounded by 2x the stage budget so a
    // pathologically stuck pair can't wedge a lap forever.
    const continueDeadline = Date.now() + base.timeoutMs * 2;
    let lastGrowth = { file: "", size: -1 };
    for (let resumes = 0; resumes < 8; resumes++) {
      const o = res.outcome;
      const dead =
        (o.kind === "provider_error" && /terminated|timed out|no assistant message/i.test(o.error ?? "")) ||
        o.kind === "timeout";
      if (!dead || !a.sessionDir) break;
      if (Date.now() >= continueDeadline) break;
      const newest = newestSessionFile(a.sessionDir);
      if (!newest) break;
      // progress gate: a resume that writes nothing new cannot fix anything
      let size = -1;
      try { size = statSync(newest).size; } catch {}
      if (newest === lastGrowth.file && size === lastGrowth.size) break;
      lastGrowth = { file: newest, size };
      res = await callPiWithFallback(
        {
          ...base,
          prompt:
            "Continue from exactly where you left off in this session — complete the outstanding work and produce the required final output.",
          runnerPrefix,
          extraArgs: [...base.extraArgs, "--session", newest],
        },
        a.models
      );
    }
    return res;
  };
}

function newestSessionFile(dir: string): string | null {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }));
    if (files.length === 0) return null;
    files.sort((a, b) => b.m - a.m);
    return join(dir, files[0].f);
  } catch {
    return null;
  }
}

const modelStr = (m: ModelSpec) => `${m.provider}/${m.model}${m.thinking ? `:${m.thinking}` : ""}`;

/**
 * Unparseable review verdicts are re-asked this many times before the text
 * fails closed as REJECT. Flash-tier reviewers occasionally emit prose without
 * the verdict line; a re-ask is cheap next to the repair round a false REJECT
 * burns.
 */
const REVIEW_REASKS = 5;

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
 * Per-repo git mutex: parallel laps share one source checkout, and git is
 * not fond of concurrent `worktree add` / `fetch && reset` on the same .git.
 */
const sourceLocks = new Map<string, Promise<unknown>>();
async function withSourceLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = sourceLocks.get(slug) ?? Promise.resolve();
  const task = prev.then(fn, fn);
  sourceLocks.set(slug, task.catch(() => {}));
  return task;
}

/**
 * Crash reconciliation — the anti-wedge pass. During a tick, ANY in_progress
 * row is by definition an interrupted lap (laps only run inside ticks):
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

/** fetch + reset main, close the books on crashed laps — once per repo per tick */
export async function prepareRepo(cfg: RepoConfig, stateDir: string, deps: TickDeps): Promise<void> {
  await withSourceLock(cfg.slug, () => ensureSource(stateDir, cfg));
  await reconcile(cfg, deps, stateDir);
}

export async function runLap(cfg: RepoConfig, stateDir: string, deps: TickDeps, issue: IssueLite): Promise<string> {
  const n = issue.number;
  const priorRow = deps.ledger.getIssue(cfg.repo, n);
  if (!priorRow) {
    if (!deps.ledger.claim(cfg.repo, n)) return "claimed-elsewhere"; // race
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
    const runTag = `${attempt}-${Date.now().toString(36)}`;
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
        name: `pdf-${cfg.slug}-${n}-plan-${runTag}`,
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
      if (parsed.kind === "insufficient_context") {
        // The planner needs a product decision from the issue author. Park the
        // issue on GitHub under the gate label and drop the claim — the label
        // alone keeps intake away, so a fresh lap (with a clean attempt count)
        // starts the moment the human answers and removes it.
        deps.ledger.endLap(lapId, "needs_context", parsed.question);
        try {
          await deps.gh.issueComment(n, needsContextComment(cfg, n, parsed.question ?? "", parsed.assumptions ?? ""));
          await deps.gh.issueAddLabels(n, [NEEDS_INFO_LABEL]);
        } catch {}
        deps.ledger.dropIssue(cfg.repo, n);
        receipt(stateDir, `lap #${n} NEEDS_CONTEXT (parked under ${NEEDS_INFO_LABEL}): ${parsed.question}`);
        outcome = "needs_context";
        break outer;
      }
      plan = parsed.plan!;
      writeFileSync(join(issueDir(stateDir, cfg.slug, n), "plan.md"), plan);
    }

    // ---- IMPLEMENT (worktree is created once, reused across repairs of this issue)
    const worktree = await withSourceLock(cfg.slug, () => addWorktree(stateDir, cfg, n));
    const implModels = resolveModels(cfg, "implement");
    const implRes = await deps.callStage("implement", {
      models: implModels,
      prompt: buildImplementPrompt(cfg, issue, plan, { attempt, findings }),
      systemPrompt: IMPLEMENTER_SYSTEM,
      cwd: worktree,
      tools: cfg.pi.tools,
      sessionDir: sessDir,
      name: `pdf-${cfg.slug}-${n}-impl-${runTag}`,
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

    // ---- REVIEW (independent, read-only; unparseable → re-ask up to 5× → fail closed as REJECT)
    const revModels = resolveModels(cfg, "review");
    const callReview = () =>
      deps.callStage("review", {
        models: revModels,
        prompt: buildReviewPrompt(cfg, issue, { plan, scenarioSummary: scenarioSummary(v.scenarios), attempt }),
        systemPrompt: REVIEWER_SYSTEM,
        cwd: worktree,
        tools: cfg.pi.plan_tools,
        sessionDir: sessDir,
        name: `pdf-${cfg.slug}-${n}-rev-${runTag}`,
      });
    let revRes = await callReview();
    recordStage("review", attempt, revModels, revRes);
    let reask = 0;
    while (
      revRes.outcome.kind === "ok" &&
      parseVerdict(revRes.outcome.text).verdict === "unparseable" &&
      reask < REVIEW_REASKS
    ) {
      reask++;
      receipt(stateDir, `lap #${n} review verdict unparseable — re-ask ${reask}/${REVIEW_REASKS}`);
      revRes = await callReview();
      recordStage("review", attempt, revModels, revRes);
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
      verdict.findings = "review verdict unparseable after " + REVIEW_REASKS + " re-asks — failing closed:\n" + revRes.outcome.text.slice(0, 1500);
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
    await withSourceLock(cfg.slug, () => removeWorktree(stateDir, cfg, n, { deleteBranch: true }));
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

/** one lap, single-issue convenience (used by tests and single-lap debugging) */
export async function tickRepo(cfg: RepoConfig, stateDir: string, deps: TickDeps): Promise<string> {
  await prepareRepo(cfg, stateDir, deps);
  const claimable = await listClaimable(cfg, deps.ledger, deps.gh);
  if (claimable.length === 0) {
    const lapId = deps.ledger.startLap(cfg.repo, null);
    deps.ledger.endLap(lapId, "idle", "no claimable issue (all claimed, labeled, PR'd, or dependency-blocked)");
    receipt(stateDir, "idle: no claimable issue");
    return "idle";
  }
  return runLap(cfg, stateDir, deps, claimable[0]);
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

/**
 * Every claimable issue of every repo becomes a lap; they run in parallel.
 * Limit 0 (the default) means unlimited — the host's own resources are the
 * only quota. Pass --concurrency N (or PI_FACTORY_CONCURRENCY) to cap it.
 */
export async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (limit <= 0) {
    await Promise.all(items.map(fn));
    return;
  }
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

export async function runTick(opts: { stateDir: string; repoSlug?: string; concurrency?: number }) {
  mkdirSync(opts.stateDir, { recursive: true });
  const { acquireTickLock, releaseTickLock } = await import("./lock");
  if (!acquireTickLock(opts.stateDir)) {
    receipt(opts.stateDir, "tick skipped: another tick is live (pidfile)");
    return;
  }
  try {
    const ledger = new Ledger(join(opts.stateDir, "factory.db"));
    const tasks: (() => Promise<void>)[] = [];
    for (const cfg of discoverConfigs(opts.stateDir, opts.repoSlug)) {
      try {
        const deps: TickDeps = { ledger, gh: new Gh(cfg.repo), callStage: makeCallStage(cfg, opts.stateDir) };
        await prepareRepo(cfg, opts.stateDir, deps);
        const claimable = await listClaimable(cfg, deps.ledger, deps.gh);
        // One lap per repo per tick — by design. The splice is a dependency
        // chain, and strictly ordered one-at-a-time delivery is what keeps
        // main conflict-free (concurrent branches produced union-merge
        // reconciles and a stranded branch in the previous factory's runs).
        // Repos fan out in parallel; a repo dives issue by issue, topologically.
        if (claimable.length > 0) {
          const issue = claimable[0];
          receipt(opts.stateDir, `queued: ${cfg.slug} #${issue.number} (${claimable.length - 1} claimable behind it)`);
          tasks.push(async () => {
            try {
              await runLap(cfg, opts.stateDir, deps, issue);
            } catch (e: any) {
              // infra failure (git/gh/network) — receipt and move on; the
              // in_progress row is reconciled next tick, never lost
              receipt(opts.stateDir, `lap #${issue.number} error on ${cfg.slug}: ${e.message?.slice(0, 300)}`);
            }
          });
        }
      } catch (e: any) {
        receipt(opts.stateDir, `tick error on ${cfg.slug}: ${e.message?.slice(0, 300)}`);
      }
    }
    const limit = opts.concurrency ?? 0;
    receipt(opts.stateDir, `dispatching ${tasks.length} lap(s), concurrency=${limit > 0 ? limit : "unlimited"}`);
    await runWithConcurrency(tasks, limit, (t) => t());
  } finally {
    releaseTickLock(opts.stateDir);
  }
}
