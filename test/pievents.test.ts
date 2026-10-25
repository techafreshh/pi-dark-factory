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
      input_tokens: 8693 + 3633,
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
