import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { discoverPlugins } from "../src/discovery.ts";
import createLegacyPlugin, { mcpSnippet, reconcileSkillFarm } from "../src/legacy.ts";
import { FIXTURES, makeTempDir, writeFile } from "./helpers.ts";

function isSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

describe("reconcileSkillFarm", () => {
  test("creates symlinks for discovered skills and keeps them idempotent", () => {
    const dir = makeTempDir();
    const source = path.join(dir, "plugin", "skills", "my-skill");
    const skillsDir = path.join(dir, "skills");
    writeFile(path.join(source, "SKILL.md"), "---\nname: my-skill\ndescription: D\n---\n");

    reconcileSkillFarm({ skills: {} }, new Map([["my-skill", source]]), skillsDir);
    const target = path.join(skillsDir, "my-skill");
    expect(isSymlink(target)).toBe(true);
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(source));

    reconcileSkillFarm(
      { skills: { "my-skill": source } },
      new Map([["my-skill", source]]),
      skillsDir
    );
    expect(isSymlink(target)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("never touches a real directory at the target path", () => {
    const dir = makeTempDir();
    const source = path.join(dir, "plugin", "skills", "my-skill");
    const skillsDir = path.join(dir, "skills");
    writeFile(path.join(source, "SKILL.md"), "---\nname: my-skill\ndescription: D\n---\n");
    writeFile(path.join(skillsDir, "my-skill", "SKILL.md"), "user-owned");

    reconcileSkillFarm({ skills: {} }, new Map([["my-skill", source]]), skillsDir);
    expect(isSymlink(path.join(skillsDir, "my-skill"))).toBe(false);
    expect(fs.readFileSync(path.join(skillsDir, "my-skill", "SKILL.md"), "utf8")).toBe(
      "user-owned"
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("never touches a foreign symlink pointing elsewhere", () => {
    const dir = makeTempDir();
    const source = path.join(dir, "plugin-a", "skills", "my-skill");
    const foreign = path.join(dir, "plugin-b", "skills", "my-skill");
    const skillsDir = path.join(dir, "skills");
    writeFile(path.join(source, "SKILL.md"), "---\nname: my-skill\ndescription: A\n---\n");
    writeFile(path.join(foreign, "SKILL.md"), "---\nname: my-skill\ndescription: B\n---\n");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.symlinkSync(foreign, path.join(skillsDir, "my-skill"), "dir");

    reconcileSkillFarm({ skills: {} }, new Map([["my-skill", source]]), skillsDir);
    expect(fs.realpathSync(path.join(skillsDir, "my-skill"))).toBe(fs.realpathSync(foreign));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("removes stale symlinks it previously created", () => {
    const dir = makeTempDir();
    const source = path.join(dir, "plugin", "skills", "my-skill");
    const skillsDir = path.join(dir, "skills");
    writeFile(path.join(source, "SKILL.md"), "---\nname: my-skill\ndescription: D\n---\n");

    reconcileSkillFarm({ skills: {} }, new Map([["my-skill", source]]), skillsDir);
    expect(isSymlink(path.join(skillsDir, "my-skill"))).toBe(true);

    reconcileSkillFarm({ skills: { "my-skill": source } }, new Map(), skillsDir);
    expect(fs.existsSync(path.join(skillsDir, "my-skill"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("removes a dangling symlink it previously created", () => {
    const dir = makeTempDir();
    const skillsDir = path.join(dir, "skills");
    const removedSource = path.join(dir, "plugin", "skills", "my-skill");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.symlinkSync(removedSource, path.join(skillsDir, "my-skill"), "dir");
    expect(fs.existsSync(path.join(skillsDir, "my-skill"))).toBe(false); // dangling

    reconcileSkillFarm({ skills: { "my-skill": removedSource } }, new Map(), skillsDir);
    expect(fs.lstatSync(skillsDir).isDirectory()).toBe(true);
    expect(fs.readdirSync(skillsDir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("leaves a stale entry alone when the symlink changed", () => {
    const dir = makeTempDir();
    const source = path.join(dir, "plugin", "skills", "my-skill");
    const other = path.join(dir, "other", "my-skill");
    const skillsDir = path.join(dir, "skills");
    writeFile(path.join(source, "SKILL.md"), "---\nname: my-skill\ndescription: D\n---\n");
    writeFile(path.join(other, "SKILL.md"), "---\nname: my-skill\ndescription: D\n---\n");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.symlinkSync(other, path.join(skillsDir, "my-skill"), "dir");

    reconcileSkillFarm({ skills: { "my-skill": source } }, new Map(), skillsDir);
    expect(isSymlink(path.join(skillsDir, "my-skill"))).toBe(true);
    expect(fs.realpathSync(path.join(skillsDir, "my-skill"))).toBe(fs.realpathSync(other));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("mcpSnippet", () => {
  test("renders concrete disabled entries with client-set variables", () => {
    const original = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(makeTempDir(), "data-home");
    try {
      const discovery = discoverPlugins([FIXTURES]);
      const snippet = mcpSnippet(discovery.plugins, false);
      expect(snippet).toContain('"enabled": false');
      expect(snippet).toContain('"PLUGIN_ROOT"');
      expect(snippet).toContain('"PLUGIN_DATA"');
      expect(snippet).toContain("local-tools");
      expect(snippet).toContain("remote-tools");
    } finally {
      if (original === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = original;
    }
  });
});

describe("createLegacyPlugin", () => {
  const originalEnv = process.env;

  test("does nothing when disabled by environment", () => {
    const dir = makeTempDir();
    process.env = {
      PATH: originalEnv.PATH ?? "",
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      AGENT_PLUGINS_DISABLED: "1",
    };
    const hooks = createLegacyPlugin({ directory: path.join(FIXTURES, "minimal") });
    expect(hooks).toEqual({});
    const skillsDir = path.join(dir, "config", "opencode", "skills");
    if (fs.existsSync(skillsDir)) expect(fs.readdirSync(skillsDir)).toEqual([]);
    process.env = originalEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("writes the skill farm and logs the MCP opt-in snippet", () => {
    const dir = makeTempDir();
    process.env = {
      PATH: originalEnv.PATH ?? "",
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      AGENT_PLUGINS_DIRS: FIXTURES,
      AGENT_PLUGINS_MCP: "1",
    };
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (message: unknown) => {
      lines.push(String(message));
    };
    try {
      createLegacyPlugin({ directory: FIXTURES });
    } finally {
      console.log = originalLog;
    }
    const skillsDir = path.join(dir, "config", "opencode", "skills");
    expect(fs.readdirSync(skillsDir)).toContain("greeting");
    expect(lines.join("\n")).toContain('"enabled": false');
    process.env = originalEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("does not log an MCP snippet when MCP is disabled", () => {
    const dir = makeTempDir();
    process.env = {
      PATH: originalEnv.PATH ?? "",
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      AGENT_PLUGINS_DIRS: FIXTURES,
      AGENT_PLUGINS_MCP: "0",
    };
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (message: unknown) => {
      lines.push(String(message));
    };
    try {
      createLegacyPlugin({ directory: FIXTURES });
    } finally {
      console.log = originalLog;
    }
    expect(lines.join("\n")).not.toContain("Opt in by adding");
    process.env = originalEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("skill farm ownership", () => {
  test("replaces its own symlink when the skill source changes", () => {
    const dir = makeTempDir();
    const skillsDir = path.join(dir, "skills");
    const a = path.join(dir, "a", "s");
    const b = path.join(dir, "b", "s");
    writeFile(path.join(a, "SKILL.md"), "---\nname: s\ndescription: A\n---\n");
    writeFile(path.join(b, "SKILL.md"), "---\nname: s\ndescription: B\n---\n");

    const first = reconcileSkillFarm({ skills: {} }, new Map([["s", a]]), skillsDir);
    expect(first.skills).toEqual({ s: a });
    const second = reconcileSkillFarm(first, new Map([["s", b]]), skillsDir);
    expect(second.skills).toEqual({ s: b });
    expect(fs.realpathSync(path.join(skillsDir, "s"))).toBe(fs.realpathSync(b));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("never adopts an untracked symlink", () => {
    const dir = makeTempDir();
    const skillsDir = path.join(dir, "skills");
    const source = path.join(dir, "plugin", "s");
    writeFile(path.join(source, "SKILL.md"), "---\nname: s\ndescription: D\n---\n");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.symlinkSync(source, path.join(skillsDir, "s"), "dir");

    const state = reconcileSkillFarm({ skills: {} }, new Map([["s", source]]), skillsDir);
    expect(state.skills).toEqual({});
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("mcpSnippet duplicates", () => {
  test("keeps one entry per display name", () => {
    const original = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(makeTempDir(), "data-home");
    try {
      const discovery = discoverPlugins([FIXTURES]);
      const snippet = mcpSnippet(discovery.plugins, false);
      expect(snippet.split('"remote-tools"').length - 1).toBe(1);
    } finally {
      if (original === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = original;
    }
  });
});

describe("v1 npm packages", () => {
  test("loads skills from packages resolved in the project", () => {
    const original = process.env;
    const dir = makeTempDir();
    const project = path.join(dir, "project");
    const pkg = path.join(project, "node_modules", "@acme", "agent-plugin");
    writeFile(
      path.join(pkg, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "npm-plugin",
      })
    );
    writeFile(
      path.join(pkg, "skills", "npmskill", "SKILL.md"),
      "---\nname: npmskill\ndescription: From npm\n---\nBody."
    );
    const skillsDir = path.join(dir, "skills");
    process.env = {
      PATH: original.PATH ?? "",
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      AGENT_PLUGINS_PACKAGES: "@acme/agent-plugin",
      AGENT_PLUGINS_SKILLS_DIR: skillsDir,
    };
    try {
      createLegacyPlugin({ directory: project });
      expect(fs.readdirSync(skillsDir)).toContain("npmskill");
    } finally {
      process.env = original;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("v1 kill switches clean owned links", () => {
  function farmSetup(): { dir: string; skillsDir: string } {
    const dir = makeTempDir();
    const skillsDir = path.join(dir, "skills");
    return { dir, skillsDir };
  }

  test("AGENT_PLUGINS_DISABLED removes previously farmed links", () => {
    const original = process.env;
    const { dir, skillsDir } = farmSetup();
    process.env = {
      PATH: original.PATH ?? "",
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_DATA_HOME: path.join(dir, "data"),
      AGENT_PLUGINS_DIRS: FIXTURES,
      AGENT_PLUGINS_SKILLS_DIR: skillsDir,
    };
    try {
      createLegacyPlugin({ directory: FIXTURES });
      expect(fs.readdirSync(skillsDir).length).toBeGreaterThan(0);
      process.env.AGENT_PLUGINS_DISABLED = "1";
      createLegacyPlugin({ directory: FIXTURES });
      expect(fs.readdirSync(skillsDir)).toEqual([]);
    } finally {
      process.env = original;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("AGENT_PLUGINS_SKILLS=0 removes previously farmed links", () => {
    const original = process.env;
    const { dir, skillsDir } = farmSetup();
    process.env = {
      PATH: original.PATH ?? "",
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_DATA_HOME: path.join(dir, "data"),
      AGENT_PLUGINS_DIRS: FIXTURES,
      AGENT_PLUGINS_SKILLS_DIR: skillsDir,
    };
    try {
      createLegacyPlugin({ directory: FIXTURES });
      expect(fs.readdirSync(skillsDir).length).toBeGreaterThan(0);
      process.env.AGENT_PLUGINS_SKILLS = "0";
      createLegacyPlugin({ directory: FIXTURES });
      expect(fs.readdirSync(skillsDir)).toEqual([]);
    } finally {
      process.env = original;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an unwritable skills directory preserves the previous ownership state", () => {
    const dir = makeTempDir();
    const notADir = path.join(dir, "skills-file");
    fs.writeFileSync(notADir, "x");
    const state = reconcileSkillFarm(
      { skills: { keep: path.join(dir, "src") } },
      new Map(),
      notADir
    );
    expect(state.skills).toEqual({ keep: path.join(dir, "src") });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("v1 kill switch across directories and permissions", () => {
  test("preserves ownership when the skills directory is read-only", () => {
    const dir = makeTempDir();
    const skillsDir = path.join(dir, "skills");
    const source = path.join(dir, "src", "s");
    writeFile(path.join(source, "SKILL.md"), "---\nname: s\ndescription: D\n---\n");
    const first = reconcileSkillFarm({ skills: {} }, new Map([["s", source]]), skillsDir);
    expect(first.skills.s).toBe(source);

    fs.chmodSync(skillsDir, 0o555);
    const second = reconcileSkillFarm({ skills: first.skills, skillsDir }, new Map(), skillsDir);
    fs.chmodSync(skillsDir, 0o755);
    // Removal failed, so ownership must survive for a later retry.
    expect(second.skills.s).toBe(source);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("cleanup uses the recorded skills directory after an override is removed", () => {
    const original = process.env;
    const dir = makeTempDir();
    const customDir = path.join(dir, "custom-skills");
    process.env = {
      PATH: original.PATH ?? "",
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_DATA_HOME: path.join(dir, "data"),
      AGENT_PLUGINS_DIRS: FIXTURES,
      AGENT_PLUGINS_SKILLS_DIR: customDir,
    };
    try {
      createLegacyPlugin({ directory: FIXTURES });
      expect(fs.readdirSync(customDir).length).toBeGreaterThan(0);
      delete process.env.AGENT_PLUGINS_SKILLS_DIR;
      process.env.AGENT_PLUGINS_DISABLED = "1";
      createLegacyPlugin({ directory: FIXTURES });
      expect(fs.readdirSync(customDir)).toEqual([]);
    } finally {
      process.env = original;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("v1 farm — directory migration and retry", () => {
  test("changing the skills directory cleans the previous farm", () => {
    const original = process.env;
    const dir = makeTempDir();
    const a = path.join(dir, "skills-a");
    const b = path.join(dir, "skills-b");
    process.env = {
      PATH: original.PATH ?? "",
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_DATA_HOME: path.join(dir, "data"),
      AGENT_PLUGINS_DIRS: FIXTURES,
      AGENT_PLUGINS_SKILLS_DIR: a,
    };
    try {
      createLegacyPlugin({ directory: FIXTURES });
      expect(fs.readdirSync(a).length).toBeGreaterThan(0);
      process.env.AGENT_PLUGINS_SKILLS_DIR = b;
      createLegacyPlugin({ directory: FIXTURES });
      expect(fs.readdirSync(a)).toEqual([]);
      expect(fs.readdirSync(b).length).toBeGreaterThan(0);
      delete process.env.AGENT_PLUGINS_SKILLS_DIR;
      process.env.AGENT_PLUGINS_DISABLED = "1";
      createLegacyPlugin({ directory: FIXTURES });
      expect(fs.readdirSync(b)).toEqual([]);
    } finally {
      process.env = original;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a failed removal in a recorded directory is retried later", () => {
    const original = process.env;
    const dir = makeTempDir();
    const custom = path.join(dir, "custom-skills");
    process.env = {
      PATH: original.PATH ?? "",
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_DATA_HOME: path.join(dir, "data"),
      AGENT_PLUGINS_DIRS: FIXTURES,
      AGENT_PLUGINS_SKILLS_DIR: custom,
    };
    try {
      createLegacyPlugin({ directory: FIXTURES });
      const names = fs.readdirSync(custom);
      expect(names.length).toBeGreaterThan(0);
      delete process.env.AGENT_PLUGINS_SKILLS_DIR;
      fs.chmodSync(custom, 0o555);
      process.env.AGENT_PLUGINS_DISABLED = "1";
      createLegacyPlugin({ directory: FIXTURES });
      expect(fs.readdirSync(custom)).toEqual(names);
      fs.chmodSync(custom, 0o755);
      createLegacyPlugin({ directory: FIXTURES });
      expect(fs.readdirSync(custom)).toEqual([]);
    } finally {
      fs.chmodSync(custom, 0o755);
      process.env = original;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a ${PLUGIN_DATA} cwd is included in the v1 snippet", () => {
    const dir = makeTempDir();
    const plugin = path.join(dir, "plugin");
    writeFile(
      path.join(plugin, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "data-tools",
      })
    );
    writeFile(
      path.join(plugin, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { data: { type: "stdio", command: "node", cwd: "${PLUGIN_DATA}" } },
      })
    );
    const discovery = discoverPlugins([dir]);
    const original = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(dir, "data-home");
    try {
      const snippet = mcpSnippet(discovery.plugins, false);
      expect(snippet).toContain("data-tools");
      expect(snippet).toContain('"enabled": false');
    } finally {
      if (original === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = original;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
