import { spawn as nodeSpawn } from "node:child_process";
import { parseEventStream } from "./pievents";
import { killTree, sh } from "./sh";
import type { ModelSpec, StageModels, Usage } from "./types";

export interface PiCallOpts {
  binary: string;
  model: ModelSpec;
  prompt: string;
  cwd: string;
  tools?: string[];
  noTools?: boolean;
  sessionDir?: string;
  systemPrompt?: string;
  extraArgs?: string[];
  timeoutMs: number;
  /** kill a run whose stdout/stderr has emitted nothing for this long — every
   *  live signal (reasoning deltas, tool updates, partial tool output) produces
   *  bytes, so silence means a hung turn, a wedged tool process, or a stalled
   *  provider request; surfaces as "timeout" so the caller's continue-ladder
   *  resumes the session instead of waiting out the whole stage budget */
  quietMs?: number;
  /** container mode: docker prefix; cleanupArgv runs after any exit (docker rm -f) */
  runnerPrefix?: { argvPrefix: string[]; cleanupArgv?: string[] };
}

export type PiOutcome =
  | { kind: "ok"; text: string; usage: Usage | null }
  | { kind: "timeout"; error?: string }
  | { kind: "provider_error"; error: string }
  | { kind: "spawn_error"; error: string };

const STDOUT_CAP = 5_000_000;

export function buildPiArgs(o: PiCallOpts): string[] {
  const args = [
    "--mode", "json",
    "--provider", o.model.provider,
    "--model", o.model.model,
  ];
  if (o.model.thinking) args.push("--thinking", o.model.thinking);
  if (o.noTools) {
    args.push("--no-tools");
  } else if (o.tools) {
    args.push("--tools", o.tools.join(","));
  }
  if (o.sessionDir) args.push("--session-dir", o.sessionDir);
  if (o.systemPrompt) args.push("--append-system-prompt", o.systemPrompt);
  if (o.extraArgs) args.push(...o.extraArgs);
  return args;
}

