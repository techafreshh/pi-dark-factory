/**
 * Shared fixtures for the lease / parallel / merge-queue tests: a real bare
 * git origin, a FakeGh shaped like the recorded gh outputs the other suites
 * use (label strings after the boundary normalization, author logins), and a
 * fake lap machine whose "box" is a real local clone — stages commit and
 * force-push exactly like the in-box stage driver does.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckState, GhApi } from "../src/gh";
import { Ledger } from "../src/ledger";
import type { LapMachineLike, MachineStageOpts, MachineStageResult, ShRes } from "../src/machine";
import type { CallStageFn, TickDeps } from "../src/tick";
import type { IssueLite, PrLite, RepoConfig } from "../src/types";

export const GIT_ID = "-c user.email=t@t.io -c user.name=Test";
export const FAKE_REPO_DIR = "/fake/box/repo";

export class FakeGh implements GhApi {
  repo = "acme/toy";
  issues: IssueLite[] = [];
  prs: PrLite[] = [];
  mergedPrs: PrLite[] = [];
  states: Record<number, string> = {};
  comments: string[] = [];
  created: { number: number; title: string; body: string }[] = [];
  nextPr = 101;
  merged: number[] = [];
  /** merge hook: the test's "GitHub" squash-merges the PR branch into main */
  onMerge: (pr: number) => void = () => {};
  heads: Record<number, string> = {};

  issueList(state: "open" | "all", limit?: number): Promise<IssueLite[]> {
    return Promise.resolve(
      this.issues
        .filter((i) => state === "all" || (this.states[i.number] ?? "open") === "open")
        .slice(0, limit)
        .map((i) => ({ ...i, author: i.author ?? "acme" }))
    );
  }
  viewerLogin(): Promise<string | null> {
    return Promise.resolve("factory-bot");
  }
  issueView(n: number): Promise<IssueLite & { state: string }> {
    const i = this.issues.find((x) => x.number === n);
    if (!i) return Promise.reject(new Error("not found"));
    return Promise.resolve({ ...i, state: this.states[n] ?? "open" });
  }
  issueComment(n: number, body: string): Promise<void> {
    this.comments.push(`#${n}: ${body}`);
    return Promise.resolve();
  }
  issueClose(n: number): Promise<void> {
    this.states[n] = "closed";
    return Promise.resolve();
  }
  issueCreate(title: string, body: string): Promise<number> {
    const number = Math.max(0, ...this.issues.map((i) => i.number)) + 1;
    this.issues.push({ number, title, body, labels: [] });
    this.created.push({ number, title, body });
    return Promise.resolve(number);
  }
  issueAddLabels(n: number, labels: string[]): Promise<void> {
    const i = this.issues.find((x) => x.number === n);
    if (i) i.labels = [...(i.labels ?? []), ...labels];
    return Promise.resolve();
  }
  prListOpen(): Promise<PrLite[]> {
    return Promise.resolve(this.prs);
  }
  prListMerged(): Promise<PrLite[]> {
    return Promise.resolve(this.mergedPrs);
  }
  prCreate(head: string, _base: string, title: string, body: string): Promise<number> {
    const n = this.nextPr++;
    this.prs.push({ number: n, title, body, headRefName: head });
    return Promise.resolve(n);
  }
  prClose(): Promise<void> {
    return Promise.resolve();
  }
  prChecks(): Promise<CheckState[]> {
    return Promise.resolve([]);
  }
  prHeadSha(n: number): Promise<string | null> {
    if (this.heads[n]) return Promise.resolve(this.heads[n]);
    // like GitHub: the PR head is the branch tip on the remote right now
    const head = this.prs.find((p) => p.number === n)?.headRefName;
    if (!head || !this.origin) return Promise.resolve("f".repeat(40));
    try {
      return Promise.resolve(execSync(`git --git-dir=${this.origin} rev-parse refs/heads/${head}`).toString().trim());
    } catch {
      return Promise.resolve(null);
    }
  }
  origin = "";
  prMerge(n: number): Promise<void> {
    this.onMerge(n);
    this.merged.push(n);
    this.prs = this.prs.filter((p) => p.number !== n);
    return Promise.resolve();
  }
}

