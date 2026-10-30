import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSharedBase, resolveSnapshotName, SHARED_BASE_ALIAS } from "../src/sharedbase";

let dir: string | null = null;
const tmp = () => (dir ??= mkdtempSync(join(tmpdir(), "pdfbase-")));
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe("shared-base resolution", () => {
  test("the alias token resolves through the state file", () => {
    writeFileSync(join(tmp(), "base-snapshot.json"), JSON.stringify({ snapshot: "factory-base-r3", bakedAt: "2026-10-29", template: "agent-browser@2026-10-25.23", contents: "pi + agent-browser" }));
    expect(resolveSnapshotName(dir!, SHARED_BASE_ALIAS)).toBe("factory-base-r3");
    const info = readSharedBase(dir!)!;
    expect(info.bakedAt).toBe("2026-10-29");
    expect(info.contents).toContain("agent-browser");
  });

  test("a literal snapshot name passes through untouched (per-repo fork)", () => {
    expect(resolveSnapshotName(tmp(), "myrepo-base")).toBe("myrepo-base");
  });

  test("a missing or empty state file fails through with the token itself — the boot error names the real fix", () => {
    expect(resolveSnapshotName(tmp(), SHARED_BASE_ALIAS)).toBe(SHARED_BASE_ALIAS);
    writeFileSync(join(tmp(), "base-snapshot.json"), "{}");
    expect(resolveSnapshotName(tmp(), SHARED_BASE_ALIAS)).toBe(SHARED_BASE_ALIAS);
    expect(readSharedBase(tmp())).toBeNull();
  });
});
