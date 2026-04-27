/**
 * Skills directory enumeration. The user configures `skills_directory` in
 * settings — we list the available skills (filename + one-line summary)
 * and append that to the system prompt so the agent knows what's there.
 *
 * We deliberately don't inline full skill content. Skills can be long, and
 * most aren't relevant to a given task. Listing them lets the agent decide
 * to `cat` the file when the situation matches, keeping the system prompt
 * cheap on every run.
 *
 * Two layouts are supported, mirroring the conventions in the wild:
 *   1. Flat:        <dir>/<name>.md
 *   2. Per-skill:   <dir>/<name>/SKILL.md   (a-la Claude Code skills)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log";

export interface SkillEntry {
  name: string;
  path: string;
  summary: string;
}

/** First non-blank, non-heading line of the file — the agent's hint of
 *  what the skill is for. Capped to keep the prompt tight. */
function extractSummary(absPath: string): string {
  try {
    const raw = readFileSync(absPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("---")) continue;
      return trimmed.slice(0, 160);
    }
  } catch {
    /* fall through */
  }
  return "";
}

/**
 * Enumerate skills in the configured directory. Returns an empty list if
 * the directory is unset, missing, or unreadable — failures must never
 * block a run, so we log and move on.
 */
export function listSkills(skillsDir: string): SkillEntry[] {
  const dir = skillsDir.trim();
  if (!dir) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    log.warn("orchestrator.skills.read_failed", { dir, error: String(err) });
    return [];
  }
  const skills: SkillEntry[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
    const full = join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      skills.push({
        name: e.name.replace(/\.md$/i, ""),
        path: full,
        summary: extractSummary(full),
      });
      continue;
    }
    if (e.isDirectory()) {
      const skillFile = join(full, "SKILL.md");
      try {
        if (statSync(skillFile).isFile()) {
          skills.push({
            name: e.name,
            path: skillFile,
            summary: extractSummary(skillFile),
          });
        }
      } catch {
        /* no SKILL.md, skip */
      }
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** Render a markdown section listing the skills the agent can pull on
 *  demand. Empty input → empty string (caller can concat unconditionally). */
export function renderSkillsSection(skills: SkillEntry[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) =>
    s.summary ? `- \`${s.path}\` — ${s.summary}` : `- \`${s.path}\``,
  );
  return `

---

# Skills available

The user has a personal skills library. These files describe how to handle specific situations — read one when its summary matches what you're about to do. They're regular markdown; use your bash tool to \`cat\` the path.

${lines.join("\n")}`;
}
