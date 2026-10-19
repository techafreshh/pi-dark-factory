import { parseEventStream } from "./pievents";
import { killTree } from "./sh";
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
}

export type PiOutcome =
  | { kind: "ok"; text: string; usage: Usage | null }
  | { kind: "timeout" }
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
  const cmd = [o.binary, ...buildPiArgs(o)];
  let proc: any;
  try {
    const full = process.platform === "linux" ? ["setsid", ...cmd] : cmd;
    proc = Bun.spawn(full, {
      cwd: o.cwd,
      env: { ...process.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
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
  proc.stdin.write(o.prompt);
  try { proc.stdin.end(); } catch {} // FileSink.end() is sync in Bun

  const exited = proc.exited as Promise<number>;
  let timedOut = false;
  const timeoutP =
    o.timeoutMs > 0
      ? new Promise<number>((resolve) => {
          setTimeout(() => {
            timedOut = true;
            killTree(proc.pid);
            resolve(137);
          }, o.timeoutMs);
        })
      : null;
  const code = await (timeoutP ? Promise.race([exited, timeoutP]) : exited);
  if (timedOut) return { kind: "timeout" };

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
