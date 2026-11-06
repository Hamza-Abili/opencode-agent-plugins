/**
 * opencode-agent-plugins — v2 application entry.
 *
 * Wires discovery, registration and commands. Every registration step and
 * every per-entry body is isolated so one failure cannot disable the rest.
 */

import fs from "node:fs";
import path from "node:path";
import { collectMcpServers, findWorktreeRoot } from "../discovery.ts";
import { xdgDataHome } from "../fs.ts";
import { logger, setLogLevel } from "../log.ts";
import { cleanupInternalDirs, discoverMarketplaces } from "../marketplace.ts";
import { mapMcpServer } from "../mcp.ts";
import { parseOptions } from "../options.ts";
import { resolvePackages } from "../packages.ts";
import type { OpenCodeMcpConfig } from "../types.ts";
import { registerCommands } from "./commands.ts";
import type { V2Context } from "./host.ts";
import { currentDiscovery } from "./reload.ts";
import {
  applyOptionSeeds,
  buildAliases,
  buildCanonicalIds,
  isMcpEnabled,
  mcpCanonicalId,
  normalizeDisabled,
  normalizePersisted,
  resolveAlias,
  type V2State,
} from "./state.ts";
import { loadPersistence, loadSources, persistState } from "./storage.ts";
import { trace } from "./trace.ts";

async function registerSkills(ctx: V2Context, state: V2State): Promise<void> {
  const skillCtx = ctx.skill;
  if (!skillCtx || typeof skillCtx.transform !== "function") {
    logger.debug("host has no skill.transform surface — skills not registered");
    return;
  }
  if (!state.options.skills) {
    logger.info("skill loading disabled by options");
    return;
  }

  await skillCtx.transform((editor) => {
    try {
      const existing = new Set(editor.list().map((skill) => skill.id));
      for (const plugin of state.discovery.plugins) {
        for (const skill of plugin.skills) {
          try {
            if (existing.has(skill.name)) {
              logger.warn(
                `skill ${JSON.stringify(skill.name)} from plugin ${JSON.stringify(plugin.slug)} collides with an existing skill — user/earlier registration wins`
              );
              continue;
            }
            editor.add({
              id: skill.name,
              name: skill.name,
              description: skill.description,
              path: skill.path,
              content: skill.content,
            });
            existing.add(skill.name);
            logger.debug(`registered skill ${skill.name} from ${plugin.slug}`);
          } catch (error) {
            logger.warn(
              `skill ${skill.name} from ${plugin.slug} failed to register: ${String(error)}`
            );
          }
        }
      }
    } catch (error) {
      logger.error(`skill registration failed: ${String(error)}`);
    }
  });
}

async function registerMcp(ctx: V2Context, state: V2State): Promise<void> {
  const mcpCtx = ctx.mcp;
  if (!mcpCtx || typeof mcpCtx.transform !== "function") {
    logger.debug("host has no mcp.transform surface — MCP servers not registered");
    return;
  }
  if (!state.options.mcp) {
    logger.info("MCP loading disabled by options");
    return;
  }

  const servers = collectMcpServers(state.discovery.plugins, state.options.prefix);
  await mcpCtx.transform((editor) => {
    try {
      // Transforms replay onto a fresh registry: rebuild the tracking list so
      // repeated reloads never accumulate duplicates.
      state.registeredMcp = [];
      for (const entry of servers) {
        try {
          const dataDir = path.join(state.dataRoot, entry.slug);
          ensureDir(dataDir);
          const mapped = mapMcpServer(entry.server, entry.pluginRoot, dataDir);
          if ("error" in mapped) {
            logger.warn(
              `mcp server ${JSON.stringify(entry.name)} from ${JSON.stringify(entry.slug)} skipped: ${mapped.error}`
            );
            continue;
          }
          if (editor.get(entry.name) !== undefined) {
            logger.warn(
              `mcp server ${JSON.stringify(entry.name)} from ${JSON.stringify(entry.slug)} collides with an existing server — user/earlier registration wins`
            );
            continue;
          }
          const canonical = mcpCanonicalId(entry.slug, entry.server.name);
          const short = entry.server.name;
          const enabled = isMcpEnabled(state, canonical);
          trace("mcp:entry", { name: entry.name, canonical, enabled });
          // The v2 transform contract disables servers with `disabled: true`;
          // `enabled` belongs to the v1 config shape only.
          const config: OpenCodeMcpConfig & { disabled: boolean } = {
            ...mapped.config,
            disabled: !enabled,
          };
          editor.set(entry.name, config);
          state.registeredMcp.push({ display: entry.name, canonical, short });
          logger.debug(`registered mcp server ${entry.name} (enabled: ${enabled})`);
        } catch (error) {
          trace("mcp:error", {
            name: entry.name,
            error: error instanceof Error ? error.message : "unknown",
          });
          logger.warn(`mcp server ${entry.name} failed to register: ${String(error)}`);
        }
      }
    } catch (error) {
      logger.error(`MCP registration failed: ${String(error)}`);
    }
  });
}

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    logger.warn(`cannot create plugin data directory ${dir}: ${String(error)}`);
  }
}

