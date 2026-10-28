import { afterEach, describe, expect, test } from "bun:test";
import {
  FETCH_MAX_URLS,
  fetchValidationError,
  limitText,
  searchRequestUrl,
  searchValidationError,
  tinyfishFetch,
  tinyfishSearch,
  type FetchLike,
} from "../pi-extensions/pdf-tinyfish-client";

/** stub fetch returning a canned response */
function stubFetch(status: number, body: string, capture?: { url?: string; init?: RequestInit }): FetchLike {
  return async (input, init) => {
    if (capture) {
      capture.url = typeof input === "string" ? input : (input as URL).toString();
      capture.init = init;
    }
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  };
}

describe("searchRequestUrl", () => {
  test("base query lands on the search endpoint with a URL-encoded query", () => {
    const u = new URL(searchRequestUrl({ query: "pi coding agent extensions" }));
    expect(u.origin + u.pathname).toBe("https://api.search.tinyfish.ai/");
    expect(u.searchParams.get("query")).toBe("pi coding agent extensions");
  });

  test("purpose is capped at 2000 chars", () => {
    const u = new URL(searchRequestUrl({ query: "q", purpose: "x".repeat(3000) }));
    expect(u.searchParams.get("purpose")!.length).toBe(2000);
  });

  test("recency_minutes, domain_type, location, language pass through", () => {
    const u = new URL(searchRequestUrl({ query: "q", recencyMinutes: 43200, domainType: "news", location: "Vietnam", language: "en" }));
    expect(u.searchParams.get("recency_minutes")).toBe("43200");
    expect(u.searchParams.get("domain_type")).toBe("news");
    expect(u.searchParams.get("location")).toBe("Vietnam");
    expect(u.searchParams.get("language")).toBe("en");
  });

  test("after_date / before_date pass through; unset params stay absent", () => {
    const u = new URL(searchRequestUrl({ query: "q", afterDate: "2026-01-01", beforeDate: "2026-06-30" }));
    expect(u.searchParams.get("after_date")).toBe("2026-01-01");
    expect(u.searchParams.get("before_date")).toBe("2026-06-30");
    expect(u.searchParams.get("recency_minutes")).toBe(null);
  });
});

describe("searchValidationError (fail closed before hitting the API)", () => {
  test("empty query is rejected", () => {
    expect(searchValidationError({ query: "  " })).toMatch(/query is required/);
  });

  test("recency_minutes combined with a date filter is rejected (the API errors on both)", () => {
    expect(searchValidationError({ query: "q", recencyMinutes: 60, afterDate: "2026-01-01" })).toMatch(/recency_minutes OR/);
  });

  test("non-positive recency is rejected", () => {
    expect(searchValidationError({ query: "q", recencyMinutes: 0 })).toMatch(/positive/);
  });
});

describe("tinyfishSearch", () => {
  const sample = JSON.stringify({
    query: "q",
    results: [
      { position: 1, site_name: "docs.dev", title: "The endpoint", snippet: "GET /v2/thing", url: "https://docs.dev/thing" },
      { position: 2, site_name: "blog.dev", title: "no url here", snippet: "s", url: "not-a-url" },
    ],
    total_results: 2,
  });

  test("ok response maps results and drops entries without a usable URL", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const out = await tinyfishSearch({ query: "q" }, "sk-test", stubFetch(200, sample, cap));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results.length).toBe(1);
    expect(out.results[0].url).toBe("https://docs.dev/thing");
    expect(out.total_results).toBe(2);
    expect((cap.init?.headers as Record<string, string>)["X-API-Key"]).toBe("sk-test");
    expect((cap.url ?? "").startsWith("https://api.search.tinyfish.ai/")).toBe(true);
  });

  test("401 maps to a key message", async () => {
    const out = await tinyfishSearch({ query: "q" }, "bad", stubFetch(401, '{"error":"nope"}'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/TINYFISH_API_KEY/);
    expect(out.status).toBe(401);
  });

  test("429 maps to a quota message", async () => {
    const out = await tinyfishSearch({ query: "q" }, "k", stubFetch(429, "rate limited"));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/rate|quota|limit/i);
  });

  test("network failure maps to a clean error, never a throw", async () => {
    const out = await tinyfishSearch({ query: "q" }, "k", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/network error/);
  });

  test("client-side validation short-circuits before any network call", async () => {
    let called = false;
    const out = await tinyfishSearch(
      { query: "q", recencyMinutes: 10, afterDate: "2026-01-01" },
      "k",
      async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }
    );
    expect(called).toBe(false);
    expect(out.ok).toBe(false);
  });
});

