/**
 * Parallel mode (docs/parallel-mode.md): up to scheduling.max_lanes laps of
 * one repo run at once inside the repo's single tick process (the repo
 * pidfile still guarantees one), each on an issue whose dependencies are
 * closed, picked by critical path. Approved branches land one at a time
 * through the repo's MergeQueue, rebased onto the current main and
 * re-verified there, so main never takes a conflicting merge.
 *
 * What stays lane-scoped: a block ends only that lane's lap (its dependents
 * stay gated by intake); an error makes the issue wait for the next tick.
 * What stops every lane before its next lap: a pause (a billing hold writes
 * one), a daily ceiling, the tick's start budget, a platform outage.
 * In-flight laps always finish.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configForPool, releaseSlot } from "./allocator";
import { loadRepoConfig } from "./config";
import { rankByCriticalPath } from "./critpath";
import type { Ledger, MergeQueueState } from "./ledger";
import { repoReceipt } from "./receipts";
import { DISCOVERY_LABEL, describeIntakeSkips, listClaimableDetailed, MINOR_LABEL } from "./stages/intake";
import { acquireLaneSlot, fleetCeilingReached, runLap, type LaneCtx, type TickDeps } from "./tick";
import type { IssueLite, RepoConfig } from "./types";

const isDiscovery = (i: IssueLite) => (i.labels ?? []).includes(DISCOVERY_LABEL);
const isMinor = (i: IssueLite) => (i.labels ?? []).includes(MINOR_LABEL);

export interface InFlight {
  lane: number;
  title: string;
  discovery: boolean;
}

/**
 * The discovery queue policy (prioritizeDiscoveries) applied per lane, with
 * one more rule: at most ONE discovery lap in flight per repo. A discovery
 * has no `Depends on:`, so it always looks independent and would otherwise
 * fill every lane (the jetpack starvation of 2026-11-02, times the width).
 * Majors still go first — in that one lane; minors wait until no product
 * issue is claimable (in flight counts: the PRD backlog has not drained).
 */
export function pickForLane(ranked: IssueLite[], inFlight: Map<number, InFlight>): IssueLite | undefined {
  const discoveryInFlight = [...inFlight.values()].some((f) => f.discovery);
  const productClaimable = ranked.some((i) => !isDiscovery(i));
  const free = ranked.filter((i) => !inFlight.has(i.number));
  if (!discoveryInFlight) {
    const major = free.find((i) => isDiscovery(i) && !isMinor(i));
    if (major) return major;
  }
  const product = free.find((i) => !isDiscovery(i));
  if (product) return product;
  if (!discoveryInFlight && !productClaimable) return free.find((i) => isDiscovery(i) && isMinor(i));
  return undefined;
}

/**
 * The repo's merge queue: an in-process FIFO (all lanes of a repo live in
 * one process), so "ready order" is arrival order. Each turn is mirrored to
 * the ledger's merge_queue table for the dashboard. `mergedSince` names the
 * issues this queue merged after a given time — the conflict findings tell a
 * repairing lap what landed ahead of it.
 */
