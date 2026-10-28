/**
 * TinyFish Search + Fetch HTTP client — pure functions, no pi imports, no npm
 * dependencies. The factory's bun test suite loads it directly; pi's jiti
 * loader loads it in-process next to the extension that imports it, so every
 * consumer gets the exact same file.
 *
 * Search API  — GET https://api.search.tinyfish.ai            (free tier: 12k req/day)
 * Fetch API   — POST https://api.fetch.tinyfish.ai            (free tier: 1k URLs/day)
 * Auth        — X-API-Key header on both (TINYFISH_API_KEY)
 */

const SEARCH_URL = "https://api.search.tinyfish.ai";
const FETCH_URL = "https://api.fetch.tinyfish.ai";
export const FETCH_MAX_URLS = 10;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SearchParams {
  query: string;
  /** why you are searching, one sentence — improves result quality (≤2000 chars) */
  purpose?: string;
  domainType?: "web" | "news" | "research_paper";
  /** freshness window in minutes (1..5256000) — mutually exclusive with afterDate/beforeDate */
  recencyMinutes?: number;
  /** YYYY-MM-DD */
  afterDate?: string;
  /** YYYY-MM-DD */
  beforeDate?: string;
  location?: string;
  language?: string;
}

export interface SearchResult {
  position: number;
  site_name: string;
  title: string;
  snippet: string;
  url: string;
}

export interface ApiFail {
  ok: false;
  error: string;
  status?: number;
}

export interface SearchOk {
  ok: true;
  query: string;
  results: SearchResult[];
  total_results: number;
}

export type SearchOutcome = SearchOk | ApiFail;

export interface FetchParams {
  urls: string[];
  format?: "markdown" | "html" | "json";
  /** 0 = live fetch bypassing the cache (the default — grounding wants current truth);
   *  undefined = accept any cached entry */
  ttlSeconds?: number;
}

export interface FetchedPage {
  url: string;
  final_url: string;
  title: string;
  description?: string;
  language?: string;
  text: string;
}

export interface FetchOk {
  ok: true;
  results: FetchedPage[];
  errors: { url: string; error: string }[];
}

export type FetchOutcome = FetchOk | ApiFail;

/** Pre-flight validation of search params; returns the error message or null. */
export function searchValidationError(p: SearchParams): string | null {
  if (!p.query || !p.query.trim()) return "query is required";
  if (p.recencyMinutes !== undefined && (p.afterDate || p.beforeDate))
    return "pass recency_minutes OR after_date/before_date — the API rejects both together";
  if (p.recencyMinutes !== undefined && (!Number.isFinite(p.recencyMinutes) || p.recencyMinutes < 1))
    return "recency_minutes must be a positive number of minutes";
  if (p.recencyMinutes !== undefined && p.recencyMinutes > 5256000)
    return "recency_minutes max is 5256000 (10 years)";
  for (const [label, d] of [["after_date", p.afterDate], ["before_date", p.beforeDate]] as const) {
    if (d && !DATE_RE.test(d)) return `${label} must be YYYY-MM-DD`;
  }
  if (p.afterDate && p.beforeDate && p.afterDate > p.beforeDate)
    return "after_date must be <= before_date";
  return null;
}

export function searchRequestUrl(p: SearchParams): string {
  const u = new URL(SEARCH_URL + "/");
  u.searchParams.set("query", p.query.trim());
  if (p.purpose?.trim()) u.searchParams.set("purpose", p.purpose.trim().slice(0, 2000));
  if (p.domainType) u.searchParams.set("domain_type", p.domainType);
  if (p.recencyMinutes !== undefined)
    u.searchParams.set("recency_minutes", String(Math.max(1, Math.round(p.recencyMinutes))));
  if (p.afterDate) u.searchParams.set("after_date", p.afterDate);
  if (p.beforeDate) u.searchParams.set("before_date", p.beforeDate);
  if (p.location?.trim()) u.searchParams.set("location", p.location.trim());
  if (p.language?.trim()) u.searchParams.set("language", p.language.trim());
  return u.toString();
}

function mapStatusError(status: number, body: string): string {
  if (status === 401 || status === 403)
    return `TinyFish rejected the request (${status}) — TINYFISH_API_KEY is missing or invalid`;
  if (status === 402)
    return "TinyFish account is out of quota (402) — free tier exhausted, wallet needs a positive balance";
  if (status === 429)
    return "TinyFish rate limit (429) — wait a moment before retrying";
  const detail = body.trim().slice(0, 200);
  return `TinyFish API returned ${status}${detail ? `: ${detail}` : ""}`;
}

