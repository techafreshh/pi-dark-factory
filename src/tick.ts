import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { loadRepoConfig, resolveModels } from "./config";
import { buildStageCmd } from "./env";
import { sh } from "./sh";
import { Gh, type GhApi } from "./gh";
import { branchName, issueDir, sessionDir as sessionDirOf, sourceDir, sourceDir as sourceDirOf, worktreeDir, addWorktree, changedPaths, changedPathsFromRef, commitsAhead, commitsAheadRef, ensureSource, fetchBranch, lockfileOnly, pushBranch, removeWorktree, uncommitted } from "./gitws";
import { machineNameFor } from "./instabox";
import { openLapMachine, type LapMachine } from "./machine";
import { Ledger } from "./ledger";
import { blockedComment, mergedComment, needsContextComment, noActionComment } from "./notify";
import { callPiWithFallback, type PiStageResult } from "./pi";
import { receipt } from "./receipts";
import { scenarioSummary, runVerify } from "./stages/verify";
import { listClaimable, NEEDS_INFO_LABEL } from "./stages/intake";
import { buildPlanPrompt, parsePlan, PLANNER_SYSTEM } from "./stages/plan";
import { buildImplementPrompt, IMPLEMENTER_SYSTEM } from "./stages/implement";
import { buildReviewPrompt, parseVerdict, REVIEWER_SYSTEM } from "./stages/review";
import { buildRuntimeContext } from "./runtime-context";
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
  /** "where am I" brief — written to the cwd and prepended to the prompt */
  runtimeContext?: string;
}

export type CallStageFn = (
  stage: StageName,
  args: CallStageArgs
) => Promise<PiStageResult>;

/** per-stage wall-clock minutes; a hung stream is killed, never waited on forever */
const stageMinutes = (cfg: RepoConfig, stage: StageName): number =>
  (cfg.timeouts as any)[`${stage}_minutes`] ?? cfg.timeouts.stage_minutes;

/**
 * Quiet-kill: a live run never goes silent for long — thinking streams as
 * reasoning deltas and tool calls emit partial output — so N minutes of zero
 * stdout/stderr bytes means a hung tool process (e.g. a test run that never
 * exits), a wedged turn, or a stalled provider request. Kill it early so the
 * outcome reads "timeout" and the continue-ladder resumes the session at
 * once, instead of freezing until the full stage budget expires. The window
 * must exceed the slowest legitimate silent stretch (a quiet build/install
 * mid-tool), hence 15 minutes.
 */