describe("tinyfishFetch", () => {
  const sample = JSON.stringify({
    results: [
      { url: "https://a.dev/", final_url: "https://a.dev/final", title: "A", text: "# hello\nworld", language: "en", format: "markdown" },
    ],
    errors: [{ url: "https://b.dev/", error: "timeout" }],
  });

  test("ok response maps pages and per-URL errors independently; bare call omits ttl (the client is cache-neutral — the extension enforces live-by-default)", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const out = await tinyfishFetch({ urls: ["https://a.dev/", "https://b.dev/"] }, "sk-test", stubFetch(200, sample, cap));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results[0].text).toContain("hello");
    expect(out.errors).toEqual([{ url: "https://b.dev/", error: "timeout" }]);
    const body = JSON.parse(String(cap.init?.body));
    expect(body.urls).toEqual(["https://a.dev/", "https://b.dev/"]);
    expect("ttl" in body).toBe(false);
    expect(body.format).toBe("markdown");
  });

  test("ttlSeconds: 0 = live fetch — the extension's grounding default", async () => {
    const cap: { init?: RequestInit } = {};
    await tinyfishFetch({ urls: ["https://a.dev/"], ttlSeconds: 0 }, "sk-test", stubFetch(200, sample, cap));
    expect(JSON.parse(String(cap.init?.body)).ttl).toBe(0);
  });

  test("ttlSeconds undefined omits ttl entirely (accept any cache)", async () => {
    const cap: { init?: RequestInit } = {};
    await tinyfishFetch({ urls: ["https://a.dev/"] }, "k", stubFetch(200, sample, cap));
    const body = JSON.parse(String(cap.init?.body));
    expect("ttl" in body).toBe(false);
  });

  test("ttlSeconds > 0 is passed through as the freshness window", async () => {
    const cap: { init?: RequestInit } = {};
    await tinyfishFetch({ urls: ["https://a.dev/"], ttlSeconds: 3600 }, "k", stubFetch(200, sample, cap));
    const body = JSON.parse(String(cap.init?.body));
    expect(body.ttl).toBe(3600);
  });

  test("more than the max URLs is rejected without a network call", async () => {
    let called = false;
    const out = await tinyfishFetch(
      { urls: Array.from({ length: FETCH_MAX_URLS + 1 }, (_, i) => `https://x${i}.dev/`) },
      "k",
      async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }
    );
    expect(called).toBe(false);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/10 URLs/);
  });
});

describe("fetchValidationError", () => {
  test("empty list rejected", () => {
    expect(fetchValidationError({ urls: [] })).toMatch(/no URLs/);
  });
  test("non-http scheme rejected", () => {
    expect(fetchValidationError({ urls: ["ftp://a.dev/x"] })).toMatch(/http/);
  });
});

describe("limitText", () => {
  test("short strings pass through untouched", () => {
    expect(limitText("hello", 100)).toBe("hello");
  });
  test("long strings are head+tail joined with an elision marker and never exceed the cap", () => {
    const s = "a".repeat(2400) + "MIDDLE" + "b".repeat(2400);
    for (const max of [50, 200, 2000]) {
      const out = limitText(s, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out.startsWith("a")).toBe(true);
      expect(out.endsWith("b")).toBe(true);
      expect(out).toMatch(/chars truncated/);
      expect(out).not.toContain("MIDDLE");
    }
  });
  test("a cap above the length passes the string through untouched", () => {
    const s = "a".repeat(2400) + "MIDDLE" + "b".repeat(2400);
    expect(limitText(s, 20_000)).toBe(s);
  });
  test("below the elision floor it just slices", () => {
    const s = "x".repeat(100);
    expect(limitText(s, 30).length).toBe(30);
  });
});
