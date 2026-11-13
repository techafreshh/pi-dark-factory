import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger";

// the dashboard module reads STATE_DIR at import — point it at a tmp dir
const dir = mkdtempSync(join(tmpdir(), "pdfdash-"));
process.env.DASHBOARD_STATE_DIR = dir;
const { secret, computeSummary, listLaps, listProjects, lapDetail, parseSession, readSession, matchArtifacts } = await import("../bin/dashboard");

const R1 = "techafreshh/alpha";
const R2 = "techafreshh/beta";

const led = new Ledger(":memory:");
// in-progress lap with stages (one done, one running)
led.claim(R1, 5);
led.setIssue(R1, 5, { state: "in_progress", attempts: 2, pr: 12 });
const lap1 = led.startLap(R1, 5);
const s1 = led.startStage(R1, 5, lap1, "implement", 1, "m/x");
led.endStage(s1, "ok", { input_tokens: 1000, output_tokens: 500 });
led.startStage(R1, 5, lap1, "review", 1, "m/y"); // left open = currently running

// merged lap with tokens
led.claim(R2, 9);
led.setIssue(R2, 9, { state: "merged", attempts: 1 });
const lap2 = led.startLap(R2, 9);
const s2 = led.startStage(R2, 9, lap2, "plan", 1, "m/x");
led.endStage(s2, "ok", { input_tokens: 2000, output_tokens: 800, cost: 0.5 });
led.endLap(lap2, "merged", "PR #1");

// blocked row whose last stage failed on billing across the whole chain
led.claim(R2, 11);
led.setIssue(R2, 11, { state: "blocked", attempts: 3, last_error: "no commits ahead of base" });
const lap3 = led.startLap(R2, 11);
const s3 = led.startStage(R2, 11, lap3, "plan", 1, "river/glm:low");
led.endStage(s3, "provider_error", null, "402 insufficient balance",
  JSON.stringify([{ model: "river/glm:low", outcome: "provider_error", error: "402: Insufficient Balance" }]));
led.endLap(lap3, "blocked", "plan stage failed");

mkdirSync(join(dir, "repos", "alpha"), { recursive: true });
writeFileSync(join(dir, "repos", "alpha", "config.json"), JSON.stringify({ repo: R1, env: { mode: "instabox" } }));
writeFileSync(join(dir, "repos", "alpha", "paused"), "2026-11-01T00:00:00.000Z every model failed on billing\n");
mkdirSync(join(dir, "repos", "beta"), { recursive: true });
writeFileSync(join(dir, "repos", "beta", "config.json"), JSON.stringify({ repo: R2, limits: { daily_attempts: 1 } }));
writeFileSync(join(dir, "laps.log"),
  `[2026-11-01T00:00:00.000Z] [beta] lap #9 "Add the beta widget" (attempt base 1, PR: none)\n` +
  `[2026-11-01T00:15:00.000Z] scheduler: started 2 repo tick(s), 0 still running\n`);

describe("computeSummary (read-only overview)", () => {
  const s = computeSummary(led.db);

  test("the live lap shows its issue, PR, and the stage running right now", () => {
    expect(s.live.length).toBe(1);
    const lap = s.live[0];
    expect(lap.slug).toBe("alpha");
    expect(lap.issue_number).toBe(5);
    expect(lap.pr).toBe(12);
    expect(lap.stage.stage).toBe("review");
    expect(lap.stage.ended_at).toBeNull();
  });

  test("needs-you lists blocked issues, paused repos with their reason, and billing-dead models", () => {
    const kinds = s.needs_you.map((n) => n.kind);
    expect(kinds).toContain("blocked");
    const paused = s.needs_you.find((n) => n.kind === "paused")!;
    expect(paused.slug).toBe("alpha");
    expect(paused.detail).toBe("every model failed on billing");
    const billing = s.needs_you.find((n) => n.kind === "billing")!;
    expect(billing.detail).toContain("river/glm");
  });

  test("KPIs, outcome and cost series cover today; scheduler pass comes from laps.log", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(s.kpis.merged_today).toBe(1);
    expect(s.kpis.cost_today).toBe(0.5);
    const day = s.outcomes_by_day.find((d) => d.day === today)! as Record<string, any>;
    expect(day.merged).toBe(1);
    expect(day.running).toBe(1);
    expect(day.blocked).toBe(1);
    expect(s.cost_by_day.length).toBe(30);
    expect(s.scheduler.last_pass_at).toBe("2026-11-01T00:15:00.000Z");
  });

  test("a failing state backup shows up in needs-you", () => {
    writeFileSync(join(dir, "backup.json"), JSON.stringify({ last_ok_at: "2026-11-01T00:00:00.000Z", last_error: "connect ECONNREFUSED", last_error_at: "2026-11-01T01:00:00.000Z" }));
    const b = computeSummary(led.db).needs_you.find((n) => n.kind === "backup")!;
    expect(b.detail).toContain("ECONNREFUSED");
    writeFileSync(join(dir, "backup.json"), JSON.stringify({ last_ok_at: new Date().toISOString() }));
    expect(computeSummary(led.db).needs_you.some((n) => n.kind === "backup")).toBe(false);
  });

  test("model health is attributed from the fallback trail", () => {
    const h = s.model_health.find((m) => m.model === "river/glm:low")!;
    expect(h.last_outcome).toBe("billing");
  });
});

