import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBases, readSharedBase, resolveSnapshotName, SHARED_BASE_ALIAS } from "../src/sharedbase";

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

  test("stack aliases resolve from the map — godot-base is independent of shared-base", () => {
    writeFileSync(join(tmp(), "base-snapshot.json"), JSON.stringify({
      "shared-base": { snapshot: "factory-base-r3", bakedAt: "2026-10-29" },
      "godot-base": { snapshot: "factory-godot-r1", bakedAt: "2026-11-01", contents: "Godot 4.7 + web export templates" },
    }));
    expect(resolveSnapshotName(dir!, SHARED_BASE_ALIAS)).toBe("factory-base-r3");
    expect(resolveSnapshotName(dir!, "godot-base")).toBe("factory-godot-r1");
    expect(readBases(dir!)["godot-base"]!.contents).toContain("Godot 4.7");
  });

  test("the original flat single-base file still reads as the shared-base entry", () => {
    writeFileSync(join(tmp(), "base-snapshot.json"), JSON.stringify({ snapshot: "factory-base-r2", bakedAt: "2026-10-28" }));
    const bases = readBases(dir!);
    expect(bases[SHARED_BASE_ALIAS]!.snapshot).toBe("factory-base-r2");
    expect(Object.keys(bases)).toEqual([SHARED_BASE_ALIAS]);
  });

  test("a missing or empty state file fails through with the token itself — the boot error names the real fix", () => {
    expect(resolveSnapshotName(tmp(), SHARED_BASE_ALIAS)).toBe(SHARED_BASE_ALIAS);
    writeFileSync(join(tmp(), "base-snapshot.json"), "{}");
    expect(resolveSnapshotName(tmp(), SHARED_BASE_ALIAS)).toBe(SHARED_BASE_ALIAS);
    expect(readSharedBase(tmp())).toBeNull();
  });
});