async function drainStream(stream: ReadableStream<Uint8Array> | undefined): Promise<string[]> {
  if (!stream) return [];
  const dec = new TextDecoder();
  let buf = "";
  const lines: string[] = [];
  try {
    for await (const chunk of stream) {
      buf += dec.decode(chunk, { stream: true });
      if (buf.length > STDOUT_CAP) buf = buf.slice(-STDOUT_CAP);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
  } catch {
    // killed mid-stream — lines collected so far are enough
  }
  if (buf) lines.push(buf);
  return lines;
}

/**
 * One-shot `pi --mode json` call: prompt via stdin, events on stdout, fresh
 * process per stage. Spawned under setsid (Linux) so a timeout kills the
 * whole process tree — no orphaned workers.
 */
export async function callPi(o: PiCallOpts): Promise<PiOutcome> {
  const cmd = [...(o.runnerPrefix?.argvPrefix ?? []), o.binary, ...buildPiArgs(o)];
  let proc: any;
  try {
    // container mode: the payload lives in the docker daemon, not this
    // process tree — the docker client itself needs no setsid group
    const full = process.platform === "linux" && !o.runnerPrefix ? ["setsid", ...cmd] : cmd;
    // node:child_process, not Bun.spawn — the Bun transport parked inside
    // long-lived factory processes (daemon laps/ticks) with no child and an
    // unresolved exit promise while identical shell invocations worked.
    proc = nodeSpawn(full[0], full.slice(1), {
      cwd: o.cwd,
      env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.on("error", () => {}); // spawn failures surface via the exit promise
  } catch (e: any) {
    return { kind: "spawn_error", error: `cannot start ${o.binary}: ${e.message}` };
  }

  const stdoutP = drainStream(proc.stdout);
  const stderrP = (async () => {
    let s = "";
    try {
      const dec = new TextDecoder();
      for await (const chunk of proc.stderr) s += dec.decode(chunk, { stream: true });
    } catch {}
    return s.slice(0, 20000);
  })();
  proc.stdin.on?.("error", () => {}); // a failed exec EPIPEs the write; the
  // exit promise below reports it — an unhandled stdin error must never
  // kill the worker
  try {
    proc.stdin.write(o.prompt);
    proc.stdin.end();
  } catch {}

  // heartbeat taps alongside the async-iterator drains below — any byte on
  // stdout/stderr (thinking delta, tool update, partial tool output) counts
  // as life; only true silence ages the quiet clock
  let lastActivity = Date.now();
  proc.stdout?.on?.("data", () => { lastActivity = Date.now(); });
  proc.stderr?.on?.("data", () => { lastActivity = Date.now(); });

  const exited = new Promise<number>((resolve) => {
    proc.on("exit", (c: any) => resolve(c ?? 137));
    proc.on("error", () => resolve(127));
  });
  let timedOut = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutP =
    o.timeoutMs > 0
      ? new Promise<number>((resolve) => {
          timeoutTimer = setTimeout(() => {
            timedOut = true;
            killTree(proc.pid);
            resolve(137);
          }, o.timeoutMs);
        })
      : null;
  let quietKilled = false;
  let quietIv: ReturnType<typeof setInterval> | null = null;
  const quietP =
    o.quietMs && o.quietMs > 0
      ? new Promise<number>((resolve) => {
          quietIv = setInterval(() => {
            if (Date.now() - lastActivity >= (o.quietMs ?? 0)) {
              quietKilled = true;
              killTree(proc.pid);
              resolve(137);
            }
          }, 30_000);
        })
      : null;
  const racers = timeoutP || quietP ? [exited, ...(timeoutP ? [timeoutP] : []), ...(quietP ? [quietP] : [])] : [exited];
  const code = await Promise.race(racers);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  if (quietIv) clearInterval(quietIv);
  if (o.runnerPrefix?.cleanupArgv) {
    // --rm removes normally-exiting containers; rm -f is the mop-up for
    // killed clients, timeouts, and crashes — and is idempotent
    await sh(o.runnerPrefix.cleanupArgv, { timeoutMs: 20000 }).catch(() => {});
  }
  if (timedOut) return { kind: "timeout" };
  if (quietKilled)
    return { kind: "timeout", error: `no stream output for ${Math.round((o.quietMs ?? 0) / 60_000)}m` };

  const [lines, stderr] = await Promise.all([stdoutP, stderrP]);
  const parsed = parseEventStream(lines);
  if (code !== 0) {
    const detail = parsed.errorHint ?? stderr.trim().split("\n").slice(-5).join("\n");
    return { kind: "provider_error", error: `pi exited ${code}: ${detail.slice(0, 500)}` };
  }
  if (parsed.assistantText === null) {
    const detail = (parsed.errorHint ?? stderr.trim().slice(0, 300)) || "no assistant message in event stream";
    return { kind: "provider_error", error: `model produced no final text: ${detail}` };
  }
  return { kind: "ok", text: parsed.assistantText, usage: parsed.usage };
}

export interface PiStageResult {
  outcome: PiOutcome;
  modelsTried: { spec: ModelSpec; outcome: PiOutcome["kind"]; error?: string }[];
}

/**
 * Run a stage against [base, ...fallback]. Provider errors advance the
 * chain; timeouts and spawn errors return immediately (a hung stream is a
 * host problem, not a model problem — retrying on another model just burns
 * the same memory twice).
 */
export async function callPiWithFallback(o: Omit<PiCallOpts, "model">, models: StageModels): Promise<PiStageResult> {
  const chain = [models.base, ...models.fallback];
  const tried: PiStageResult["modelsTried"] = [];
  let last: PiOutcome = { kind: "provider_error", error: "no models configured" };
  for (const spec of chain) {
    const outcome = await callPi({ ...o, model: spec });
    tried.push({ spec, outcome: outcome.kind, error: outcome.kind === "ok" ? undefined : ("error" in outcome ? outcome.error : outcome.kind) });
    last = outcome;
    if (outcome.kind === "ok") return { outcome, modelsTried: tried };
    if (outcome.kind === "timeout" || outcome.kind === "spawn_error") return { outcome, modelsTried: tried };
  }
  return { outcome: last, modelsTried: tried };
}
