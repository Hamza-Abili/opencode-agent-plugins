/**
 * opencode-agent-plugins — options resolution.
 *
 * OpenCode v2 passes plugin options through the object form of the plugins
 * entry; OpenCode v1 has no per-plugin options, so the v1 adapter derives
 * them from environment variables instead. Both land on the same typed
 * `PluginOptions`, so the shared core never sees the difference.
 */

import path from "node:path";
import { buildDefaultDirectories } from "./discovery.ts";
import { xdgDataHome } from "./fs.ts";
import type { LogLevel, PluginOptions } from "./types.ts";
import { DEFAULT_OPTIONS, LOG_LEVELS } from "./types.ts";

function defaultInstallRoot(): string {
  return path.join(xdgDataHome(), "opencode-agent-plugins", "installed");
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
  }
  if (typeof value === "string") {
    return value
      .split(path.delimiter)
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asLogLevel(value: unknown): LogLevel | undefined {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value)
    ? (value as LogLevel)
    : undefined;
}

/**
 * Resolve options from the v2 plugin options object. Unknown or malformed
 * values fall back to defaults (never throw at plugin load).
 */
export function parseOptions(raw: unknown, cwd: string): PluginOptions {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

  const configured = asStringArray(record.directories) ?? [];
  const directories = configured.length > 0 ? configured : buildDefaultDirectories(cwd);

  return {
    directories,
    directoriesExplicit: configured.length > 0,
    skills: asBoolean(record.skills) ?? DEFAULT_OPTIONS.skills,
    mcp: asBoolean(record.mcp) ?? DEFAULT_OPTIONS.mcp,
    prefix: asBoolean(record.prefix) ?? DEFAULT_OPTIONS.prefix,
    enabledMcp: asStringArray(record.enabledMcp) ?? [],
    logLevel: asLogLevel(record.logLevel) ?? DEFAULT_OPTIONS.logLevel,
    packages: asStringArray(record.packages) ?? [],
    marketplaces: asBoolean(record.marketplaces) ?? DEFAULT_OPTIONS.marketplaces,
    installRoot:
      typeof record.installRoot === "string" && record.installRoot !== ""
        ? record.installRoot
        : defaultInstallRoot(),
  };
}

/** Resolve options from environment variables (OpenCode v1 path). */
export function parseEnvOptions(cwd: string): PluginOptions {
  const env = process.env;
  const directories: string[] = [];
  const envDirs = env.AGENT_PLUGINS_DIRS;
  if (envDirs !== undefined && envDirs.trim() !== "") {
    directories.push(
      ...envDirs
        .split(path.delimiter)
        .map((item) => item.trim())
        .filter((item) => item !== "")
    );
  }
  const explicit = directories.length > 0;
  if (directories.length === 0) {
    directories.push(...buildDefaultDirectories(cwd));
  }

  const booleanEnv = (name: string, fallback: boolean): boolean => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    const lowered = value.toLowerCase();
    if (lowered === "1" || lowered === "true" || lowered === "yes") return true;
    if (lowered === "0" || lowered === "false" || lowered === "no") return false;
    return fallback;
  };

  return {
    directories,
    directoriesExplicit: explicit,
    skills: booleanEnv("AGENT_PLUGINS_SKILLS", DEFAULT_OPTIONS.skills),
    mcp: booleanEnv("AGENT_PLUGINS_MCP", DEFAULT_OPTIONS.mcp),
    prefix: booleanEnv("AGENT_PLUGINS_PREFIX", DEFAULT_OPTIONS.prefix),
    enabledMcp: asStringArray(env.AGENT_PLUGINS_ENABLED_MCP) ?? [],
    logLevel: asLogLevel(env.AGENT_PLUGINS_LOG_LEVEL) ?? DEFAULT_OPTIONS.logLevel,
    packages: asStringArray(env.AGENT_PLUGINS_PACKAGES) ?? [],
    marketplaces: booleanEnv("AGENT_PLUGINS_MARKETPLACES", DEFAULT_OPTIONS.marketplaces),
    installRoot:
      env.AGENT_PLUGINS_INSTALL_ROOT !== undefined && env.AGENT_PLUGINS_INSTALL_ROOT !== ""
        ? env.AGENT_PLUGINS_INSTALL_ROOT
        : defaultInstallRoot(),
  };
}
