import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { billingFailure, billingHold, buildPiArgs, callPi, callPiWithFallback } from "../src/pi";
import type { ModelSpec, StageModels } from "../src/types";

let fixtureDir: string;
let fakePi: string;
let passExec: string;
let cleanupMark: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "pdfpi-"));
  fakePi = join(fixtureDir, "fake-pi");
  writeFileSync(
    fakePi,
    [
      "#!/usr/bin/env python3",
      "import sys, os, json",
      "prompt = sys.stdin.read()",
      "args = sys.argv[1:]",
      "",
      "def emit(text):",
      "    print(json.dumps({'type': 'message_end', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': text}]}}), flush=True)",
      "    sys.exit(0)",
      "",
      "mode = os.environ.get('FAKE_MODE', 'ok')",
      "if mode == 'ok':",
      "    if '--provider' in args and args[args.index('--provider')+1] == 'bad':",
      "        sys.stderr.write('Error 429: rate limit'); sys.exit(1)",
      "    emit('PROMPT<[' + prompt[:24] + ']>')",
      "elif mode == 'hang':",
      "    import time; time.sleep(120)",
      "elif mode == 'no_text':",
      "    print(json.dumps({'type': 'agent_start'}), flush=True); sys.exit(0)",
      "elif mode == 'env':",
      "    emit(','.join(sorted(os.environ.keys())))",
      "else:",
      "    sys.exit(2)",
    ].join("\n")
  );
  chmodSync(fakePi, 0o755);
  // passthrough wrapper (docker prefix stand-in) and a cleanup that drops a marker file
  passExec = join(fixtureDir, "pass-exec");
  writeFileSync(passExec, "#!/usr/bin/env bash\nexec \"$@\"\n");
  chmodSync(passExec, 0o755);
  cleanupMark = join(fixtureDir, "cleanup-mark");
  writeFileSync(cleanupMark, "#!/usr/bin/env bash\ntouch \"$1\"\n");
  chmodSync(cleanupMark, 0o755);
});

afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

const model = (provider: string, m = "m"): ModelSpec => ({ provider, model: m });
const opts = (timeoutMs: number) => ({
  binary: fakePi,
  prompt: "do the thing",
  cwd: fixtureDir,
  timeoutMs,
  tools: ["read", "bash"],
  // the fake's control knob rides the same allowlist a repo's pass_env does
  passEnv: ["FAKE_MODE"],
});

describe("buildPiArgs", () => {
  test("assembles the one-shot command line", () => {
    const args = buildPiArgs({
      binary: "pi",
      model: { provider: "zai", model: "glm-5.3", thinking: "high" },
      prompt: "x",
      cwd: "/x",
      tools: ["read", "bash"],
      sessionDir: "/sessions",
      systemPrompt: "be careful",
      extraArgs: ["--flag"],
      timeoutMs: 1000,
    });
    expect(args.join(" ")).toContain("--mode json --provider zai --model glm-5.3 --thinking high --tools read,bash --session-dir /sessions --append-system-prompt be careful --flag");
  });
});

describe("callPi (real subprocess, fake pi)", () => {
  test("ok: prompt arrives via stdin, assistant text extracted", async () => {
    const res = await callPi({ ...opts(5000), model: model("good") });
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.text).toContain("PROMPT<[do the thing");
    }
  }, 10000);

  test("provider error on non-zero exit", async () => {
    const res = await callPi({ ...opts(5000), model: model("bad") });
    expect(res.kind).toBe("provider_error");
    if (res.kind === "provider_error") expect(res.error).toContain("429");
  }, 10000);

  test("no assistant text is a provider error, not ok", async () => {
    process.env.FAKE_MODE = "no_text";
    try {
      const res = await callPi({ ...opts(5000), model: model("good") });
      expect(res.kind).toBe("provider_error");
    } finally {
      delete process.env.FAKE_MODE;
    }
  }, 10000);

  test("timeout kills the process tree and returns quickly", async () => {
    process.env.FAKE_MODE = "hang";
    try {
      const started = Date.now();
      const res = await callPi({ ...opts(1500), model: model("good") });
      expect(res.kind).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      delete process.env.FAKE_MODE;
    }
  }, 10000);

  test("the agent sees an env allowlist: factory secrets stay out, pass_env and the web key ride in", async () => {
    const secrets = ["FACTORY_API_KEY", "DARK_FACTORY_LAPTOP_KEY", "INSTABOX_API_KEY", "BOXD_API_KEY", "GH_TOKEN"];
    const touched = [...secrets, "ZAI_API_KEY", "TINYFISH_API_KEY", "FAKE_MODE"];
    const saved = Object.fromEntries(touched.map((k) => [k, process.env[k]]));
    for (const k of secrets) process.env[k] = "secret-" + k;
    process.env.ZAI_API_KEY = "model-key";
    process.env.TINYFISH_API_KEY = "web-key";
    process.env.FAKE_MODE = "env";
    try {
      const res = await callPi({ ...opts(5000), model: model("good"), passEnv: ["FAKE_MODE", "ZAI_API_KEY"] });
      expect(res.kind).toBe("ok");
      const names = res.kind === "ok" ? res.text.split(",") : [];
      for (const k of secrets) expect(names).not.toContain(k);
      expect(names).toContain("ZAI_API_KEY"); // the repo's pass_env
      expect(names).toContain("TINYFISH_API_KEY"); // force-delivered like the machine env file
      expect(names).toContain("PATH");
      expect(names).toContain("HOME");
    } finally {
      for (const k of touched) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }, 10000);
});

