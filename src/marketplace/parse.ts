/**
 * opencode-agent-plugins — marketplace catalog discovery and validation.
 *
 * Reads the vendor-neutral `.agents/plugins/marketplace.json` format with
 * per-entry failure isolation. Catalogs must resolve under the project,
 * worktree or home/XDG agent roots.
 */

import path from "node:path";
import { isInside, pathExists, readJSON, realpathOrNull } from "../fs.ts";
import { logger } from "../log.ts";
import type { Problem } from "../types.ts";
import type {
  Marketplace,
  MarketplaceDiscovery,
  MarketplaceEntry,
  MarketplaceSource,
  MarketplaceSourceGit,
  MarketplaceSourceLocal,
} from "./types.ts";
import {
  AUTHENTICATION_VALUES,
  INSTALLATION_VALUES,
  MARKETPLACE_NAME_PATTERN,
  SAFE_REF_PATTERN,
  SAFE_SHA_PATTERN,
} from "./types.ts";
import { ENTRY_NAME_PATTERN, isRecord, lstatOrNull, statSyncOrNull } from "./util.ts";

export function marketplaceFiles(projectRoot: string, worktreeRoot: string): string[] {
  const files: string[] = [];
  let current = projectRoot;
  for (;;) {
    files.push(path.join(current, ".agents", "plugins", "marketplace.json"));
    if (current === worktreeRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const home = process.env.HOME ?? "";
  if (home !== "") files.push(path.join(home, ".agents", "plugins", "marketplace.json"));
  const xdgData =
    process.env.XDG_DATA_HOME || (home !== "" ? path.join(home, ".local", "share") : "");
  if (xdgData !== "") files.push(path.join(xdgData, "agents", "plugins", "marketplace.json"));
  return files;
}

export function discoverMarketplaces(
  projectRoot: string,
  worktreeRoot: string
): MarketplaceDiscovery {
  const found: Marketplace[] = [];
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const home = process.env.HOME ?? "";
  const xdgData =
    process.env.XDG_DATA_HOME || (home !== "" ? path.join(home, ".local", "share") : "");
  const allowedRoots = [
    worktreeRoot,
    home !== "" ? path.join(home, ".agents") : "",
    xdgData !== "" ? path.join(xdgData, "agents") : "",
  ]
    .filter((root) => root !== "")
    .flatMap((root) => {
      const real = realpathOrNull(root);
      return real === null ? [] : [real];
    });
  for (const file of marketplaceFiles(projectRoot, worktreeRoot)) {
    if (!pathExists(file)) continue;
    const realFile = realpathOrNull(file);
    if (realFile === null || seen.has(realFile)) continue;
    if (!allowedRoots.some((root) => isInside(realFile, root))) {
      problems.push({
        level: "warning",
        message: `${realFile}: marketplace resolves outside the project/home roots — ignored`,
      });
      continue;
    }
    seen.add(realFile);
    const parsed = parseMarketplace(realFile);
    if ("entry" in parsed) {
      found.push(parsed.entry);
    } else {
      for (const problem of parsed.problems) {
        problems.push({ level: problem.level, message: `${realFile}: ${problem.message}` });
        logger.warn(`marketplace ${realFile}: ${problem.message}`);
      }
    }
  }
  return { marketplaces: found, problems };
}

/* -------------------------------- parsing --------------------------------- */

type ParseResult = { entry: Marketplace } | { problems: Problem[] };

export function parseMarketplace(file: string): ParseResult {
  const stat = lstatOrNull(file);
  if (stat === null || (!stat.isFile() && !stat.isSymbolicLink())) {
    return { problems: [{ level: "error", message: "marketplace.json is not a regular file" }] };
  }
  if (stat.isSymbolicLink()) {
    const targetStat = statSyncOrNull(file);
    if (targetStat === null || !targetStat.isFile()) {
      return {
        problems: [
          { level: "error", message: "marketplace.json symlink does not point to a regular file" },
        ],
      };
    }
  }
  const parsed = readJSON(file);
  if (parsed.error !== undefined) {
    return { problems: [{ level: "error", message: `marketplace.json ${parsed.error}` }] };
  }
  const doc = parsed.value;
  if (!isRecord(doc)) {
    return { problems: [{ level: "error", message: "marketplace.json must be a JSON object" }] };
  }

  const problems: Problem[] = [];
  const name = doc.name;
  if (typeof name !== "string" || !MARKETPLACE_NAME_PATTERN.test(name)) {
    return {
      problems: [{ level: "error", message: "marketplace.json name must match [A-Za-z0-9_-]+" }],
    };
  }
  if (!Array.isArray(doc.plugins)) {
    return { problems: [{ level: "error", message: "marketplace.json plugins must be an array" }] };
  }

  const root = path.dirname(path.dirname(path.dirname(file))); // .agents/plugins/marketplace.json → root
  const entries: MarketplaceEntry[] = [];
  const seen = new Set<string>();

  for (const raw of doc.plugins) {
    const result = parseEntry(raw, root);
    if ("error" in result) {
      problems.push({ level: "warning", message: `marketplace entry skipped: ${result.error}` });
      continue;
    }
    if (seen.has(result.entry.name)) {
      problems.push({
        level: "warning",
        message: `marketplace entry ${JSON.stringify(result.entry.name)} is duplicated — first wins`,
      });
      continue;
    }
    seen.add(result.entry.name);
    entries.push(result.entry);
  }

  return {
    entry: {
      root,
      file,
      name,
      displayName:
        isRecord(doc.interface) && typeof doc.interface.displayName === "string"
          ? doc.interface.displayName
          : undefined,
      entries,
      problems,
    },
  };
}

type EntryResult = { entry: MarketplaceEntry } | { error: string };

function parseEntry(raw: unknown, marketplaceRoot: string): EntryResult {
  if (!isRecord(raw)) return { error: "entry must be an object" };
  const name = raw.name;
  if (typeof name !== "string" || !ENTRY_NAME_PATTERN.test(name)) {
    return {
      error: `entry name must match ^[a-z0-9][a-z0-9-]*$ (got ${JSON.stringify(String(name))})`,
    };
  }

  const sourceResult = parseSource(raw.source, marketplaceRoot);
  if ("error" in sourceResult)
    return { error: `entry ${JSON.stringify(name)}: ${sourceResult.error}` };

  const entry: MarketplaceEntry = { name, source: sourceResult.source };
  if (typeof raw.category === "string") entry.category = raw.category;
  if (typeof raw.description === "string") entry.description = raw.description;
  if (typeof raw.version === "string") entry.version = raw.version;

  if (isRecord(raw.policy)) {
    const installation = raw.policy.installation;
    if (installation !== undefined) {
      if (typeof installation === "string" && INSTALLATION_VALUES.has(installation)) {
        entry.installation = installation as MarketplaceEntry["installation"];
      } else {
        return { error: `entry ${JSON.stringify(name)}: invalid policy.installation` };
      }
    }
    const authentication = raw.policy.authentication;
    if (authentication !== undefined) {
      if (typeof authentication === "string" && AUTHENTICATION_VALUES.has(authentication)) {
        entry.authentication = authentication as MarketplaceEntry["authentication"];
      } else {
        return { error: `entry ${JSON.stringify(name)}: invalid policy.authentication` };
      }
    }
  }

  return { entry };
}

function parseSource(
  raw: unknown,
  marketplaceRoot: string
): { source: MarketplaceSource } | { error: string } {
  if (typeof raw === "string") {
    return parseLocalPath(raw, marketplaceRoot);
  }
  if (!isRecord(raw)) return { error: "source must be a path string or an object" };

  const type = raw.source;
  if (type === "local") {
    if (typeof raw.path !== "string") return { error: "local source requires a path string" };
    return parseLocalPath(raw.path, marketplaceRoot);
  }
  if (type === "url" || type === "git-subdir") {
    if (typeof raw.url !== "string" || raw.url === "")
      return { error: `${type} source requires a url` };
    const url = normalizeGitUrl(raw.url);
    if ("error" in url) return { error: url.error };
    const source: MarketplaceSourceGit = { type, url: url.url };
    if (typeof raw.path === "string" && raw.path !== "") {
      if (hasTraversal(raw.path)) return { error: "git source path must not contain .. segments" };
      source.path = raw.path;
    } else if (type === "git-subdir") {
      return { error: "git-subdir source requires a path" };
    }
    if (raw.ref !== undefined) {
      if (typeof raw.ref !== "string" || !isSafeGitRef(raw.ref)) {
        return { error: "git ref must be a safe branch/tag name" };
      }
      source.ref = raw.ref;
    }
    if (raw.sha !== undefined) {
      if (typeof raw.sha !== "string" || !SAFE_SHA_PATTERN.test(raw.sha)) {
        return { error: "git sha must be a hexadecimal commit id" };
      }
      source.sha = raw.sha;
    }
    return { source };
  }
  if (type === "npm") {
    if (typeof raw.package !== "string" || raw.package === "")
      return { error: "npm source requires a package" };
    if (raw.registry !== undefined) {
      if (typeof raw.registry !== "string") return { error: "npm registry must be a string" };
      let registry: URL;
      try {
        registry = new URL(raw.registry);
      } catch {
        return { error: "npm registry must be a valid URL" };
      }
      if (
        registry.protocol !== "https:" ||
        registry.username !== "" ||
        registry.password !== "" ||
        registry.search !== "" ||
        registry.hash !== ""
      ) {
        return { error: "npm registry must be https with no credentials, query or fragment" };
      }
    }
    return {
      source: {
        type: "npm",
        package: raw.package,
        version: typeof raw.version === "string" ? raw.version : undefined,
        registry: typeof raw.registry === "string" ? raw.registry : undefined,
      },
    };
  }
  return { error: `unknown source type ${JSON.stringify(String(type))}` };
}

function parseLocalPath(
  raw: string,
  marketplaceRoot: string
): { source: MarketplaceSourceLocal } | { error: string } {
  if (!raw.startsWith("./")) return { error: "local source path must start with ./" };
  if (hasTraversal(raw)) return { error: "local source path must not contain .. segments" };
  const candidate = path.resolve(marketplaceRoot, raw);
  const realRoot = realpathOrNull(marketplaceRoot);
  const realCandidate = realpathOrNull(candidate);
  if (realRoot !== null && realCandidate !== null && !isInside(realCandidate, realRoot)) {
    return { error: "local source path escapes the marketplace root" };
  }
  return { source: { type: "local", path: candidate } };
}

function hasTraversal(value: string): boolean {
  return value.split(/[\\/]/).some((segment) => segment === "..");
}

/** Git refs must not be option-like or traversal-like. */
export function isSafeGitRef(ref: string): boolean {
  return (
    ref !== "" &&
    !ref.startsWith("-") &&
    !ref.includes("..") &&
    SAFE_REF_PATTERN.test(ref) &&
    !ref.endsWith("/") &&
    !ref.endsWith(".")
  );
}

/** Normalize `owner/repo` shorthand and reject unsafe git URLs. */
export function normalizeGitUrl(raw: string): { url: string } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { error: "git url must not be empty" };
  if (trimmed.startsWith("-")) return { error: "git url must not start with a dash" };
  if (/^[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/i.test(trimmed)) {
    const [owner, repo] = trimmed.split("/");
    const cleanRepo = repo.endsWith(".git") ? repo.slice(0, -4) : repo;
    return { url: `https://github.com/${owner}/${cleanRepo}.git` };
  }
  if (/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(trimmed)) {
    return { url: trimmed };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: `invalid git url ${JSON.stringify(trimmed)}` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    return { error: `unsupported git protocol ${parsed.protocol} (https or ssh only)` };
  }
  if (parsed.password !== "" || (parsed.username !== "" && parsed.protocol === "https:")) {
    return { error: "git url must not embed credentials" };
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    return { error: "git url must not contain a query or fragment (use ref/sha fields)" };
  }
  return { url: trimmed };
}

/* ------------------------------ installation ------------------------------ */
