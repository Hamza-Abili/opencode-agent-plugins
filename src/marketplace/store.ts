/**
 * opencode-agent-plugins — managed install store.
 *
 * Provenance, listing, crash recovery and uninstall. Only directories named
 * as managed entries are ever plugins; backups and staging copies are
 * internal and recovered or removed on startup.
 */

import fs from "node:fs";
import path from "node:path";
import { isInside, listEntries, pathExists, readJSON, realpathOrNull } from "../fs.ts";
import { logger } from "../log.ts";
import type { Provenance } from "./types.ts";
import { ENTRY_NAME_PATTERN, isRecord } from "./util.ts";

export function provenanceFile(storeRoot: string, name: string): string {
  return path.join(storeRoot, ".provenance", `${name}.json`);
}

export function readProvenance(storeRoot: string, name: string): Provenance | null {
  if (!ENTRY_NAME_PATTERN.test(name)) return null;
  const parsed = readJSON(provenanceFile(storeRoot, name));
  if (parsed.error !== undefined || !isRecord(parsed.value)) return null;
  const value = parsed.value;
  if (
    typeof value.name !== "string" ||
    typeof value.marketplace !== "string" ||
    typeof value.commit !== "string" ||
    typeof value.installedAt !== "string" ||
    !isRecord(value.source) ||
    (value.source.type !== "url" && value.source.type !== "git-subdir") ||
    typeof value.source.url !== "string"
  ) {
    return null;
  }
  return value as unknown as Provenance;
}

export function listInstalled(storeRoot: string): string[] {
  const entries = listEntries(storeRoot);
  if (entries === null) return [];
  return entries
    .filter((entry) => entry.kind === "dir" && ENTRY_NAME_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Remove internal staging/backup leftovers from interrupted installs. They
 * are never loadable plugins and must not survive a restart.
 */
export function cleanupInternalDirs(storeRoot: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(storeRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const handled = new Set<string>();
  const failedRecovery = new Set<string>();
  // Recover interrupted update swaps first: the only working copy may live
  // in a backup directory.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^(.+)\.backup-\d+$/.exec(entry.name);
    if (match === null) continue;
    const name = match[1];
    const destination = path.join(storeRoot, name);
    const backup = path.join(storeRoot, entry.name);
    try {
      if (pathExists(destination)) {
        fs.rmSync(backup, { recursive: true, force: true });
      } else {
        fs.renameSync(backup, destination);
        logger.warn(`recovered interrupted update: restored ${name}`);
      }
      handled.add(entry.name);
    } catch (error) {
      failedRecovery.add(entry.name);
      logger.warn(`cannot recover backup ${entry.name}: ${String(error)}`);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (handled.has(entry.name) || failedRecovery.has(entry.name)) continue;
    const internal = /^(\.tmp-|.+?(\.staging-\d+|\.backup-\d+)$)/.test(entry.name);
    if (!internal) continue;
    try {
      fs.rmSync(path.join(storeRoot, entry.name), { recursive: true, force: true });
      logger.info(`removed stale install directory ${entry.name}`);
    } catch (error) {
      logger.warn(`cannot remove stale install directory ${entry.name}: ${String(error)}`);
    }
  }
}

export function uninstallEntry(storeRoot: string, name: string): { ok: boolean; message: string } {
  if (!ENTRY_NAME_PATTERN.test(name))
    return { ok: false, message: `invalid plugin name ${JSON.stringify(name)}` };
  const directory = path.join(storeRoot, name);
  const hasDestination = pathExists(directory);
  let leftovers: string[] = [];
  try {
    leftovers = fs
      .readdirSync(storeRoot)
      .filter(
        (entry) => entry.startsWith(`${name}.backup-`) || entry.startsWith(`${name}.staging-`)
      );
  } catch {
    leftovers = [];
  }
  if (!hasDestination && leftovers.length === 0) {
    return { ok: false, message: `${name} is not installed in the managed store` };
  }
  if (hasDestination) {
    const realStore = realpathOrNull(storeRoot);
    const realDir = realpathOrNull(directory);
    if (realStore === null || realDir === null || !isInside(realDir, realStore)) {
      return { ok: false, message: "refusing to remove a directory outside the managed store" };
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  for (const entry of leftovers) {
    fs.rmSync(path.join(storeRoot, entry), { recursive: true, force: true });
  }
  fs.rmSync(provenanceFile(storeRoot, name), { force: true });
  return {
    ok: true,
    message: hasDestination
      ? `removed ${directory}`
      : `removed interrupted install leftovers for ${name}`,
  };
}