const QUIET_KILL_MS = 15 * 60_000;

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
      quietMs: QUIET_KILL_MS,
    };
    // "where am I" brief: prepended to the prompt (zero tool calls to see
    // it) and — where the working tree is local — written to disk beside it.
    // Machine-mode stages (implement/review in-box) get it prompt-only; the
    // box clone holds no host-side file.
    if (a.runtimeContext) {
      if (cfg.env?.mode !== "instabox") {
        try {
          writeFileSync(a.cwd + "/.factory-context.md", a.runtimeContext + "\n");
        } catch {}
      }
    }
    const withContext = a.runtimeContext ? a.runtimeContext + "\n\n---\n\n" + a.prompt : a.prompt;
    const runnerPrefix = envBuild.containerized
      ? { argvPrefix: envBuild.argvPrefix, cleanupArgv: envBuild.cleanup }
      : undefined;
    if (runnerPrefix) {
      // container mode: sweep this repo's leaked stage containers before
      // spawning — a container from a killed lap holds the published
      // scenario ports and would fail every spawn with "port is already
      // allocated"
      const sweep = await sh(
        ["bash", "-c",
         // root-owned files from container stages (sessions, trust state)
         // would starve the factory user's own pi — repair ownership via a
         // root container through the docker socket (factory has no host sudo)
         `docker run --rm -v /home/factory/.pi:/fix alpine chown -R 1001:1001 /fix 2>/dev/null || true; ` +
         `docker ps -aq --filter name=pdf-${cfg.slug}- | xargs -r docker rm -f` +
         // a container publishing this repo's reserved scenario ports (any
         // name: a leaked compose stack, a foreign project) blocks every
         // spawned stage with "port is already allocated" — remove holders
         // name-agnostically; the ports are reserved to this repo by config
         (cfg.scenario.ports ?? []).map((p) => `; docker ps -aq --filter publish=${p} | xargs -r docker rm -f`).join("") +
         // self-heal the pi launcher's node seed: /usr/local/bin/pi (mounted
         // from .pi/agent/bin/pi) execs .pi/host-runtimes/node/bin/node —
         // when that binary goes missing (vanished twice on 2026-10-23, actor
         // unknown) every container spawn dies with exit 127. Re-copy it from
         // the factory user's node before the stage needs it, and RECEIPT the
         // repair so the disappearance window is time-stamped in laps.log.
         `; SEED=/home/factory/.pi/host-runtimes/node/bin/node; ` +
         `if [ ! -x $SEED ] && SRC=$(bash -lc 'command -v node' 2>/dev/null) && [ -x $SRC ]; ` +
         `then mkdir -p $(dirname $SEED) && cp $SRC $SEED && echo seed-repaired; fi`],
        { timeoutMs: 30000 }
      ).catch(() => null);
      if (sweep?.stdout?.includes("seed-repaired")) {
        receipt(stateDir, `seed-repaired: .pi/host-runtimes/node/bin/node was missing and re-copied — container spawns would have exited 127 (no /root/.pi mount change; a copy-erasing actor is at work — monitor laps.log for this line's timestamps)`);
      }
    }
    let res = await callPiWithFallback(
      { ...base, prompt: withContext, runnerPrefix },
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
            (a.runtimeContext ? a.runtimeContext + "\n\n---\n\n" : "") +
            "Continue from exactly where you left off in this session — complete the outstanding work and produce the required final output.",
          runnerPrefix,
          extraArgs: [...base.extraArgs, "--session", newest],
        },
        a.models
      );
    }
    if (runnerPrefix) await chownBack(stateDir, cfg, [a.cwd]);
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
  // instabox machine mode: one machine per issue's lap, created lazily at the
  // first implement attempt and kept across repairs; destroyed when the lap
  // books out (a crashed lap leaves it parked for reclaim + the janitor)
  let machine: LapMachine | null = null;

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

  // "where am I" brief builder — the per-stage runtime context every agent
  // gets (prompt preamble; host/compose modes also write it to disk beside
  // the work). The instabox branch keys the "where" on the stage: the plan
  // runs host-side even in machine mode, implement/review run in the box.
  const contextFor = (stage: StageName, attempt: number, cwd: string): string =>
    buildRuntimeContext(cfg, {
      repo: cfg.repo,
      slug: cfg.slug,
      issue: n,
      issueTitle: issue.title.slice(0, 120),
      stage,
      attempt,
      attemptsMax: cfg.attempts,
      branch: branchName(n),
      base: cfg.default_branch,
      mode: cfg.env.mode,
      where:
        cfg.env.mode === "instabox"
          ? stage === "plan"
            ? `on the factory VPS as plain processes — the plan stage stays host-side even in machine mode; the lap's InstaBox machine (${machineNameFor(cfg.slug, n)}) is created afterward for implement/review`
            : `your own ephemeral InstaBox machine "${machineNameFor(cfg.slug, n)}" — its own kernel and root; the clone of ${cfg.repo} lives at ${cfg.env.instabox.repo_dir}; gh and the toolchain are preinstalled and signed in`
          : cfg.env.mode === "compose"
            ? `inside the product's own docker compose "worker" service — a root, ephemeral container; the repo and factory state are bind-mounted at their host paths; the model API resolves via the factory-injected host-gateway`
            : `on the factory VPS as plain processes (no container); the model API resolves via the factory-injected host-gateway`,
      cwd,
      toolchain:
        cfg.env.mode === "instabox"
          ? `whatever the machine snapshot ships — node, git, gh (signed in), curl; network egress allowed`
          : cfg.env.mode === "compose"
            ? `the worker image provides the runtime; the factory injects git identity + safe.directory and the pi binary at /usr/local/bin/pi; test servers bind INSIDE this container only`
            : `factory user environment on the VPS: node, bun, git, gh all on PATH`,
    });

  try {
  // connection-blip backoff: an attempt that dies within ~2 minutes to a
  // connection-class error (model API/edge hiccup, router pass-through reset)
  // made zero progress — chained insta-fails must not burn the attempt
  // budget, so give the upstream edge a cooldown before the next attempt.
  // Real stage work (gates, reviews, genuine turn failures) takes minutes and
  // never trips this.
  const CONNECTION_BLIP_RE =
    /connection error|connection (terminated|reset)|econn(reset|refused)|socket hang up|fetch failed|terminated/i;
  const RAPID_FAIL_MS = 120_000;
  const BLIP_COOLDOWN_MS = 120_000;
  let prevStart: number | null = null;

  outer: for (let attempt = startAttempt; attempt <= cfg.attempts; attempt++) {
    if (
      prevStart !== null &&
      Date.now() - prevStart < RAPID_FAIL_MS &&
      CONNECTION_BLIP_RE.test(lastError)
    ) {
      receipt(
        stateDir,
        `attempt ${attempt - 1} died fast to a connection-class error — cooling down ${BLIP_COOLDOWN_MS / 1000}s before attempt ${attempt} (blips shouldn't burn the attempt budget)`
      );
      await new Promise((r) => setTimeout(r, BLIP_COOLDOWN_MS));
    }
    prevStart = Date.now();
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
        runtimeContext: buildRuntimeContext(cfg, {
          repo: cfg.repo,
          slug: cfg.slug,
          issue: n,
          issueTitle: issue.title.slice(0, 120),
          stage: "plan",
          attempt,
          attemptsMax: cfg.attempts,
          branch: branchName(n),
          base: cfg.default_branch,
          mode: cfg.env.mode,
          where:
            cfg.env.mode === "instabox"
              ? `on the factory VPS as plain processes — the plan stage stays host-side even in machine mode; the lap's InstaBox machine (${machineNameFor(cfg.slug, n)}) is created afterward for implement/review`
              : cfg.env.mode === "compose"
                ? `on the factory VPS as plain processes (no container)`
                : `on the factory VPS as plain processes (no container)`,
          cwd: join(stateDir, "repos", cfg.slug, "source"),
          toolchain: "factory user environment on the VPS: node, bun, git, gh all on PATH",
        }),
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

    // ---- IMPLEMENT (machine mode: the machine's clone IS the worktree —
    // created once, reused across repairs; the machine runs the same gates
    // and pushes the branch itself)
    const implModels = resolveModels(cfg, "implement");
    const implPrompt = buildImplementPrompt(cfg, issue, plan, { attempt, findings });
    let worktree: string | null = null;
    let implRes: PiStageResult;
    if (cfg.env.mode === "instabox") {
      machine ??= openLapMachine(cfg, n, (m) => receipt(stateDir, m));
      const machRes = await machine.callStage("implement", {
        models: implModels,
        prompt:
          contextFor("implement", attempt, cfg.env.instabox.repo_dir) + "\n\n---\n\n" + implPrompt,
        systemPrompt: IMPLEMENTER_SYSTEM,
        tools: cfg.pi.tools,
        extraArgs: cfg.pi.extra_args,
        timeoutMs: stageMinutes(cfg, "implement") * 60_000,
      });
      if (machRes.raw) writeFileSync(join(issueDir(stateDir, cfg.slug, n), `implement-${attempt}.jsonl`), machRes.raw);
      implRes = machRes;
    } else {
      worktree = await withSourceLock(cfg.slug, () => addWorktree(stateDir, cfg, n));
      implRes = await deps.callStage("implement", {
        models: implModels,
        prompt: implPrompt,
        runtimeContext: contextFor("implement", attempt, worktree),
        systemPrompt: IMPLEMENTER_SYSTEM,
        cwd: worktree,
        tools: cfg.pi.tools,
        sessionDir: sessDir,
        name: `pdf-${cfg.slug}-${n}-impl-${runTag}`,
      });
    }
    recordStage("implement", attempt, implModels, implRes);
    if (implRes.outcome.kind !== "ok") {
      lastError = `implement stage failed: ${"error" in implRes.outcome ? implRes.outcome.error : implRes.outcome.kind}`;
      deps.ledger.setIssue(cfg.repo, n, { last_error: lastError });
      receipt(stateDir, `attempt ${attempt} failed at implement: ${lastError}`);
      continue outer;
    }

    // deterministic post-gates — self-report is never trusted. Machine mode
    // already enforced cleanliness + commit-count inside the machine (their
    // failure failed the stage); the host re-judges the pushed branch from
    // its own git truth. Gate failures carry a repair directive into the next
    // attempt's findings either way — the machine's clone persists across
    // repair rounds, so the directive points the implementer back at it.
    let paths: string[];
    if (machine) {
      await withSourceLock(cfg.slug, () => fetchBranch(stateDir, cfg, n));
      const src = sourceDir(stateDir, cfg.slug);
      const ahead = await commitsAheadRef(src, cfg.default_branch, branchName(n));
      if (ahead === 0) {
        lastError = "machine pushed no commits ahead of base — nothing was implemented";
        findings = "The changed gate rejected your previous attempt: no commit was pushed on top of " + cfg.default_branch + " — nothing was implemented. Your clone persists in the machine at " + cfg.env.instabox.repo_dir + ": implement the issue per the plan and COMMIT the changes (git add -A && git commit). The stage driver pushes for you once the tree is clean.";
        deps.ledger.setIssue(cfg.repo, n, { last_error: lastError });
        receipt(stateDir, `attempt ${attempt} failed at changed gate: ${lastError}`);
        continue outer;
      }
      paths = await changedPathsFromRef(src, cfg.default_branch, branchName(n));
    } else {
      const dirty = await uncommitted(worktree!);
      if (dirty.length > 0) {
        lastError = `implementer left ${dirty.length} uncommitted change(s): ${dirty.slice(0, 5).join(" | ")}`;
        findings = `The changed gate rejected your previous attempt: you left ${dirty.length} uncommitted change(s) (${dirty.slice(0, 5).join(", ")}). Your edits persist in the worktree — run git status, finish the work, and git add -A && git commit EVERYTHING before you finish. An attempt that ends with uncommitted changes is discarded as if it did nothing.`;
        deps.ledger.setIssue(cfg.repo, n, { last_error: lastError });
        receipt(stateDir, `attempt ${attempt} failed at changed gate: ${lastError}`);
        continue outer;
      }
      const ahead = await commitsAhead(worktree!, cfg.default_branch);
      if (ahead === 0) {
        lastError = "no commits ahead of base — nothing was implemented";
        findings = `The changed gate rejected your previous attempt: no commits ahead of ${cfg.default_branch} — nothing was implemented. Implement the issue per the plan and COMMIT the changes (git add -A && git commit) before you finish.`;
        deps.ledger.setIssue(cfg.repo, n, { last_error: lastError });
        receipt(stateDir, `attempt ${attempt} failed at changed gate: ${lastError}`);
        continue outer;
      }
      paths = await changedPaths(worktree!, cfg.default_branch);
      await pushBranch(worktree!, n);
    }
    if (lockfileOnly(paths)) {
      lastError = `only lockfiles changed (${paths.join(", ")})`;
      findings = `The changed gate rejected your previous attempt: only lockfiles changed (${paths.join(", ")}). The commit gate needs the actual implementation committed on top of the base branch.`;
      deps.ledger.setIssue(cfg.repo, n, { last_error: lastError });
      receipt(stateDir, `attempt ${attempt} failed at changed gate: ${lastError}`);
      continue outer;
    }

    if (pr === null) {
      pr = await deps.gh.prCreate(branchName(n), cfg.default_branch, `[#${n}] ${issue.title}`, prBody(cfg, issue, plan));
      deps.ledger.setIssue(cfg.repo, n, { branch: branchName(n), pr });
      receipt(stateDir, `lap #${n} opened PR #${pr}`);
    }

    // ---- VERIFY (all deterministic)
    const v = await runVerify(cfg, deps.gh, { stateDir, issue: n, worktree: worktree ?? undefined, machine: machine ?? undefined, pr });
    if (!v.pass) {
      // receipt/ledger get the one-line summary; the repair round gets FULL
      // reproduction evidence (failing probe's command, expect, and the
      // actual response body) — the agent reproduces instead of guessing
      const summary = v.failures.map((f) => `[${f.gate}] ${f.detail}`).join("\n");
      findings = v.failures
        .map((f) => `[${f.gate}] ${f.detail}${f.repair ? "\n" + f.repair : ""}`)
        .join("\n\n");
      lastError = `verification failed:\n${summary}`;
      deps.ledger.setIssue(cfg.repo, n, { last_error: lastError });
      receipt(stateDir, `attempt ${attempt} failed at verify: ${summary.replace(/\n/g, " ; ")}`);
      continue outer;
    }

    // ---- REVIEW (independent, read-only; unparseable → re-ask up to 5× → fail closed as REJECT)
    const revModels = resolveModels(cfg, "review");
    const revPrompt = buildReviewPrompt(cfg, issue, { plan, scenarioSummary: scenarioSummary(v.scenarios), attempt });
    const reviewContext = contextFor("review", attempt, machine ? cfg.env.instabox.repo_dir : worktree!);
    const callReview = () =>
      machine
        ? machine.callStage("review", {
            models: revModels,
            prompt: reviewContext + "\n\n---\n\n" + revPrompt,
            systemPrompt: REVIEWER_SYSTEM,
            timeoutMs: stageMinutes(cfg, "review") * 60_000,
          })
        : deps.callStage("review", {
            models: revModels,
            prompt: revPrompt,
            systemPrompt: REVIEWER_SYSTEM,
            cwd: worktree!,
            tools: cfg.pi.plan_tools,
            sessionDir: sessDir,
            name: `pdf-${cfg.slug}-${n}-rev-${runTag}`,
            runtimeContext: reviewContext,
          });
    let revRes = await callReview();
    recordStage("review", attempt, revModels, revRes);
    {
      const raw = (revRes as PiStageResult & { raw?: string }).raw;
      if (raw) writeFileSync(join(issueDir(stateDir, cfg.slug, n), `review-${attempt}.jsonl`), raw);
    }
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
    if (machine) {
      // the machine's clone was the worktree — the host has nothing to clean;
      // the machine itself is destroyed in the finally below
    } else {
      // root-written files from containerized stages would EACCES the
      // host-side worktree removal — hand ownership back first
      await chownBack(stateDir, cfg, [worktreeDir(stateDir, cfg.slug, n)]);
      await withSourceLock(cfg.slug, () => removeWorktree(stateDir, cfg, n, { deleteBranch: true }));
    }
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
  } finally {
    // booked laps destroy their machine; a crashed lap leaves it parked for
    // reclaim (paused — storage only) and the cleanup janitor to reap
    if (machine && outcome !== null) await machine.destroy();
  }
  return outcome;
}

