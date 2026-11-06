/**
 * opencode-agent-plugins — `/ap` commands.
 *
 * The command layer owns user-facing actions: status, enable/disable,
 * marketplace install/update/uninstall and reload. Installs run only here,
 * from an explicit command.
 */

import path from "node:path";
import { discoverPluginRoot } from "../discovery.ts";
import { realpathOrNull } from "../fs.ts";
import { logger } from "../log.ts";
import {
  type Installer,
  installEntry,
  type Marketplace,
  type MarketplaceEntry,
  readProvenance,
  uninstallEntry,
  updateEntry,
} from "../marketplace.ts";
import { resolveNpmSource } from "../packages.ts";
import { HELP_TEXT, listText, marketplaceText, packagesText, statusText } from "./format.ts";
import { runGit } from "./git.ts";
import type { V2Context } from "./host.ts";
import { addSource, reloadState } from "./reload.ts";
import type { RegisteredMcp, V2State } from "./state.ts";
import { persistSources, persistState } from "./storage.ts";

export async function registerCommands(ctx: V2Context, state: V2State): Promise<void> {
  const commandCtx = ctx.command;
  if (!commandCtx || typeof commandCtx.transform !== "function") {
    logger.debug("host has no command.transform surface — /ap commands not registered");
    return;
  }

  await commandCtx.transform((editor) => {
    try {
      editor.add({
        name: "ap",
        description:
          "Agent Plugins: status, enable/disable MCP, marketplace install/update/uninstall, packages, reload",
        execute: async (input) => {
          try {
            const text = await runCommand(ctx, state, input.sessionID, input.prompt.text);
            await respond(ctx, input.sessionID, text);
          } catch (error) {
            logger.error(`/ap failed: ${String(error)}`);
          }
        },
      });
    } catch (error) {
      logger.error(`command registration failed: ${String(error)}`);
    }
  });
}

async function respond(ctx: V2Context, sessionID: string, text: string): Promise<void> {
  if (typeof sessionID === "string" && sessionID !== "" && ctx.session?.synthetic) {
    await ctx.session.synthetic({ sessionID, text });
    return;
  }
  console.log(text);
}

async function runCommand(
  ctx: V2Context,
  state: V2State,
  _sessionID: string,
  raw: string
): Promise<string> {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
  const sub = tokens[0] ?? "";
  const argument = tokens[1] ?? "";

  switch (sub) {
    case "":
    case "help":
      return HELP_TEXT;
    case "status":
      return statusText(state);
    case "list":
      return listText(state);
    case "enable":
      return toggle(ctx, state, argument, true);
    case "disable":
      return toggle(ctx, state, argument, false);
    case "reload":
      return reload(ctx, state);
    case "marketplace":
      return marketplaceText(state);
    case "install":
      return installCommand(ctx, state, argument);
    case "update":
      return updateCommand(ctx, state, argument);
    case "uninstall":
      return uninstallCommand(ctx, state, argument);
    case "packages":
      return packagesText(state);
    default:
      return `Unknown /ap command ${JSON.stringify(sub)}.\n\n${HELP_TEXT}`;
  }
}

function findMcpTargets(state: V2State, argument: string): RegisteredMcp[] {
  if (argument === "") return [];
  const exact = state.registeredMcp.filter(
    (entry) =>
      entry.display === argument || entry.canonical === argument || entry.short === argument
  );
  if (exact.length > 0) return exact;
  return state.registeredMcp.filter(
    (entry) => entry.display.endsWith(`-${argument}`) || entry.canonical.endsWith(`::${argument}`)
  );
}

async function toggle(
  ctx: V2Context,
  state: V2State,
  argument: string,
  enable: boolean
): Promise<string> {
  if (argument === "") {
    return "Usage: /ap enable <mcp-server> or /ap disable <mcp-server>. Run /ap status for names.";
  }
  const targets = findMcpTargets(state, argument);
  if (targets.length === 0) {
    return `Unknown MCP server ${JSON.stringify(argument)} — run /ap status for the registered names.`;
  }
  if (targets.length > 1) {
    const names = targets.map((target) => target.display).join(", ");
    return `Ambiguous MCP server ${JSON.stringify(argument)} — matches: ${names}. Use the full name.`;
  }
  const target = targets[0];
  // Remove every stored form that resolves to this canonical server.
  for (const stored of [...state.enabledMcp]) {
    const matches = state.aliases.get(stored);
    if (
      stored === target.canonical ||
      (matches !== undefined && matches.size === 1 && matches.has(target.canonical))
    ) {
      state.enabledMcp.delete(stored);
    }
  }
  if (enable) {
    state.persistedDisabled.delete(target.canonical);
    state.persistedEnabled.add(target.canonical);
    state.enabledMcp.add(target.canonical);
    await persistState(ctx, state);
  } else {
    state.persistedEnabled.delete(target.canonical);
    state.persistedDisabled.add(target.canonical);
    state.enabledMcp.delete(target.canonical);
    await persistState(ctx, state);
  }
  if (ctx.mcp?.reload) {
    await ctx.mcp.reload();
  } else {
    logger.debug("host has no mcp.reload surface — changes apply on next startup");
  }
  return `MCP server ${JSON.stringify(target.display)} ${enable ? "enabled" : "disabled"}.`;
}