describe("listLaps (paged, filtered, sorted)", () => {
  test("filters by status and repo slug, pages, and carries titles from laps.log", () => {
    const all = listLaps(led.db, {});
    expect(all.total).toBe(3);
    const merged = listLaps(led.db, { outcome: "merged" });
    expect(merged.total).toBe(1);
    expect(merged.rows[0].title).toBe("Add the beta widget");
    expect(listLaps(led.db, { repo: "alpha" }).rows.map((r) => r.status)).toEqual(["running"]);
    const page = listLaps(led.db, { limit: 1, offset: 1, sort: "id", order: "asc" });
    expect(page.rows.length).toBe(1);
    expect(page.rows[0].id).toBe(lap2);
  });

  test("free-text search matches titles and issue numbers", () => {
    expect(listLaps(led.db, { q: "widget" }).rows.map((r) => r.id)).toEqual([lap2]);
    expect(listLaps(led.db, { q: "#11" }).rows.map((r) => r.id)).toEqual([lap3]);
  });

  test("sorting by cost puts the expensive lap first", () => {
    expect(listLaps(led.db, { sort: "cost", order: "desc" }).rows[0].id).toBe(lap2);
  });
});

describe("listProjects", () => {
  test("one row per repo with lap and issue stats", () => {
    const rows = listProjects(led.db);
    const beta = rows.find((r) => r.slug === "beta")!;
    expect(beta.laps).toBe(2);
    expect(beta.merged).toBe(1);
    expect(beta.issues_blocked).toBe(1);
    expect(rows.find((r) => r.slug === "alpha")!.running).toBe(true);
  });
});