export interface World {
  stateDir: string;
  origin: string;
  cfg: RepoConfig;
  ledger: Ledger;
  gh: FakeGh;
  machines: FakeMachine[];
}

const worlds: string[] = [];
export function cleanupWorlds() {
  for (const d of worlds.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** a machine-mode repo (instabox by default) over a real bare origin */
export function makeMachineWorld(opts: { mode?: "instabox" | "boxd"; attempts?: number; scheduling?: RepoConfig["scheduling"]; files?: Record<string, string> } = {}): World {
  const stateDir = mkdtempSync(join(tmpdir(), "pdfpar-"));
  worlds.push(stateDir);
  const origin = join(stateDir, "origin.git");
  execSync(`git init -q --bare ${origin}`);
  execSync(`git --git-dir=${origin} symbolic-ref HEAD refs/heads/main`);
  const seed = join(stateDir, "seed");
  execSync(`git clone -q ${origin} ${seed}`);
  execSync(`git -C ${seed} checkout -q -b main`);
  writeFileSync(join(seed, "README.md"), "# toy product\n");
  for (const [f, body] of Object.entries(opts.files ?? {})) writeFileSync(join(seed, f), body);
  execSync(`git -C ${seed} ${GIT_ID} add -A`);
  execSync(`git -C ${seed} ${GIT_ID} commit -q -m init`);
  execSync(`git -C ${seed} push -q origin main`);
  rmSync(seed, { recursive: true, force: true });

  const cfgDir = join(stateDir, "repos", "toy");
  mkdirSync(cfgDir, { recursive: true });
  const cfg: RepoConfig = {
    repo: "acme/toy",
    slug: "toy",
    default_branch: "main",
    origin_url: origin,
    attempts: opts.attempts ?? 3,
    merge: { method: "squash", required_checks: [], delete_branch: true },
    models: { default: { provider: "x", model: "y" } },
    timeouts: { stage_minutes: 5, checks_minutes: 1, readiness_seconds: 10, probe_ms: 3000 },
    scenario: { ports: [] },
    skip_labels: [],
    env: {
      mode: opts.mode ?? "instabox",
      compose_file: "docker-compose.yml",
      service: "worker",
      image: "ubuntu:24.04",
      pass_env: [],
      instabox: { api_base: "http://127.0.0.1:9", api_key_env: "INSTABOX_API_KEY", template: "basic", snapshot: "", repo_dir: FAKE_REPO_DIR, bake: "" },
      boxd: { repo_dir: FAKE_REPO_DIR, snapshot: "factory-base-boxd-r1" },
    },
    pi: { binary: "pi", tools: ["read", "bash"], plan_tools: ["read"], extra_args: [], web: { search: false, fetch: false } },
    discoveries: { auto_file: true },
    scheduling: { priority: "normal", spill_over: false, parallel: false, max_lanes: 3, ...(opts.scheduling ?? {}) },
  };
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify(cfg));
  const gh = new FakeGh();
  gh.origin = origin;
  // "GitHub" squash-merges the PR's branch into main when the factory merges
  gh.onMerge = (pr) => {
    const head = gh.prs.find((p) => p.number === pr)?.headRefName;
    if (!head) throw new Error(`no open PR #${pr}`);
    const tmp = mkdtempSync(join(tmpdir(), "pdfmerge-"));
    try {
      execSync(`git clone -q ${origin} ${tmp}/c`);
      execSync(`git -C ${tmp}/c ${GIT_ID} merge -q --squash origin/${head}`, { stdio: "pipe" });
      execSync(`git -C ${tmp}/c ${GIT_ID} commit -q -m "squash ${head}"`);
      execSync(`git -C ${tmp}/c push -q origin main`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };
  return { stateDir, origin, cfg, ledger: new Ledger(join(stateDir, "factory.db")), gh, machines: [] };
}

export interface MachineBehavior {
  /** edit the box's clone for this issue's implement round (commit is automatic) */
  implement?: (clone: string, issue: number, round: number) => void | Promise<void>;
  plan?: (issue: number) => string;
  review?: (issue: number, round: number) => string;
}

const ok = (text: string): MachineStageResult => ({
  outcome: { kind: "ok", text, usage: { input_tokens: 10, output_tokens: 5 } } as any,
  modelsTried: [{ spec: { provider: "x", model: "y" }, outcome: "ok" }],
  raw: "",
});

/** a lap machine whose box is a local clone; bash() runs the script locally
 *  with the configured in-box repo_dir pointed at that clone */
export class FakeMachine implements LapMachineLike {
  readonly name: string;
  clone: string;
  destroyed = false;
  rounds = 0;
  reviews = 0;
  stages: string[] = [];
  prompts: string[] = [];

  constructor(private w: World, private cfg: RepoConfig, public issue: number, lapId: number, private b: MachineBehavior) {
    this.name = `pdf-${cfg.slug}-i${issue}-g${lapId}`;
    this.clone = join(w.stateDir, "boxes", this.name);
    w.machines.push(this);
  }

  async bash(script: string, opts: { timeoutMs?: number } = {}): Promise<ShRes> {
    const s = script.split(FAKE_REPO_DIR).join(this.clone);
    const p = Bun.spawn(["bash", "-c", s], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t.io", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t.io" } });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr, timedOut: false };
  }

  async bootstrap(): Promise<void> {
    const branch = `factory/issue-${this.issue}`;
    if (!existsSync(join(this.clone, ".git"))) execSync(`git clone -q ${this.w.origin} ${this.clone}`);
    else execSync(`git -C ${this.clone} fetch -q origin --prune`);
    const local = execSync(`git -C ${this.clone} branch --list ${branch}`).toString().trim();
    if (local) execSync(`git -C ${this.clone} checkout -q ${branch}`);
    else {
      const remote = execSync(`git -C ${this.clone} branch -r --list origin/${branch}`).toString().trim();
      execSync(`git -C ${this.clone} checkout -q -B ${branch} ${remote ? `origin/${branch}` : "origin/main"}`);
    }
  }

  async callStage(stage: "plan" | "implement" | "review", _o: MachineStageOpts): Promise<MachineStageResult & { stage: typeof stage }> {
    this.stages.push(stage);
    this.prompts.push(_o.prompt);
    if (stage === "plan") {
      await this.bootstrap();
      return { ...ok(this.b.plan?.(this.issue) ?? `PLAN: implement issue ${this.issue}.`), stage };
    }
    if (stage === "implement") {
      await this.bootstrap();
      this.rounds++;
      if (this.b.implement) await this.b.implement(this.clone, this.issue, this.rounds);
      else writeFileSync(join(this.clone, `issue-${this.issue}.txt`), `issue ${this.issue} round ${this.rounds}\n`);
      execSync(`git -C ${this.clone} ${GIT_ID} add -A`);
      execSync(`git -C ${this.clone} ${GIT_ID} commit -q -m "issue ${this.issue} round ${this.rounds}" --allow-empty`);
      execSync(`git -C ${this.clone} push -q --force origin HEAD:refs/heads/factory/issue-${this.issue}`);
      return { ...ok(`implemented #${this.issue}`), stage };
    }
    this.reviews++;
    return { ...ok(this.b.review?.(this.issue, this.reviews) ?? "VERDICT: APPROVE\nlooks right"), stage };
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

/** TickDeps for a machine world: stage calls go to FakeMachine; the host
 *  callStage must never run in machine mode */
export function machineDeps(w: World, b: MachineBehavior = {}): TickDeps {
  const never: CallStageFn = async (stage) => {
    throw new Error(`host callStage(${stage}) called in machine mode`);
  };
  return {
    ledger: w.ledger,
    gh: w.gh,
    callStage: never,
    openMachine: (cfg, n, _log, lapId) => new FakeMachine(w, cfg, n, lapId, b),
  };
}

export const issue = (number: number, title: string, body = "", labels: string[] = []): IssueLite => ({ number, title, body, labels });
