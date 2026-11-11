import { useEffect, useState } from "react";

/**
 * Hash routing (#/laps?status=merged). Path routes would fight the server:
 * Caddy strips /dashboard before the sidecar sees the request, and the
 * built assets resolve relative to /dashboard/.
 */
export interface Route { path: string; parts: string[]; query: URLSearchParams }

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [path, qs = ""] = raw.split("?");
  return { path, parts: path.split("/").filter(Boolean), query: new URLSearchParams(qs) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function href(path: string, query?: Record<string, string | number | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== null && v !== undefined && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return `#${path}${s ? "?" + s : ""}`;
}

/** replace the query of the current route (filters/sort/page live in the URL, so views are shareable) */
export function setQuery(patch: Record<string, string | number | null | undefined>) {
  const r = parse();
  const q: Record<string, string> = Object.fromEntries(r.query.entries());
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") delete q[k];
    else q[k] = String(v);
  }
  const next = href(r.path, q);
  if (next !== window.location.hash) window.location.replace(next);
}
