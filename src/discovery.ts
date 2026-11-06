/**
 * opencode-agent-plugins — plugin discovery.
 *
 * Agent Plugins are directories carrying a root `plugin.json`. This module
 * discovers them in the directories handed to it, validates each one, and
 * returns the portable pieces (manifest, skills, MCP servers) plus every
 * non-fatal finding. Directories are scanned one level deep; each directory
 * without a plugin.json is simply not a plugin. Client-specific extension
 * namespaces are not loaded: a package that ships one still contributes its
 * portable components and is reported once for what was left behind.
 */

import fs from "node:fs";
import path from "node:path";
import {
  listEntries,
  lstatOrNull,
  pathExists,
  readJSON,
  realpathOrNull,
  resolvedInside,
} from "./fs.ts";
import { manifestEscapesRoot, validateManifest } from "./manifest.ts";
import { parseMcp } from "./mcp.ts";
import { discoverSkills } from "./skills.ts";
import type {
  DiscoveredPlugin,
  DiscoveryResult,
  McpServer,
  PluginManifest,
  Problem,
} from "./types.ts";

/**
 * Directory scan roots, in precedence order: project-level directories walk
 * up from `cwd` to the git worktree root (nearest first, matching how
 * OpenCode discovers skills), then the global directories. Entries are
 * deduplicated by realpath so the same plugin is never loaded twice.
 */