export class MergeQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private merged: { issue: number; title: string; at: number }[] = [];

  constructor(private ledger: Ledger, private repo: string) {}

  async run<T>(issue: number, lapId: number, fn: (set: (state: MergeQueueState, detail?: string) => void) => Promise<T>): Promise<T> {
    const id = this.ledger.mergeQueueEnter(this.repo, issue, lapId);
    const set = (state: MergeQueueState, detail?: string) => this.ledger.mergeQueueSet(id, state, detail ?? null);
    const turn = this.tail.then(async () => {
      try {
        return await fn(set);
      } catch (e) {
        set("bounced", `error: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
        throw e;
      }
    });
    this.tail = turn.catch(() => {});
    return turn;
  }

  noteMerged(issue: number, title: string) {
    this.merged.push({ issue, title, at: Date.now() });
  }

  mergedSince(t: number): { issue: number; title: string }[] {
    return this.merged.filter((m) => m.at >= t).map(({ issue, title }) => ({ issue, title }));
  }
}

/** run one repo's lanes until nothing is claimable or a stop condition hits */
export async function runParallel(cfg: RepoConfig, stateDir: string, deps: TickDeps): Promise<void> {
  const lanes = cfg.scheduling?.max_lanes ?? 3;
  const budgetMs = +(process.env.PDF_CHAIN_BUDGET_MS ?? 12 * 60_000);
  const startCap = 6 * lanes;
  const t0 = Date.now();
  const inFlight = new Map<number, InFlight>();
  const retryNextTick = new Set<number>();
  const mergeQueue = new MergeQueue(deps.ledger, cfg.repo);
  const filedThisTick: string[] = [];
  let started = 0;
  let held = 0; // leases this process holds or waits for: the first is a first lane
  let stop: string | null = null;
  let finishes = 0;
  let waiters: (() => void)[] = [];
  const notify = () => {
    finishes++;
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  };
  const nextFinish = () => new Promise<void>((r) => waiters.push(r));
  const pausedFile = join(stateDir, "repos", cfg.slug, "paused");
  const stopWith = (why: string) => {
    if (!stop) {
      stop = why;
      repoReceipt(cfg.slug, stateDir, why);
    }
  };

  const stopReason = (): string | null => {
    if (stop) return stop;
    if (existsSync(pausedFile)) {
      let why = "";
      try {
        why = readFileSync(pausedFile, "utf8").trim().replace(/^\S+\s*/, "");
      } catch {}
      stopWith(`paused — no new lap starts on ${cfg.slug}${why ? ` (${why.slice(0, 200)})` : ""}; in-flight laps finish`);
      return stop;
    }
    const ceiling = cfg.limits?.daily_attempts ?? 0;
    if (ceiling > 0) {
      const used = deps.ledger.countStages(cfg.repo, "implement", new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
      if (used >= ceiling) {
        stopWith(`daily attempt ceiling reached for ${cfg.slug}: ${used}/${ceiling} implement attempts today (UTC, shared by every lane) — no new lap starts; resumes after 00:00 UTC`);
        return stop;
      }
    }
    const fleet = fleetCeilingReached(deps.ledger);
    if (fleet) {
      stopWith(`${fleet} — no new lap starts on ${cfg.slug}`);
      return stop;
    }
    if (Date.now() - t0 >= budgetMs) {
      stopWith(`chain budget (${Math.round(budgetMs / 60_000)} min) spent for ${cfg.slug} this tick — no new lap starts; the next tick takes the rest`);
      return stop;
    }
    if (started >= startCap) {
      stopWith(`start cap (${startCap} laps, ${lanes} lanes) reached for ${cfg.slug} this tick — the next tick takes the rest`);
      return stop;
    }
    return null;
  };

  /** claimable issues not waiting for the next tick, critical path first */
  const ranked = async (): Promise<{ list: IssueLite[]; depthOf: Map<number, number> }> => {
    try {
      Object.assign(cfg, loadRepoConfig(join(stateDir, "repos", cfg.slug, "config.json")));
    } catch {}
    const d = await listClaimableDetailed(cfg, deps.ledger, deps.gh).catch(() => null);
    if (!d) return { list: [], depthOf: new Map() };
    const ranks = rankByCriticalPath(
      d.claimable.filter((i) => !retryNextTick.has(i.number)),
      d.open
    );
    return { list: ranks.map((r) => r.issue), depthOf: new Map(ranks.map((r) => [r.issue.number, r.depth])) };
  };

  const ctxFor = (lane: number): LaneCtx => ({
    lane,
    siblings: () => [...inFlight.entries()].filter(([, f]) => f.lane !== lane).map(([number, f]) => ({ number, title: f.title })),
    mergeQueue,
    filedThisTick,
  });

  const laneLoop = async (lane: number) => {
    for (;;) {
      if (stopReason()) return;
      const seen = finishes;
      const first = await ranked();
      if (!pickForLane(first.list, inFlight)) {
        // nothing for this lane now; a sibling's merge may unblock a
        // dependent, so wait for the next finish while anything is in flight
        if (finishes !== seen) continue;
        if (inFlight.size === 0) return;
        await nextFinish();
        continue;
      }
      const extra = held > 0;
      held++;
      let lease;
      try {
        lease = await acquireLaneSlot(cfg, stateDir, deps, lane, extra);
      } catch (e) {
        held--;
        throw e;
      }
      if (!lease) {
        held--;
        return; // paused while waiting, or parked for the next tick
      }
      // pick again: the wait may have outlived the first pick, and a sibling
      // may have taken it. No await between this pick and the reservation.
      const fresh = await ranked();
      const pick = pickForLane(fresh.list, inFlight);
      if (!pick || stopReason()) {
        releaseSlot(deps.ledger, lease.id, pick ? "stopped before the lap started" : "nothing claimable after the wait");
        held--;
        if (!pick && inFlight.size > 0 && !stop) {
          await nextFinish();
          continue;
        }
        return;
      }
      inFlight.set(pick.number, { lane, title: pick.title, discovery: isDiscovery(pick) });
      started++;
      const others = inFlight.size - 1;
      repoReceipt(
        cfg.slug,
        stateDir,
        `lane ${lane}: #${pick.number} "${pick.title.slice(0, 80)}" (critical path ${fresh.depthOf.get(pick.number) ?? 1}, ${others} other lap${others === 1 ? "" : "s"} in flight${lease.pool !== cfg.env.mode ? `, on ${lease.pool}` : ""})`
      );
      let outcome: string | null = null;
      try {
        outcome = await runLap(configForPool(cfg, lease.pool), stateDir, deps, pick, { lease, lane: ctxFor(lane) });
      } catch (e: any) {
        repoReceipt(cfg.slug, stateDir, `lane ${lane}: lap #${pick.number} error on ${cfg.slug}: ${String(e?.message ?? e).slice(0, 300)}`);
      } finally {
        inFlight.delete(pick.number);
        releaseSlot(deps.ledger, lease.id);
        held--;
        notify();
      }
      if (outcome === null || outcome === "error") retryNextTick.add(pick.number);
      if (outcome === "infra_deferred") stopWith(`platform unavailable — no new lap starts on ${cfg.slug} this tick; in-flight laps finish`);
      // billing_hold wrote the paused marker: stopReason() sees it next
    }
  };

  const initial = await ranked();
  repoReceipt(cfg.slug, stateDir, `parallel: ${lanes} lane(s) on ${cfg.slug}, ${initial.list.length} claimable (critical path first: ${initial.list.slice(0, 5).map((i) => `#${i.number}`).join(" ") || "none"})`);
  await Promise.all(Array.from({ length: lanes }, (_, k) => laneLoop(k)));

  if (stop && /budget|start cap/.test(stop)) return; // its receipt already says the rest resumes next tick
  if (!stop && started > 0) {
    const d = await listClaimableDetailed(cfg, deps.ledger, deps.gh).catch(() => null);
    if (d && d.skips.openCount > 0 && d.claimable.length === 0)
      repoReceipt(cfg.slug, stateDir, `parallel lanes idle after ${started} lap(s): ${d.skips.openCount} open, none claimable — ${describeIntakeSkips(d.skips)}`);
    else if (retryNextTick.size > 0)
      repoReceipt(cfg.slug, stateDir, `#${[...retryNextTick].join(" #")} errored this tick — the next tick retries`);
  }
}