export async function tinyfishSearch(
  p: SearchParams,
  apiKey: string,
  fetchImpl?: FetchLike
): Promise<SearchOutcome> {
  const invalid = searchValidationError(p);
  if (invalid) return { ok: false, error: invalid };
  const doFetch = fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(searchRequestUrl(p), {
      headers: { "X-API-Key": apiKey, accept: "application/json" },
    });
  } catch (e: any) {
    return { ok: false, error: `network error reaching TinyFish search: ${e?.message ?? e}` };
  }
  const body = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, error: mapStatusError(res.status, body), status: res.status };
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    return { ok: false, error: "TinyFish search returned a non-JSON body" };
  }
  const raw = Array.isArray(data?.results) ? data.results : [];
  const results = raw
    .map((r: any): SearchResult => ({
      position: Number(r?.position ?? 0),
      site_name: String(r?.site_name ?? ""),
      title: String(r?.title ?? ""),
      snippet: String(r?.snippet ?? ""),
      url: String(r?.url ?? ""),
    }))
    .filter((r: SearchResult) => /^https?:\/\//i.test(r.url));
  return {
    ok: true,
    query: typeof data?.query === "string" ? data.query : p.query,
    results,
    total_results: Number(data?.total_results ?? results.length),
  };
}

/** Pre-flight validation of fetch params; returns the error message or null. */
export function fetchValidationError(p: FetchParams): string | null {
  const urls = p.urls.map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) return "no URLs given";
  if (urls.length > FETCH_MAX_URLS) return `at most ${FETCH_MAX_URLS} URLs per call (got ${urls.length})`;
  for (const u of urls) {
    if (!/^https?:\/\//i.test(u)) return `URL must start with http(s):// — got "${u.slice(0, 100)}"`;
  }
  return null;
}

export async function tinyfishFetch(
  p: FetchParams,
  apiKey: string,
  fetchImpl?: FetchLike
): Promise<FetchOutcome> {
  const invalid = fetchValidationError(p);
  if (invalid) return { ok: false, error: invalid };
  const doFetch = fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    urls: p.urls.map((u) => u.trim()).filter(Boolean),
    format: p.format ?? "markdown",
  };
  // ttl 0 = live fetch (fresh truth is the point of grounding); omitting ttl
  // accepts any cached entry — the caller opts out via ttlSeconds: undefined
  if (p.ttlSeconds !== undefined) body.ttl = Math.max(0, Math.round(p.ttlSeconds));
  let res: Response;
  try {
    res = await doFetch(FETCH_URL, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    return { ok: false, error: `network error reaching TinyFish fetch: ${e?.message ?? e}` };
  }
  const rawBody = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, error: mapStatusError(res.status, rawBody), status: res.status };
  let data: any;
  try {
    data = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: "TinyFish fetch returned a non-JSON body" };
  }
  const pages = (Array.isArray(data?.results) ? data.results : []).map((r: any): FetchedPage => ({
    url: String(r?.url ?? ""),
    final_url: String(r?.final_url ?? r?.url ?? ""),
    title: String(r?.title ?? ""),
    description: r?.description === undefined ? undefined : String(r.description),
    language: r?.language === undefined ? undefined : String(r.language),
    text: typeof r?.text === "string" ? r.text : String(r?.text ?? ""),
  }));
  const errors = (Array.isArray(data?.errors) ? data.errors : []).map((e: any) => ({
    url: String(e?.url ?? ""),
    error: String(e?.error ?? "unknown error"),
  }));
  return { ok: true, results: pages, errors };
}

/**
 * Head+tail truncation: the beginning carries the page's identity, the tail
 * often carries code blocks and references; the middle is what dies. The
 * result never exceeds max — the elision marker is sized from the actual
 * digit count and the tail is shaved until head+marker+tail fits.
 */
export function limitText(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max < 48) return s.slice(0, max); // too small to elide meaningfully
  const marker = (elided: number) => `\n\n[… ${elided} chars truncated …]\n\n`;
  let head = Math.floor((max - 24) * 0.7);
  let tail = Math.max(0, max - 24 - head);
  let out = s.slice(0, head) + marker(s.length - head - tail) + (tail > 0 ? s.slice(s.length - tail) : "");
  while (out.length > max && tail > 0) {
    tail--;
    out = s.slice(0, head) + marker(s.length - head - tail) + s.slice(s.length - tail);
  }
  return out.length > max ? out.slice(0, max) : out;
}
