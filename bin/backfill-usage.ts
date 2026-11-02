/**
 * One-shot usage backfill: re-parse every implement/review raw session file
 * with the CURRENT parseEventStream (cache-aware, cost-aware) and correct the
 * stage_runs rows. Before 2026-11-02 the parser dropped cacheRead/cacheWrite,
 * so historical input undercounts by the cache share (92% on the meta key) —
 * the raw files on disk are the ground truth and this replays them.
 *
 * Plan stages have no raw event file (host-side pi sessions, a different
 * format) and are skipped — their historical rows stay uncached-input only.
 *
 * Chunked UPDATEs: a concurrent tick's write transaction never queues behind
 * more than ~100 row updates.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../src/ledger";
import { parseEventStream } from "../src/pievents";

const STATE_DIR = process.env.DASHBOARD_STATE_DIR ?? "/home/factory/state";

export function slugMap(stateDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const slug of readdirSync(join(stateDir, "repos"))) {
      const p = join(stateDir, "repos", slug, "config.json");
      if (existsSync(p)) {
        try {
          out[JSON.parse(readFileSync(p, "utf8")).repo] = slug;
        } catch {}
      }
    }
  } catch {}
  return out;
}

export interface BackfillResult {
  total: number;
  fixed: number;
  unchanged: number;
  missing: number; // raw file absent (crashed lap, cleaned dir)
  nousage: number; // file present but no usage events
  norepo: number; // repo not in the config scan
}

export function backfill(db: Database, stateDir: string): BackfillResult {
  const slugs = slugMap(stateDir);
  const rows = db
    .query(
      "SELECT id, repo, issue_number, stage, attempt, input_tokens, output_tokens, cost FROM stage_runs WHERE stage IN ('implement','review') AND issue_number IS NOT NULL"
    )
    .all() as any[];
  const upd = db.query("UPDATE stage_runs SET input_tokens = ?, output_tokens = ?, cost = ? WHERE id = ?");
  const res: BackfillResult = { total: rows.length, fixed: 0, unchanged: 0, missing: 0, nousage: 0, norepo: 0 };
  let chunk = 0;
  db.exec("BEGIN");
  for (const r of rows) {
    const slug = slugs[r.repo];
    if (!slug) {
      res.norepo++;
      continue;
    }
    const f = join(stateDir, "repos", slug, "issues", String(r.issue_number), `${r.stage}-${r.attempt}.jsonl`);
    if (!existsSync(f)) {
      res.missing++;
      continue;
    }
    const u = parseEventStream(readFileSync(f, "utf8").split("\n")).usage;
    if (!u) {
      res.nousage++;
      continue;
    }
    if (u.input_tokens === r.input_tokens && (u.cost ?? null) === (r.cost ?? null)) {
      res.unchanged++;
    } else {
      upd.run(u.input_tokens, u.output_tokens, u.cost ?? null, r.id);
      res.fixed++;
      if (++chunk >= 100) {
        db.exec("COMMIT");
        db.exec("BEGIN");
        chunk = 0;
      }
    }
  }
  db.exec("COMMIT");
  return res;
}

if (import.meta.main) {
  const ledger = new Ledger(join(STATE_DIR, "factory.db")); // opens rw + runs the cost migration
  const res = backfill(ledger.db, STATE_DIR);
  console.log(JSON.stringify(res, null, 1));
}