/** one lap, single-issue convenience (used by tests and single-lap debugging) */
export async function tickRepo(cfg: RepoConfig, stateDir: string, deps: TickDeps): Promise<string> {
  // revive BEFORE reconcile: past ticks' blocked rows get their fresh budget
  // first; a crash-blocked row from THIS tick's reconcile stays blocked until
  // the next explicit tick (conservative — a crash deserves a human look)
  autoReviveBlocked(cfg, stateDir, deps.ledger);
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

/**
 * Auto-revive — a lap that burns its attempt budget must not park the issue
 * behind a manual `unblock` (the factory has to heal its own retry ladder).
 * The NEXT tick grants the blocked issue a fresh attempt budget, bounded by
 * two fuses so autonomy never means unbounded spend:
 *  - stagnation: the same failure signature on ${STAGNATION_SAME} consecutive
 *    blocked rounds means the wheel is spinning — the row stays blocked for a
 *    human (deterministic walls like a broken stage setup reproduce
 *    verbatim; evolving review/gate findings don't), and
 *  - a daily cap of AUTO_REVIVE_DAILY_CAP revive rounds per issue.
 * Round bookkeeping lives in repos/<slug>/revives.json (factory-owned state).
 */
const AUTO_REVIVE_DAILY_CAP = 3;
const STAGNATION_SAME = 2;

export function autoReviveBlocked(cfg: RepoConfig, stateDir: string, ledger: Ledger): void {
  const file = join(stateDir, "repos", cfg.slug, "revives.json");
  let rs: { day: string; counts: Record<string, number>; sigs: Record<string, string[]> } = {
    day: "", counts: {}, sigs: {},
  };
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    j.counts ??= {};
    j.sigs ??= {};
    rs = j;
  } catch {}
  const day = new Date().toISOString().slice(0, 10);
  if (rs.day !== day) rs = { day, counts: {}, sigs: rs.sigs ?? {} };

  for (const row of ledger.listIssues(cfg.repo)) {
    if (row.state !== "blocked") continue;
    const sig = (row.last_error ?? "unknown failure").replace(/\s+/g, " ").trim().slice(0, 140);
    const sigs = rs.sigs[String(row.issue_number)] ?? [];
    if (sigs.length >= STAGNATION_SAME && sigs.slice(-STAGNATION_SAME).every((s) => s === sig)) {
      receipt(
        stateDir,
        `NOT auto-reviving #${row.issue_number} — same failure signature ${sigs.length + 1} blocked rounds in a row, the wheel is spinning: human review required (${sig.slice(0, 100)})`
      );
      continue;
    }
    const used = rs.counts[String(row.issue_number)] ?? 0;
    if (used >= AUTO_REVIVE_DAILY_CAP) {
      receipt(
        stateDir,
        `NOT auto-reviving #${row.issue_number} — auto-revive daily cap (${AUTO_REVIVE_DAILY_CAP}) reached; human review required (last blocker: ${sig.slice(0, 100)})`
      );
      continue;
    }
    rs.counts[String(row.issue_number)] = used + 1;
    rs.sigs[String(row.issue_number)] = [...sigs, sig].slice(-4);
    ledger.setIssue(cfg.repo, row.issue_number, { state: "in_progress", attempts: 0 });
    receipt(
      stateDir,
      `AUTO-REVIVE #${row.issue_number} (round ${used + 1}/${AUTO_REVIVE_DAILY_CAP} today) — repair ladder continues with a fresh attempt budget; previous blocker: ${sig.slice(0, 110)}`
    );
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(rs, null, 2));
  } catch {}
}

