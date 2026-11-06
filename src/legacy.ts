/**
 * opencode-agent-plugins — OpenCode v1 (pre-2.0) adapter.
 *
 * v1 has no plugin transforms, so portable pieces are delivered the only
 * way v1 understands them:
 *
 * - **Skills** — v1 discovers `~/.config/opencode/skills/<name>/SKILL.md`.
 *   This adapter materializes one symlink per discovered skill into that
 *   directory, reconciled against a state file that records exactly which
 *   links it owns. It never touches a user directory or a foreign symlink,
 *   and it replaces its own link when a skill's source changes.
 * - **MCP servers** — v1 plugins cannot inject config, and this adapter
 *   never edits user configuration implicitly. Each stdio/remote server is
 *   logged with a ready-to-paste config snippet carrying `enabled: false`;
 *   the user opts in by adding it themselves.
 *
 * Configuration on v1 is environment-driven (v1 has no per-plugin options):
 *   AGENT_PLUGINS_DIRS       — pathsep-separated plugin directories
 *   AGENT_PLUGINS_PACKAGES   — pathsep-separated npm package names
 *   AGENT_PLUGINS_DISABLED   — "1"/"true" disables the loader entirely
 *   AGENT_PLUGINS_SKILLS     — "0"/"false" disables the skill symlink farm
 *   AGENT_PLUGINS_MCP        — "0"/"false" disables the MCP opt-in snippet
 *   AGENT_PLUGINS_PREFIX     — "1"/"true" prefixes snippet server names
 *   AGENT_PLUGINS_LOG_LEVEL  — debug|info|warn|error
 *   AGENT_PLUGINS_SKILLS_DIR — override the skill symlink directory
 *
 * Marketplace installation is v2-only (requires `/ap` commands).
 *
 * Loaded from the `./legacy` package export:
 *   opencode.json (v1): { "plugin": ["@hamzaabili/opencode-agent-plugins/legacy"] }
 */

import fs from "node:fs";
import path from "node:path";
import { discoverPluginRoot, discoverPlugins } from "./discovery.ts";
import { isInside, realpathOrNull, xdgConfigHome, xdgDataHome } from "./fs.ts";
import { logger, setLogLevel } from "./log.ts";
import { mapMcpServer } from "./mcp.ts";
import { parseEnvOptions } from "./options.ts";
import { resolvePackages } from "./packages.ts";
import type { DiscoveredPlugin, DiscoveryResult } from "./types.ts";

/** Minimal opencode v1 plugin input (extra fields ignored). */
export interface V1PluginInput {
  directory?: unknown;
  worktree?: unknown;
  client?: unknown;
}

interface SkillFarmState {
  /** skill name → absolute source path for the current directory. */
  skills: Record<string, string>;
  /** Directory the current links live in (survives env changes). */
  skillsDir?: string;
  /**
   * Ownership per directory: changing AGENT_PLUGINS_SKILLS_DIR must not
   * orphan links farmed in a previous location.
   */
  farms?: Record<string, Record<string, string>>;
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function skillsDirFromEnv(): string {
  const override = process.env.AGENT_PLUGINS_SKILLS_DIR;
  if (override !== undefined && override.trim() !== "") return override;
  return path.join(xdgConfigHome(), "opencode", "skills");
}

function stateFileFromEnv(): string {
  // Durable ownership record: cache cleaners must not orphan farmed links.
  return path.join(xdgDataHome(), "opencode-agent-plugins", "v1-skills.json");
}

function readState(file: string): SkillFarmState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as SkillFarmState).skills === "object"
    ) {
      const skills: Record<string, string> = {};
      for (const [name, source] of Object.entries((parsed as SkillFarmState).skills)) {
        // State names are path segments: reject anything that is not a skill
        // name before it ever reaches path.join.
        if (SKILL_NAME_PATTERN.test(name) && typeof source === "string") skills[name] = source;
      }
      const skillsDir =
        typeof (parsed as SkillFarmState).skillsDir === "string"
          ? (parsed as SkillFarmState).skillsDir
          : undefined;
      const farms: Record<string, Record<string, string>> = {};
      const rawFarms = (parsed as SkillFarmState).farms;
      if (typeof rawFarms === "object" && rawFarms !== null) {
        for (const [dir, owned] of Object.entries(rawFarms)) {
          if (typeof dir !== "string" || typeof owned !== "object" || owned === null) continue;
          const safe: Record<string, string> = {};
          for (const [name, source] of Object.entries(owned)) {
            if (SKILL_NAME_PATTERN.test(name) && typeof source === "string") safe[name] = source;
          }
          if (Object.keys(safe).length > 0) farms[dir] = safe;
        }
      } else if (skillsDir !== undefined && Object.keys(skills).length > 0) {
        farms[skillsDir] = skills;
      }
      return { skills, skillsDir, farms };
    }
  } catch {
    // missing or corrupt state: start from an empty manifest
  }
  return { skills: {} };
}

