/**
 * State backups to S3-compatible storage (the VPS's MinIO).
 *
 *   bun bin/backup.ts                 take a snapshot, upload it, prune old ones
 *   bun bin/backup.ts list            list snapshots in the bucket
 *   bun bin/backup.ts restore <id> <dir>   download a snapshot into <dir> (never into live state)
 *
 * A snapshot is the ledger (a consistent `VACUUM INTO` copy, integrity-checked)
 * plus the small state the factory can't rebuild from GitHub: laps.log and each
 * repo's config.json / runtime.json / holdout.json / revives.json / paused.
 * Session files, clones and worktrees are left out (GBs, and rebuildable or
 * disposable); key files (*.keys, *.env) are left out on purpose.
 *
 * Objects: snapshots/<id>/factory.db.gz, snapshots/<id>/state.json.gz, then
 * snapshots/<id>/manifest.json last — a snapshot without a manifest is
 * incomplete. Retention: every snapshot from the last 48 h, then the first
 * snapshot of each UTC day for 30 days.
 *
 * Every run writes <state>/backup.json (last success, last error) so the
 * dashboard can flag a backup that stopped working. Standalone like the
 * dashboard: no imports from src/.
 *
 * Env: PI_FACTORY_STATE (default /home/factory/state), S3_ENDPOINT, S3_BUCKET,
 * S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const STATE_DIR = process.env.PI_FACTORY_STATE ?? "/home/factory/state";
const PREFIX = "snapshots/";
const KEEP_ALL_MS = 48 * 3600_000;
const KEEP_DAILY_DAYS = 30;
/** per-repo files worth keeping; everything else under repos/<slug>/ is rebuildable */
const REPO_FILES = ["config.json", "runtime.json", "holdout.json", "revives.json", "paused"];
const TOP_FILES = ["laps.log", "base-snapshot.json", "compose-override.yml"];

export interface Manifest {
  id: string;
  created_at: string;
  db: { bytes: number; gz_bytes: number; sha256: string; laps: number; stage_runs: number; issues: number };
  state: { files: number; gz_bytes: number; sha256: string };
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** snapshot id = UTC time, sortable and safe as a key segment */
export const snapshotId = (d = new Date()) => d.toISOString().replace(/[:.]/g, "-");
const idTime = (id: string) => Date.parse(id.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, "T$1:$2:$3.$4Z"));

/** a consistent copy of the ledger, taken while tick processes may be writing */
export function snapshotDb(stateDir: string, outPath: string) {
  const src = new Database(join(stateDir, "factory.db"), { readonly: true });
  try {
    src.exec("PRAGMA busy_timeout = 15000");
    src.query("VACUUM INTO ?").run(outPath);
  } finally {
    src.close();
  }
  const copy = new Database(outPath, { readonly: true });
  try {
    const ok = (copy.query("PRAGMA integrity_check").get() as any)?.integrity_check;
    if (ok !== "ok") throw new Error(`snapshot failed integrity_check: ${ok}`);
    const count = (t: string) => (copy.query(`SELECT COUNT(*) n FROM ${t}`).get() as any).n as number;
    return { laps: count("laps"), stage_runs: count("stage_runs"), issues: count("issues") };
  } finally {
    copy.close();
  }
}

/** the small state files, as { "repos/qed/config.json": "<text>" } */
export function collectState(stateDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const f of TOP_FILES) {
    const p = join(stateDir, f);
    if (existsSync(p)) files[f] = readFileSync(p, "utf8");
  }
  const repos = join(stateDir, "repos");
  for (const slug of existsSync(repos) ? readdirSync(repos) : []) {
    for (const f of REPO_FILES) {
      const p = join(repos, slug, f);
      if (existsSync(p) && statSync(p).isFile()) files[`repos/${slug}/${f}`] = readFileSync(p, "utf8");
    }
  }
  return files;
}

/** which snapshot ids retention deletes: keep the last 48 h, then each UTC day's first for 30 days */
export function toPrune(ids: string[], now = Date.now()): string[] {
  const sorted = [...ids].sort();
  const firstOfDay = new Map<string, string>();
  for (const id of sorted) {
    const day = id.slice(0, 10);
    if (!firstOfDay.has(day)) firstOfDay.set(day, id);
  }
  return sorted.filter((id) => {
    const t = idTime(id);
    if (!Number.isFinite(t)) return false; // not ours: never delete
    if (now - t < KEEP_ALL_MS) return false;
    if (now - t < KEEP_DAILY_DAYS * 86_400_000 && firstOfDay.get(id.slice(0, 10)) === id) return false;
    return true;
  });
}

function client() {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    throw new Error("S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set (see /home/factory/backup.env)");
  }
  return new Bun.S3Client({
    endpoint: S3_ENDPOINT, bucket: S3_BUCKET, accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY,
    region: process.env.S3_REGION ?? "us-east-1",
  });
}

async function listKeys(s3: Bun.S3Client): Promise<string[]> {
  const keys: string[] = [];
  let startAfter: string | undefined;
  for (;;) {
    const page: any = await s3.list({ prefix: PREFIX, maxKeys: 1000, ...(startAfter ? { startAfter } : {}) });
    const got: string[] = (page.contents ?? []).map((c: any) => c.key);
    keys.push(...got);
    if (!page.isTruncated || got.length === 0) return keys;
    startAfter = got[got.length - 1];
  }
}

