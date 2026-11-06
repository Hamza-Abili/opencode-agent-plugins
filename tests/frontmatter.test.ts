import { describe, expect, test } from "bun:test";
import { parseSkillFile } from "../src/frontmatter.ts";

const SKILL_PATH = "/fake/skills/my-skill/SKILL.md";

describe("parseSkillFile", () => {
  test("parses a valid frontmatter block", () => {
    const result = parseSkillFile(
      "---\nname: my-skill\ndescription: Does the thing\nlicense: MIT\n---\n\nBody.",
      "my-skill",
      SKILL_PATH
    );
    expect("skill" in result).toBe(true);
    if ("skill" in result) {
      expect(result.skill.name).toBe("my-skill");
      expect(result.skill.description).toBe("Does the thing");
      expect(result.skill.path).toBe(SKILL_PATH);
    }
  });

  test("ignores unknown fields and quoted values", () => {
    const result = parseSkillFile(
      "---\nname: \"quoted-skill\"\ndescription: 'Single quoted'\nsome: other\n---\n\nBody.",
      "quoted-skill",
      SKILL_PATH
    );
    expect("skill" in result).toBe(true);
    if ("skill" in result) {
      expect(result.skill.name).toBe("quoted-skill");
      expect(result.skill.description).toBe("Single quoted");
    }
  });

  test("ignores nested metadata lines", () => {
    const result = parseSkillFile(
      "---\nname: my-skill\ndescription: Fine\nmetadata:\n  audience: maintainers\n---\n\nBody.",
      "my-skill",
      SKILL_PATH
    );
    expect("skill" in result).toBe(true);
  });

  test("rejects missing frontmatter", () => {
    const result = parseSkillFile("just a body", "my-skill", SKILL_PATH);
    expect("error" in result).toBe(true);
  });

  test("rejects unterminated frontmatter", () => {
    const result = parseSkillFile("---\nname: my-skill\ndescription: D\n", "my-skill", SKILL_PATH);
    expect("error" in result).toBe(true);
  });

  test("rejects a missing name", () => {
    const result = parseSkillFile("---\ndescription: D\n---\n", "my-skill", SKILL_PATH);
    expect("error" in result).toBe(true);
  });

  test("rejects a missing description", () => {
    const result = parseSkillFile("---\nname: my-skill\n---\n", "my-skill", SKILL_PATH);
    expect("error" in result).toBe(true);
  });

  test("rejects an invalid name pattern", () => {
    const result = parseSkillFile(
      "---\nname: My Skill!\ndescription: D\n---\n",
      "my-skill",
      SKILL_PATH
    );
    expect("error" in result).toBe(true);
  });

  test("rejects a name that does not match the directory", () => {
    const result = parseSkillFile(
      "---\nname: other-name\ndescription: D\n---\n",
      "my-skill",
      SKILL_PATH
    );
    expect("error" in result).toBe(true);
  });

  test("rejects an overlong description", () => {
    const result = parseSkillFile(
      `---\nname: my-skill\ndescription: ${"x".repeat(1025)}\n---\n`,
      "my-skill",
      SKILL_PATH
    );
    expect("error" in result).toBe(true);
  });

  test("accepts a 1024-character description", () => {
    const result = parseSkillFile(
      `---\nname: my-skill\ndescription: ${"x".repeat(1024)}\n---\n`,
      "my-skill",
      SKILL_PATH
    );
    expect("skill" in result).toBe(true);
  });
});
