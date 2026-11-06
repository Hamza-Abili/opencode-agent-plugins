/**
 * opencode-agent-plugins — pure command output formatting.
 *
 * These functions only read state and return markdown; they never mutate it.
 */

import path from "node:path";
import { listInstalled, type MarketplaceEntry } from "../marketplace.ts";
import { isMcpEnabled, mcpCanonicalId, type V2State } from "./state.ts";

export const HELP_TEXT = `**/ap — Agent Plugins**

/ap status                  — plugins, skills, MCP servers, marketplaces
/ap list                    — compact plugin list
/ap enable <mcp-server>     — enable an MCP server (persists across sessions)
/ap disable <mcp-server>    — disable an MCP server
/ap marketplace             — list marketplace catalogs and installable entries
/ap install <plugin>        — install one marketplace entry (explicit action)
/ap update <plugin>         — re-install a managed git entry
/ap uninstall <plugin>      — remove a managed install
/ap packages                — show configured npm package sources
/ap reload                  — rescan every source

MCP servers load **disabled** for safety. Skills are markdown-only and load immediately.`;

export function statusText(state: V2State): string {
  const { plugins, rejected } = state.discovery;
  const skillCount = plugins.reduce((sum, plugin) => sum + plugin.skills.length, 0);
  const mcpCount = plugins.reduce((sum, plugin) => sum + plugin.mcpServers.length, 0);

  const lines: string[] = [
    `**Agent Plugins** — ${plugins.length} plugin(s), ${skillCount} skill(s), ${mcpCount} MCP server(s)`,
  ];

  for (const plugin of plugins) {
    const version = plugin.manifest.version !== undefined ? ` v${plugin.manifest.version}` : "";
    lines.push(`\n**${plugin.slug}**${version}`);
    for (const skill of plugin.skills) lines.push(`- skill: ${skill.name}`);
    for (const server of plugin.mcpServers) {
      const display = state.options.prefix ? `${plugin.slug}-${server.name}` : server.name;
      const enabled = isMcpEnabled(state, mcpCanonicalId(plugin.slug, server.name));
      lines.push(`- mcp: ${display} [${enabled ? "enabled" : "disabled"}]`);
    }
    if (plugin.skills.length === 0 && plugin.mcpServers.length === 0)
      lines.push("- (no loadable components)");
    for (const problem of plugin.problems) lines.push(`- ⚠ ${problem.message}`);
  }

  for (const entry of rejected) {
    lines.push(`\n**${path.basename(entry.root)}** — rejected`);
    for (const problem of entry.problems) lines.push(`- ⛔ ${problem.message}`);
  }

  if (state.marketplaces.length > 0) lines.push(`\nmarketplaces: ${state.marketplaces.length}`);
  if (state.sources.length > 0) lines.push(`installed sources: ${state.sources.length}`);
  return lines.join("\n");
}

export function listText(state: V2State): string {
  if (state.discovery.plugins.length === 0) return "**Agent Plugins** — no plugins discovered.";
  const lines = ["**Agent Plugins** — discovered:"];
  for (const plugin of state.discovery.plugins) {
    lines.push(
      `- ${plugin.slug} (${plugin.skills.length} skill(s), ${plugin.mcpServers.length} mcp)`
    );
  }
  return lines.join("\n");
}

export function marketplaceText(state: V2State): string {
  const lines = ["**Agent Plugins — marketplaces**"];
  if (state.marketplaces.length === 0 && state.marketplaceProblems.length === 0) {
    lines.push("No `.agents/plugins/marketplace.json` found.");
    return lines.join("\n");
  }
  const installed = new Set([
    ...listInstalled(state.options.installRoot),
    ...state.sources.map((source) => path.basename(source)),
  ]);
  for (const marketplace of state.marketplaces) {
    const title =
      marketplace.displayName !== undefined
        ? `${marketplace.displayName} (${marketplace.name})`
        : marketplace.name;
    lines.push(`\n**${title}** — ${marketplace.entries.length} entries`);
    for (const entry of marketplace.entries) {
      const marks: string[] = [];
      if (installed.has(entry.name)) marks.push("installed");
      if (entry.installation === "NOT_AVAILABLE") marks.push("not available");
      const suffix = marks.length > 0 ? ` [${marks.join(", ")}]` : "";
      lines.push(`- ${entry.name} — ${sourceLabel(entry)}${suffix}`);
    }
    for (const problem of marketplace.problems) lines.push(`- ⚠ ${problem.message}`);
  }
  for (const problem of state.marketplaceProblems) lines.push(`- ⚠ ${problem.message}`);
  return lines.join("\n");
}

export function sourceLabel(entry: MarketplaceEntry): string {
  switch (entry.source.type) {
    case "local":
      return `local ${entry.source.path}`;
    case "npm":
      return `npm ${entry.source.package}`;
    default:
      return `git ${entry.source.url}${entry.source.path !== undefined ? `#${entry.source.path}` : ""}`;
  }
}

export function packagesText(state: V2State): string {
  if (state.options.packages.length === 0) {
    return "**Agent Plugins — packages**\nNo `packages` configured. Add npm package names that ship an Agent Plugin.";
  }
  const lines = ["**Agent Plugins — packages**"];
  for (const resolution of state.packages) {
    if (resolution.directory !== undefined)
      lines.push(`- ${resolution.packageName} → ${resolution.directory}`);
    else lines.push(`- ${resolution.packageName} — ⚠ ${resolution.error ?? "unresolved"}`);
  }
  return lines.join("\n");
}
