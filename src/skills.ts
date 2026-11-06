/**
 * opencode-agent-plugins — skills/ component discovery.
 *
 * Discovery rule: immediate child directories of `skills/` containing a
 * regular `SKILL.md`. Non-conforming skills are skipped individually (never
 * recursive, never fatal for the plugin); a `skills/` entry of the wrong
 * filesystem kind disables only the skills component.
 */

import path from "node:path";
import { parseSkillFile } from "./frontmatter.ts";
import { listEntries, lstatOrNull, readText, resolvedInside } from "./fs.ts";
import type { AgentSkill, Problem } from "./types.ts";

export function discoverSkills(root: string): { skills: AgentSkill[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const skills: AgentSkill[] = [];

  const skillsDir = path.join(root, "skills");
  const realSkillsDir = resolvedInside(skillsDir, root);
  if (realSkillsDir === null) {
    // Missing `skills/` is not an error; a present-but-escaping entry is.
    if (pathExistsSymlinkTarget(skillsDir)) {
      problems.push({
        level: "warning",
        message: "skills entry is not a directory inside the plugin root — skills disabled",
      });
    }
    return { skills, problems };
  }

  const entries = listEntries(realSkillsDir);
  if (entries === null) {
    problems.push({ level: "warning", message: "cannot read skills directory — skills disabled" });
    return { skills, problems };
  }

  for (const entry of entries) {
    if (entry.kind !== "dir") continue;
    const skillDir = path.join(realSkillsDir, entry.name);
    const skillFile = path.join(skillDir, "SKILL.md");

    const realSkillFile = resolvedInside(skillFile, root);
    if (realSkillFile === null) {
      problems.push({
        level: "warning",
        message: `skill ${JSON.stringify(entry.name)}: SKILL.md missing or escapes the plugin root — skipped`,
      });
      continue;
    }
    const skillStat = lstatOrNull(realSkillFile);
    if (skillStat === null || !skillStat.isFile()) {
      problems.push({
        level: "warning",
        message: `skill ${JSON.stringify(entry.name)}: SKILL.md is not a regular file — skipped`,
      });
      continue;
    }
    const content = readText(realSkillFile);
    if (content === null) {
      problems.push({
        level: "warning",
        message: `skill ${JSON.stringify(entry.name)}: cannot read SKILL.md`,
      });
      continue;
    }
    const parsed = parseSkillFile(content, entry.name, realSkillFile);
    if ("error" in parsed) {
      problems.push({
        level: "warning",
        message: `skill ${JSON.stringify(entry.name)}: ${parsed.error} — skipped`,
      });
      continue;
    }
    skills.push(parsed.skill);
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, problems };
}

function pathExistsSymlinkTarget(p: string): boolean {
  // `resolvedInside` returns null both for missing entries and for escaping
  // entries; distinguish them so a missing `skills/` stays silent.
  return lstatOrNull(p) !== null;
}