describe("callPi with runnerPrefix (container mode)", () => {
  test("prefix wraps the pi argv; cleanup argv runs after a clean exit", async () => {
    const marker = join(fixtureDir, "cleanup-ran-marker");
    try {
      rmSync(marker, { force: true });
    } catch {}
    const res = await callPi({
      ...opts(5000),
      model: model("good"),
      runnerPrefix: { argvPrefix: [passExec], cleanupArgv: [cleanupMark, marker] },
    });
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.text).toContain("PROMPT<[do the thing");
    expect(existsSync(marker)).toBe(true); // docker rm -f ran even on success
  }, 10000);

  test("cleanup argv also runs after a timeout kill", async () => {
    const marker = join(fixtureDir, "cleanup-timeout-marker");
    try {
      rmSync(marker, { force: true });
    } catch {}
    process.env.FAKE_MODE = "hang";
    try {
      const res = await callPi({
        ...opts(1200),
        model: model("good"),
        runnerPrefix: { argvPrefix: [passExec], cleanupArgv: [cleanupMark, marker] },
      });
      expect(res.kind).toBe("timeout");
      expect(existsSync(marker)).toBe(true);
    } finally {
      delete process.env.FAKE_MODE;
    }
  }, 10000);
});

describe("callPiWithFallback (hot model failover)", () => {  const models = (base: ModelSpec, fallback: ModelSpec[]): StageModels => ({ base, fallback });

  test("base provider error advances to the fallback model", async () => {
    const res = await callPiWithFallback(
      { ...opts(5000), prompt: "go" },
      models(model("bad"), [model("good")])
    );
    expect(res.outcome.kind).toBe("ok");
    expect(res.modelsTried.map((t) => t.spec.provider)).toEqual(["bad", "good"]);
  }, 10000);

  test("chain exhaustion returns the last provider error", async () => {
    const res = await callPiWithFallback(
      { ...opts(5000) },
      models(model("bad"), [model("bad")])
    );
    expect(res.outcome.kind).toBe("provider_error");
    expect(res.modelsTried.length).toBe(2);
  }, 10000);

  test("timeout is not retried on another model", async () => {
    process.env.FAKE_MODE = "hang";
    try {
      const res = await callPiWithFallback(
        { ...opts(1500) },
        models(model("good"), [model("good")])
      );
      expect(res.outcome.kind).toBe("timeout");
      expect(res.modelsTried.length).toBe(1); // stopped immediately
    } finally {
      delete process.env.FAKE_MODE;
    }
  }, 10000);
});

describe("billingFailure (errors no retry can fix)", () => {
  const pe = (error: string) => ({ kind: "provider_error" as const, error });

  test("the recorded out-of-credit shape is a billing failure", () => {
    // verbatim prefix from the ledger (machine-mode implement, kvstore #19, 2026-11-09)
    const real =
      'machine model produced no final text: 402: {"message":"Insufficient Balance (request_id: 282682a1-cec5-4782-a3a6-ab53835170d3)","type":"insufficient_balance_error"}';
    expect(billingFailure(pe(real))).toContain("out of credit (402)");
  });

  test("a rejected key is a billing failure too", () => {
    expect(billingFailure(pe("pi exited 1: 401 Unauthorized: invalid api key"))).toContain("rejected the API key (401)");
  });

  test("rate limits, outages, dead streams and non-provider outcomes are not", () => {
    for (const e of ["pi exited 1: Error 429: rate limit", "HTTP 500 upstream", "terminated", "model produced no final text: stream cut"]) {
      expect(billingFailure(pe(e))).toBeNull();
    }
    expect(billingFailure({ kind: "timeout" })).toBeNull();
    expect(billingFailure({ kind: "ok", text: "the docs mention 402 Payment Required", usage: null })).toBeNull();
  });
});

describe("billingHold (only when no model in the chain can serve)", () => {
  // provider texts recorded 2026-11-10 from the factory's own models.json providers
  const RIVER_402 = 'model produced no final text: 402: {"message":"Billing: insufficient_funds","type":"invalid_request_error","code":null}';
  const DEEPSEEK_402 = 'model produced no final text: 402: {"message":"Insufficient Balance (request_id: 6e70b4f4)","type":"insufficient_balance_error"}';
  const COOLING_429 = 'model produced no final text: 429: {"message":"all clinepass keys are cooling"}';
  const step = (provider: string, outcome: "ok" | "provider_error", error?: string) => ({
    spec: { provider, model: "m" },
    outcome,
    ...(error ? { error } : {}),
  });
  const res = (steps: ReturnType<typeof step>[]) => {
    const last = steps[steps.length - 1];
    return {
      outcome: last.outcome === "ok" ? { kind: "ok" as const, text: "x", usage: null } : { kind: "provider_error" as const, error: last.error! },
      modelsTried: steps,
    };
  };

  test("every model out of credit is a hold, and the reason names each one", () => {
    const why = billingHold(res([step("river", "provider_error", RIVER_402), step("deepseek", "provider_error", DEEPSEEK_402)]));
    expect(why).toContain("river/m");
    expect(why).toContain("deepseek/m");
  });

  test("a transient failure anywhere in the chain is not a hold", () => {
    expect(billingHold(res([step("meta", "provider_error", "pi exited 1: HTTP 500"), step("river", "provider_error", RIVER_402), step("deepseek", "provider_error", DEEPSEEK_402)]))).toBeNull();
    expect(billingHold(res([step("river", "provider_error", RIVER_402), step("clinepass-rotator", "provider_error", COOLING_429), step("deepseek", "provider_error", DEEPSEEK_402)]))).toBeNull();
  });

  test("a fallback that served means the stage worked", () => {
    expect(billingHold(res([step("river", "provider_error", RIVER_402), step("meta", "ok")]))).toBeNull();
  });
});
