import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSkillsB64, skillsSourceDir, syncHostSkills } from "../src/skills";
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

  test("the shipped tree carries the ui router with all four libraries and real commands", () => {
    const skill = readFileSync(join(skillsSourceDir(), "ui", "SKILL.md"), "utf8");
    expect(skill).toContain("name: ui");
    for (const lib of ["coss", "efferd", "Preline", "beUI", "transitions-dev", "web-design-guidelines"]) expect(skill).toContain(lib);
    // the install surface: registry JSON URLs, not MCP config
    expect(skill).toContain("npx shadcn@latest add");
    expect(skill).toContain("https://beui.dev/r");
    expect(skill).toContain("efferd.com/r/{style}/{name}.json");
    expect(skill).toContain("UI libraries: DISABLED for"); // names the runtime-context line it obeys
    expect(skill).toContain("ui.enabled=false");
  });

  test("the shipped tree carries the companion skills (audit, motion, readme)", () => {
    const audit = readFileSync(join(skillsSourceDir(), "web-design-guidelines", "SKILL.md"), "utf8");
    // the live-fetch rule is the skill's whole point — never audit from memory
    expect(audit).toContain("web-interface-guidelines/main/command.md");
    expect(audit).toContain("git diff --name-only"); // lap-diff default target
    const t = readFileSync(join(skillsSourceDir(), "transitions-dev", "SKILL.md"), "utf8");
    expect(t).toContain("transitions-dev");
    expect(t).toContain("prefers-reduced-motion");
    expect(existsSync(join(skillsSourceDir(), "transitions-dev", "12-error-state-shake.md"))).toBe(true);
    expect(existsSync(join(skillsSourceDir(), "transitions-dev", "_root.css"))).toBe(true);
    const readme = readFileSync(join(skillsSourceDir(), "create-readme", "SKILL.md"), "utf8");
    expect(readme).toContain("README.md");
    expect(readme).toContain("GFM");
  });
});

describe("syncHostSkills (host-side install)", () => {
  test("installs, updates, and clears the host tree", () => {
    const src = tmp();
    const target = tmp();
    mkdirSync(join(src, "demo"));
    writeFileSync(join(src, "demo", "SKILL.md"), "v1\n");
    process.env.PDF_SKILLS_DIR = src;
    expect(syncHostSkills(target)).toBe(true);
    expect(readFileSync(join(target, "demo", "SKILL.md"), "utf8")).toBe("v1\n");
    writeFileSync(join(src, "demo", "SKILL.md"), "v2\n");
    expect(syncHostSkills(target)).toBe(true);
    expect(readFileSync(join(target, "demo", "SKILL.md"), "utf8")).toBe("v2\n");
    rmSync(join(src, "demo"), { recursive: true, force: true });
    expect(syncHostSkills(target)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  test("an unchanged tree does not churn the install (hash gate)", () => {
    const src = tmp();
    const target = tmp();
    mkdirSync(join(src, "demo"));
    writeFileSync(join(src, "demo", "SKILL.md"), "stable\n");
    process.env.PDF_SKILLS_DIR = src;
    expect(syncHostSkills(target)).toBe(true);
    const stamped = readFileSync(join(target, "demo", "SKILL.md"));
    expect(syncHostSkills(target)).toBe(true);
    expect(readFileSync(join(target, "demo", "SKILL.md")).equals(stamped)).toBe(true);
  });
});

describe("repo operator skills (.agents/skills — the installer reads these)", () => {
  const fm = (file: string) => {
    const text = readFileSync(file, "utf8");
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!m) throw new Error(`no frontmatter block in ${file}`);
    return m[1];
  };

  test("every operator skill has a valid frontmatter block with name matching its directory", () => {
    // caught live 2026-11-05: a rename pass deleted the `name:` field and the
    // skills.sh installer skipped both skills ("missing required frontmatter
    // field(s): name" / YAML parse error on a mangled first line)
    const base = join(import.meta.dir, "..", ".agents", "skills");
    for (const dir of ["dark-factory", "dark-factory-setup", "create-readme"]) {
      const block = fm(join(base, dir, "SKILL.md"));
      const name = /(?:^|\n)name:\s*(\S+)/.exec(block)?.[1];
      expect(name, `[${dir}] name`).toBe(dir);
      const desc = /(?:^|\n)description:\s*\S/.test(block);
      expect(desc, `[${dir}] description`).toBe(true);
    }
  });
});
