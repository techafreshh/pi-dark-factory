import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISCOVERY_LABEL, fileDiscoveries } from "../src/ops";
import type { GhApi, IssueLite, PrLite } from "../src/gh";
import { loadRepoConfig } from "../src/config";

let dir: string | null = null;
const tmp = () => (dir ??= mkdtempSync(join(tmpdir(), "pdfdisc-")));
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

/** Minimal GhApi stub recording calls — fileDiscoveries only touches
 *  issueListOpen / issueCreate / issueAddLabels. */
function stubGh(opts: { openTitles?: string[] } = {}) {
  const calls: { created: [string, string][]; labeled: [number, string[]][] } = { created: [], labeled: [] };
  const open: IssueLite[] = (opts.openTitles ?? []).map((title, i) => ({ number: 55 + i, title, body: "", headRefName: "", labels: [] }));
  const gh: GhApi = {
    issueList: () => Promise.resolve([] as IssueLite[]),
    issueListOpen: () => Promise.resolve(open),
    issueView: () => Promise.resolve({ number: 0, title: "", body: "", labels: [], createdAt: "", state: "open" }),
    issueComment: () => Promise.resolve(),
    issueClose: () => Promise.resolve(),
    issueCreate: (title: string, body: string) => {
      calls.created.push([title, body]);
      return Promise.resolve(100 + calls.created.length);
    },
    issueAddLabels: (n: number, labels: string[]) => {
      calls.labeled.push([n, labels]);
      return Promise.resolve();
    },
    prListOpen: () => Promise.resolve([] as PrLite[]),
    prListMerged: () => Promise.resolve([] as PrLite[]),
    prCreate: () => Promise.resolve(0),
    prClose: () => Promise.resolve(),
    prChecks: () => Promise.resolve([]),
    prHeadSha: () => Promise.resolve(null),
    prMerge: () => Promise.resolve(),
    repo: "acme/toy",
  };
  void opts;
  return { gh, calls };
}

const seed = (slug: string, issue: number, attempt: number, titles: string[]) => {
  const d = dir ??= mkdtempSync(join(tmpdir(), "pdfdisc-"));
  const p = join(d, "repos", slug, "issues", String(issue));
  require("node:fs").mkdirSync(p, { recursive: true });
  writeFileSync(
    join(p, `discoveries-${attempt}.json`),
    JSON.stringify({ attempt, recordedAt: new Date().toISOString(), discoveries: titles.map((t) => ({ title: t, claim: `claim for ${t}`, why: `why for ${t}` })) }, null, 2)
  );
};

describe("fileDiscoveries (auto-file + verb filing)", () => {
  test("files deduped discoveries with the discovery label and an acceptance nudge", async () => {
    const d = tmp();
    seed("toy", 3, 1, ["Cache the catalog", "Pre-1.0 dependency"]);
    const { gh, calls } = stubGh();
    const deduped = [
      { issue: 3, attempt: 1, title: "Cache the catalog", claim: "c1", why: "w1" },
      { issue: 3, attempt: 1, title: "Pre-1.0 dependency", claim: "c2", why: "w2" },
    ];
    const filed = await fileDiscoveries(d, "toy", gh, deduped);
    expect(filed.map((f) => f.title)).toEqual(["[discovery] Cache the catalog", "[discovery] Pre-1.0 dependency"]);
    expect(calls.created[0][1]).toContain("Acceptance:");
    expect(calls.labeled).toEqual([
      [101, [DISCOVERY_LABEL]],
      [102, [DISCOVERY_LABEL]],
    ]);
  });

  test("titles already open as issues are skipped (re-running files nothing new)", async () => {
    const d = tmp();
    seed("toy", 3, 1, ["Cache the catalog"]);
    const { gh, calls } = stubGh({ openTitles: ["[discovery] Cache the catalog"] });
    const filed = await fileDiscoveries(d, "toy", gh, [
      { issue: 3, attempt: 1, title: "Cache the catalog", claim: "c", why: "w" },
    ]);
    expect(filed).toEqual([]);
    expect(calls.created).toEqual([]);
  });
});

describe("discoveries.auto_file config", () => {
  test("defaults false and validates the boolean", () => {
    const d = tmp();
    writeFileSync(join(d, "config.json"), JSON.stringify({ repo: "acme/toy", models: { default: { provider: "p", model: "m" } } }));
    const cfg = loadRepoConfig(join(d, "config.json"));
    expect(cfg.discoveries!.auto_file).toBe(false);
    writeFileSync(join(d, "config.json"), JSON.stringify({ repo: "acme/toy", models: { default: { provider: "p", model: "m" } }, discoveries: { auto_file: "yes" } }));
    expect(() => loadRepoConfig(join(d, "config.json"))).toThrow(/auto_file must be true or false/);
  });
});
