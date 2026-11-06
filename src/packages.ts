/**
 * opencode-agent-plugins — Agent Plugins shipped inside npm packages.
 *
 * OpenCode installs plugins from npm but never scans the package for Agent
 * Plugins assets, so vendors (e.g. @dodopayments/opencode-plugin) have to
 * ask users to hand-wire `skills.paths` against `node_modules`. This module
 * resolves explicitly configured package names to their package directory
 * and, when the package carries an Agent Plugins manifest, points discovery
 * at it — no path wiring, no config edits.
 *
 * Resolution order (first hit wins):
 *   1. <project>/node_modules/<package>
 *   2. <config-dir>/node_modules/<package> (when present)
 * The resolver only *reads*; installing the package stays a package-manager
 * decision the user makes explicitly.
 */

import path from "node:path";
import { pathExists, realpathOrNull, xdgCacheHome } from "./fs.ts";

export interface PackageResolution {
  packageName: string;
  directory?: string;
  error?: string;
}

export function resolvePackages(packages: string[], projectDir: string): PackageResolution[] {
  const out: PackageResolution[] = [];
  for (const packageName of packages) {
    const trimmed = packageName.trim();
    if (trimmed === "") continue;
    if (!isSafePackageName(trimmed)) {
      out.push({ packageName: trimmed, error: "invalid package name" });
      continue;
    }
    const directory = resolveNpmSource(projectDir, trimmed);
    if (directory === null) {
      out.push({
        packageName: trimmed,
        error: `not found (or no plugin.json) in project node_modules or the OpenCode config cache; run \`bun add ${trimmed}\``,
      });
      continue;
    }
    out.push({ packageName: trimmed, directory });
  }
  return out;
}

/** Resolve one package to a realpath containing a root `plugin.json`. */
export function resolveNpmSource(projectDir: string, packageName: string): string | null {
  if (!isSafePackageName(packageName)) return null;
  const candidates = [
    path.join(projectDir, "node_modules", packageName),
    path.join(xdgCacheHome(), "opencode", "node_modules", packageName),
  ];
  for (const candidate of candidates) {
    if (pathExists(path.join(candidate, "plugin.json"))) return realpathOrNull(candidate);
  }
  return null;
}

/** Reject path-like or traversal package names before touching the filesystem. */
export function isSafePackageName(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("/") || name.includes("..")) return false;
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name);
}
