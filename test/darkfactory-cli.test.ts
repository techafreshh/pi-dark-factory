import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatModels, formatStatus, parseArgs, run } from "../cli/bin/dark-factory.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "dfcli-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const silence = () => ({ out: () => {}, err: () => {} });

describe("parseArgs", () => {
  test("splits positionals, value flags and boolean flags", () => {
    const a = parseArgs(["scenario", "app", "runtime", "--file", "s.json", "--lint", "--branch", "dev"]);
    expect(a._).toEqual(["scenario", "app", "runtime"]);
    expect(a.file).toBe("s.json");
    expect(a.lint).toBe(true);
    expect(a.branch).toBe("dev");
  });
  test("kebab flags normalize and unknown flags error", () => {
    expect(parseArgs(["backlog", "app", "--prd-file", "PRD.md", "--max", "10"]).max).toBe("10");
    expect((parseArgs(["status", "--raw"]) as any).raw).toBe(true);
    expect(parseArgs(["status", "--wat"])?.error).toContain("unknown flag");
  });
  test("a value flag at the end errors instead of reading undefined", () => {
    expect(parseArgs(["logs", "--repo"])?.error).toContain("needs a value");
  });
});

describe("run (verbs over a mocked API)", () => {
  test("no verb prints usage and exits 2; help exits 0; unknown verb exits 2", async () => {
    const out: string[] = [];
    expect(await run([], { ...silence(), out: (s) => out.push(String(s)) })).toBe(2);
    expect(await run(["help"], silence())).toBe(0);
    expect(await run(["wat"], silence())).toBe(2);
    expect(out.join("").startsWith("dark-factory — drive a pi-dark-factory")).toBe(true);
  });

  test("status without any connection setup exits 1 with the setup hint", async () => {
    const saved = { u: process.env.DARK_FACTORY_URL, k: process.env.DARK_FACTORY_API_KEY };
    delete process.env.DARK_FACTORY_URL;
    delete process.env.DARK_FACTORY_API_KEY;
    try {
      const err: string[] = [];
      const code = await run(["status"], { home: tmp(), err: (s) => err.push(String(s)) });
      expect(code).toBe(1);
      expect(err.join("")).toContain("dark-factory setup");
    } finally {
      if (saved.u) process.env.DARK_FACTORY_URL = saved.u;
      if (saved.k) process.env.DARK_FACTORY_API_KEY = saved.k;
    }
  });

  test("env vars alone are a working config (no file)", async () => {
    const calls: any[] = [];
    process.env.DARK_FACTORY_URL = "https://factory.example";
    process.env.DARK_FACTORY_API_KEY = "envkey";
    const code = await run(["logs", "--repo", "app", "--tail", "5"], {
      ...silence(),
      fetchImpl: async (url: any, init: any) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ lines: ["l1", "l2"] }), { status: 200 });
      },
    });
    expect(code).toBe(0);
    expect(calls[0].url).toBe("https://factory.example/logs?slug=app&tail=5");
    expect(calls[0].init.headers["X-Api-Key"]).toBe("envkey");
  });

  test("setup writes the config file, where reads it back masked", async () => {
    const home = tmp();
    const out: string[] = [];
    expect(await run(["setup", "https://factory.example/", "abcd-secret"], { home, out: (s) => out.push(String(s)) })).toBe(0);
    const cfgPath = join(home, ".dark-factory", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(cfg.url).toBe("https://factory.example"); // trailing slash stripped
    expect(cfg.key).toBe("abcd-secret");
    const w: string[] = [];
    const saved = { u: process.env.DARK_FACTORY_URL, k: process.env.DARK_FACTORY_API_KEY };
    delete process.env.DARK_FACTORY_URL;
    delete process.env.DARK_FACTORY_API_KEY;
    try {
      await run(["where"], { home, out: (s) => w.push(String(s)) });
    } finally {
      if (saved.u) process.env.DARK_FACTORY_URL = saved.u;
      if (saved.k) process.env.DARK_FACTORY_API_KEY = saved.k;
    }
    expect(w.join("")).toContain("https://factory.example");
    expect(w.join("")).toContain("abcd…");
    expect(w.join("")).not.toContain("abcd-secret");
  });

  test("doctor chains the open health read and the keyed status read", async () => {
    const calls: any[] = [];
    process.env.DARK_FACTORY_URL = "https://factory.example";
    process.env.DARK_FACTORY_API_KEY = "k";
    const out: string[] = [];
    const code = await run(["doctor"], {
      out: (s) => out.push(String(s)),
      err: () => {},
      fetchImpl: async (url: any, init: any) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/health"))
          return new Response(
            JSON.stringify({ ok: true, service: "pi-dark-factory", version: "9", web_tools: { extension_on_host: true, key_set: true }, laptop_key_set: true, shared_base: { snapshot: "factory-base-r3", bakedAt: "2026-10-29T00:00:00Z", template: "t" } }),
            { status: 200 }
          );
        return new Response(JSON.stringify({ repos: [{ slug: "app", repo: "o/app", chain: 0, in_flight: 0 }] }), { status: 200 });
      },
    });
    expect(code).toBe(0);
    expect(calls.length).toBe(2);
    expect(calls[0].init.headers["X-Api-Key"]).toBeUndefined(); // /health is open
    expect(calls[1].init.headers["X-Api-Key"]).toBe("k");
    expect(out.join("")).toContain("factoryd: pi-dark-factory v9 — reachable");
    expect(out.join("")).toContain("auth OK — 1 repo(s) onboarded");
    expect(out.join("")).toContain("factory-base-r3");
  });

  test("HTTP errors die with method, path and code", async () => {
    process.env.DARK_FACTORY_URL = "https://factory.example";
    process.env.DARK_FACTORY_API_KEY = "k";
    const err: string[] = [];
    const code = await run(["status"], {
      out: () => {},
      err: (s) => err.push(String(s)),
      fetchImpl: async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 }),
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("GET /status -> HTTP 500: nope");
  });

  test("a 409 tick skip dies with the settle hint", async () => {
    process.env.DARK_FACTORY_URL = "https://factory.example";
    process.env.DARK_FACTORY_API_KEY = "k";
    const err: string[] = [];
    const code = await run(["tick", "app"], {
      out: () => {},
      err: (s) => err.push(String(s)),
      fetchImpl: async () => new Response(JSON.stringify({ queued: false, skipped: "busy" }), { status: 409 }),
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("tick SKIPPED: busy");
  });

  test("an unblock refusal exits 1 without throwing", async () => {
    process.env.DARK_FACTORY_URL = "https://factory.example";
    process.env.DARK_FACTORY_API_KEY = "k";
    const out: string[] = [];
    const code = await run(["unblock", "app", "7"], {
      out: (s) => out.push(String(s)),
      err: () => {},
      fetchImpl: async () => new Response(JSON.stringify({ refused: "in_progress", note: "lap alive" }), { status: 409 }),
    });
    expect(code).toBe(1);
    expect(out.join("")).toContain("REFUSED (in_progress): lap alive");
  });

  test("scenario --test maps the verdict to the exit code", async () => {
    process.env.DARK_FACTORY_URL = "https://factory.example";
    process.env.DARK_FACTORY_API_KEY = "k";
    const out: string[] = [];
    const ok = await run(["scenario", "app", "runtime", "--test", "--branch", "dev"], {
      out: (s) => out.push(String(s)),
      err: () => {},
      fetchImpl: async () =>
        new Response(JSON.stringify({ branch: "dev", machine: "pdf-app-i7-g1", result: { results: [{ id: "p1", pass: true, detail: "fine" }], pass: true } }), { status: 200 }),
    });
    expect(ok).toBe(0);
    expect(out.join("")).toContain("scenario runtime TEST vs dev (machine pdf-app-i7-g1)");
    expect(out.join("")).toContain("[ok ] p1");
    expect(out.join("")).toContain("VERDICT: ALL GREEN");
    const fail = await run(["scenario", "app", "runtime", "--test"], {
      out: () => {},
      err: () => {},
      fetchImpl: async () => new Response(JSON.stringify({ branch: "main", result: { results: [], pass: false } }), { status: 200 }),
    });
    expect(fail).toBe(1);
  });

  test("config --json must parse before anything is sent", async () => {
    process.env.DARK_FACTORY_URL = "https://factory.example";
    process.env.DARK_FACTORY_API_KEY = "k";
    const err: string[] = [];
    const code = await run(["config", "app", "--json", "{models: broken"], {
      out: () => {},
      err: (s) => err.push(String(s)),
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("--json is not valid JSON");
  });

  test("session without --follow streams lines and ends clean", async () => {
    process.env.DARK_FACTORY_URL = "https://factory.example";
    process.env.DARK_FACTORY_API_KEY = "k";
    const out: string[] = [];
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello\nwor"));
        c.enqueue(new TextEncoder().encode("ld\n"));
        c.close();
      },
    });
    const code = await run(["session", "app"], {
      out: (s) => out.push(String(s)),
      err: () => {},
      rawFetch: async () => new Response(body, { status: 200 }),
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("hello");
    expect(out.join("")).toContain("world");
  });
});

describe("n8n-style ergonomics (per-verb help, inline flags, --format json)", () => {
  test("every verb takes --help and prints its own usage without connecting", async () => {
    const out: string[] = [];
    expect(await run(["unblock", "--help"], { out: (s) => out.push(String(s)) })).toBe(0);
    expect(out.join("")).toContain("unblock SLUG ISSUE");
    expect(await run(["session", "-h"], { out: (s) => out.push(String(s)) })).toBe(0);
    expect(out.join("")).toContain("auto-reconnects 5s after drops");
    expect(await run(["scenario", "--help"], { out: (s) => out.push(String(s)) })).toBe(0);
    expect(out.join("")).toContain("ALWAYS lint before writing");
  });

  test("inline --url/--key beat env vars (flags > env > file)", async () => {
    const saved = { u: process.env.DARK_FACTORY_URL, k: process.env.DARK_FACTORY_API_KEY };
    process.env.DARK_FACTORY_URL = "https://env.example";
    process.env.DARK_FACTORY_API_KEY = "envkey";
    const calls: any[] = [];
    try {
      const code = await run(["status", "--url", "https://flag.example", "--key", "flagkey"], {
        ...silence(),
        fetchImpl: async (url: any, init: any) => {
          calls.push({ url: String(url), init });
          return new Response(JSON.stringify({ repos: [] }), { status: 200 });
        },
      });
      expect(code).toBe(0);
      expect(calls[0].url.startsWith("https://flag.example/status")).toBe(true);
      expect(calls[0].init.headers["X-Api-Key"]).toBe("flagkey");
    } finally {
      if (saved.u) process.env.DARK_FACTORY_URL = saved.u;
      else delete process.env.DARK_FACTORY_URL;
      if (saved.k) process.env.DARK_FACTORY_API_KEY = saved.k;
      else delete process.env.DARK_FACTORY_API_KEY;
    }
  });

  test("--format json gives machine-readable status/logs/models/doctor output", async () => {
    process.env.DARK_FACTORY_URL = "https://factory.example";
    process.env.DARK_FACTORY_API_KEY = "k";
    const out: string[] = [];
    await run(["status", "--format", "json"], {
      out: (s) => out.push(String(s)),
      err: () => {},
      fetchImpl: async () => new Response(JSON.stringify({ repos: [{ slug: "app", chain: 0 }] }), { status: 200 }),
    });
    const parsed = JSON.parse(out.join("").split("\n").filter((l) => l.trim())[0] ? out.join("") : "{}");
    expect(parsed.repos[0].slug).toBe("app"); // the raw body, not the rendered table
  });
});

describe("formatters", () => {
  test("status renders the ledger/laps/stages sections", () => {
    const s = formatStatus({
      repos: [{ slug: "app", repo: "o/app", chain: -1, in_flight: 1 }],
      issues: [{ issue_number: 7, repo: "o/app", state: "in_progress", attempts: 2, pr: 9, last_error: "boom" }],
      laps: [{ id: 3, repo: "o/app", issue_number: 7, outcome: "merged", detail: "ok" }],
      stages: [{ id: 11, stage: "implement", attempt: 1, model: "m", exit: "ok", input_tokens: 10, output_tokens: 5 }],
      worktrees: ["/wt"],
    });
    expect(s).toContain("app (o/app) — claimable chain: unknown (GitHub probe >5s), in flight: 1");
    expect(s).toContain("#7 o/app [in_progress] attempts=2 PR#9 — boom");
    expect(s).toContain("#11 implement a1 m ok tok=10/5");
  });

  test("models renders thinking support and the roster warning", () => {
    const s = formatModels({
      providers: [{ name: "acme", api: "openai-completions", baseUrl: "https://x", models: [{ id: "m1", reasoning: true, contextWindow: 128000, thinking: { supported: ["low", "high"], unsupported: ["max"] } }] }],
    });
    expect(s).toContain("acme — openai-completions · https://x");
    expect(s).toContain("reasoning=yes · ctx=128000 · thinking: low,high (NOT: max)");
  });
});
