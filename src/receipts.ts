import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** The audit spine: every tick, claim, attempt, merge, and block lands here.
 *  `slug` stamps the line as `[iso] [slug] msg` — laps.log is shared by every
 *  repo, and `logs --repo <slug>` filters on that exact tag. */
export function receipt(stateDir: string, msg: string, slug?: string) {
  const line = `[${new Date().toISOString()}]${slug ? ` [${slug}]` : ""} ${msg}`;
  appendFileSync(join(stateDir, "laps.log"), line + "\n");
  console.log(line);
}

/** Same as receipt(), but with the repo slug first — the shape tick.ts's
 *  per-repo call sites use (cfg is always in scope there). */
export const repoReceipt = (slug: string | undefined, stateDir: string, msg: string) =>
  receipt(stateDir, msg, slug);
