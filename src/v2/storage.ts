/**
 * opencode-agent-plugins — v2 persistence.
 *
 * One versioned JSON value holds explicit `/ap enable` / `/ap disable`
 * decisions for MCP servers and the installed source directories are stored
 * separately. Option seeds are never written here. A missing storage surface
 * degrades to in-memory state and never wipes existing decisions.
 */

import { logger } from "../log.ts";
import type { V2Context } from "./host.ts";
import type { V2State } from "./state.ts";

const STORAGE_STATE = "mcp-state";
const STORAGE_SOURCES = "sources";
const LEGACY_ENABLED = "enabled-mcp";
const LEGACY_DISABLED = "disabled-mcp";
const STATE_VERSION = 2;

export interface PersistedRead {
  available: boolean;
  enabled: Set<string>;
  disabled: Set<string>;
  /** True when the value came from the pre-1.2 two-key layout. */
  legacy: boolean;
}

function stringSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null;
  return new Set(value.filter((item): item is string => typeof item === "string"));
}

export async function loadPersistence(ctx: V2Context): Promise<PersistedRead> {
  if (!ctx.storage || typeof ctx.storage.get !== "function") {
    return { available: false, enabled: new Set(), disabled: new Set(), legacy: false };
  }
  try {
    const stored = await ctx.storage.get(STORAGE_STATE);
    if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
      const record = stored as Record<string, unknown>;
      if (record.version === STATE_VERSION) {
        return {
          available: true,
          enabled: stringSet(record.enabled) ?? new Set(),
          disabled: stringSet(record.disabled) ?? new Set(),
          legacy: false,
        };
      }
    }
    // Pre-1.2 layout: two separate keys, option seeds were persisted.
    const legacyEnabled = stringSet(await ctx.storage.get(LEGACY_ENABLED));
    const legacyDisabled = stringSet(await ctx.storage.get(LEGACY_DISABLED));
    if (legacyEnabled !== null || legacyDisabled !== null) {
      return {
        available: true,
        enabled: legacyEnabled ?? new Set(),
        disabled: legacyDisabled ?? new Set(),
        legacy: true,
      };
    }
    return { available: true, enabled: new Set(), disabled: new Set(), legacy: false };
  } catch (error) {
    logger.warn(`cannot read enabled state: ${String(error)}`);
    return { available: false, enabled: new Set(), disabled: new Set(), legacy: false };
  }
}

/** Persist both decision sets in one atomic write. */
export async function persistState(ctx: V2Context, state: V2State): Promise<void> {
  if (!ctx.storage || typeof ctx.storage.set !== "function") return;
  try {
    await ctx.storage.set(STORAGE_STATE, {
      version: STATE_VERSION,
      enabled: [...state.persistedEnabled],
      disabled: [...state.persistedDisabled],
    });
  } catch (error) {
    logger.warn(`cannot persist enabled state: ${String(error)}`);
  }
}

export async function persistSources(ctx: V2Context, state: V2State): Promise<void> {
  if (!ctx.storage || typeof ctx.storage.set !== "function") {
    logger.warn(
      "host has no storage surface — installed sources are still discovered from the managed store"
    );
    return;
  }
  try {
    await ctx.storage.set(STORAGE_SOURCES, [...state.sources]);
  } catch (error) {
    logger.warn(`cannot persist installed sources: ${String(error)}`);
  }
}

export async function loadSources(ctx: V2Context): Promise<string[]> {
  if (!ctx.storage || typeof ctx.storage.get !== "function") return [];
  try {
    const stored = await ctx.storage.get(STORAGE_SOURCES);
    if (Array.isArray(stored))
      return stored.filter((value): value is string => typeof value === "string");
  } catch (error) {
    logger.warn(`cannot read installed sources: ${String(error)}`);
  }
  return [];
}
