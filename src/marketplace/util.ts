/**
 * opencode-agent-plugins — internal marketplace helpers.
 */

import fs from "node:fs";

export const ENTRY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

export function statSyncOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------- discovery -------------------------------- */

/**
 * Marketplace catalog locations, highest precedence first:
 * `<project>/.agents/plugins/marketplace.json` walked up to the worktree
 * root, then the personal catalog at `~/.agents/plugins/marketplace.json`
 * and its XDG data counterpart.
 */
