/**
 * opencode-agent-plugins — filesystem helpers.
 *
 * Every path boundary in the Agent Plugins specification ("resolves outside
 * the plugin root") is enforced through realpath containment, so symlinks
 * cannot smuggle plugin files outside their declared root.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Realpath of `p`, or null when it does not resolve. */
export function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** True when `child` equals `parent` or lives below it (both realpaths). */
export function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}

/** Realpath of `candidate` when it resolves inside `root`; null otherwise. */
export function resolvedInside(candidate: string, root: string): string | null {
  const realCandidate = realpathOrNull(candidate);
  const realRoot = realpathOrNull(root);
  if (!realCandidate || !realRoot) return null;
  return isInside(realCandidate, realRoot) ? realCandidate : null;
}

export function pathExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Kind of a directory entry after resolving symlinks; null when unreadable. */
export type EntryKind = "dir" | "file" | "other";

export interface DirEntry {
  name: string;
  kind: EntryKind | null;
  /** Whether the entry itself is a symlink. */
  isSymlink: boolean;
}

/** Immediate entries of `dir`, or null when the directory cannot be read. */
export function listEntries(dir: string): DirEntry[] | null {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const entries: DirEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    let kind: EntryKind | null = null;
    try {
      const stat = fs.statSync(path.join(dir, dirent.name));
      if (stat.isDirectory()) kind = "dir";
      else if (stat.isFile()) kind = "file";
      else kind = "other";
    } catch {
      kind = null;
    }
    entries.push({ name: dirent.name, kind, isSymlink: dirent.isSymbolicLink() });
  }
  return entries;
}

/** Read a text file, or null on any failure. */
export function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Strict JSON parse of a file. Returns `value` or a failure description. */
export function readJSON(p: string): { value?: unknown; error?: string } {
  const text = readText(p);
  if (text === null) return { error: `cannot read ${p}` };
  try {
    return { value: JSON.parse(text) };
  } catch {
    // Never echo parser output: a file outside the package boundary must not
    // leak its contents through an error string.
    return { error: "invalid JSON" };
  }
}

export function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

export function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config");
}

export function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(homeDir(), ".local", "share");
}

export function xdgCacheHome(): string {
  return process.env.XDG_CACHE_HOME || path.join(homeDir(), ".cache");
}
