/**
 * opencode-agent-plugins — plugin.json (manifest) validation.
 *
 * Implements the Agent Plugins 1.0.0 loading rules with the canonical schema
 * semantics expressed in code (nothing is fetched at runtime):
 *
 * - `$schema` must be exactly the 1.0.0 manifest identifier; a missing or
 *   unsupported `$schema` rejects the plugin. Schemas are never fetched.
 * - `name` is required and constrained by the schema pattern.
 * - Unknown top-level fields and a non-object `extensions` field are
 *   non-fatal per the specification: report and continue.
 * - Every other schema violation rejects the complete plugin.
 */

import path from "node:path";
import { isInside, realpathOrNull } from "./fs.ts";
import type { PluginManifest, Problem } from "./types.ts";

export const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

const KNOWN_TOP_LEVEL = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

const KNOWN_AUTHOR_FIELDS = new Set(["name", "email", "url"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ManifestResult {
  manifest?: PluginManifest;
  problems: Problem[];
}

/**
 * Validate a parsed plugin.json. `root` is the plugin root (used only for
 * the plugin.json containment boundary, which is checked separately by the
 * caller via `manifestEscapesRoot`).
 */
export function validateManifest(raw: unknown): ManifestResult {
  const problems: Problem[] = [];

  if (!isRecord(raw)) {
    return { problems: [{ level: "error", message: "plugin.json must be a JSON object" }] };
  }

  // --- $schema (fatal when missing or unsupported) ---
  const schema = raw.$schema;
  if (typeof schema !== "string" || schema === "") {
    problems.push({
      level: "error",
      message: "plugin.json is missing the required $schema field",
    });
  } else if (schema !== PLUGIN_SCHEMA) {
    problems.push({
      level: "error",
      message: `unsupported $schema ${JSON.stringify(schema)} (supported: ${PLUGIN_SCHEMA})`,
    });
  }

  // --- name (fatal when invalid) ---
  const name = raw.name;
  if (typeof name !== "string" || name === "" || name.length > 64 || !NAME_PATTERN.test(name)) {
    problems.push({
      level: "error",
      message: "plugin.json name must be a 1-64 char slug matching the Agent Plugins pattern",
    });
  }

  // --- optional string fields (schema violations are fatal) ---
  for (const field of ["version", "description", "homepage", "repository", "license"] as const) {
    const value = raw[field];
    if (value !== undefined && typeof value !== "string") {
      problems.push({ level: "error", message: `plugin.json ${field} must be a string` });
    }
  }

  // --- author (object with string fields; unknown keys are fatal) ---
  if (raw.author !== undefined) {
    if (!isRecord(raw.author)) {
      problems.push({ level: "error", message: "plugin.json author must be an object" });
    } else {
      for (const [key, value] of Object.entries(raw.author)) {
        if (!KNOWN_AUTHOR_FIELDS.has(key)) {
          problems.push({ level: "error", message: `plugin.json author has unknown field ${key}` });
        } else if (typeof value !== "string") {
          problems.push({ level: "error", message: `plugin.json author.${key} must be a string` });
        }
      }
    }
  }

  // --- keywords (array of strings) ---
  if (raw.keywords !== undefined) {
    const ok =
      Array.isArray(raw.keywords) && raw.keywords.every((item) => typeof item === "string");
    if (!ok) {
      problems.push({
        level: "error",
        message: "plugin.json keywords must be an array of strings",
      });
    }
  }

  // --- extensions (non-object is non-fatal; contents never validated) ---
  if (raw.extensions !== undefined && !isRecord(raw.extensions)) {
    problems.push({
      level: "warning",
      message: "plugin.json extensions must be an object — ignored",
    });
  }

  // --- unknown top-level fields (non-fatal per specification) ---
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      problems.push({
        level: "warning",
        message: `plugin.json has unknown top-level field ${JSON.stringify(key)} — ignored`,
      });
    }
  }

  const fatal = problems.some((problem) => problem.level === "error");
  if (fatal) return { problems };

  const manifest: PluginManifest = { name: name as string };
  for (const field of ["version", "description", "homepage", "repository", "license"] as const) {
    const value = raw[field];
    if (typeof value === "string") manifest[field] = value;
  }
  if (isRecord(raw.author)) {
    const author: PluginManifest["author"] = {};
    for (const field of ["name", "email", "url"] as const) {
      const value = raw.author[field];
      if (typeof value === "string") author[field] = value;
    }
    manifest.author = author;
  }
  if (Array.isArray(raw.keywords)) {
    manifest.keywords = raw.keywords as string[];
  }

  return { manifest, problems };
}

/**
 * Path failure boundary #1: the manifest file must resolve inside the
 * plugin root. Returns a fatal problem when it escapes.
 */
export function manifestEscapesRoot(manifestFile: string, root: string): Problem | null {
  const realFile = realpathOrNull(manifestFile);
  const realRoot = realpathOrNull(root);
  if (realFile === null || realRoot === null || !isInside(realFile, realRoot)) {
    return {
      level: "error",
      message: `plugin.json (${path.resolve(manifestFile)}) resolves outside the plugin root`,
    };
  }
  return null;
}
