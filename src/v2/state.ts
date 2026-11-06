/**
 * opencode-agent-plugins — v2 plugin state and enabled-identity rules.
 *
 * MCP servers are identified by a canonical `<slug>::<server>` id. Aliases
 * (prefixed displays, current displays, short names) resolve globally and
 * fail closed when ambiguous.
 */

import { logger } from "../log.ts";
import type { Marketplace } from "../marketplace.ts";
import type { PackageResolution } from "../packages.ts";
import type { DiscoveryResult, PluginOptions } from "../types.ts";

export interface RegisteredMcp {
  /** Name exposed to OpenCode (prefixed when the option is on). */
  display: string;
  /** Stable identity independent of the prefix option: `<slug>::<server>`. */
  canonical: string;
  /** The plugin author's server name, regardless of the prefix option. */
  short: string;
}

export interface V2State {
  options: PluginOptions;
  directory: string;
  discovery: DiscoveryResult;
  /** Effective enabled set for this session (seeds + explicit enables − disables). */
  enabledMcp: Set<string>;
  /** Canonical ids explicitly enabled with `/ap enable` (persisted). */
  persistedEnabled: Set<string>;
  /** Canonical ids explicitly disabled with `/ap disable` (persisted). */
  persistedDisabled: Set<string>;
  registeredMcp: RegisteredMcp[];
  /** alias → canonical ids, covering every accepted name form. */
  aliases: Map<string, Set<string>>;
  /** Every canonical id currently discovered. */
  canonicalIds: Set<string>;
  dataRoot: string;
  sources: string[];
  marketplaces: Marketplace[];
  marketplaceProblems: { level: "error" | "warning"; message: string }[];
  packages: PackageResolution[];
}

export function mcpCanonicalId(slug: string, server: string): string {
  return `${slug}::${server}`;
}

/** One source of truth for enabled state across registration/status/toggle. */
export function isMcpEnabled(state: V2State, canonical: string): boolean {
  return state.enabledMcp.has(canonical);
}

/**
 * Build the global alias map: canonical ids, prefixed displays, current
 * displays and short names. A short name that collides with another
 * server's display resolves to both candidates, so it can never enable
 * anything by accident.
 */
export function buildAliases(discovery: DiscoveryResult): Map<string, Set<string>> {
  const aliases = new Map<string, Set<string>>();
  const add = (alias: string, canonical: string) => {
    const current = aliases.get(alias) ?? new Set<string>();
    current.add(canonical);
    aliases.set(alias, current);
  };
  for (const plugin of discovery.plugins) {
    for (const server of plugin.mcpServers) {
      const canonical = mcpCanonicalId(plugin.slug, server.name);
      add(canonical, canonical);
      add(`${plugin.slug}-${server.name}`, canonical);
      add(server.name, canonical);
    }
  }
  return aliases;
}

/** Resolve one alias to a canonical id; ambiguous aliases fail closed. */
export function resolveAlias(aliases: Map<string, Set<string>>, raw: string): string | null {
  const matches = aliases.get(raw);
  if (matches === undefined) return null;
  if (matches.size !== 1) {
    logger.warn(
      `enabled MCP alias ${JSON.stringify(raw)} is ambiguous — ignored (use the canonical name)`
    );
    return null;
  }
  return [...matches][0];
}

/**
 * Normalize persisted enables. Canonical ids win over foreign short aliases;
 * ambiguous non-canonical aliases fail closed (dropped). Unknown ids stay for
 * a later reload.
 */
export function normalizePersisted(
  persisted: Set<string>,
  aliases: Map<string, Set<string>>,
  canonicalIds: Set<string>
): Set<string> {
  const normalized = new Set<string>();
  for (const raw of persisted) {
    if (canonicalIds.has(raw)) {
      normalized.add(raw);
      continue;
    }
    const canonical = resolveAlias(aliases, raw);
    if (canonical !== null) normalized.add(canonical);
    else if (!aliases.has(raw)) normalized.add(raw); // server temporarily absent
  }
  return normalized;
}

/**
 * Normalize persisted disables. Exact canonical ids win; an ambiguous
 * non-canonical alias disables every candidate (fail closed) so a shadowing
 * server name cannot silently re-enable something the user disabled.
 */
export function normalizeDisabled(
  persisted: Set<string>,
  aliases: Map<string, Set<string>>,
  canonicalIds: Set<string>
): Set<string> {
  const normalized = new Set<string>();
  for (const raw of persisted) {
    if (canonicalIds.has(raw)) {
      normalized.add(raw);
      continue;
    }
    const matches = aliases.get(raw);
    if (matches === undefined) {
      normalized.add(raw); // server temporarily absent
      continue;
    }
    for (const canonical of matches) normalized.add(canonical);
  }
  return normalized;
}

/** Build the set of canonical ids for the current discovery. */
export function buildCanonicalIds(discovery: DiscoveryResult): Set<string> {
  const ids = new Set<string>();
  for (const plugin of discovery.plugins) {
    for (const server of plugin.mcpServers) ids.add(mcpCanonicalId(plugin.slug, server.name));
  }
  return ids;
}

/**
 * Compute the effective enabled set: explicit persisted enables, plus the
 * `enabledMcp` option seeds (session-only), minus explicit persisted
 * disables. Removing an option therefore disables a seeded server again;
 * `/ap disable` wins over the option across restarts.
 */
export function applyOptionSeeds(state: V2State, optionNames: readonly string[]): void {
  const effective = new Set(state.persistedEnabled);
  for (const raw of optionNames) {
    const canonical = resolveAlias(state.aliases, raw);
    if (canonical === null) {
      if (!state.aliases.has(raw)) {
        logger.warn(
          `enabledMcp entry ${JSON.stringify(raw)} does not match a discovered server — ignored`
        );
      }
      continue;
    }
    if (!state.persistedDisabled.has(canonical)) effective.add(canonical);
  }
  for (const canonical of state.persistedDisabled) effective.delete(canonical);
  state.enabledMcp = effective;
}
