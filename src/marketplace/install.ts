/**
 * opencode-agent-plugins — marketplace installation.
 *
 * Installs run only from explicit commands. Git sources are cloned into a
 * private temp directory, validated with the full plugin loader, copied with
 * symlink-escape checks, and swapped into place atomically with provenance
 * and rollback.
 */

import fs from "node:fs";
import path from "node:path";
import { discoverPluginRoot } from "../discovery.ts";
import { isInside, pathExists, realpathOrNull } from "../fs.ts";
import { resolveNpmSource } from "../packages.ts";
import { provenanceFile, readProvenance } from "./store.ts";
import type {
  Installer,
  InstallResult,
  Marketplace,
  MarketplaceEntry,
  MarketplaceSourceGit,
  Provenance,
} from "./types.ts";
import { ENTRY_NAME_PATTERN } from "./util.ts";

interface FetchedSource {
  sourceDir: string;
  tempDir: string;
  commit: string;
}

function validateTarget(dir: string): string | null {
  const plugin = discoverPluginRoot(dir);
  if (plugin !== null) return null;
  return "not a valid Agent Plugin (manifest rejected, unreadable, or escaping the plugin root)";
}

/**
 * Reject symlinks that resolve outside the plugin tree (or dangling ones)
 * before copying: the installed tree must contain exactly what the loader
 * validated, never a window into the host filesystem.
 */
function escapingSymlink(root: string): string | null {
  const realRoot = realpathOrNull(root) ?? root;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const candidate = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const real = realpathOrNull(candidate);
        if (real === null) return `dangling symlink ${candidate}`;
        if (!isInside(real, realRoot)) return `symlink ${candidate} escapes the plugin tree`;
      } else if (entry.isDirectory()) {
        stack.push(candidate);
      }
    }
  }
  return null;
}

/** Copy a plugin tree, excluding VCS metadata, after escape checks. */
function copyTree(sourceRoot: string, destination: string): string | null {
  const escapeError = escapingSymlink(sourceRoot);
  if (escapeError !== null) return escapeError;
  try {
    fs.cpSync(sourceRoot, destination, {
      recursive: true,
      dereference: true,
      filter: (entry) => !entry.split(path.sep).includes(".git"),
    });
  } catch (error) {
    return `copy failed: ${String(error)}`;
  }
  return null;
}

/**
 * Clone and validate a git entry into a temp directory. The caller owns
 * `tempDir` and must remove it.
 */
async function fetchGitSource(
  installer: Installer,
  source: MarketplaceSourceGit
): Promise<{ fetched: FetchedSource } | { error: string }> {
  let tempDir: string;
  try {
    fs.mkdirSync(installer.storeRoot, { recursive: true });
    tempDir = fs.mkdtempSync(path.join(installer.storeRoot, ".tmp-"));
  } catch (error) {
    return { error: `cannot prepare install store: ${String(error)}` };
  }
  try {
    const clone = await installer.git(
      // `--` stops option parsing even if a URL slips through validation.
      ["clone", "--quiet", "--filter=blob:none", "--", source.url, tempDir],
      installer.storeRoot
    );
    if (clone.code !== 0) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { error: `git clone failed: ${clone.output.trim()}` };
    }
    const target = source.sha ?? source.ref ?? "HEAD";
    let checkout = await installer.git(["checkout", "--quiet", target], tempDir);
    if (checkout.code !== 0) {
      await installer.git(["fetch", "--quiet", "--depth", "1", "origin", target], tempDir);
      checkout = await installer.git(["checkout", "--quiet", target], tempDir);
      if (checkout.code !== 0) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        return { error: `git checkout ${target} failed: ${checkout.output.trim()}` };
      }
    }
    const rev = await installer.git(["rev-parse", "HEAD"], tempDir);
    if (rev.code !== 0) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { error: `git rev-parse failed: ${rev.output.trim()}` };
    }

    let sourceDir = tempDir;
    if (source.path !== undefined) {
      const candidate = path.resolve(tempDir, source.path);
      const realTemp = realpathOrNull(tempDir) ?? tempDir;
      const realSource = realpathOrNull(candidate);
      if (realSource === null || !isInside(realSource, realTemp)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        return { error: `plugin path ${source.path} escapes the repository` };
      }
      sourceDir = realSource;
    }
    const validationError = validateTarget(sourceDir);
    if (validationError !== null) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { error: `repository does not contain a valid Agent Plugin: ${validationError}` };
    }
    return { fetched: { sourceDir, tempDir, commit: rev.output.trim() } };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return { error: `git install failed: ${String(error)}` };
  }
}

function writeProvenance(
  installer: Installer,
  marketplace: Marketplace,
  entry: MarketplaceEntry,
  commit: string
): void {
  if (entry.source.type !== "url" && entry.source.type !== "git-subdir") return;
  const provenance: Provenance = {
    name: entry.name,
    marketplace: marketplace.name,
    source: entry.source,
    commit,
    installedAt: (installer.now?.() ?? new Date()).toISOString(),
  };
  fs.mkdirSync(path.dirname(provenanceFile(installer.storeRoot, entry.name)), { recursive: true });
  fs.writeFileSync(
    provenanceFile(installer.storeRoot, entry.name),
    JSON.stringify(provenance, null, 2)
  );
}

