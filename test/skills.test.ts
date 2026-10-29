import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSkillsB64, skillsSourceDir } from "../src/skills";
import { sh } from "../src/sh";

let dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "pdfskills-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  delete process.env.PDF_SKILLS_DIR;
});

describe("collectSkillsB64 (factory skills channel)", () => {
  test("null when the directory is absent", () => {
    expect(collectSkillsB64(join(tmpdir(), "pdfskills-absent-xyz"))).toBeNull();
  });

  test("null when empty or dotfiles-only", () => {
    const d = tmp();
    expect(collectSkillsB64(d)).toBeNull();
    writeFileSync(join(d, ".hidden"), "x");
    expect(collectSkillsB64(d)).toBeNull();
  });

  test("a skill tree tars and round-trips byte-identical through the driver's pipeline", async () => {
    const d = tmp();
    mkdirSync(join(d, "demo", "refs"), { recursive: true });
    writeFileSync(join(d, "demo", "SKILL.md"), "---\nname: demo\n---\n\nbody\n");
    writeFileSync(join(d, "demo", "refs", "notes.md"), "support file\n");
    const b64 = collectSkillsB64(d);
    expect(b64).not.toBeNull();
    const out = tmp();
    await sh(["bash", "-c", `printf %s '${b64}' | base64 -d | tar xzf - -C '${out}'`]);
    expect(readFileSync(join(out, "demo", "SKILL.md"), "utf8")).toBe("---\nname: demo\n---\n\nbody\n");
    expect(readFileSync(join(out, "demo", "refs", "notes.md"), "utf8")).toBe("support file\n");
  });

  test("the real checkout tree produces a payload — machines get the shipped skills", () => {
    expect(collectSkillsB64(skillsSourceDir())).not.toBeNull();
  });
});
