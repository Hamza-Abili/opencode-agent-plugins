/**
 * opencode-agent-plugins — SKILL.md frontmatter parsing.
 *
 * Agent Skills require a YAML frontmatter block with `name` (required) and
 * `description` (required). This parser supports the flat subset those
 * fields need, plus YAML block scalars (`|` and `>`) for long descriptions:
 *
 *   ---
 *   name: release-notes
 *   description: |
 *     Draft release notes from merged PRs
 *     and propose a version bump.
 *   ---
 *
 * Nested maps (e.g. `metadata:`) are ignored, unknown fields are ignored,
 * and anything the parser cannot understand as a required field is a skill
 * error so the skill is skipped rather than half-loaded.
 */

import type { AgentSkill } from "./types.ts";

/**
 * Skill names must be lowercase alphanumeric with single hyphen separators,
 * match their directory name, and stay within 1–64 characters — the same
 * rule OpenCode applies to discovered skills.
 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const MAX_DESCRIPTION_LENGTH = 1024;

export interface ParsedSkill {
  skill: AgentSkill;
}

export interface SkillFailure {
  error: string;
}

interface ParsedFields {
  fields: Record<string, string>;
  error?: string;
}

/** Parse the flat frontmatter body, including block scalars. */
function parseFields(lines: string[]): ParsedFields {
  const fields: Record<string, string> = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const colon = trimmed.indexOf(":");
      if (colon <= 0) continue; // ignore non-key/value lines
      const key = trimmed.slice(0, colon).trim();
      if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
      let rawValue = trimmed.slice(colon + 1).trim();

      // Block scalar: collect indented continuation lines.
      if (/^[|>][+-]?$/.test(rawValue)) {
        const folded = rawValue.startsWith(">");
        const collected: string[] = [];
        let cursor = index + 1;
        while (cursor < lines.length) {
          const next = lines[cursor];
          if (next.trim() !== "" && !/^\s/.test(next)) break;
          collected.push(next);
          cursor += 1;
        }
        index = cursor - 1;
        const nonBlank = collected.filter((entry) => entry.trim() !== "");
        const indent = nonBlank.reduce((min, entry) => {
          const width = entry.length - entry.trimStart().length;
          return Math.min(min, width);
        }, Number.POSITIVE_INFINITY);
        const stripped = collected.map((entry) => (entry.trim() === "" ? "" : entry.slice(indent)));
        const joined = folded
          ? stripped.filter((entry) => entry !== "").join(" ")
          : stripped.join("\n");
        rawValue = joined.trim();
      }

      const value =
        (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))
          ? rawValue.slice(1, -1)
          : rawValue;
      fields[key] = value;
    }
    // indented lines belong to a previous nested map — ignored
  }

  return { fields };
}

/**
 * Parse a SKILL.md. `dirName` is the directory containing it (the skill name
 * must match it) and `filePath` is the absolute, symlink-resolved file path.
 */
export function parseSkillFile(
  content: string,
  dirName: string,
  filePath: string
): ParsedSkill | SkillFailure {
  if (!content.startsWith("---")) {
    return { error: "missing YAML frontmatter (must start with ---)" };
  }

  const lines = content.split("\n");
  const closeIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closeIndex === -1) {
    return { error: "unterminated YAML frontmatter" };
  }

  const { fields } = parseFields(lines.slice(1, closeIndex));

  const name = fields.name;
  if (name === undefined || name === "") {
    return { error: "frontmatter is missing the required name field" };
  }
  if (!SKILL_NAME_PATTERN.test(name) || name.length > 64) {
    return { error: `invalid skill name ${JSON.stringify(name)} (lowercase, hyphens, 1-64 chars)` };
  }
  if (name !== dirName) {
    return {
      error: `skill name ${JSON.stringify(name)} does not match directory ${JSON.stringify(dirName)}`,
    };
  }

  const description = fields.description;
  if (description === undefined || description === "") {
    return { error: "frontmatter is missing the required description field" };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { error: `description exceeds ${MAX_DESCRIPTION_LENGTH} characters` };
  }

  return { skill: { name, description, path: filePath, content } };
}
