import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoReviveBlocked, bumpInputsEpoch } from "../src/tick";
import type { RepoConfig } from "../src/types";

interface Row {
  issue_number: number;
  state: string;
  attempts: number;
  last_error: string | null;
}

function fakeLedger(rows: Row[]) {
  const patches: { repo: string; n: number; patch: any }[] = [];
  return {
    rows,
    patches,
    listIssues(_repo: string) {
      return rows as any;
    },
    setIssue(repo: string, n: number, patch: any) {
      patches.push({ repo, n, patch });
      const r = rows.find((x) => x.issue_number === n);
      if (r) Object.assign(r, patch);
    },
  };
}

const cfg: RepoConfig = {
  repo: "acme/app",
  slug: "app",
  default_branch: "main",
  attempts: 3,
  merge: { method: "squash", required_checks: [], delete_branch: true },
  models: { default: { provider: "x", model: "y" } },
  timeouts: { stage_minutes: 30, checks_minutes: 30, readiness_seconds: 10, probe_ms: 1000 },
  scenario: { ports: [] },
  skip_labels: [],
  env: { mode: "host" },
  pi: { binary: "pi", tools: [], plan_tools: [], extra_args: [] },
} as any;

const blocked = (last_error: string): Row => ({
  issue_number: 1,
  state: "blocked",
  attempts: 3,
  last_error,
});

describe("autoReviveBlocked (bounded self-heal of exhausted laps)", () => {
  test("a fresh blocker revives: row back to open lane, receipts explain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfrev-"));
    const led = fakeLedger([blocked("review rejected: findings A")]);
    await autoReviveBlocked(cfg, dir, led as any);
    expect(led.patches).toEqual([{ repo: "acme/app", n: 1, patch: { state: "in_progress", attempts: 0 } }]);
    expect(led.rows[0].state).toBe("in_progress");
  });

  test("identical failure signature twice in a row → third round refuses (stagnation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfrev-"));
    const led = fakeLedger([blocked("implement stage failed: model produced no final text: Connection error.")]);
    await autoReviveBlocked(cfg, dir, led as any); // revive 1
    led.rows[0] = blocked("implement stage failed: model produced no final text: Connection error.");
    await autoReviveBlocked(cfg, dir, led as any); // revive 2 (signature repeats once)
    led.rows[0] = blocked("implement stage failed: model produced no final text: Connection error.");
    await autoReviveBlocked(cfg, dir, led as any); // stagnation → refuse
    const revives = led.patches.filter((p: any) => p.patch?.state === "in_progress").length;
    expect(revives).toBe(2);
    expect(led.rows[0].state).toBe("blocked");
  });

  test("evolving failure signatures keep reviving until the daily cap, then refuse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfrev-"));
    const led = fakeLedger([blocked("gate A")]);
    for (let i = 0; i < 5; i++) {
      led.rows[0] = blocked(`gate finds ${i}`); // every round fails differently
      await autoReviveBlocked(cfg, dir, led as any);
    }
    const revives = led.patches.filter((p: any) => p.patch?.state === "in_progress").length;
    expect(revives).toBe(3); // AUTO_REVIVE_DAILY_CAP
    expect(led.rows[0].state).toBe("blocked");
  });

  test("inputs-epoch: a scenario/config write resets the fuses — the world changed (P0-7)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfrev-"));
    const led = fakeLedger([blocked("holdout probe demands 404 for POST /api/rooms")]);
    for (let i = 0; i < 4; i++) {
      led.rows[0] = blocked(`gate finds ${i}`);
      await autoReviveBlocked(cfg, dir, led as any);
    }
    // cap spent — tic-tac-toe #11 2026-10-25 sat here refusing identically
    let revives = led.patches.filter((p: any) => p.patch?.state === "in_progress").length;
    expect(revives).toBe(3);
    expect(led.rows[0].state).toBe("blocked");
    // the operator fixes the scenario → epoch bump → fresh budget + clean
    // stagnation history: the past no longer predicts the changed world
    bumpInputsEpoch(dir, "app");
    led.rows[0] = blocked("holdout probe demands 404 for POST /api/rooms");
    await autoReviveBlocked(cfg, dir, led as any);
    revives = led.patches.filter((p: any) => p.patch?.state === "in_progress").length;
    expect(revives).toBe(4);
    expect(led.rows[0].state).toBe("in_progress");
  });
});

describe("stuck failure summary (fail loudly, once per day)", () => {
  const fakeGh = () => {
    const comments: { issue: number; body: string }[] = [];
    return { comments, issueComment: async (issue: number, body: string) => { comments.push({ issue, body }); } };
  };

  test("stagnation refusal posts the evidence bundle to the issue; once per day only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfrevsum-"));
    const led = fakeLedger([blocked("server never became ready — In-box socket state: LISTEN 6 5")]);
    const gh = fakeGh();
    const sig = "server never became ready — In-box socket state: LISTEN 6 5";
    // rounds 1+2 revive (distinct signatures); round 3 revives again and
    // records the repeat; round 4 is the stagnation refusal → LOUD summary
    await autoReviveBlocked(cfg, dir, led as any, gh as any);
    led.rows[0] = blocked(`${sig} v2`);
    await autoReviveBlocked(cfg, dir, led as any, gh as any);
    led.rows[0] = blocked(`${sig} v2`);
    await autoReviveBlocked(cfg, dir, led as any, gh as any);
    led.rows[0] = blocked(`${sig} v2`); // the round-3 revive flipped it in_progress — block it again
    await autoReviveBlocked(cfg, dir, led as any, gh as any); // refusal + summary
    expect(gh.comments.length).toBe(1);
    const body = gh.comments[0].body;
    expect(body).toContain("FAILURE SUMMARY");
    expect(body).toContain("Latest full verdict");
    expect(body).toContain("LISTEN 6 5"); // the evidence rides the comment
    expect(body).toContain("scenario <slug> runtime"); // verifier-owned hint fires
    // a later tick the same day refuses again but does NOT re-post
    await autoReviveBlocked(cfg, dir, led as any, gh as any);
    expect(gh.comments.length).toBe(1);
  });

  test("daily-cap refusal posts the summary too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfrevsum2-"));
    const led = fakeLedger([blocked("gate A")]);
    const gh = fakeGh();
    for (let i = 0; i < 4; i++) {
      led.rows[0] = blocked(`gate finds ${i}`); // every round fails differently
      await autoReviveBlocked(cfg, dir, led as any, gh as any);
    }
    expect(led.rows[0].state).toBe("blocked");
    expect(gh.comments.length).toBe(1); // cap refusal → summary, once
    expect(gh.comments[0].body).toContain("daily cap");
  });
});
