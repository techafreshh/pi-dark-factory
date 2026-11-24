import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE_PLATFORMS,
  BASE_SEEDS,
  assertBaseAlias,
  assertBaseName,
  assertNotAlias,
  baseBakeScript,
  isBasePlatform,
  opsBaseBake,
  opsBaseList,
  resolveRepoBakeNames,
  seedFor,
  summarizeBase,
} from "../src/basebake";
import { pentheraSpec } from "../src/security";

let dir: string | null = null;
const tmp = () => (dir ??= mkdtempSync(join(tmpdir(), "pdfbasebake-")));
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe("base platforms and seeds", () => {
  test("the four bakeable platforms exclude instavm (3 GiB snapshot build disk)", () => {
    expect([...BASE_PLATFORMS]).toEqual(["instabox", "boxd", "daytona", "e2b"]);
    expect(isBasePlatform("daytona")).toBe(true);
    expect(isBasePlatform("instavm")).toBe(false);
  });

  test("each seed is the provider's richest stock image, not a bare distro", () => {
    expect(BASE_SEEDS.instabox).toMatchObject({ kind: "template", value: "agent-browser" });
    expect(BASE_SEEDS.boxd).toMatchObject({ kind: "image", value: "" });
    expect(BASE_SEEDS.daytona).toMatchObject({ kind: "snapshot", value: "daytona-medium" });
    expect(BASE_SEEDS.e2b).toMatchObject({ kind: "template", value: "base" });
  });

  test("a platform only accepts seed kinds its API can boot", () => {
    expect(() => seedFor("instabox", { name: "x", seedKind: "image", seed: "ubuntu:24.04" })).toThrow(/cannot seed from a image/);
    expect(() => seedFor("e2b", { name: "x", seedKind: "snapshot", seed: "base" })).toThrow(/cannot seed from a snapshot/);
    expect(seedFor("daytona", { name: "x", seedKind: "image", seed: "node:22-bookworm" }).kind).toBe("image");
  });
});

describe("the dev-base toolchain script", () => {
  const script = baseBakeScript();

  test("installs the dev tools the factory stages need", () => {
    expect(script).toContain("@earendil-works/pi-coding-agent");
    expect(script).toContain("go.dev/dl/go");
    expect(script).toContain("https://deb.nodesource.com/setup_22.x");
    expect(script).toContain("cli.github.com/packages");
    expect(script).toContain("bun.sh/install");
  });

  test("bakes in the acceptance toolchain and the pinned security scanner", () => {
    expect(script).toContain("/opt/pdf-e2e");
    expect(script).toContain("CHROME_OK");
    expect(script).toContain("TOOLCHAIN_OK");
    expect(script).toContain(pentheraSpec());
    expect(script).toContain("PENTHERA_OK");
  });

  test("smokes every tool and fails loudly instead of snapshotting a half-provisioned box", () => {
    for (const marker of ["NODE_OK", "PYTHON_OK", "GO_OK", "GIT_OK", "GH_OK", "BUN_OK", "PI_OK", "DEV_TOOLS_OK"]) {
      expect(script).toContain(marker);
    }
    expect(script).toContain("exit 32");
    expect(script).toContain("exit 31");
  });

  test("summarizeBase reads the smoke markers into the recorded contents", () => {
    const raw = [
      "NODE_OK v22.23.5",
      "PYTHON_OK Python 3.13.2",
      "GIT_OK git version 2.47.1",
      "GO_OK go version go1.27.1 linux/amd64",
      "GH_OK gh version 2.102.0 (2026-10-01)",
      "BUN_OK 1.4.4",
      "PI_OK pi 1.4.0",
      "PENTHERA_OK penthera 2.4.0",
    ].join("\n");
    const s = summarizeBase(BASE_SEEDS.daytona, raw);
    expect(s).toContain("node v22.23.5");
    expect(s).toContain("go1.27.1");
    expect(s).toContain("gh version 2.102.0");
    expect(s).toContain("pi 1.4.0");
    expect(s).toContain("/opt/pdf-e2e");
  });
});