function findEntry(
  state: V2State,
  name: string
): { marketplace: Marketplace; entry: MarketplaceEntry } | null {
  for (const marketplace of state.marketplaces) {
    const entry = marketplace.entries.find((candidate) => candidate.name === name);
    if (entry !== undefined) return { marketplace, entry };
  }
  return null;
}

function createInstaller(state: V2State): Installer {
  return {
    storeRoot: state.options.installRoot,
    projectDir: state.directory,
    git: runGit,
  };
}

async function installCommand(ctx: V2Context, state: V2State, name: string): Promise<string> {
  if (name === "") return "Usage: /ap install <plugin>. Run /ap marketplace for available entries.";
  const found = findEntry(state, name);
  if (found === null) {
    const available = state.marketplaces.flatMap((marketplace) =>
      marketplace.entries.map((entry) => entry.name)
    );
    return available.length === 0
      ? `Unknown plugin ${JSON.stringify(name)} — no marketplace catalogs found.`
      : `Unknown plugin ${JSON.stringify(name)}. Available: ${available.join(", ")}`;
  }
  const result = await installEntry(createInstaller(state), found.marketplace, found.entry);
  if (!result.ok || result.directory === undefined) return `Install failed: ${result.message}`;
  addSource(state, result.directory);
  await persistSources(ctx, state);
  await reloadState(ctx, state);
  return `**Installed ${name}**\n${result.message}\n\n${statusText(state)}`;
}

async function updateCommand(ctx: V2Context, state: V2State, name: string): Promise<string> {
  if (name === "") return "Usage: /ap update <plugin>.";
  const provenance = readProvenance(state.options.installRoot, name);
  if (provenance === null) {
    return `${JSON.stringify(name)} is not a managed git install (local and npm sources are updated by their owner).`;
  }
  const found = findEntry(state, name);
  if (found === null) {
    return `No marketplace entry named ${JSON.stringify(name)} is available to update from.`;
  }
  const result = await updateEntry(createInstaller(state), found.marketplace, found.entry);
  if (!result.ok || result.directory === undefined) {
    return `Update failed (old install untouched): ${result.message}`;
  }
  addSource(state, result.directory);
  await persistSources(ctx, state);
  await reloadState(ctx, state);
  const from = (result.previousCommit ?? provenance.commit).slice(0, 12);
  const to = (result.commit ?? "unknown").slice(0, 12);
  return `**Updated ${name}**\n${from} → ${to}\n${result.message}`;
}

async function uninstallCommand(ctx: V2Context, state: V2State, name: string): Promise<string> {
  if (name === "") return "Usage: /ap uninstall <plugin>.";
  const removal = uninstallEntry(state.options.installRoot, name);
  if (removal.ok) {
    state.sources = state.sources.filter((source) => path.basename(source) !== name);
    await persistSources(ctx, state);
    await reloadState(ctx, state);
    return `**Uninstalled ${name}**\n${removal.message}`;
  }
  // Local and npm sources are owned by the marketplace/package manager: drop
  // the registration, never delete the directory. Match by directory name or
  // by the plugin's own manifest name (an npm package directory usually
  // differs from the entry name).
  const entryDirs = new Set<string>();
  for (const marketplace of state.marketplaces) {
    const entry = marketplace.entries.find((candidate) => candidate.name === name);
    if (entry === undefined) continue;
    if (entry.source.type === "local") {
      entryDirs.add(realpathOrNull(entry.source.path) ?? entry.source.path);
    }
    if (entry.source.type === "npm") {
      // Resolve the package directly: the `packages` option may be empty even
      // though this entry was installed from npm.
      const resolved = resolveNpmSource(state.directory, entry.source.package);
      if (resolved !== null) entryDirs.add(resolved);
    }
  }
  const before = state.sources.length;
  state.sources = state.sources.filter((source) => {
    const real = realpathOrNull(source) ?? source;
    if (entryDirs.has(real)) return false;
    if (path.basename(source) === name) return false;
    return discoverPluginRoot(source)?.slug !== name;
  });
  if (state.sources.length === before) return `Uninstall failed: ${removal.message}`;
  await persistSources(ctx, state);
  await reloadState(ctx, state);
  return `**Unregistered ${name}**\nThe source directory was left in place (owned by its marketplace or package manager).`;
}

async function reload(ctx: V2Context, state: V2State): Promise<string> {
  await reloadState(ctx, state);
  return `Rescanned all sources.\n\n${statusText(state)}`;
}
