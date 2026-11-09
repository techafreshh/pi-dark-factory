import { Database } from "bun:sqlite";

export type IssueState = "in_progress" | "merged" | "no_action" | "blocked";

export interface IssueRow {
  repo: string;
  issue_number: number;
  state: IssueState;
  attempts: number;
  branch: string | null;
  pr: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface LapRow {
  id: number;
  repo: string;
  issue_number: number | null;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  detail: string | null;
}

export interface StageRunRow {
  id: number;
  lap_id: number | null;
  repo: string;
  issue_number: number | null;
  stage: string;
  attempt: number;
  model: string;
  started_at: string;
  ended_at: string | null;
  exit: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
  error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'in_progress',
  attempts INTEGER NOT NULL DEFAULT 0,
  branch TEXT,
  pr INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, issue_number)
);
CREATE TABLE IF NOT EXISTS laps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue_number INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS stage_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lap_id INTEGER,
  repo TEXT NOT NULL,
  issue_number INTEGER,
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error TEXT
);
`;

const now = () => new Date().toISOString();

export class Ledger {
  db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(SCHEMA);
    // additive migration: pi's usage carries a computed dollar cost — try the
    // column once per open; duplicate-column errors mean it's already there
    try {
      this.db.run("ALTER TABLE stage_runs ADD COLUMN cost REAL");
    } catch {}
  }

  /** Returns false if the issue was already claimed (row exists). */
  claim(repo: string, n: number): boolean {
    const r = this.db
      .query(
        "INSERT OR IGNORE INTO issues (repo, issue_number, state, attempts, created_at, updated_at) VALUES (?, ?, 'in_progress', 0, ?, ?)"
      )
      .run(repo, n, now(), now());
    return r.changes === 1;
  }

  getIssue(repo: string, n: number): IssueRow | null {
    return (this.db.query("SELECT * FROM issues WHERE repo = ? AND issue_number = ?").get(repo, n) as IssueRow) ?? null;
  }

  setIssue(
    repo: string,
    n: number,
    patch: Partial<Pick<IssueRow, "state" | "attempts" | "branch" | "pr" | "last_error">>
  ) {
    const sets = Object.keys(patch).map((k) => `${k} = ?`);
    const vals = Object.values(patch);
    this.db
      .query(`UPDATE issues SET ${sets.join(", ")}, updated_at = ? WHERE repo = ? AND issue_number = ?`)
      .run(...vals, now(), repo, n);
  }

  /** Manual unblock: drop the row entirely so intake can re-claim the issue. */
  dropIssue(repo: string, n: number) {
    this.db.query("DELETE FROM issues WHERE repo = ? AND issue_number = ?").run(repo, n);
  }

  listIssues(repo?: string): IssueRow[] {
    return repo
      ? (this.db.query("SELECT * FROM issues WHERE repo = ? ORDER BY issue_number").all(repo) as IssueRow[])
      : (this.db.query("SELECT * FROM issues ORDER BY repo, issue_number").all() as IssueRow[]);
  }

  startLap(repo: string, n: number | null): number {
    const r = this.db
      .query("INSERT INTO laps (repo, issue_number, started_at) VALUES (?, ?, ?)")
      .run(repo, n, now());
    return Number(r.lastInsertRowid);
  }

  endLap(id: number, outcome: string, detail?: string) {
    this.db.query("UPDATE laps SET ended_at = ?, outcome = ?, detail = ? WHERE id = ?").run(now(), outcome, detail ?? null, id);
  }

  /** Close every lap row of this issue that never got an outcome (its process
   *  died mid-lap). Only reconcile calls it, under the repo's tick lock, when
   *  no live lap for the repo can exist. Returns how many rows it closed. */
  endDanglingLaps(repo: string, n: number, outcome: string, detail: string): number {
    return this.db
      .query("UPDATE laps SET ended_at = ?, outcome = ?, detail = ? WHERE repo = ? AND issue_number = ? AND ended_at IS NULL")
      .run(now(), outcome, detail, repo, n).changes;
  }

  recentLaps(repo?: string, limit = 10): LapRow[] {
    return repo
      ? (this.db.query("SELECT * FROM laps WHERE repo = ? ORDER BY id DESC LIMIT ?").all(repo, limit) as LapRow[])
      : (this.db.query("SELECT * FROM laps ORDER BY id DESC LIMIT ?").all(limit) as LapRow[]);
  }

  startStage(repo: string, n: number, lapId: number, stage: string, attempt: number, model: string): number {
    const r = this.db
      .query("INSERT INTO stage_runs (lap_id, repo, issue_number, stage, attempt, model, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(lapId, repo, n, stage, attempt, model, now());
    return Number(r.lastInsertRowid);
  }

  endStage(
    id: number,
    exit: string,
    tokens?: { input_tokens: number; output_tokens: number; cost?: number } | null,
    error?: string | null
  ) {
    this.db
      .query(
        "UPDATE stage_runs SET ended_at = ?, exit = ?, input_tokens = ?, output_tokens = ?, cost = ?, error = ? WHERE id = ?"
      )
      .run(now(), exit, tokens?.input_tokens ?? null, tokens?.output_tokens ?? null, tokens?.cost ?? null, error ?? null, id);
  }

  recentStages(repo?: string, limit = 20): StageRunRow[] {
    return repo
      ? (this.db.query("SELECT * FROM stage_runs WHERE repo = ? ORDER BY id DESC LIMIT ?").all(repo, limit) as StageRunRow[])
      : (this.db.query("SELECT * FROM stage_runs ORDER BY id DESC LIMIT ?").all(limit) as StageRunRow[]);
  }

  /** stage runs of one repo started at or after `sinceIso` — the daily
   *  attempt ceiling counts implement runs from 00:00 UTC */
  countStages(repo: string, stage: string, sinceIso: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS c FROM stage_runs WHERE repo = ? AND stage = ? AND started_at >= ?")
      .get(repo, stage, sinceIso) as { c: number } | null;
    return row?.c ?? 0;
  }
}
