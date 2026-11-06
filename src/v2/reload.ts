/**
 * opencode-agent-plugins — discovery reload.
 *
 * Recomputes directories (including default dirs created after startup),
 * marketplaces, package sources and the managed store, then refreshes the
 * canonical alias map.
 */

import path from "node:path";
import {
  buildDefaultDirectories,
  discoverPluginRoot,
  discoverPlugins,
  findWorktreeRoot,
} from "../discovery.ts";
import { realpathOrNull } from "../fs.ts";
import { logger } from "../log.ts";
import { discoverMarketplaces, listInstalled } from "../marketplace.ts";
import { resolvePackages } from "../packages.ts";
import type { DiscoveryResult } from "../types.ts";
import type { V2Context } from "./host.ts";
import {
  applyOptionSeeds,
  buildAliases,
  buildCanonicalIds,
  normalizeDisabled,
  normalizePersisted,
  type V2State,
} from "./state.ts";
import { loadPersistence } from "./storage.ts";

export function mergeDiscovery(scan: DiscoveryResult, directRoots: string[]): DiscoveryResult {
  const seen = new Set(scan.plugins.map((plugin) => plugin.root));
  for (const entry of scan.rejected) seen.add(entry.root);
  const merged: DiscoveryResult = { plugins: [...scan.plugins], rejected: [...scan.rejected] };
  for (const root of directRoots) {
    const realRoot = realpathOrNull(root);
    if (realRoot === null || seen.has(realRoot)) continue;
    seen.add(realRoot);
    const plugin = discoverPluginRoot(realRoot);
    if (plugin !== null) merged.plugins.push(plugin);
  }
  return merged;
}

export function currentDiscovery(state: V2State): DiscoveryResult {
  const scan = discoverPlugins(state.options.directories);
  const packageDirs = state.packages.flatMap((resolution) =>
    resolution.directory !== undefined ? [resolution.directory] : []
  );
  // The managed store is the durable artifact: even when plugin storage is
  // unavailable or lost, installed copies are discovered from disk.
  const installedDirs = listInstalled(state.options.installRoot).map((name) =>
    path.join(state.options.installRoot, name)
  );
  return mergeDiscovery(scan, [...state.sources, ...packageDirs, ...installedDirs]);
}

export async function reloadState(ctx: V2Context, state: V2State): Promise<void> {
  if (!state.options.directoriesExplicit) {
    state.options.directories = buildDefaultDirectories(state.directory);
  }
  if (state.options.marketplaces) {
    const discovery = discoverMarketplaces(state.directory, findWorktreeRoot(state.directory));
    state.marketplaces = discovery.marketplaces;
    state.marketplaceProblems = discovery.problems;
  } else {
    state.marketplaces = [];
    state.marketplaceProblems = [];
  }
  state.packages = resolvePackages(state.options.packages, state.directory);
  state.discovery = currentDiscovery(state);
  state.aliases = buildAliases(state.discovery);
  state.canonicalIds = buildCanonicalIds(state.discovery);
  const persistence = await loadPersistence(ctx);
  if (persistence.available) {
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
  }
  applyOptionSeeds(state, state.options.enabledMcp);
  state.registeredMcp = [];
  try {
    if (ctx.skill?.reload) await ctx.skill.reload();
  } catch (error) {
    logger.error(`skill reload failed: ${String(error)}`);
  }
  try {
    if (ctx.mcp?.reload) await ctx.mcp.reload();
  } catch (error) {
    logger.error(`MCP reload failed: ${String(error)}`);
  }
}

export function addSource(state: V2State, directory: string): void {
  const real = realpathOrNull(directory) ?? directory;
  if (state.sources.includes(real)) return;
  state.sources.push(real);
}