describe("sessions", () => {
  const stream = [
    { type: "session", id: "s1", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/data/repo" },
    { type: "message_update", assistantMessageEvent: { delta: "x" } },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } },
    { type: "message_end", message: { role: "assistant", model: "glm", provider: "river", stopReason: "toolUse",
      usage: { input: 10, output: 5, cacheRead: 2, cost: { total: 0.01 } },
      content: [{ type: "thinking", thinking: "I should list files" }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }] } },
    { type: "message_end", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, content: [{ type: "text", text: "README.md" }] } },
    { type: "message_end", message: { role: "assistant", model: "glm", provider: "river",
      content: [{ type: "thinking", thinking: "", thinkingSignature: "enc" }, { type: "text", text: "done" }] } },
  ].map((e) => JSON.stringify(e)).join("\n") + '\n{"type":"message_end","mess';

  test("a stage stream parses into messages with thinking, tool calls and results", () => {
    const p = parseSession(stream);
    expect(p.header.id).toBe("s1");
    expect(p.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(p.messages[1].parts[0]).toEqual({ type: "thinking", text: "I should list files", redacted: false });
    expect(p.messages[1].parts[1]).toMatchObject({ type: "tool_call", name: "bash" });
    expect(p.messages[3].parts[0]).toMatchObject({ type: "thinking", redacted: true });
    expect(p.stats).toMatchObject({ turns: 2, tool_calls: 1, thinking: 1, thinking_redacted: 1, input: 10 });
    expect(p.truncated).toBe(true); // capped raw: last line cut mid-JSON
  });

  test("host session files (type: message) parse the same way", () => {
    const host = [
      { type: "session", id: "h1", timestamp: "2026-11-01T00:00:00.000Z" },
      { type: "model_change", provider: "meta", modelId: "muse" },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "PLAN: x" }] } },
    ].map((e) => JSON.stringify(e)).join("\n");
    expect(parseSession(host).messages[0].parts[0]).toEqual({ type: "text", text: "PLAN: x" });
  });

  test("readSession refuses paths outside the issue's session files", () => {
    const issue = join(dir, "repos", "beta", "issues", "9");
    mkdirSync(issue, { recursive: true });
    writeFileSync(join(issue, "plan-1.jsonl"), stream);
    expect(readSession("beta", 9, "plan-1.jsonl")!.messages.length).toBe(4);
    expect(readSession("beta", 9, "../../config.json")).toBeNull();
    expect(readSession("beta", 9, "plan.md")).toBeNull();
    expect(readSession("../beta", 9, "plan-1.jsonl")).toBeNull();
  });

  test("files pair with the stage whose window they were written in; an older lap's overwritten file does not", () => {
    const stages = [
      { id: 1, stage: "plan", attempt: 1, started_at: "2026-11-01T10:00:00.000Z", ended_at: "2026-11-01T10:05:00.000Z" },
      { id: 2, stage: "implement", attempt: 1, started_at: "2026-11-01T10:05:00.000Z", ended_at: "2026-11-01T10:20:00.000Z" },
    ];
    const files = [
      { file: "plan-1.jsonl", stage: "plan", attempt: 1, started: "2026-11-01T10:00:01.000Z", ended: "2026-11-01T10:05:00.000Z", bytes: 1, kind: "machine" as const },
      // written by a LATER lap of the same issue: outside this lap
      { file: "implement-1.jsonl", stage: "implement", attempt: 1, started: "2026-11-02T09:00:00.000Z", ended: "2026-11-02T09:20:00.000Z", bytes: 1, kind: "machine" as const },
    ];
    const { byStage, extra } = matchArtifacts(stages, files, { started_at: "2026-11-01T10:00:00.000Z", ended_at: "2026-11-01T10:30:00.000Z" });
    expect(byStage.get(1)?.file).toBe("plan-1.jsonl");
    expect(byStage.has(2)).toBe(false);
    expect(extra).toEqual([]);
  });

  test("lapDetail returns stages, matched artifacts and the plan", () => {
    const issue = join(dir, "repos", "beta", "issues", "9");
    writeFileSync(join(issue, "plan.md"), "PLAN: widget");
    const end = new Date(led.recentStages(R2, 10).find((s) => s.id === s2)!.ended_at!);
    writeFileSync(join(issue, "plan-1.jsonl"), stream.replace("2026-11-01T00:00:00.000Z", end.toISOString()));
    utimesSync(join(issue, "plan-1.jsonl"), end, end);
    const d = lapDetail(led.db, lap2)!;
    expect(d.lap.title).toBe("Add the beta widget");
    expect(d.plan).toBe("PLAN: widget");
    expect(d.stages[0].artifact?.file).toBe("plan-1.jsonl");
    expect(lapDetail(led.db, 99999)).toBeNull();
  });
});