const idOf = (key: string) => key.slice(PREFIX.length).split("/")[0];

function writeStatus(stateDir: string, patch: Record<string, unknown>) {
  const p = join(stateDir, "backup.json");
  let cur: Record<string, unknown> = {};
  try {
    cur = JSON.parse(readFileSync(p, "utf8"));
  } catch {}
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify({ ...cur, ...patch }, null, 2) + "\n");
  renameSync(tmp, p); // the dashboard never reads a half-written file
}

export async function backup(stateDir = STATE_DIR, s3 = client()): Promise<Manifest> {
  const id = snapshotId();
  const work = mkdtempSync(join(tmpdir(), "pdf-backup-"));
  try {
    const dbPath = join(work, "factory.db");
    const counts = snapshotDb(stateDir, dbPath);
    const db = readFileSync(dbPath);
    const dbGz = Bun.gzipSync(db, { level: 9 });
    const files = collectState(stateDir);
    const stateGz = Bun.gzipSync(Buffer.from(JSON.stringify({ version: 1, files })), { level: 9 });
    const manifest: Manifest = {
      id,
      created_at: new Date().toISOString(),
      db: { bytes: db.length, gz_bytes: dbGz.length, sha256: sha(dbGz), ...counts },
      state: { files: Object.keys(files).length, gz_bytes: stateGz.length, sha256: sha(stateGz) },
    };
    await s3.write(`${PREFIX}${id}/factory.db.gz`, dbGz, { type: "application/gzip" });
    await s3.write(`${PREFIX}${id}/state.json.gz`, stateGz, { type: "application/gzip" });
    await s3.write(`${PREFIX}${id}/manifest.json`, JSON.stringify(manifest, null, 2), { type: "application/json" });
    return manifest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function prune(s3 = client(), now = Date.now()): Promise<string[]> {
  const keys = await listKeys(s3);
  const ids = [...new Set(keys.map(idOf))];
  const complete = new Set(keys.filter((k) => k.endsWith("/manifest.json")).map(idOf));
  // retention counts complete snapshots only; an incomplete one older than a day is debris
  const doomed = new Set([
    ...toPrune([...complete], now),
    ...ids.filter((id) => !complete.has(id) && now - idTime(id) > 86_400_000),
  ]);
  for (const k of keys) if (doomed.has(idOf(k))) await s3.delete(k);
  return [...doomed];
}

export async function restore(id: string, dir: string, s3 = client()) {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} is not empty — restore only into an empty directory`);
  const manifest = (await s3.file(`${PREFIX}${id}/manifest.json`).json()) as Manifest;
  const dbGz = new Uint8Array(await s3.file(`${PREFIX}${id}/factory.db.gz`).arrayBuffer());
  const stateGz = new Uint8Array(await s3.file(`${PREFIX}${id}/state.json.gz`).arrayBuffer());
  if (sha(dbGz) !== manifest.db.sha256 || sha(stateGz) !== manifest.state.sha256) throw new Error("checksum mismatch — snapshot is damaged");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "factory.db"), Bun.gunzipSync(dbGz));
  const { files } = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(stateGz))) as { files: Record<string, string> };
  for (const [rel, text] of Object.entries(files)) {
    if (rel.includes("..") || rel.startsWith("/")) continue;
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return { manifest, files: Object.keys(files).length };
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (!cmd || cmd === "run") {
      writeStatus(STATE_DIR, { last_attempt_at: new Date().toISOString() });
      const m = await backup();
      const pruned = await prune();
      writeStatus(STATE_DIR, { last_ok_at: m.created_at, last_id: m.id, last_bytes: m.db.gz_bytes + m.state.gz_bytes, last_error: null, last_error_at: null });
      console.log(`backup ${m.id}: ledger ${m.db.laps} laps / ${m.db.stage_runs} stages (${m.db.gz_bytes} B gz), ${m.state.files} state files (${m.state.gz_bytes} B gz); pruned ${pruned.length}`);
    } else if (cmd === "list") {
      const keys = await listKeys(client());
      const complete = new Set(keys.filter((k) => k.endsWith("/manifest.json")).map(idOf));
      for (const id of [...new Set(keys.map(idOf))].sort()) console.log(`${id}${complete.has(id) ? "" : "  (incomplete)"}`);
    } else if (cmd === "restore") {
      const [id, dir] = args;
      if (!id || !dir) throw new Error("usage: bun bin/backup.ts restore <id> <empty-dir>");
      const r = await restore(id, dir);
      console.log(`restored ${id} into ${dir}: factory.db (${r.manifest.db.laps} laps) + ${r.files} state files`);
    } else {
      throw new Error(`unknown command ${cmd} (run | list | restore <id> <dir>)`);
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    if (!cmd || cmd === "run") writeStatus(STATE_DIR, { last_error: msg, last_error_at: new Date().toISOString() });
    console.error(`backup ${cmd ?? "run"} failed: ${msg}`);
    process.exit(1);
  }
}
