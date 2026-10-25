import type { Usage } from "./types";

export interface ParsedEvents {
  /** text of the FINAL assistant message (last one wins — tool-loop turns are overwritten) */
  assistantText: string | null;
  usage: Usage | null;
  errorHint: string | null;
}

function extractUsage(u: any): Usage | null {
  if (!u || typeof u !== "object") return null;
  // pi's own wire shape is {input, output, reasoning, cacheRead, ...} — the
  // OpenAI/Anthropic names below are for foreign/legacy streams. This missed
  // the pi shape for the factory's whole life: every stage row ever recorded
  // answered tok=None/None (found 2026-10-25 against real bi-ai-ui streams).
  const input = u.inputTokens ?? u.input_tokens ?? u.promptTokens ?? u.prompt_tokens ?? u.input;
  const output = u.outputTokens ?? u.output_tokens ?? u.completionTokens ?? u.completion_tokens ?? u.output;
  const reasoning = u.reasoningTokens ?? u.reasoning ?? 0;
  if (input === undefined && output === undefined) return null;
  return { input_tokens: Number(input ?? 0), output_tokens: Number(output ?? 0) + Number(reasoning ?? 0) };
}

/** usage arrives per-message (each message_end carries that message's
 *  tokens) — a stage's real cost is the SUM, not the last message's. */
function addUsage(into: Usage | null, u: Usage | null): Usage | null {
  if (!u) return into;
  if (!into) return { ...u };
  return { input_tokens: into.input_tokens + u.input_tokens, output_tokens: into.output_tokens + u.output_tokens };
}

function textOfMessage(message: any): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((b: any) => b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
}

/**
 * Parse a `pi --mode json` stdout stream (one JSON event per line, wire
 * version 3). Pure function — unit-tested against fixture streams.
 */
export function parseEventStream(lines: string[]): ParsedEvents {
  let assistantText: string | null = null;
  let usage: Usage | null = null;
  let errorHint: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: any;
    try {
      e = JSON.parse(trimmed);
    } catch {
      continue; // tolerate stray non-JSON noise
    }
    if (!e || typeof e !== "object") continue;
    switch (e.type) {
      case "message_end": {
        const u = extractUsage(e.usage ?? e.message?.usage);
        if (u) usage = addUsage(usage, u);
        if (e.message?.role === "assistant") {
          if (e.message.stopReason === "error") {
            // a failed model stream is a provider error, not an empty verdict —
            // surface the upstream message so callers fail honestly (429/402
            // used to masquerade as an empty review and burn the re-ask loop)
            errorHint = String(e.message.errorMessage ?? e.errorMessage ?? "model stream error").slice(0, 500);
            assistantText = null;
            break;
          }
          const t = textOfMessage(e.message);
          if (t) assistantText = t; // empty assistant text is no text at all
        }
        break;
      }
      case "turn_end": {
        const u = extractUsage(e.usage);
        if (u) usage = addUsage(usage, u);
        break;
      }
      case "agent_end": {
        const u = extractUsage(e.usage);
        if (u) usage = addUsage(usage, u);
        if (assistantText === null && Array.isArray(e.messages)) {
          const last = [...e.messages].reverse().find((m: any) => m?.role === "assistant");
          const t = last ? textOfMessage(last) : "";
          if (t) assistantText = t; // only real text may become the verdict
        }
        break;
      }
      default: {
        if (typeof e.type === "string" && e.type.includes("error")) {
          errorHint = String(e.error ?? e.message ?? trimmed).slice(0, 500);
        }
        if (e.error) errorHint = String(e.error).slice(0, 500);
      }
    }
  }
  return { assistantText, usage, errorHint };
}
