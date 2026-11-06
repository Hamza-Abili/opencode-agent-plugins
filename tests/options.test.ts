import { describe, expect, test } from "bun:test";
import path from "node:path";
import { parseEnvOptions, parseOptions } from "../src/options.ts";

describe("parseOptions (v2)", () => {
  test("defaults are stable", () => {
    const options = parseOptions({}, "/tmp/project");
    expect(options.skills).toBe(true);
    expect(options.mcp).toBe(true);
    expect(options.prefix).toBe(false);
    expect(options.logLevel).toBe("info");
    expect(options.enabledMcp).toEqual([]);
    expect(options.packages).toEqual([]);
    expect(options.marketplaces).toBe(true);
    expect(options.installRoot).toContain("opencode-agent-plugins");
    expect(Array.isArray(options.directories)).toBe(true);
  });

  test("accepts packages, marketplaces and installRoot", () => {
    const options = parseOptions(
      {
        packages: ["@acme/agent-plugin"],
        marketplaces: false,
        installRoot: "/custom/installed",
      },
      "/tmp/project"
    );
    expect(options.packages).toEqual(["@acme/agent-plugin"]);
    expect(options.marketplaces).toBe(false);
    expect(options.installRoot).toBe("/custom/installed");
  });

  test("accepts arrays, strings and booleans", () => {
    const options = parseOptions(
      {
        directories: ["/a", "/b"],
        skills: false,
        mcp: false,
        prefix: true,
        enabledMcp: ["x"],
        logLevel: "debug",
      },
      "/tmp/project"
    );
    expect(options.directories).toEqual(["/a", "/b"]);
    expect(options.skills).toBe(false);
    expect(options.mcp).toBe(false);
    expect(options.prefix).toBe(true);
    expect(options.enabledMcp).toEqual(["x"]);
    expect(options.logLevel).toBe("debug");
  });

  test("splits a pathsep-separated directories string", () => {
    const options = parseOptions({ directories: `/a${path.delimiter}/b` }, "/tmp/project");
    expect(options.directories).toEqual(["/a", "/b"]);
  });

  test("falls back to defaults for malformed values", () => {
    const options = parseOptions(
      { skills: "yes", mcp: 1, prefix: "true", logLevel: "loud", enabledMcp: 5 },
      "/tmp/project"
    );
    expect(options.skills).toBe(true);
    expect(options.mcp).toBe(true);
    expect(options.prefix).toBe(false);
    expect(options.logLevel).toBe("info");
    expect(options.enabledMcp).toEqual([]);
  });

  test("handles a non-object options value", () => {
    const options = parseOptions("not-an-object", "/tmp/project");
    expect(options.skills).toBe(true);
    expect(Array.isArray(options.directories)).toBe(true);
  });
});

describe("parseEnvOptions (v1)", () => {
  const original = process.env;

  test("reads directories and toggles from the environment", () => {
    process.env.AGENT_PLUGINS_DIRS = `/a${path.delimiter}/b`;
    process.env.AGENT_PLUGINS_PREFIX = "1";
    process.env.AGENT_PLUGINS_SKILLS = "0";
    process.env.AGENT_PLUGINS_LOG_LEVEL = "warn";
    try {
      const options = parseEnvOptions("/tmp/project");
      expect(options.directories).toEqual(["/a", "/b"]);
      expect(options.prefix).toBe(true);
      expect(options.skills).toBe(false);
      expect(options.logLevel).toBe("warn");
    } finally {
      process.env = original;
    }
  });

  test("falls back to defaults without environment variables", () => {
    process.env = { PATH: process.env.PATH ?? "" };
    try {
      const options = parseEnvOptions("/tmp/project");
      expect(Array.isArray(options.directories)).toBe(true);
      expect(options.skills).toBe(true);
      expect(options.prefix).toBe(false);
    } finally {
      process.env = original;
    }
  });

  test("ignores malformed boolean values", () => {
    process.env.AGENT_PLUGINS_PREFIX = "perhaps";
    try {
      expect(parseEnvOptions("/tmp/project").prefix).toBe(false);
    } finally {
      process.env = original;
    }
  });
});

describe("isInside", () => {
  test("handles the filesystem root and prefix collisions", async () => {
    const { isInside } = await import("../src/fs.ts");
    expect(isInside("/tmp", "/")).toBe(true);
    expect(isInside("/rooted", "/root")).toBe(false);
    expect(isInside("/root/x", "/root")).toBe(true);
  });
});