export interface V2App {
  dispose(): void;
}

export async function createV2App(ctx: V2Context): Promise<V2App> {
  const directory = ctx.location?.directory ?? process.cwd();
  const options = parseOptions(ctx.options, directory);
  setLogLevel(options.logLevel);

  cleanupInternalDirs(options.installRoot);
  const sources = await loadSources(ctx);
  const packages = resolvePackages(options.packages, directory);
  const marketplaceDiscovery = options.marketplaces
    ? discoverMarketplaces(directory, findWorktreeRoot(directory))
    : { marketplaces: [], problems: [] };

  trace("options", {
    directories: options.directories,
    packages: options.packages,
    marketplaces: options.marketplaces,
  });
  const state: V2State = {
    options,
    directory,
    discovery: { plugins: [], rejected: [] },
    enabledMcp: new Set<string>(),
    persistedEnabled: new Set<string>(),
    persistedDisabled: new Set<string>(),
    registeredMcp: [],
    aliases: new Map(),
    canonicalIds: new Set<string>(),
    dataRoot: path.join(xdgDataHome(), "opencode-agent-plugins", "data"),
    sources,
    marketplaces: marketplaceDiscovery.marketplaces,
    marketplaceProblems: marketplaceDiscovery.problems,
    packages,
  };
  state.discovery = currentDiscovery(state);
  state.aliases = buildAliases(state.discovery);
  state.canonicalIds = buildCanonicalIds(state.discovery);
  const persistence = await loadPersistence(ctx);
  if (persistence.legacy) {
    // Pre-1.2 wrote option seeds into the enabled set. Remove entries that
    // match the current seed so removing the option disables them again.
    // Legacy storage holds the raw option names (not canonical ids): drop
    // every entry that is an option seed or resolves to one.
    const seedCanonicals = new Set(
      options.enabledMcp
        .map((raw) => resolveAlias(state.aliases, raw))
        .filter((canonical): canonical is string => canonical !== null)
    );
    for (const raw of [...persistence.enabled]) {
      const canonical = resolveAlias(state.aliases, raw) ?? raw;
      if (options.enabledMcp.includes(raw) || seedCanonicals.has(canonical)) {
        persistence.enabled.delete(raw);
      }
    }
  }
  state.persistedEnabled = normalizePersisted(
    persistence.enabled,
    state.aliases,
    state.canonicalIds
  );
  state.persistedDisabled = normalizeDisabled(
    persistence.disabled,
    state.aliases,
    state.canonicalIds
  );
  applyOptionSeeds(state, options.enabledMcp);
  if (persistence.legacy && persistence.available) await persistState(ctx, state);
  trace("discovery", {
    plugins: state.discovery.plugins.map((plugin) => ({
      slug: plugin.slug,
      servers: plugin.mcpServers.map((server) => server.name),
      problems: plugin.problems,
    })),
    enabled: [...state.enabledMcp],
  });

  logger.info(
    `loaded (host ${ctx.app?.version ?? "unknown"}); ${options.directories.length} scan directories, ${sources.length} installed source(s), ${packages.length} package(s), ${state.marketplaces.length} marketplace(s)`
  );

  for (const plugin of state.discovery.plugins) {
    logger.info(
      `discovered ${plugin.slug} (${plugin.skills.length} skill(s), ${plugin.mcpServers.length} mcp server(s))`
    );
    for (const problem of plugin.problems) {
      if (problem.level === "error") logger.error(`${plugin.slug}: ${problem.message}`);
      else logger.warn(`${plugin.slug}: ${problem.message}`);
    }
  }
  for (const entry of state.discovery.rejected) {
    for (const problem of entry.problems) {
      logger.error(`${entry.root}: ${problem.message}`);
    }
  }
  for (const resolution of packages) {
    if (resolution.error !== undefined)
      logger.warn(`package ${resolution.packageName}: ${resolution.error}`);
  }

  for (const register of [registerSkills, registerMcp, registerCommands]) {
    try {
      await register(ctx, state);
    } catch (error) {
      logger.error(`registration step ${register.name} failed: ${String(error)}`);
    }
  }

  // MCP transforms are applied lazily by the host; force one reconcile so
  // registration is materialized at startup (same as an explicit reload).
  try {
    if (ctx.mcp?.reload) await ctx.mcp.reload();
  } catch (error) {
    logger.error(`initial MCP reconcile failed: ${String(error)}`);
  }

  return {
    dispose() {
      logger.debug("unloaded");
    },
  };
}

/* ------------------------------ test helpers ------------------------------ */

/** Exported for tests: the canonical enabled identity of an MCP server. */
export { mcpCanonicalId };
