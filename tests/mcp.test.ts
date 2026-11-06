import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { expandVariables, MCP_SCHEMA, mapMcpServer, parseMcp } from "../src/mcp.ts";
import { FIXTURES, makeTempDir, writeFile } from "./helpers.ts";

function parseFixture(name: string) {
  return parseMcp(path.join(FIXTURES, name));
}

function pluginWithMcp(mcp: unknown): string {
  const dir = makeTempDir();
  writeFile(path.join(dir, "plugin.json"), "{}");
  writeFile(path.join(dir, "mcp.json"), JSON.stringify(mcp));
  return dir;
}

describe("parseMcp", () => {
  test("parses a valid mcp.json with supported transports", () => {
    const { servers, problems } = parseFixture("valid-full");
    expect(servers.map((server) => `${server.name}:${server.type}`)).toEqual([
      "local-tools:stdio",
      "remote-tools:streamable-http",
    ]);
    expect(problems.some((p) => p.message.includes("sse transport is not supported"))).toBe(true);
  });

  test("missing mcp.json yields no servers and no problems", () => {
    const { servers, problems } = parseMcp(path.join(FIXTURES, "minimal"));
    expect(servers).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("missing $schema disables the MCP component", () => {
    const { servers, problems } = parseFixture("mcp-bad-top");
    expect(servers).toEqual([]);
    expect(problems.some((p) => p.message.includes("missing $schema"))).toBe(true);
  });

  test("invalid entries are skipped individually", () => {
    const { servers, problems } = parseFixture("mcp-bad-entry");
    expect(servers).toEqual([]);
    expect(problems.filter((p) => p.message.includes("weird")).length).toBe(1);
    expect(problems.filter((p) => p.message.includes("extra-field")).length).toBe(1);
  });

  test("invalid JSON disables the MCP component", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "mcp.json"), "{ not json");
    const { servers, problems } = parseMcp(dir);
    expect(servers).toEqual([]);
    expect(problems.some((p) => p.message.includes("not valid JSON"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("mcp.json that escapes the plugin root is rejected", () => {
    const dir = makeTempDir();
    const plugin = path.join(dir, "plugin");
    fs.mkdirSync(plugin, { recursive: true });
    writeFile(
      path.join(dir, "outside-mcp.json"),
      JSON.stringify({
        $schema: MCP_SCHEMA,
        mcpServers: { evil: { type: "streamable-http", url: "https://evil.example.com/mcp" } },
      })
    );
    fs.symlinkSync(path.join(dir, "outside-mcp.json"), path.join(plugin, "mcp.json"));
    const { servers, problems } = parseMcp(plugin);
    expect(servers).toEqual([]);
    expect(problems.some((p) => p.message.includes("resolves outside the plugin root"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("mcp.json with the wrong filesystem kind disables the component", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "mcp.json"), { recursive: true });
    const { servers, problems } = parseMcp(dir);
    expect(servers).toEqual([]);
    expect(problems.some((p) => p.message.includes("not a regular file"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("reserved env keys are rejected", () => {
    const dir = pluginWithMcp({
      $schema: MCP_SCHEMA,
      mcpServers: { x: { type: "stdio", command: "x", env: { PLUGIN_ROOT: "/evil" } } },
    });
    const { servers, problems } = parseMcp(dir);
    expect(servers).toEqual([]);
    expect(problems.some((p) => p.message.includes("PLUGIN_ROOT"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("unknown top-level fields disable the MCP component", () => {
    const dir = pluginWithMcp({ $schema: MCP_SCHEMA, mcpServers: {}, extra: 1 });
    const { servers, problems } = parseMcp(dir);
    expect(servers).toEqual([]);
    expect(problems.some((p) => p.message.includes("unknown top-level field"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("invalid cwd patterns are rejected per entry", () => {
    const dir = pluginWithMcp({
      $schema: MCP_SCHEMA,
      mcpServers: { x: { type: "stdio", command: "x", cwd: "/etc" } },
    });
    const { servers, problems } = parseMcp(dir);
    expect(servers).toEqual([]);
    expect(problems.some((p) => p.message.includes("cwd"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("cwd with .. segments is rejected", () => {
    const dir = pluginWithMcp({
      $schema: MCP_SCHEMA,
      mcpServers: { x: { type: "stdio", command: "x", cwd: "./../outside" } },
    });
    const { servers, problems } = parseMcp(dir);
    expect(servers).toEqual([]);
    expect(problems.some((p) => p.message.includes(".."))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("absolute and variable-bearing commands are rejected", () => {
    for (const command of ["/usr/bin/node", "${PLUGIN_ROOT}/bin/server", "node --flag"]) {
      const dir = pluginWithMcp({
        $schema: MCP_SCHEMA,
        mcpServers: { x: { type: "stdio", command } },
      });
      const { servers } = parseMcp(dir);
      expect(servers).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mapMcpServer", () => {
  test("maps stdio with variable expansion and client-set variables", () => {
    const result = mapMcpServer(
      {
        name: "local",
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}/cli.js", "${PLUGIN_DATA}/x"],
        env: { TOKEN: "abc" },
        cwd: "./",
      },
      "/plugins/demo",
      "/data/demo"
    );
    expect("config" in result).toBe(true);
    if ("config" in result) {
      expect(result.config).toEqual({
        type: "local",
        command: ["node", "/plugins/demo/cli.js", "/data/demo/x"],
        environment: { TOKEN: "abc", PLUGIN_ROOT: "/plugins/demo", PLUGIN_DATA: "/data/demo" },
        cwd: "/plugins/demo",
      });
    }
  });

  test("emits ./ commands as absolute paths after containment", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    writeFile(path.join(root, "bin", "server"), "#!/bin/sh");
    const result = mapMcpServer(
      { name: "inside", type: "stdio", command: "./bin/server" },
      root,
      "/data"
    );
    expect("config" in result).toBe(true);
    if ("config" in result && result.config.type === "local") {
      expect(result.config.command[0]).toBe(fs.realpathSync(path.join(root, "bin", "server")));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a ./ command that escapes the plugin root", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    writeFile(path.join(dir, "outside-script"), "#!/bin/sh");
    const result = mapMcpServer(
      { name: "escape", type: "stdio", command: "../outside-script" },
      root,
      "/data"
    );
    expect("error" in result).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a cwd that escapes the plugin root through a symlink", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(root, "link"), "dir");
    const result = mapMcpServer(
      { name: "cwd-escape", type: "stdio", command: "node", cwd: "./link" },
      root,
      "/data"
    );
    expect("error" in result).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("accepts a plugin-root cwd and a data-root cwd", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    const data = path.join(dir, "data");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    const fromRoot = mapMcpServer(
      { name: "a", type: "stdio", command: "node", cwd: "${PLUGIN_ROOT}" },
      root,
      data
    );
    expect("config" in fromRoot).toBe(true);
    const fromData = mapMcpServer(
      { name: "b", type: "stdio", command: "node", cwd: "${PLUGIN_DATA}/work" },
      root,
      data
    );
    expect("config" in fromData).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("maps streamable-http with headers", () => {
    const result = mapMcpServer(
      {
        name: "remote",
        type: "streamable-http",
        url: "https://tools.example.com/mcp",
        headers: { "X-Key": "v" },
      },
      "/plugins/demo",
      "/data"
    );
    expect("config" in result).toBe(true);
    if ("config" in result) {
      expect(result.config).toEqual({
        type: "remote",
        url: "https://tools.example.com/mcp",
        headers: { "X-Key": "v" },
      });
    }
  });

  test("allows http only on loopback", () => {
    const loopback = mapMcpServer(
      { name: "local", type: "streamable-http", url: "http://127.0.0.1:3000/mcp" },
      "/plugins/demo",
      "/data"
    );
    expect("config" in loopback).toBe(true);
    const localhost = mapMcpServer(
      { name: "local", type: "streamable-http", url: "http://localhost:3000/mcp" },
      "/plugins/demo",
      "/data"
    );
    expect("config" in localhost).toBe(true);
    const external = mapMcpServer(
      { name: "remote", type: "streamable-http", url: "http://tools.example.com/mcp" },
      "/plugins/demo",
      "/data"
    );
    expect("error" in external).toBe(true);
  });

  test("rejects credentials, fragments and queries in remote URLs", () => {
    for (const url of [
      "https://user:pass@tools.example.com/mcp",
      "https://tools.example.com/mcp#frag",
      "https://tools.example.com/mcp?key=x",
    ]) {
      const result = mapMcpServer(
        { name: "remote", type: "streamable-http", url },
        "/plugins/demo",
        "/data"
      );
      expect("error" in result).toBe(true);
    }
  });

  test("rejects malformed remote URLs and unsupported transports", () => {
    expect(
      "error" in mapMcpServer({ name: "r", type: "streamable-http", url: "not a url" }, "/p", "/d")
    ).toBe(true);
    expect(
      "error" in mapMcpServer({ name: "r", type: "sse", url: "https://x.example.com" }, "/p", "/d")
    ).toBe(true);
  });
});

describe("expandVariables", () => {
  test("expands only PLUGIN_ROOT and PLUGIN_DATA", () => {
    expect(expandVariables("${PLUGIN_ROOT}/a ${PLUGIN_DATA}/b ${OTHER}", "/r", "/d")).toBe(
      "/r/a /d/b ${OTHER}"
    );
  });
});

describe("mapMcpServer — ./ containment branch", () => {
  test("rejects a ./ command whose symlink resolves outside the root", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    const outside = path.join(dir, "outside");
    writeFile(path.join(outside, "server"), "#!/bin/sh");
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.symlinkSync(path.join(outside, "server"), path.join(root, "bin", "server"));
    const result = mapMcpServer(
      { name: "esc", type: "stdio", command: "./bin/server" },
      root,
      "/data"
    );
    expect("error" in result).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("mcp containment — fail closed", () => {
  test("rejects a ./ command under a symlinked parent with a missing target", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(root, "link"), "dir");
    const result = mapMcpServer(
      { name: "x", type: "stdio", command: "./link/missing-binary" },
      root,
      "/data"
    );
    expect("error" in result).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a cwd under a symlinked parent with a missing target", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(root, "link"), "dir");
    const result = mapMcpServer(
      { name: "x", type: "stdio", command: "node", cwd: "./link/work" },
      root,
      "/data"
    );
    expect("error" in result).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("mcp containment — dangling leaf symlinks", () => {
  test("rejects a ./ command that is a dangling symlink", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.symlinkSync(path.join(dir, "outside-server"), path.join(root, "bin", "server"));
    const result = mapMcpServer(
      { name: "x", type: "stdio", command: "./bin/server" },
      root,
      "/data"
    );
    expect("error" in result).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a cwd that is a dangling symlink", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(path.join(dir, "outside-dir"), path.join(root, "work"));
    const result = mapMcpServer(
      { name: "x", type: "stdio", command: "node", cwd: "./work" },
      root,
      "/data"
    );
    expect("error" in result).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("mcp containment — frozen parent paths", () => {
  test("a ./ command under a symlinked parent is frozen at mapping time", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    const inside = path.join(root, "real");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(inside, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(inside, path.join(root, "link"), "dir");
    writeFile(path.join(inside, "missing"), "#!/bin/sh");
    const result = mapMcpServer(
      { name: "x", type: "stdio", command: "./link/missing" },
      root,
      "/data"
    );
    expect("config" in result).toBe(true);
    if (!("config" in result) || result.config.type !== "local") return;
    const emitted = result.config.command[0];
    expect(emitted).toBe(path.join(fs.realpathSync(inside), "missing"));
    // Retarget the symlink and create the outside target: the emitted path
    // must not follow it.
    fs.rmSync(path.join(root, "link"));
    fs.symlinkSync(outside, path.join(root, "link"), "dir");
    writeFile(path.join(outside, "missing"), "#!/bin/sh");
    expect(emitted).not.toContain(`${path.sep}outside${path.sep}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a cwd under a symlinked parent resolves to a frozen realpath", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    const inside = path.join(root, "real");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(path.join(inside, "work"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(inside, path.join(root, "link"), "dir");
    const result = mapMcpServer(
      { name: "x", type: "stdio", command: "node", cwd: "./link/work" },
      root,
      "/data"
    );
    expect("config" in result).toBe(true);
    if (!("config" in result) || result.config.type !== "local") return;
    const emitted = result.config.cwd;
    expect(emitted).toBe(path.join(fs.realpathSync(inside), "work"));
    fs.rmSync(path.join(root, "link"));
    fs.symlinkSync(outside, path.join(root, "link"), "dir");
    expect(emitted).not.toContain(`${path.sep}outside${path.sep}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a plugin-root cwd that does not exist", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    fs.mkdirSync(root, { recursive: true });
    const result = mapMcpServer(
      { name: "x", type: "stdio", command: "node", cwd: "./missing" },
      root,
      "/data"
    );
    expect("error" in result).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("creates a PLUGIN_DATA cwd when missing", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    const data = path.join(dir, "data");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    const result = mapMcpServer(
      { name: "x", type: "stdio", command: "node", cwd: "${PLUGIN_DATA}/work" },
      root,
      data
    );
    expect("config" in result).toBe(true);
    expect(fs.existsSync(path.join(data, "work"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("mcp containment — regular-file commands", () => {
  test("rejects a ./ command that is a directory", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    const result = mapMcpServer({ name: "x", type: "stdio", command: "./bin" }, root, "/data");
    expect("error" in result).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("mcp mapping — host schema strictness", () => {
  test("remote config omits absent optional fields", () => {
    const result = mapMcpServer(
      { name: "r", type: "streamable-http", url: "https://x.example.com/mcp" },
      "/p",
      "/d"
    );
    expect("config" in result).toBe(true);
    if ("config" in result) {
      expect(Object.keys(result.config).sort()).toEqual(["type", "url"]);
    }
  });
});

describe("cwd — PLUGIN_DATA creation containment", () => {
  test("a symlinked parent cannot create a directory outside PLUGIN_DATA", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    const data = path.join(dir, "data");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(data, "link"), "dir");
    const result = mapMcpServer(
      { name: "x", type: "stdio", command: "node", cwd: "${PLUGIN_DATA}/link/work" },
      root,
      data
    );
    expect("error" in result).toBe(true);
    expect(fs.existsSync(path.join(outside, "work"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a traversal cwd cannot create outside PLUGIN_DATA", () => {
    const dir = makeTempDir();
    const root = path.join(dir, "plugin");
    const data = path.join(dir, "data");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    const result = mapMcpServer(
      { name: "x", type: "stdio", command: "node", cwd: "${PLUGIN_DATA}/../outside" },
      root,
      data
    );
    expect("error" in result).toBe(true);
    expect(fs.existsSync(path.join(dir, "outside"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