/**
 * Hand root-written files back to the factory uid. Containerized stages (the
 * product's compose worker, fallback images) run as root and write into the
 * bind-mounted worktree — and, through git's shared object database, into the
 * source repo's .git. Host-side git (factory user) then EACCESes on cleanup
 * and even on `git fetch`. The factory has docker access but no sudo, so the
 * chown runs through a throwaway root container (same pattern as the .pi
 * sweep before stages).
 */
/** Chown target: the invoking user — the factory user (1001) in production,
 * whoever runs the tests elsewhere. A hardcoded 1001 left test trees owned by
 * factory after the docker-root chown, and the test runner (ubuntu) then
 * EACCESed on its own cleanup. */
const chownTarget = () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1001;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1001;
  return `${uid}:${gid}`;
};

export async function chownBack(stateDir: string, cfg: RepoConfig, extraDirs: string[] = []): Promise<void> {
  const dirs = [sourceDirOf(stateDir, cfg.slug), ...extraDirs];
  for (const d of dirs) {
    await sh(["docker", "run", "--rm", "-v", `${d}:/fix`, "alpine", "chown", "-R", chownTarget(), "/fix"], {
      timeoutMs: 600000,
    }).catch(() => {});
  }
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
        // revive before prepareRepo/reconcile — see tickRepo's ordering note
        autoReviveBlocked(cfg, opts.stateDir, deps.ledger);
        await prepareRepo(cfg, opts.stateDir, deps);
        const claimable = await listClaimable(cfg, deps.ledger, deps.gh);
        // Chained laps: a merge (or block/idle) re-intakes immediately, so one
        // tick drains the dependency chain instead of doling out one issue per
        // manual tick. Strictly ordered one-lap-at-a-time still holds inside a
        // repo (that ordering is what keeps main conflict-free), and
        // MAX_LAPS bounds a pathological loop — the chain continues next tick.
        if (claimable.length === 0) continue;
        const MAX_LAPS_PER_TICK_PER_REPO = 6;
        receipt(opts.stateDir, `queued: ${cfg.slug} #${claimable[0].number} (${claimable.length - 1} claimable behind it)`);
        tasks.push(async () => {
          let laps = 0;
          let issue = claimable[0];
          let revivedInTick = false;
          const REVIVE_COOLDOWN_MS = 10 * 60_000;
          while (issue && laps < MAX_LAPS_PER_TICK_PER_REPO) {
            laps++;
            try {
              await runLap(cfg, opts.stateDir, deps, issue);
            } catch (e: any) {
              // infra failure (git/gh/network) — receipt and move on; the
              // in_progress row is reconciled next tick, never lost
              receipt(opts.stateDir, `lap #${issue.number} error on ${cfg.slug}: ${e.message?.slice(0, 300)}`);
            }
            // fresh dependsCache per intake: issues closed by the merge just
            // completed unblock their dependent here
            const finished = issue.number;
            let next = await listClaimable(cfg, deps.ledger, deps.gh).catch(() => []);
            if (next.length === 0 && !revivedInTick) {
              // the chain just stalled (likely: this lap burned its attempts
              // and blocked). A blocked row only ever revives on a tick — and
              // with no timer armed that means sitting idle until a human
              // arrives. Pace ONE in-tick revive instead: cool down, retry the
              // revive (the daily cap and stagnation breaker still bind), and
              // re-intake once. Bounded: at most one cooldown per repo/tick.
              revivedInTick = true;
              receipt(opts.stateDir, `chain stalled after #${finished} — cooling ${REVIVE_COOLDOWN_MS / 60_000} min before one in-tick revive attempt (fuses: daily cap, stagnation)`);
              await new Promise((r) => setTimeout(r, REVIVE_COOLDOWN_MS));
              autoReviveBlocked(cfg, opts.stateDir, deps.ledger);
              next = await listClaimable(cfg, deps.ledger, deps.gh).catch(() => []);
            }
            issue = next[0];
            if (issue && laps < MAX_LAPS_PER_TICK_PER_REPO) {
              receipt(opts.stateDir, `queued: ${cfg.slug} #${issue.number} (${next.length - 1} behind it) — chained after #${finished}`);
            }
          }
          if (laps >= MAX_LAPS_PER_TICK_PER_REPO) {
            const remaining = await listClaimable(cfg, deps.ledger, deps.gh).catch(() => []);
            if (remaining.length > 0) {
              receipt(opts.stateDir, `lap cap (${MAX_LAPS_PER_TICK_PER_REPO}) reached for ${cfg.slug} this tick — remaining chain (from #${remaining[0].number}) resumes on the next tick`);
            }
          }
        });
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