describe("per-repo bake layering", () => {
  test("a base alias is layered: boot it, save <slug>-base, switch the config", () => {
    writeFileSync(
      join(tmp(), "base-snapshot.json"),
      JSON.stringify({ "shared-base": { platforms: { instabox: { snapshot: "dev-ib-r1" } } } })
    );
    const names = resolveRepoBakeNames(dir!, "app", "instabox", "shared-base");
    expect(names).toEqual({ from: "shared-base", name: "app-base", switchConfig: true });
  });

  test("empty snapshot = the platform seed; it still saves a per-repo <slug>-base", () => {
    expect(resolveRepoBakeNames(tmp(), "app", "daytona", "")).toEqual({ from: null, name: "app-base", switchConfig: true });
    expect(resolveRepoBakeNames(tmp(), "app", "daytona", undefined)).toEqual({ from: null, name: "app-base", switchConfig: true });
  });

  test("a literal snapshot is enriched in place (no config switch)", () => {
    expect(resolveRepoBakeNames(tmp(), "app", "daytona", "app-base")).toEqual({
      from: "app-base",
      name: "app-base",
      switchConfig: false,
    });
  });

  test("boxd's literal default base counts as 'no per-repo snapshot yet'", () => {
    expect(
      resolveRepoBakeNames(tmp(), "app", "boxd", "factory-base-boxd-r1", { defaultLiteral: "factory-base-boxd-r1" })
    ).toEqual({ from: "factory-base-boxd-r1", name: "app-base", switchConfig: true });
    expect(() =>
      resolveRepoBakeNames(tmp(), "app", "boxd", "factory-base-boxd-r1", {
        defaultLiteral: "factory-base-boxd-r1",
        name: "factory-base-boxd-r1",
      })
    ).toThrow(/shared default base/);
  });

  test("--from/--name override the boot base and the output name", () => {
    writeFileSync(
      join(tmp(), "base-snapshot.json"),
      JSON.stringify({
        "shared-base": { platforms: { instabox: { snapshot: "dev-ib-r1" } } },
        "godot-base": { platforms: { instabox: { snapshot: "godot-r1" } } },
      })
    );
    expect(resolveRepoBakeNames(dir!, "app", "instabox", "shared-base", { from: "godot-base", name: "app-godot-r1" })).toEqual({
      from: "godot-base",
      name: "app-godot-r1",
      switchConfig: true,
    });
  });

  test("a per-repo bake can never overwrite an alias or a shared base's physical snapshot", () => {
    writeFileSync(
      join(tmp(), "base-snapshot.json"),
      JSON.stringify({ "shared-base": { platforms: { instabox: { snapshot: "dev-ib-r1" } } } })
    );
    expect(() => resolveRepoBakeNames(dir!, "app", "instabox", "", { name: "shared-base" })).toThrow(/is a base alias/);
    expect(() => resolveRepoBakeNames(dir!, "app", "instabox", "", { name: "dev-ib-r1" })).toThrow(/physical snapshot of base alias/);
  });

  test("an unmapped shared-base names the missing base instead of pretending it is a literal", () => {
    expect(() => resolveRepoBakeNames(tmp(), "app", "daytona", "shared-base")).toThrow(/bake the platform base first/);
    expect(() => resolveRepoBakeNames(tmp(), "app", "instavm", "shared-base")).toThrow(/InstaVM has no shared base/);
  });

  test("output names and base references cannot be flag-like or contain whitespace", () => {
    expect(() => resolveRepoBakeNames(tmp(), "app", "daytona", "", { name: "--evil" })).toThrow(/invalid/);
    expect(() => resolveRepoBakeNames(tmp(), "app", "daytona", "", { from: "bad name" })).toThrow(/invalid/);
    expect(() => seedFor("daytona", { name: "x", seed: "--evil", seedKind: "snapshot" })).toThrow(/invalid/);
  });
});

describe("base bake validation (no platform calls)", () => {
  test("instavm is refused with the disk-cap reason", async () => {
    await expect(opsBaseBake(tmp(), "instavm", { name: "factory-dev-instavm-r1" })).rejects.toThrow(/InstaVM is excluded/);
  });

  test("a snapshot name must be a lower-case versioned literal", () => {
    expect(() => assertBaseName("Factory Dev r1")).toThrow(/invalid/);
    assertBaseName("factory-dev-daytona-r1");
    expect(() => assertBaseAlias("Not An Alias")).toThrow(/invalid/);
    assertBaseAlias("shared-base");
  });

  test("an alias token can never be the physical snapshot name", () => {
    writeFileSync(join(tmp(), "base-snapshot.json"), JSON.stringify({ "shared-base": { snapshot: "factory-base-r3" } }));
    expect(() => assertNotAlias(dir!, "shared-base")).toThrow(/is a base alias/);
    expect(() => assertNotAlias(dir!, "factory-dev-daytona-r1")).not.toThrow();
  });

  test("opsBaseBake refuses an alias target before touching a platform API", async () => {
    writeFileSync(join(tmp(), "base-snapshot.json"), JSON.stringify({ "shared-base": { snapshot: "factory-base-r3" } }));
    await expect(opsBaseBake(dir!, "daytona", { name: "shared-base" })).rejects.toThrow(/is a base alias/);
  });

  test("base list reports per-platform physical snapshots", () => {
    writeFileSync(
      join(tmp(), "base-snapshot.json"),
      JSON.stringify({
        "shared-base": {
          platforms: {
            instabox: { snapshot: "dev-ib-r1", bakedAt: "2026-11-24", contents: "node/python/go" },
            daytona: { snapshot: "dev-day-r1", contents: "node/python/go" },
          },
        },
      })
    );
    const rows = opsBaseList(dir!);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.alias).toBe("shared-base");
    expect(rows[0]!.platforms.map((p) => `${p.platform}:${p.snapshot}`)).toEqual(["instabox:dev-ib-r1", "daytona:dev-day-r1"]);
  });
});
