import { describe, expect, test } from "bun:test";
import { parseEventStream } from "../src/pievents";

describe("parseEventStream (pi --mode json wire format)", () => {
  test("final assistant message wins over earlier tool-loop turns; usage extracted", () => {
    const lines = [
      '{"type":"session","version":3,"id":"u1","cwd":"/x"}',
      '{"type":"agent_start"}',
      '{"type":"message_update","usage":{"inputTokens":10},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"planning"}}',
      '{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":"ls"}',
      '{"type":"tool_execution_end","toolCallId":"t1","result":"ok"}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"I ran ls."}]}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"tool_use","id":"x"},{"type":"text","text":"All done"}],"usage":{"inputTokens":42,"outputTokens":7}}}',
      '{"type":"agent_end"}',
    ];
    const parsed = parseEventStream(lines);
    expect(parsed.assistantText).toBe("All done");
    expect(parsed.usage).toEqual({ input_tokens: 42, output_tokens: 7 });
  });

  test("agent_end messages are the fallback when message_end is missing", () => {
    const lines = [
      '{"type":"session","version":3}',
      '{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]},{"role":"assistant","content":[{"type":"text","text":"hello back"}]}]}',
    ];
    expect(parseEventStream(lines).assistantText).toBe("hello back");
  });

  test("no assistant message at all → null text (a provider_error upstream)", () => {
    const parsed = parseEventStream(['{"type":"session","version":3}', '{"type":"agent_start"}']);
    expect(parsed.assistantText).toBeNull();
  });

  test("error events surface as errorHint", () => {
    const parsed = parseEventStream(['{"type":"provider_error_event","error":"boom 429"}']);
    expect(parsed.errorHint).toContain("boom");
  });

  test("snake_case usage keys are understood", () => {
    const parsed = parseEventStream([
      '{"type":"turn_end","usage":{"input_tokens":5,"output_tokens":6}}',
    ]);
    expect(parsed.usage).toEqual({ input_tokens: 5, output_tokens: 6 });
  });

  test("pi-native usage shape {input, output, reasoning} is understood and summed across messages", () => {
    // verbatim shapes from a real bi-ai-ui machine stream (2026-10-25) —
    // extractUsage missed these field names for the factory's whole life,
    // so every stage row ever recorded answered tok=None/None
    const lines = [
      '{"type":"message_start","message":{"role":"assistant","content":[],"provider":"river","usage":{"input":0,"output":0,"totalTokens":0}}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"one"}],"usage":{"input":8693,"output":2643,"reasoning":2554,"cacheRead":2048,"totalTokens":13384}}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"two"}],"usage":{"input":3633,"output":223,"reasoning":66,"cacheRead":10496,"totalTokens":14352}}}',
    ];
    const parsed = parseEventStream(lines);
    expect(parsed.assistantText).toBe("two");
    expect(parsed.usage).toEqual({
      // input includes cacheRead (2048 + 10496) — Meta's console counts
      // cached + uncached as one Input total; the old expectation here
      // dropped cache and undercounted input by the cache share
      input_tokens: 8693 + 3633 + 2048 + 10496,
      output_tokens: (2643 + 2554) + (223 + 66), // output + reasoning, per message, summed
    });
  });

  test("stray non-JSON lines are tolerated", () => {
    const parsed = parseEventStream([
      "noise line without braces",
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
    ]);
    expect(parsed.assistantText).toBe("ok");
  });
});

describe("usage accounting (cache tokens + event-type precedence)", () => {
  const museMessageEnd = (input: number, cacheRead: number, output: number, reasoning = 0) =>
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { input, output, cacheRead, cacheWrite: 0, reasoning, cost: { input: 0.001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.01 }, totalTokens: input + cacheRead + output },
      },
    });

  test("cacheRead folds into input — the real muse shape (2026-11-02: input 106k, cacheRead 2.2M)", () => {
    const p = parseEventStream([museMessageEnd(106626, 2210654, 32764, 17946)]);
    expect(p.usage).toEqual({ input_tokens: 106626 + 2210654, output_tokens: 32764 + 17946, cost: 0.01 });
  });

  test("turn_end totals are the fallback when message_end carries no usage (the dead path, now live)", () => {
    const p = parseEventStream([
      JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [], usage: { input: 100, output: 20, cacheRead: 900 } } }),
    ]);
    expect(p.usage).toEqual({ input_tokens: 1000, output_tokens: 20 });
  });

  test("message_end wins over turn_end totals — the same tokens are never summed twice", () => {
    const p = parseEventStream([
      museMessageEnd(1000, 5000, 100),
      JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [], usage: { input: 1000, output: 100, cacheRead: 5000 } } }),
    ]);
    expect(p.usage).toEqual({ input_tokens: 6000, output_tokens: 100, cost: 0.01 });
  });

  test("agent_end is the last-resort source", () => {
    const p = parseEventStream([
      JSON.stringify({ type: "agent_end", usage: { input: 50, output: 5, cacheRead: 0 } }),
    ]);
    expect(p.usage).toEqual({ input_tokens: 50, output_tokens: 5 });
  });
});