function writeState(
  file: string,
  farms: Record<string, Record<string, string>>,
  currentDir: string
): void {
  try {
    const state: SkillFarmState = {
      skills: farms[currentDir] ?? {},
      skillsDir: currentDir,
      farms,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, file);
  } catch (error) {
    logger.warn(`cannot write skill farm state: ${String(error)}`);
  }
}

function readlinkOrNull(target: string): string | null {
  try {
    return fs.readlinkSync(target);
  } catch {
    return null;
  }
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/**
 * True when `target` is a symlink previously recorded in the state file.
 * Dangling links are owned too: readlink still returns the recorded path.
 */
function isOwned(previous: SkillFarmState, name: string, target: string): boolean {
  const recorded = previous.skills[name];
  if (recorded === undefined) return false;
  const link = readlinkOrNull(target);
  if (link === null) return false;
  if (link === recorded) return true;
  const linkedReal = realpathOrNull(target);
  const recordedReal = realpathOrNull(recorded);
  return linkedReal !== null && recordedReal !== null && linkedReal === recordedReal;
}

/**
 * Reconcile the skill symlink farm:
 * - create missing symlinks for currently discovered skills,
 * - replace a link this plugin owns when the skill source changed,
 * - never touch a real directory, a foreign symlink, or an untracked link,
 * - remove stale links recorded in the previous state (dangling included).
 *
 * Returns the state of the links this plugin owns after reconciliation.
 */
export function reconcileSkillFarm(
  previous: SkillFarmState,
  current: Map<string, string>,
  skillsDir: string
): SkillFarmState {
  const owned: Record<string, string> = {};

  try {
    fs.mkdirSync(skillsDir, { recursive: true });
  } catch (error) {
    logger.error(`cannot create skills directory ${skillsDir}: ${String(error)}`);
    // Keep the previous ownership record: losing it would orphan our links.
    return { skills: { ...previous.skills } };
  }

  for (const [name, source] of current) {
    if (!SKILL_NAME_PATTERN.test(name)) {
      logger.warn(`skill ${JSON.stringify(name)}: invalid name — skipped`);
      continue;
    }
    const target = path.join(skillsDir, name);
    const existing = lstatOrNull(target);

    if (existing !== null) {
      const link = readlinkOrNull(target);
      if (link === null) {
        logger.warn(
          `skill ${JSON.stringify(name)}: ${target} exists and is not a symlink — user entry wins, skipped`
        );
        continue;
      }
      if (!isOwned(previous, name, target)) {
        logger.warn(
          `skill ${JSON.stringify(name)}: symlink is not managed by this plugin — left untouched`
        );
        continue;
      }
      const linkedReal = realpathOrNull(target);
      const sourceReal = realpathOrNull(source);
      if (linkedReal !== null && sourceReal !== null && linkedReal === sourceReal) {
        owned[name] = source;
        continue;
      }
      // Ours, but the source moved: replace the link.
      try {
        fs.rmSync(target);
      } catch (error) {
        logger.warn(`skill ${JSON.stringify(name)}: cannot replace old symlink: ${String(error)}`);
        // Keep ownership so a later run (with permissions) can retry.
        owned[name] = previous.skills[name];
        continue;
      }
    }

    try {
      fs.symlinkSync(source, target, "dir");
      owned[name] = source;
      logger.info(`skill ${JSON.stringify(name)} → ${target}`);
    } catch (error) {
      logger.warn(`skill ${JSON.stringify(name)}: symlink failed: ${String(error)}`);
    }
  }

  for (const name of Object.keys(previous.skills)) {
    if (owned[name] !== undefined) continue;
    if (!SKILL_NAME_PATTERN.test(name)) continue;
    const target = path.join(skillsDir, name);
    const existing = lstatOrNull(target);
    if (existing === null) continue; // already gone
    const link = readlinkOrNull(target);
    if (link === null) {
      logger.warn(
        `stale skill ${JSON.stringify(name)}: ${target} is not a symlink — left untouched`
      );
      continue;
    }
    if (isOwned(previous, name, target)) {
      try {
        fs.rmSync(target);
        logger.info(`removed stale skill symlink ${JSON.stringify(name)}`);
      } catch (error) {
        logger.warn(`cannot remove stale skill symlink ${target}: ${String(error)}`);
        // Keep ownership so the next cleanup attempt can finish the job.
        owned[name] = previous.skills[name];
      }
    } else {
      logger.warn(`stale skill ${JSON.stringify(name)}: symlink changed — left untouched`);
    }
  }

  return { skills: owned };
}

/**
 * Remove every skill link this plugin owns. Used by the kill switches so a
 * disabled loader never leaves farmed skills active in OpenCode's discovery.
 */
function cleanupSkillFarm(): void {
  const currentDir = skillsDirFromEnv();
  const stateFile = stateFileFromEnv();
  const previous = readState(stateFile);
  const farms: Record<string, Record<string, string>> = { ...(previous.farms ?? {}) };
  if (previous.skillsDir !== undefined && Object.keys(previous.skills).length > 0) {
    farms[previous.skillsDir] = { ...(farms[previous.skillsDir] ?? {}), ...previous.skills };
  }

  // Clean every directory links are known to live in; failed removals stay
  // recorded under their own directory so a later run can retry.
  for (const dir of Object.keys(farms)) {
    const result = reconcileSkillFarm({ skills: farms[dir], skillsDir: dir }, new Map(), dir);
    if (Object.keys(result.skills).length === 0) delete farms[dir];
    else farms[dir] = result.skills;
  }
  writeState(stateFile, farms, currentDir);
}

/**
 * Build the OpenCode config snippet suggested for v1 MCP opt-in. Every
 * discovered server is rendered as a concrete `mcp` entry with
 * `enabled: false` — the user opts in by copying the block and flipping
 * the flag; this adapter never edits user configuration by itself.
 * Duplicate names across plugins keep the first entry (v2 behaves the same).
 * Exported for tests.
 */
export function mcpSnippet(plugins: DiscoveredPlugin[], prefix: boolean): string {
  const dataRoot = path.join(xdgDataHome(), "opencode-agent-plugins", "data");
  const seen = new Set<string>();
  const entries: string[] = [];

  for (const plugin of plugins) {
    for (const server of plugin.mcpServers) {
      const display = prefix ? `${plugin.slug}-${server.name}` : server.name;
      if (seen.has(display)) {
        logger.warn(
          `mcp server ${JSON.stringify(display)} appears in multiple plugins — snippet keeps the first`
        );
        continue;
      }
      seen.add(display);

      const dataDir = path.join(dataRoot, plugin.slug);
      // Create PLUGIN_DATA before mapping: a `${PLUGIN_DATA}` cwd must
      // resolve against a directory that already exists.
      if (server.type === "stdio") {
        try {
          fs.mkdirSync(dataDir, { recursive: true });
        } catch (error) {
          logger.warn(`cannot create plugin data directory ${dataDir}: ${String(error)}`);
        }
      }
      const mapped = mapMcpServer(server, plugin.root, dataDir);
      if ("error" in mapped) {
        logger.warn(`mcp server ${JSON.stringify(display)} skipped in snippet: ${mapped.error}`);
        continue;
      }
      const config = mapped.config;
      const body =
        config.type === "local"
          ? {
              type: "local",
              command: config.command,
              environment: config.environment,
              cwd: config.cwd,
            }
          : { type: "remote", url: config.url, headers: config.headers };
      const rendered = JSON.stringify({ ...body, enabled: false }, null, 2).replaceAll(
        "\n",
        "\n    "
      );
      entries.push(`    ${JSON.stringify(display)}: ${rendered}`);
    }
  }

  if (entries.length === 0) return "";
  return (
    "v1 cannot auto-register MCP servers (plugins cannot inject config). " +
    "Opt in by adding this block to your opencode.json under `mcp` (flip `enabled` to true per server):\n" +
    "{\n" +
    '  "mcp": {\n' +
    `${entries.join(",\n")}\n` +
    "  }\n" +
    "}"
  );
}

/** Merge direct plugin roots (installed sources / npm packages) into discovery. */
function mergeDirectRoots(discovery: DiscoveryResult, roots: string[]): DiscoveryResult {
  const seen = new Set(discovery.plugins.map((plugin) => plugin.root));
  const merged: DiscoveryResult = {
    plugins: [...discovery.plugins],
    rejected: [...discovery.rejected],
  };
  for (const root of roots) {
    const real = realpathOrNull(root);
    if (real === null || seen.has(real)) continue;
    const plugin = discoverPluginRoot(real);
    if (plugin !== null) {
      seen.add(real);
      merged.plugins.push(plugin);
    } else {
      logger.warn(`package directory ${real} does not contain a valid Agent Plugin`);
    }
  }
  return merged;
}

/** Default export for the `./legacy` subpath: a v1 plugin factory. */
export default function createLegacyPlugin(input: V1PluginInput): Record<string, never> {
  const disabled = process.env.AGENT_PLUGINS_DISABLED;
  if (disabled !== undefined && ["1", "true", "yes"].includes(disabled.toLowerCase())) {
    logger.info("disabled via AGENT_PLUGINS_DISABLED");
    try {
      cleanupSkillFarm();
    } catch (error) {
      logger.warn(`cannot clean the skill farm while disabled: ${String(error)}`);
    }
    return {};
  }

  const directory =
    typeof input.directory === "string" && input.directory !== ""
      ? input.directory
      : typeof input.worktree === "string" && input.worktree !== ""
        ? input.worktree
        : process.cwd();

  try {
    const options = parseEnvOptions(directory);
    setLogLevel(options.logLevel);

    const packages = resolvePackages(options.packages, directory);
    for (const resolution of packages) {
      if (resolution.error !== undefined)
        logger.warn(`package ${resolution.packageName}: ${resolution.error}`);
    }
    const packageDirs = packages.flatMap((resolution) =>
      resolution.directory !== undefined ? [resolution.directory] : []
    );

    logger.info(`v1 adapter loaded; scanning ${options.directories.length} directories`);
    const discovery = mergeDirectRoots(discoverPlugins(options.directories), packageDirs);

    for (const plugin of discovery.plugins) {
      logger.info(
        `discovered ${plugin.slug} (${plugin.skills.length} skill(s), ${plugin.mcpServers.length} mcp server(s))`
      );
      for (const problem of plugin.problems) {
        if (problem.level === "error") logger.error(`${plugin.slug}: ${problem.message}`);
        else logger.warn(`${plugin.slug}: ${problem.message}`);
      }
    }
    for (const entry of discovery.rejected) {
      for (const problem of entry.problems) {
        logger.error(`${entry.root}: ${problem.message}`);
      }
    }

    if (!options.skills) {
      try {
        cleanupSkillFarm();
      } catch (error) {
        logger.warn(`cannot clean the skill farm with skills disabled: ${String(error)}`);
      }
    } else {
      const skillsDir = skillsDirFromEnv();
      const stateFile = stateFileFromEnv();
      const previous = readState(stateFile);

      const current = new Map<string, string>();
      const seen = new Set<string>();
      for (const plugin of discovery.plugins) {
        for (const skill of plugin.skills) {
          if (seen.has(skill.name)) {
            logger.warn(
              `skill ${JSON.stringify(skill.name)} appears in multiple plugins — first wins`
            );
            continue;
          }
          seen.add(skill.name);
          const sourceDir = path.dirname(skill.path);
          if (isInside(sourceDir, plugin.root)) current.set(skill.name, sourceDir);
        }
      }

      const farms: Record<string, Record<string, string>> = { ...(previous.farms ?? {}) };
      if (previous.skillsDir !== undefined && Object.keys(previous.skills).length > 0) {
        farms[previous.skillsDir] = { ...(farms[previous.skillsDir] ?? {}), ...previous.skills };
      }
      // A changed AGENT_PLUGINS_SKILLS_DIR must not orphan links farmed in
      // the previous location: clean them before farming the new directory.
      for (const dir of Object.keys(farms)) {
        if (dir === skillsDir) continue;
        const result = reconcileSkillFarm({ skills: farms[dir], skillsDir: dir }, new Map(), dir);
        if (Object.keys(result.skills).length === 0) delete farms[dir];
        else farms[dir] = result.skills;
      }
      const owned = reconcileSkillFarm(
        { skills: farms[skillsDir] ?? {}, skillsDir },
        current,
        skillsDir
      );
      if (Object.keys(owned.skills).length === 0) delete farms[skillsDir];
      else farms[skillsDir] = owned.skills;
      writeState(stateFile, farms, skillsDir);
    }

    const mcpCount = discovery.plugins.reduce((sum, plugin) => sum + plugin.mcpServers.length, 0);
    if (mcpCount > 0 && options.mcp) {
      const snippet = mcpSnippet(discovery.plugins, options.prefix);
      if (snippet !== "") logger.info(`${mcpCount} MCP server(s) discovered.\n${snippet}`);
    } else if (mcpCount > 0) {
      logger.debug("MCP disabled by AGENT_PLUGINS_MCP — snippet not generated");
    }
  } catch (error) {
    // Never break the host at plugin-load time (v1 hosts treat factory
    // exceptions as plugin failures).
    logger.error(`v1 start failed: ${String(error)}`);
  }

  return {};
}