describe("computeScheduling (slot pools, queue, lanes, merge queues)", async () => {
  const { computeScheduling, effectivePriority: dashEff, POOL_NAMES } = await import("../bin/dashboard");
  const alloc = await import("../src/allocator");
  const R3 = "techafreshh/gamma";
  const sl = new Ledger(":memory:");
  mkdirSync(join(dir, "repos", "gamma"), { recursive: true });
  writeFileSync(join(dir, "repos", "gamma", "config.json"), JSON.stringify({ repo: R3, env: { mode: "instabox" }, scheduling: { parallel: true, max_lanes: 2, spill_over: true, priority: "high" } }));
  const now = Date.now();
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  // a lease on boxd for an instabox repo (spilled), bound to a live lap
  sl.claim(R3, 21);
  const lap = sl.startLap(R3, 21);
  sl.startStage(R3, 21, lap, "implement", 1, "m/x");
  const leased = alloc.requestSlot(sl, { repo: R3, slug: "gamma", lane: 0, pools: ["instabox", "boxd"], priority: "high", extraLane: false }, now - 5 * 60_000);
  sl.db.query("UPDATE slot_requests SET state = 'granted', pool = 'boxd', granted_at = ?, issue_number = 21, lap_id = ? WHERE id = ?").run(iso(4), lap, leased);
  // waiting: an extra lane (high) and an old low first lane that aged to high
  alloc.requestSlot(sl, { repo: R3, slug: "gamma", lane: 1, pools: ["instabox", "boxd"], priority: "high", extraLane: true }, now - 2 * 60_000);
  alloc.requestSlot(sl, { repo: R1, slug: "alpha", lane: 0, pools: ["instabox"], priority: "low", extraLane: false }, now - 90 * 60_000);
  const mq = sl.mergeQueueEnter(R3, 21, lap);
  sl.mergeQueueSet(mq, "reverifying");
  const done = sl.mergeQueueEnter(R3, 20, lap - 1);
  sl.mergeQueueSet(done, "merged");

  const s = computeScheduling(sl.db, now);

  test("POOL_NAMES mirrors allocator POOLS — the dashboard copies it by the no-imports rule", () => {
    expect([...POOL_NAMES]).toEqual([...alloc.POOLS]);
  });

  test("pools count leases against caps; waiting counts by first preference", () => {
    // all five machine platforms appear on the Scheduling page, even with no
    // repo using them yet
    expect(s.pools.map((p) => p.pool)).toEqual(["instabox", "boxd", "daytona", "e2b", "instavm"]);
    expect(s.pools.find((p) => p.pool === "daytona")).toMatchObject({ cap: 5, used: 0, waiting: 0 });
    expect(s.pools.find((p) => p.pool === "e2b")).toMatchObject({ cap: 10, used: 0, waiting: 0 });
    expect(s.pools.find((p) => p.pool === "instavm")).toMatchObject({ cap: 5, used: 0, waiting: 0 });
    expect(s.pools.find((p) => p.pool === "boxd")).toMatchObject({ cap: 10, used: 1 });
    expect(s.pools.find((p) => p.pool === "instabox")).toMatchObject({ cap: 5, used: 0, waiting: 2 });
  });

  test("the waiting queue is in grant order with priority after aging", () => {
    expect(s.waiting.map((w) => [w.slug, w.lane, w.effective, w.position])).toEqual([
      ["alpha", 0, "high", 1], // first lane, aged low → high after 90 min
      ["gamma", 1, "high", 2], // extra lane waits behind every first lane
    ]);
  });

  test("leases show the lap's stage and whether they spilled", () => {
    expect(s.leases[0]).toMatchObject({ slug: "gamma", issue: 21, pool: "boxd", spilled: true });
    expect(s.leases[0].stage.stage).toBe("implement");
    expect(s.spills.map((x) => [x.slug, x.pool, x.own])).toEqual([["gamma", "boxd", "instabox"]]);
  });

  test("lanes group a parallel repo's leases; merge queues split open from recent", () => {
    const g = s.lanes.find((l) => l.slug === "gamma")!;
    expect(g).toMatchObject({ parallel: true, max_lanes: 2, priority: "high", waiting: 1 });
    expect(g.laps.map((l) => l.issue)).toEqual([21]);
    const q = s.merge_queues.find((m) => m.slug === "gamma")!;
    expect(q.open.map((r: any) => [r.issue_number, r.state])).toEqual([[21, "reverifying"]]);
    expect(q.recent.map((r: any) => [r.issue_number, r.state])).toEqual([[20, "merged"]]);
  });

  test("a request waiting over an hour shows up in needs-you", () => {
    const n = computeSummary(sl.db).needs_you.filter((x) => x.kind === "slot_wait");
    expect(n.length).toBe(1);
    expect(n[0].slug).toBe("alpha");
    expect(n[0].detail).toContain("machine slot on instabox");
  });

  test("the dashboard's effectivePriority copy agrees with the allocator's", () => {
    for (const base of ["low", "normal", "high"] as const)
      for (const m of [0, 29, 30, 59, 60, 61, 200]) {
        const at = new Date(now - m * 60_000).toISOString();
        expect(dashEff(base, at, now, 30)).toBe(alloc.effectivePriority(base, at, now, 30));
      }
  });
});

describe("secret (machine-panel keys: environment first, then the key file)", () => {
  const NAME = "PDF_TEST_PANEL_KEY";
  const file = join(dir, "panel.env");
  const withEnv = (v: string | undefined, fn: () => void) => {
    const saved = process.env[NAME];
    if (v === undefined) delete process.env[NAME];
    else process.env[NAME] = v;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env[NAME];
      else process.env[NAME] = saved;
    }
  };
  writeFileSync(file, `OTHER=x\n${NAME}="from-file"\n`);

  test("the environment variable wins over the file", () => {
    withEnv("from-env", () => expect(secret(NAME, file)).toBe("from-env"));
  });
  test("the file is used when the variable is unset", () => {
    withEnv(undefined, () => expect(secret(NAME, file)).toBe("from-file"));
  });
  test("an empty variable falls back to the file", () => {
    withEnv("", () => expect(secret(NAME, file)).toBe("from-file"));
  });
  test("neither the variable nor a readable file gives null", () => {
    withEnv(undefined, () => expect(secret(NAME, join(dir, "missing.env"))).toBeNull());
  });
});
