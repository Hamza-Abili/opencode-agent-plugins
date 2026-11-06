import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { buildDefaultDirectories, discoverPlugins, findWorktreeRoot } from "../src/discovery.ts";
import { PLUGIN_SCHEMA } from "../src/manifest.ts";
import { FIXTURES, makeTempDir, writeFile } from "./helpers.ts";

/** Discover all fixture plugins and pick one by slug. */
function fixturePlugin(slug: string) {
  const result = discoverPlugins([FIXTURES]);
  return result.plugins.find((plugin) => plugin.slug === slug);
}

function rejectedBySuffix(suffix: string) {
  const result = discoverPlugins([FIXTURES]);
  return result.rejected.filter((entry) => entry.root.endsWith(suffix));
}

describe("discoverPlugins", () => {
  test("discovers the full valid plugin with skills and MCP", () => {
    const plugin = fixturePlugin("demo-tools");
    expect(plugin).toBeDefined();
    expect(plugin?.manifest.version).toBe("1.2.0");
    expect(plugin?.skills.map((skill) => skill.name)).toEqual(["greeting", "summarize"]);
    expect(plugin?.mcpServers.map((server) => server.name)).toEqual([
      "local-tools",
      "remote-tools",
    ]);
  });

  test("discovers a minimal manifest-only plugin", () => {
    const plugin = fixturePlugin("minimal");
    expect(plugin).toBeDefined();
    expect(plugin?.skills).toEqual([]);
    expect(plugin?.mcpServers).toEqual([]);
  });

  test("rejects plugins with a bad schema, name or author", () => {
    expect(rejectedBySuffix("bad-schema").length).toBe(1);
    expect(rejectedBySuffix("bad-name").length).toBe(1);
    expect(rejectedBySuffix("author-bad").length).toBe(1);
  });

  test("keeps warnings non-fatal on unknown top-level fields", () => {
    const plugin = fixturePlugin("unknown-top");
    expect(plugin).toBeDefined();
    expect(plugin?.problems.some((p) => p.level === "warning")).toBe(true);
  });

  test("skips skills whose name does not match the directory", () => {
    const plugin = fixturePlugin("name-mismatch");
    expect(plugin?.skills).toEqual([]);
    expect(plugin?.problems.some((p) => p.message.includes("does not match directory"))).toBe(true);
  });

  test("disables skills when the skills entry has the wrong filesystem kind", () => {
    const plugin = fixturePlugin("skills-file");
    expect(plugin?.skills).toEqual([]);
    expect(plugin?.problems.some((p) => p.message.includes("skills"))).toBe(true);
  });

  test("ignores directories without a plugin.json", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "not-a-plugin", "README.md"), "hi");
    const result = discoverPlugins([dir]);
    expect(result.plugins).toEqual([]);
    expect(result.rejected).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a plugin.json that escapes its root through a symlink", () => {
    const dir = makeTempDir();
    const scanRoot = path.join(dir, "scan");
    const outside = path.join(dir, "outside");
    const pluginRoot = path.join(scanRoot, "plugin");
    writeFile(
      path.join(outside, "plugin.json"),
      JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "esc" })
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.symlinkSync(path.join(outside, "plugin.json"), path.join(pluginRoot, "plugin.json"));
    const result = discoverPlugins([scanRoot]);
    expect(result.rejected.length).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("skips a skill whose SKILL.md escapes the plugin root", () => {
    const dir = makeTempDir();
    const scanRoot = path.join(dir, "scan");
    const outside = path.join(dir, "outside");
    const pluginRoot = path.join(scanRoot, "plugin");
    writeFile(path.join(outside, "SKILL.md"), "---\nname: sneaky\ndescription: D\n---\n");
    writeFile(
      path.join(pluginRoot, "plugin.json"),
      JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "esc-skill" })
    );
    fs.mkdirSync(path.join(pluginRoot, "skills"), { recursive: true });
    fs.symlinkSync(outside, path.join(pluginRoot, "skills", "sneaky"));
    const result = discoverPlugins([scanRoot]);
    expect(result.plugins.length).toBe(1);
    expect(result.plugins[0].skills).toEqual([]);
    expect(result.plugins[0].problems.some((p) => p.message.includes("sneaky"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("does not load the same plugin twice when directories overlap", () => {
    const result = discoverPlugins([FIXTURES, FIXTURES]);
    expect(result.plugins.filter((plugin) => plugin.slug === "demo-tools").length).toBe(1);
  });
});

describe("buildDefaultDirectories", () => {
  test("walks up from cwd to the git worktree root", () => {
    const root = makeTempDir();
    const worktree = path.join(root, "repo");
    const deep = path.join(worktree, "a", "b");
    fs.mkdirSync(path.join(worktree, ".git"), { recursive: true });
    fs.mkdirSync(path.join(worktree, ".agents", "plugins"), { recursive: true });
    fs.mkdirSync(deep, { recursive: true });

    const dirs = buildDefaultDirectories(deep);
    const projectDirs = dirs.filter((dir) => dir.startsWith(root));
    expect(projectDirs).toEqual([path.join(worktree, ".agents", "plugins")]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("stops walking at the worktree root", () => {
    const root = makeTempDir();
    const worktree = path.join(root, "repo");
    fs.mkdirSync(path.join(worktree, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, ".agents", "plugins"), { recursive: true });
    const deep = path.join(worktree, "x");
    fs.mkdirSync(deep, { recursive: true });

    const dirs = buildDefaultDirectories(deep);
    expect(dirs).not.toContain(path.join(root, ".agents", "plugins"));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("findWorktreeRoot", () => {
  test("finds the worktree root by .git", () => {
    const root = makeTempDir();
    const worktree = path.join(root, "repo");
    fs.mkdirSync(path.join(worktree, ".git"), { recursive: true });
    expect(findWorktreeRoot(path.join(worktree, "a", "b"))).toBe(worktree);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("falls back to the filesystem root", () => {
    expect(findWorktreeRoot("/tmp")).toBe("/");
  });
});

describe("discovery — client extension namespace", () => {
  function writePackage(name: string): string {
    const dir = makeTempDir();
    writeFile(
      path.join(dir, "plugin", "plugin.json"),
      JSON.stringify({ $schema: PLUGIN_SCHEMA, name })
    );
    return dir;
  }

  test("reports ai.opencode components it does not load, and still loads the portable half", () => {
    const dir = writePackage("with-extensions");
    writeFile(
      path.join(dir, "plugin", "skills", "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Greets\n---\nHi\n"
    );
    writeFile(path.join(dir, "plugin", "ai.opencode", "plugin.ts"), "export default {}");
    writeFile(path.join(dir, "plugin", "ai.opencode", "agents", "reviewer.md"), "# reviewer");

    const result = discoverPlugins([dir]);
    const plugin = result.plugins[0];
    expect(plugin?.skills.map((skill) => skill.name)).toEqual(["greet"]);
    const warning = plugin?.problems.find((p) => p.message.includes("ai.opencode"));
    expect(warning?.level).toBe("warning");
    expect(warning?.message).toContain("agents, plugin.ts");
    expect(warning?.message).toContain("#40993");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("stays silent for an empty namespace or unrelated files", () => {
    const dir = writePackage("quiet-extensions");
    fs.mkdirSync(path.join(dir, "plugin", "ai.opencode"), { recursive: true });
    writeFile(path.join(dir, "plugin", "ai.opencode", "README.md"), "client docs");

    const result = discoverPlugins([dir]);
    expect(result.plugins[0].problems.some((p) => p.message.includes("ai.opencode"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("never lists an ai.opencode namespace that escapes the plugin root", () => {
    const dir = writePackage("escaping-extensions");
    const outside = path.join(dir, "outside");
    writeFile(path.join(outside, "agents", "secret-component.md"), "# outside");
    fs.symlinkSync(outside, path.join(dir, "plugin", "ai.opencode"), "dir");

    const result = discoverPlugins([dir]);
    const messages = result.plugins[0].problems.map((problem) => problem.message);
    expect(messages).toContain(
      "ai.opencode entry is not a directory inside the plugin root — client extensions ignored"
    );
    expect(messages.join("\n")).not.toContain("ships");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("ignores a plain file named ai.opencode", () => {
    const dir = writePackage("not-a-namespace");
    writeFile(path.join(dir, "plugin", "ai.opencode"), "not a directory");

    const result = discoverPlugins([dir]);
    expect(result.plugins[0].problems.some((p) => p.message.includes("ai.opencode"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("reports a dangling ai.opencode symlink instead of reading it", () => {
    const dir = writePackage("dangling-namespace");
    fs.symlinkSync(path.join(dir, "missing"), path.join(dir, "plugin", "ai.opencode"), "dir");

    const result = discoverPlugins([dir]);
    const messages = result.plugins[0].problems.map((problem) => problem.message);
    expect(messages).toContain(
      "ai.opencode entry is not a directory inside the plugin root — client extensions ignored"
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("reports an unreadable ai.opencode namespace", () => {
    // Root can readdir a 000 directory, so the branch is unreachable there.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dir = writePackage("unreadable-namespace");
    const namespaceDir = path.join(dir, "plugin", "ai.opencode");
    fs.mkdirSync(namespaceDir, { recursive: true });
    fs.chmodSync(namespaceDir, 0o000);

    try {
      const result = discoverPlugins([dir]);
      expect(result.plugins[0].problems.map((problem) => problem.message)).toContain(
        "cannot read ai.opencode/ — client extensions ignored"
      );
    } finally {
      fs.chmodSync(namespaceDir, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("discoverSkils — skills directory escape", () => {
  test("disables skills when the skills directory is a symlink outside the root", () => {
    const dir = makeTempDir();
    const scanRoot = path.join(dir, "scan");
    const outside = path.join(dir, "outside");
    const pluginRoot = path.join(scanRoot, "plugin");
    writeFile(path.join(outside, "s", "SKILL.md"), "---\nname: s\ndescription: D\n---\n");
    writeFile(
      path.join(pluginRoot, "plugin.json"),
      JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "skills-escape" })
    );
    fs.symlinkSync(outside, path.join(pluginRoot, "skills"), "dir");
    const result = discoverPlugins([scanRoot]);
    expect(result.plugins.length).toBe(1);
    expect(result.plugins[0].skills).toEqual([]);
    expect(result.plugins[0].problems.some((p) => p.message.includes("skills"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("discovery read safety", () => {
  test("never reads a plugin.json that escapes the root (no content leak)", () => {
    const dir = makeTempDir();
    const scanRoot = path.join(dir, "scan");
    const pluginRoot = path.join(scanRoot, "plugin");
    writeFile(path.join(dir, "outside.json"), "SUPER_SECRET_SENTINEL");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.symlinkSync(path.join(dir, "outside.json"), path.join(pluginRoot, "plugin.json"));
    const result = discoverPlugins([scanRoot]);
    const text = JSON.stringify(result);
    expect(text).not.toContain("SUPER_SECRET_SENTINEL");
    expect(result.rejected.length).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("skips a plugin.json that is a FIFO without hanging", () => {
    const dir = makeTempDir();
    const pluginRoot = path.join(dir, "plugin");
    fs.mkdirSync(pluginRoot, { recursive: true });
    const fifo = path.join(pluginRoot, "plugin.json");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    if (made.exitCode !== 0) return; // platform without mkfifo
    const result = discoverPlugins([dir]);
    expect(result.plugins).toEqual([]);
    expect(result.rejected.length).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("discovery — inside-root manifest symlink", () => {
  test("accepts a plugin.json symlink that resolves inside the plugin root", () => {
    const dir = makeTempDir();
    const pluginRoot = path.join(dir, "plugin");
    writeFile(
      path.join(pluginRoot, "real-plugin.json"),
      JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "linked" })
    );
    fs.symlinkSync(path.join(pluginRoot, "real-plugin.json"), path.join(pluginRoot, "plugin.json"));
    const result = discoverPlugins([dir]);
    expect(result.plugins.length).toBe(1);
    expect(result.plugins[0].slug).toBe("linked");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
