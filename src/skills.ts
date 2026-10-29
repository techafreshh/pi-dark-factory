import { readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Factory-managed skills for lap agents — `pi-skills/` in this checkout ships
 * into instabox machines as a base64 tarball on PDF_PI_SKILLS_B64, and the
 * stage driver unpacks it into $HOME/.pi/agent/skills where pi's native
 * discovery (dist/core/skills.js: agentDir/skills, cwd/.pi/skills) lists every
 * SKILL.md in the stage's system prompt. Host and compose modes need no
 * channel: host stages read the directory through their own HOME and compose
 * bind-mounts ~/.pi — only machines freeze ~/.pi into a snapshot.
 *
 * Each top-level directory under pi-skills/ is one skill (a SKILL.md plus any
 * support files). Loose .md files in the root would ALSO load as skills — pi
 * treats direct .md children of the root as skills — so keep them in dirs.
 */

/** Test seam: tests point PDF_SKILLS_DIR at a temp tree (mirrors PDF_SSH_BIN). */
export function skillsSourceDir(): string {
  return process.env.PDF_SKILLS_DIR || join(import.meta.dir, "..", "pi-skills");
}

/** A base64 skills payload over this size means someone dropped a data dir
 *  into pi-skills/ — refuse rather than bloat every stage's ssh stdin. */
const MAX_B64_BYTES = 4 * 1024 * 1024;

/**
 * base64 (single line) of a gzipped tar of the whole skills tree, or null
 * when the directory is absent, empty, or dotfiles-only. Sync on purpose:
 * buildMachineEnvFile is sync and runs per stage — a small text tar costs
 * milliseconds.
 */
export function collectSkillsB64(dir: string = skillsSourceDir()): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const hasContent = entries
    .filter((e) => !e.startsWith("."))
    .some((e) => {
      try {
        const st = statSync(join(dir, e));
        return st.isDirectory() || e.endsWith(".md");
      } catch {
        return false;
      }
    });
  if (!hasContent) return null;
  let out: string;
  try {
    out = execFileSync("bash", ["-c", `tar czf - -C ${escapeArg(dir)} . | base64 -w0`], {
      maxBuffer: MAX_B64_BYTES,
      timeoutMs: 15000,
    })
      .toString()
      .trim();
  } catch (e) {
    console.error(`skills: tar of ${dir} failed (${e instanceof Error ? e.message : e}) — stages run without factory skills`);
    return null;
  }
  if (!out) return null;
  if (out.length > MAX_B64_BYTES) {
    console.error(`skills: pi-skills tar is ${out.length} base64 bytes (> ${MAX_B64_BYTES}) — not shipping it into stages`);
    return null;
  }
  return out;
}

function escapeArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
