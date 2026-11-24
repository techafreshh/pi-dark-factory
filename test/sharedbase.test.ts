import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBases, readSharedBase, resolveSnapshotName, setBasePlatform, SHARED_BASE_ALIAS } from "../src/sharedbase";

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
    expect(() => resolveSnapshotName(tmp(), SHARED_BASE_ALIAS, "daytona")).toThrow(/foreman base bake --platform daytona/);
    writeFileSync(join(tmp(), "base-snapshot.json"), "{}");
    expect(resolveSnapshotName(tmp(), SHARED_BASE_ALIAS)).toBe(SHARED_BASE_ALIAS);
    expect(() => resolveSnapshotName(tmp(), SHARED_BASE_ALIAS, "instabox")).toThrow(/has no instabox snapshot/);
    expect(readSharedBase(tmp())).toBeNull();
  });
});

describe("per-platform base aliases", () => {
  test("one token resolves to each platform's own physical snapshot", () => {
    writeFileSync(
      join(tmp(), "base-snapshot.json"),
      JSON.stringify({
        "shared-base": {
          platforms: {
            instabox: { snapshot: "dev-instabox-r1", bakedAt: "2026-11-24" },
            daytona: { snapshot: "dev-daytona-r1" },
          },
          contents: "node/python/go + e2e + penthera",
        },
      })
    );
    expect(resolveSnapshotName(dir!, "shared-base", "instabox")).toBe("dev-instabox-r1");
    expect(resolveSnapshotName(dir!, "shared-base", "daytona")).toBe("dev-daytona-r1");
    expect(readSharedBase(dir!)!.contents).toContain("penthera");
  });

  test("a platform the alias does not name fails with the bake instruction, never another platform's snapshot", () => {
    writeFileSync(
      join(tmp(), "base-snapshot.json"),
      JSON.stringify({ "shared-base": { platforms: { instabox: { snapshot: "dev-instabox-r1" } } } })
    );
    expect(() => resolveSnapshotName(dir!, "shared-base", "e2b")).toThrow(/has no e2b snapshot/);
    expect(() => resolveSnapshotName(dir!, "shared-base", "e2b")).toThrow(/foreman base bake --platform e2b/);
    // without a platform there is no safe physical answer for a platform-only entry
    expect(resolveSnapshotName(dir!, "shared-base")).toBe("shared-base");
  });

  test("a legacy flat entry resolves only on InstaBox — never another platform", () => {
    writeFileSync(join(tmp(), "base-snapshot.json"), JSON.stringify({ snapshot: "factory-base-r3" }));
    expect(resolveSnapshotName(dir!, "shared-base", "instabox")).toBe("factory-base-r3");
    expect(() => resolveSnapshotName(dir!, "shared-base", "daytona")).toThrow(/has no daytona snapshot/);
    expect(() => resolveSnapshotName(dir!, "shared-base", "instavm")).toThrow(/InstaVM has no shared base/);
  });

  test("setBasePlatform refuses to overwrite an unreadable state file", () => {
    const path = join(tmp(), "base-snapshot.json");
    writeFileSync(path, "{ this is not json");
    expect(() => setBasePlatform(dir!, "shared-base", "daytona", { snapshot: "factory-dev-daytona-r1" })).toThrow(/unreadable/);
    expect(readFileSync(path, "utf8")).toBe("{ this is not json");
  });

  test("setBasePlatform records one platform, preserves the other aliases and the legacy flat snapshot", () => {
    writeFileSync(
      join(tmp(), "base-snapshot.json"),
      JSON.stringify({
        "shared-base": { snapshot: "factory-base-r3", bakedAt: "2026-10-29", contents: "legacy" },
        "godot-base": { snapshot: "factory-godot-r1", contents: "Godot 4.7" },
      })
    );
    setBasePlatform(dir!, "shared-base", "daytona", {
      snapshot: "factory-dev-daytona-r1",
      bakedAt: "2026-11-24T00:00:00Z",
      template: "snapshot daytona-medium",
      contents: "node/python/go + e2e + penthera",
    });
    const bases = readBases(dir!);
    expect(bases["shared-base"]!.snapshot).toBe("factory-base-r3");
    expect(bases["shared-base"]!.platforms!.daytona!.snapshot).toBe("factory-dev-daytona-r1");
    expect(bases["shared-base"]!.contents).toContain("penthera");
    expect(bases["godot-base"]!.snapshot).toBe("factory-godot-r1");
    expect(resolveSnapshotName(dir!, "shared-base", "daytona")).toBe("factory-dev-daytona-r1");
    // instabox still has no platform entry: it falls through to the legacy
    // flat snapshot, never to daytona's
    expect(resolveSnapshotName(dir!, "shared-base", "instabox")).toBe("factory-base-r3");
  });

  test("the original single-base root shape is migrated into shared-base when a platform is recorded", () => {
    writeFileSync(join(tmp(), "base-snapshot.json"), JSON.stringify({ snapshot: "factory-base-r3" }));
    setBasePlatform(dir!, "shared-base", "e2b", { snapshot: "factory-dev-e2b-r1" });
    const bases = readBases(dir!);
    expect(bases["shared-base"]!.snapshot).toBe("factory-base-r3");
    expect(bases["shared-base"]!.platforms!.e2b!.snapshot).toBe("factory-dev-e2b-r1");
  });
});
