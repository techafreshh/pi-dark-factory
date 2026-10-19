import type { Usage } from "./types";

export interface ParsedEvents {
  /** text of the FINAL assistant message (last one wins — tool-loop turns are overwritten) */
  assistantText: string | null;
  usage: Usage | null;
  errorHint: string | null;
}

function extractUsage(u: any): Usage | null {
  if (!u || typeof u !== "object") return null;
  const input = u.inputTokens ?? u.input_tokens ?? u.promptTokens ?? u.prompt_tokens;
  const output = u.outputTokens ?? u.output_tokens ?? u.completionTokens ?? u.completion_tokens;
  if (input === undefined && output === undefined) return null;
  return { input_tokens: Number(input ?? 0), output_tokens: Number(output ?? 0) };
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
        if (u) usage = u;
        if (e.message?.role === "assistant") assistantText = textOfMessage(e.message);
        break;
      }
      case "turn_end": {
        const u = extractUsage(e.usage);
        if (u) usage = u;
        break;
      }
      case "agent_end": {
        const u = extractUsage(e.usage);
        if (u) usage = u;
        if (assistantText === null && Array.isArray(e.messages)) {
          const last = [...e.messages].reverse().find((m: any) => m?.role === "assistant");
          if (last) assistantText = textOfMessage(last);
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
