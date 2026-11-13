import { useCallback, useEffect, useRef, useState } from "react";

/** Shapes served by bin/dashboard.ts. */

export interface StageRef { stage: string; model: string; attempt: number; started_at: string; ended_at: string | null; exit: string | null }
export interface LiveLap { id: number; repo: string; slug: string; issue_number: number; title: string | null; started_at: string; attempts: number | null; pr: number | null; stage: StageRef | null }
export interface NeedsYou { kind: "blocked" | "paused" | "daily_cap" | "billing" | "backup" | "slot_wait"; repo: string | null; slug: string | null; issue: number | null; title: string | null; detail: string; at: string | null; pr?: number | null; attempts?: number; lap_id?: number | null }
export interface ModelHealth { model: string; tries: number; ok: number; failed: number; billing: number; last_at: string; last_outcome: string; last_error: string | null }
export type MachineProvider = "instabox" | "boxd" | "daytona" | "e2b" | "instavm";
export interface MachineRow { provider: MachineProvider; name: string; state: string; slug: string | null; issue: number | null; created: string | null }
export interface MachinePool { provider: MachineProvider; configured: boolean; error: string | null; machines: MachineRow[] }

export interface Summary {
  generatedAt: string;
  slugs: Record<string, string>;
  kpis: {
    laps_today: number; merged_today: number; laps_7d: number; merged_7d: number; blocked_7d: number;
    merge_rate_7d: number | null; cost_today: number; cost_7d: number; cost_all: number;
    tokens_today: number; tokens_7d: number; tokens_all: number; blocked_issues: number;
  };
  needs_you: NeedsYou[];
  live: LiveLap[];
  outcomes_by_day: ({ day: string } & Record<string, number>)[];
  cost_by_day: { day: string; i: number; o: number; cost: number; stages: number }[];
  model_health: ModelHealth[];
  stage_model: { stage: string; model: string; n: number; ok: number; i: number; o: number; cost: number | null; avg_s: number | null }[];
  scheduler: { last_pass_at: string | null; last_pass: string; ticks_running: string[]; minutes: number | null; next_pass_at: string | null; daemon_up: boolean };
  machines: MachinePool[];
  backup: { last_ok_at?: string | null; last_id?: string; last_error?: string | null; last_error_at?: string | null } | null;
}

export type PoolName = "instabox" | "boxd" | "daytona" | "e2b" | "instavm";
export interface PoolRow { pool: PoolName; cap: number; used: number; waiting: number; parked: number }
export interface LeaseRow {
  id: number; repo: string; slug: string; lane: number; pool: PoolName; priority: string; issue: number | null; title: string | null;
  lap_id: number | null; granted_at: string; requested_at: string; spilled: boolean; stage: StageRef | null;
}
export interface WaitingRow {
  id: number; repo: string; slug: string; lane: number; pools: PoolName[]; priority: string; effective: string;
  extra_lane: boolean; state: "waiting" | "parked"; requested_at: string; position: number;
}
export interface LaneRepo {
  repo: string; slug: string; parallel: boolean; max_lanes: number; priority: string; spill_over: boolean; mode: string | null;
  laps: LeaseRow[]; waiting: number;
}
export interface MergeQueueRow { id: number; repo: string; issue_number: number; lap_id: number; state: string; entered_at: string; updated_at: string; detail: string | null; title: string | null }
export interface Scheduling {
  generatedAt: string; aging_minutes: number; daemon_up: boolean;
  pools: PoolRow[]; leases: LeaseRow[]; waiting: WaitingRow[]; lanes: LaneRepo[];
  merge_queues: { repo: string; slug: string; open: MergeQueueRow[]; recent: MergeQueueRow[] }[];
  spills: { id: number; repo: string; slug: string; issue: number | null; title: string | null; pool: PoolName; own: string | null; granted_at: string; state: string }[];
}

export interface Project {
  repo: string; slug: string; mode: string | null; onboarded: boolean; paused: { at: string; reason: string } | null; running: boolean;
  laps: number; merged: number; blocked_laps: number; laps_7d: number; merged_7d: number; last_lap: string | null;
  issues_blocked: number; issues_in_progress: number; issues_merged: number; tokens: number; cost: number; cost_7d: number;
}

export interface LapRow {
  id: number; repo: string; slug: string; issue_number: number; title: string | null; started_at: string; ended_at: string | null;
  detail: string | null; pr: number | null; status: string; duration_s: number | null; stages: number | null;
  i: number | null; o: number | null; cost: number | null; attempts: number | null; models: string | null;
}
export interface LapPage { total: number; limit: number; offset: number; rows: LapRow[] }

export interface Artifact { file: string; stage: string | null; attempt: number | null; started: string | null; ended: string; bytes: number; kind: "machine" | "host" }
export interface StageDetail {
  id: number; stage: string; attempt: number; model: string; started_at: string | null; ended_at: string | null; exit: string | null;
  duration_s: number | null; input_tokens: number | null; output_tokens: number | null; cost: number | null; error: string | null;
  tried: { model: string; outcome: string; error?: string }[] | null; artifact: Artifact | null;
}
export interface LapDetail {
  lap: { id: number; repo: string; slug: string | null; issue_number: number; title: string | null; started_at: string; ended_at: string | null;
    outcome: string | null; detail: string | null; status: string; pr: number | null; branch: string | null; issue_state: string | null; last_error: string | null };
  stages: StageDetail[];
  extra_artifacts: Artifact[];
  plan: string | null;
  issue_laps: { id: number; started_at: string; status: string }[];
}

export type SessionPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; redacted: boolean }
  | { type: "tool_call"; id: string; name: string; args: string };
export interface SessionMessage {
  role: "system" | "user" | "assistant" | "tool"; ts: number | null; parts: SessionPart[];
  model?: string; provider?: string; usage?: { input: number; output: number; cacheRead: number; cost: number } | null;
  durationMs?: number | null; stopReason?: string | null; error?: string | null;
  toolCallId?: string; toolName?: string; isError?: boolean;
}
export interface Session {
  file: string; bytes: number; modified: string; header: { id: string; timestamp: string; cwd?: string } | null;
  messages: SessionMessage[]; truncated: boolean; unparsed_lines: number;
  stats: { turns: number; tool_calls: number; tool_errors: number; input: number; output: number; cacheRead: number; cost: number;
    thinking: number; thinking_redacted: number; tools: Record<string, number>; models: string[] };
}

/** fetch JSON relative to the app (works at / and behind Caddy at /dashboard/) */
export function useApi<T>(url: string | null, refreshMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!url) return;
    const mine = ++seq.current;
    setLoading(true);
    fetch(url)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
        return j as T;
      })
      .then((j) => {
        if (mine !== seq.current) return; // a newer request superseded this one
        setData(j);
        setError(null);
      })
      .catch((e) => mine === seq.current && setError(String(e?.message ?? e)))
      .finally(() => mine === seq.current && setLoading(false));
  }, [url]);
  useEffect(() => {
    load();
    if (!refreshMs) return;
    const t = setInterval(() => document.visibilityState === "visible" && load(), refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);
  return { data, error, loading, reload: load };
}