export function buildDefaultDirectories(cwd: string): string[] {
  const directories: string[] = [];

  const projectRoot = findWorktreeRoot(cwd);
  let current = cwd;
  for (;;) {
    const candidate = path.join(current, ".agents", "plugins");
    if (pathExists(candidate)) directories.push(candidate);
    if (current === projectRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const home = process.env.HOME ?? "";
  const xdgData =
    process.env.XDG_DATA_HOME || (home !== "" ? path.join(home, ".local", "share") : "");
  for (const dir of [
    home !== "" ? path.join(home, ".agents", "plugins") : "",
    xdgData !== "" ? path.join(xdgData, "agents", "plugins") : "",
  ]) {
    if (dir !== "" && pathExists(dir)) directories.push(dir);
  }

  return dedupeByRealpath(directories);
}

/** Walk up from `cwd` to the git worktree root (or the filesystem root). */
export function findWorktreeRoot(cwd: string): string {
  let current = cwd;
  for (;;) {
    if (pathExists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function statSyncOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function dedupeByRealpath(directories: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of directories) {
    const real = realpathOrNull(dir) ?? dir;
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(dir);
  }
  return out;
}

export function discoverPlugins(directories: string[]): DiscoveryResult {
  const result: DiscoveryResult = { plugins: [], rejected: [] };
  const seenRoots = new Set<string>();

  for (const directory of directories) {
    const entries = listEntries(directory);
    if (entries === null) continue;
    for (const entry of entries) {
      if (entry.kind !== "dir") continue;
      const root = path.join(directory, entry.name);
      if (!pathExists(path.join(root, "plugin.json"))) continue;

      const realRoot = realpathOrNull(root);
      if (realRoot === null) continue;
      if (seenRoots.has(realRoot)) continue;
      seenRoots.add(realRoot);

      const plugin = discoverPlugin(realRoot);
      if (plugin === null) {
        result.rejected.push({
          root: realRoot,
          problems: [{ level: "error", message: "plugin could not be read" }],
        });
        continue;
      }
      if (plugin.loaded === undefined) {
        result.rejected.push({ root: realRoot, problems: plugin.problems });
        continue;
      }
      result.plugins.push(plugin.loaded);
    }
  }

  return result;
}

type PluginLoadResult = { loaded?: DiscoveredPlugin; problems: Problem[] };

/**
 * Client-specific extension namespace reserved for OpenCode. The spec lets a
 * package carry per-client behavior here; this client implements the portable
 * core only, so those components are reported once instead of vanishing.
 */
const EXTENSION_NAMESPACE = "ai.opencode";
const EXTENSION_COMPONENTS = new Set([
  "plugin.ts",
  "plugin.js",
  "agents",
  "commands",
  "modes",
  "hooks",
]);

function detectUnloadedExtensions(root: string, problems: Problem[]): void {
  const namespaceDir = path.join(root, EXTENSION_NAMESPACE);
  if (lstatOrNull(namespaceDir) === null) return;

  // Names only: the namespace must resolve to a directory inside the root
  // before it is listed, exactly like every other package path.
  const realNamespace = resolvedInside(namespaceDir, root);
  if (realNamespace === null) {
    problems.push({
      level: "warning",
      message: `${EXTENSION_NAMESPACE} entry is not a directory inside the plugin root — client extensions ignored`,
    });
    return;
  }
  const namespaceStat = statSyncOrNull(realNamespace);
  if (namespaceStat === null || !namespaceStat.isDirectory()) return;

  const entries = listEntries(realNamespace);
  if (entries === null) {
    problems.push({
      level: "warning",
      message: `cannot read ${EXTENSION_NAMESPACE}/ — client extensions ignored`,
    });
    return;
  }
  const present = entries
    .map((entry) => entry.name)
    .filter((name) => EXTENSION_COMPONENTS.has(name))
    .sort();
  if (present.length === 0) return;

  problems.push({
    level: "warning",
    message: `${EXTENSION_NAMESPACE}/ ships ${present.join(", ")} — this client loads skills and MCP servers only (see anomalyco/opencode#40993)`,
  });
}

function discoverPlugin(root: string): PluginLoadResult | null {
  const manifestFile = path.join(root, "plugin.json");
  const problems: Problem[] = [];

  // Containment and file-kind checks run BEFORE any read: a symlink to an
  // outside file (or a FIFO/device) must never be opened.
  const escapeProblem = manifestEscapesRoot(manifestFile, root);
  if (escapeProblem !== null) {
    return { problems: [escapeProblem] };
  }
  const realManifest = realpathOrNull(manifestFile);
  const manifestStat = realManifest === null ? null : statSyncOrNull(realManifest);
  if (manifestStat === null) return null;
  if (!manifestStat.isFile()) {
    return { problems: [{ level: "error", message: "plugin.json is not a regular file" }] };
  }

  const parsed = readJSON(realManifest as string);
  if (parsed.error !== undefined) {
    if (parsed.error.startsWith("cannot read")) return null;
    return { problems: [{ level: "error", message: `plugin.json ${parsed.error}` }] };
  }

  const validated = validateManifest(parsed.value);
  problems.push(...validated.problems);
  if (validated.manifest === undefined) {
    return { problems };
  }

  const skillsResult = discoverSkills(root);
  problems.push(...skillsResult.problems);

  const mcpResult = parseMcp(root);
  problems.push(...mcpResult.problems);

  detectUnloadedExtensions(root, problems);

  const manifest: PluginManifest = validated.manifest;
  return {
    loaded: {
      root,
      slug: manifest.name,
      manifest,
      skills: skillsResult.skills,
      mcpServers: mcpResult.servers,
      problems,
    },
    problems: [],
  };
}

/** Load a single plugin directory directly (used for installed sources). */
export function discoverPluginRoot(root: string): DiscoveredPlugin | null {
  const realRoot = realpathOrNull(root);
  if (realRoot === null) return null;
  const result = discoverPlugin(realRoot);
  return result?.loaded ?? null;
}

/** Stable, deduplicated list of MCP servers across all discovered plugins. */
export function collectMcpServers(
  plugins: DiscoveredPlugin[],
  prefix: boolean
): { server: McpServer; name: string; pluginRoot: string; slug: string }[] {
  const out: { server: McpServer; name: string; pluginRoot: string; slug: string }[] = [];
  for (const plugin of plugins) {
    for (const server of plugin.mcpServers) {
      out.push({
        server,
        name: prefix ? `${plugin.slug}-${server.name}` : server.name,
        pluginRoot: plugin.root,
        slug: plugin.slug,
      });
    }
  }
  return out;
}
