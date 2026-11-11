import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Ledger } from "../src/ledger";
import { backup, collectState, prune, restore, snapshotId, toPrune } from "../bin/backup";

/** in-memory stand-in for Bun.S3Client: the four calls backup.ts makes */
class FakeS3 {
  objects = new Map<string, Uint8Array>();
  async write(key: string, body: Uint8Array | string) {
    this.objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body));
  }
  async list({ prefix, maxKeys = 1000, startAfter }: { prefix: string; maxKeys?: number; startAfter?: string }) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort();
    return { contents: keys.slice(0, maxKeys).map((key) => ({ key })), isTruncated: keys.length > maxKeys };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  file(key: string) {
    const body = this.objects.get(key)!;
    return { json: async () => JSON.parse(new TextDecoder().decode(body)), arrayBuffer: async () => body.slice().buffer };
  }
}

function makeState() {
  const dir = mkdtempSync(join(tmpdir(), "pdfbackup-"));
  const led = new Ledger(join(dir, "factory.db"));
  led.claim("acme/toy", 3);
  const lap = led.startLap("acme/toy", 3);
  led.startStage("acme/toy", 3, lap, "plan", 1, "m/x"); // left open: a write in flight
  mkdirSync(join(dir, "repos", "toy", "issues", "3"), { recursive: true });
  writeFileSync(join(dir, "repos", "toy", "config.json"), '{"repo":"acme/toy"}');
  writeFileSync(join(dir, "repos", "toy", "paused"), "2026-11-01T00:00:00Z by hand\n");
  writeFileSync(join(dir, "repos", "toy", "issues", "3", "plan-1.jsonl"), "{}"); // session: not backed up
  writeFileSync(join(dir, "laps.log"), "[t] [toy] lap #3\n");
  writeFileSync(join(dir, "clinepass.keys"), "secret"); // key file: not backed up
  return { dir, led };
}

describe("backup", () => {
  test("collectState keeps configs, markers and laps.log, and skips sessions and key files", () => {
    const { dir } = makeState();
    expect(Object.keys(collectState(dir)).sort()).toEqual(["laps.log", "repos/toy/config.json", "repos/toy/paused"]);
  });

  test("a snapshot round-trips through the bucket: restore gives the same ledger and files", async () => {
    const { dir } = makeState();
    const s3 = new FakeS3();
    const m = await backup(dir, s3 as any);
    expect(m.db.laps).toBe(1);
    expect(m.db.stage_runs).toBe(1);
    expect([...s3.objects.keys()].sort()).toEqual([
      `snapshots/${m.id}/factory.db.gz`, `snapshots/${m.id}/manifest.json`, `snapshots/${m.id}/state.json.gz`,
    ]);
    const out = join(mkdtempSync(join(tmpdir(), "pdfrestore-")), "r");
    await restore(m.id, out, s3 as any);
    const db = new Database(join(out, "factory.db"), { readonly: true });
    expect((db.query("SELECT COUNT(*) n FROM stage_runs").get() as any).n).toBe(1);
    db.close();
    expect(readFileSync(join(out, "repos", "toy", "paused"), "utf8")).toContain("by hand");
  });

  test("restore refuses a damaged snapshot and a non-empty target", async () => {
    const { dir } = makeState();
    const s3 = new FakeS3();
    const m = await backup(dir, s3 as any);
    await expect(restore(m.id, dir, s3 as any)).rejects.toThrow("not empty");
    s3.objects.set(`snapshots/${m.id}/factory.db.gz`, new Uint8Array([1, 2, 3]));
    await expect(restore(m.id, join(mkdtempSync(join(tmpdir(), "pdfr-")), "x"), s3 as any)).rejects.toThrow("checksum");
  });

  test("retention keeps 48 h of snapshots, then the first of each day for 30 days", () => {
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    const at = (iso: string) => snapshotId(new Date(iso));
    const ids = [
      at("2026-11-20T11:00:00.000Z"), // recent
      at("2026-11-18T13:00:00.000Z"), // inside 48 h
      at("2026-11-15T00:07:00.000Z"), // first of its day: kept
      at("2026-11-15T01:07:00.000Z"), // same day, later: pruned
      at("2026-10-01T00:07:00.000Z"), // past 30 days: pruned
    ];
    expect(toPrune(ids, now)).toEqual([ids[4], ids[3]]);
    expect(toPrune(["not-a-snapshot"], now)).toEqual([]);
  });

  test("prune deletes every object of a pruned snapshot and old incomplete ones", async () => {
    const s3 = new FakeS3();
    const old = snapshotId(new Date("2026-09-01T00:00:00.000Z"));
    const partial = snapshotId(new Date("2026-11-10T05:00:00.000Z"));
    const fresh = snapshotId(new Date("2026-11-20T11:00:00.000Z"));
    for (const id of [old, fresh]) for (const f of ["factory.db.gz", "state.json.gz", "manifest.json"]) await s3.write(`snapshots/${id}/${f}`, "x");
    await s3.write(`snapshots/${partial}/factory.db.gz`, "x");
    const gone = await prune(s3 as any, Date.parse("2026-11-20T12:00:00.000Z"));
    expect(gone.sort()).toEqual([old, partial].sort());
    expect([...s3.objects.keys()].every((k) => k.includes(fresh))).toBe(true);
  });
});