export async function installEntry(
  installer: Installer,
  marketplace: Marketplace,
  entry: MarketplaceEntry
): Promise<InstallResult> {
  if (!ENTRY_NAME_PATTERN.test(entry.name)) {
    return { ok: false, message: `invalid plugin name ${JSON.stringify(entry.name)}` };
  }
  if (entry.installation === "NOT_AVAILABLE") {
    return { ok: false, message: `${entry.name} is marked NOT_AVAILABLE by its marketplace` };
  }
  const destination = path.join(installer.storeRoot, entry.name);

  if (entry.source.type === "local") {
    // Re-resolve at install time: the path may have been missing or benign
    // when the catalog was parsed and replaced since.
    const realRoot = realpathOrNull(marketplace.root);
    const realSource = realpathOrNull(entry.source.path);
    if (realRoot === null || realSource === null || !isInside(realSource, realRoot)) {
      return { ok: false, message: "local source escapes its marketplace root" };
    }
    const error = validateTarget(realSource);
    if (error !== null)
      return { ok: false, message: `local source is not a valid Agent Plugin: ${error}` };
    return {
      ok: true,
      directory: realSource,
      message: `local source registered: ${realSource} (no copy; the marketplace owns this directory)`,
    };
  }

  if (entry.source.type === "npm") {
    const resolved = resolveNpmSource(installer.projectDir, entry.source.package);
    if (resolved === null) {
      return {
        ok: false,
        message: `npm package ${entry.source.package} is not installed in ${installer.projectDir}; run \`bun add ${entry.source.package}\` first`,
      };
    }
    const error = validateTarget(resolved);
    if (error !== null)
      return { ok: false, message: `npm package is not a valid Agent Plugin: ${error}` };
    return {
      ok: true,
      directory: resolved,
      message: `npm source registered: ${resolved} (package-managed; the package manager owns this directory)`,
    };
  }

  // git install
  if (pathExists(destination)) {
    return {
      ok: false,
      message: `${entry.name} is already installed at ${destination}; run /ap update ${entry.name}`,
    };
  }
  const result = await fetchGitSource(installer, entry.source);
  if ("error" in result) return { ok: false, message: result.error };
  const { fetched } = result;
  const staging = `${destination}.staging-${process.pid}`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    const copyError = copyTree(fetched.sourceDir, staging);
    if (copyError !== null) {
      return { ok: false, message: `install copy refused: ${copyError}` };
    }
    const stagingError = validateTarget(staging);
    if (stagingError !== null) {
      return { ok: false, message: `staged copy is not a valid Agent Plugin: ${stagingError}` };
    }
    // Provenance is written before the destination is exposed: a failure
    // here leaves nothing installed and the user can retry cleanly.
    try {
      writeProvenance(installer, marketplace, entry, fetched.commit);
    } catch (error) {
      return { ok: false, message: `cannot record provenance: ${String(error)}` };
    }
    try {
      fs.renameSync(staging, destination);
    } catch (error) {
      fs.rmSync(provenanceFile(installer.storeRoot, entry.name), { force: true });
      return { ok: false, message: `install swap failed: ${String(error)}` };
    }
    return {
      ok: true,
      directory: destination,
      commit: fetched.commit,
      message: `installed at ${destination} (commit ${fetched.commit.slice(0, 12)})`,
    };
  } finally {
    fs.rmSync(fetched.tempDir, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Replace an installed git entry without ever leaving the store without a
 * working copy: fetch and validate first, swap with a backup, roll back on
 * failure.
 */
export async function updateEntry(
  installer: Installer,
  marketplace: Marketplace,
  entry: MarketplaceEntry
): Promise<InstallResult & { previousCommit?: string }> {
  if (!ENTRY_NAME_PATTERN.test(entry.name)) {
    return { ok: false, message: `invalid plugin name ${JSON.stringify(entry.name)}` };
  }
  if (entry.installation === "NOT_AVAILABLE") {
    return { ok: false, message: `${entry.name} is marked NOT_AVAILABLE by its marketplace` };
  }
  const destination = path.join(installer.storeRoot, entry.name);
  if (!pathExists(destination)) return installEntry(installer, marketplace, entry);
  if (entry.source.type !== "url" && entry.source.type !== "git-subdir") {
    return { ok: false, message: "only git sources can be updated" };
  }
  const previous = readProvenance(installer.storeRoot, entry.name);

  const result = await fetchGitSource(installer, entry.source);
  if ("error" in result) return { ok: false, message: result.error };
  const { fetched } = result;

  const staging = `${destination}.staging-${process.pid}`;
  const backup = `${destination}.backup-${process.pid}`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    const copyError = copyTree(fetched.sourceDir, staging);
    if (copyError !== null) {
      return { ok: false, message: `update copy refused (old install untouched): ${copyError}` };
    }
    const stagingError = validateTarget(staging);
    if (stagingError !== null) {
      return {
        ok: false,
        message: `staged copy is not a valid Agent Plugin (old install untouched): ${stagingError}`,
      };
    }
    fs.rmSync(backup, { recursive: true, force: true });
    fs.renameSync(destination, backup);
    try {
      fs.renameSync(staging, destination);
    } catch (error) {
      fs.renameSync(backup, destination); // roll back
      return { ok: false, message: `swap failed, old install restored: ${String(error)}` };
    }
    try {
      writeProvenance(installer, marketplace, entry, fetched.commit);
    } catch (error) {
      // Roll the swap back so code and provenance never disagree.
      fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(backup, destination);
      return {
        ok: false,
        message: `cannot record provenance, old install restored: ${String(error)}`,
      };
    }
    fs.rmSync(backup, { recursive: true, force: true });
    return {
      ok: true,
      directory: destination,
      commit: fetched.commit,
      previousCommit: previous?.commit,
      message: `updated at ${destination} (${previous?.commit?.slice(0, 12) ?? "unknown"} → ${fetched.commit.slice(0, 12)})`,
    };
  } finally {
    fs.rmSync(fetched.tempDir, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
    if (pathExists(backup) && !pathExists(destination)) {
      fs.renameSync(backup, destination);
    }
  }
}

/** Remove an installed copy. Never touches local or npm sources. */
