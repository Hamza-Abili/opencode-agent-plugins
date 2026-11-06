/**
 * opencode-agent-plugins — mcp.json parsing and mapping.
 *
 * Two stages per the specification:
 *
 * 1. Top-level validation: a regular `mcp.json` inside the plugin root, valid
 *    JSON, the 1.0.0 MCP schema identifier, a required `mcpServers` object,
 *    and no unknown top-level fields. A top-level failure disables the MCP
 *    component for that plugin (the rest of the plugin still loads).
 * 2. Per-entry validation against the declared transport. An invalid entry
 *    skips only that entry. `stdio` and `streamable-http` are supported;
 *    legacy `sse` is valid but unsupported and is skipped with a warning.
 *
 * Mapping to OpenCode (`mapMcpServer`) enforces the runtime rules:
 * `./` commands resolve against the plugin root, are containment-checked and
 * emitted as absolute paths (so the spawn cwd cannot change what runs);
 * `cwd` is resolved and containment-checked against the plugin root or the
 * plugin data directory; `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` expand in
 * args/env/cwd (never in `command`); PLUGIN_ROOT / PLUGIN_DATA are set
 * client-side (never taken from the plugin's own `env`).
 */

import fs from "node:fs";
import path from "node:path";
import { isInside, readJSON, realpathOrNull, resolvedInside } from "./fs.ts";
import type { McpServer, OpenCodeMcpConfig, Problem } from "./types.ts";

export const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const RESERVED_ENV_KEYS = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);

/** Schema pattern for portable `cwd` values. */
const CWD_PATTERN = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;

/** A bare command token: an executable name, no separators or variables. */
const BARE_COMMAND_PATTERN = /^[A-Za-z0-9._-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

export function parseMcp(root: string): { servers: McpServer[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const servers: McpServer[] = [];

  // --- component location: regular file, inside the plugin root ---
  const mcpFile = path.join(root, "mcp.json");
  const stat = lstatOrNull(mcpFile);
  if (stat === null) return { servers, problems }; // absent is fine
  const realFile = resolvedInside(mcpFile, root);
  if (realFile === null) {
    problems.push({
      level: "warning",
      message: "mcp.json resolves outside the plugin root — MCP disabled for this plugin",
    });
    return { servers, problems };
  }
  const realStat = lstatOrNull(realFile);
  if (realStat === null || !realStat.isFile()) {
    problems.push({
      level: "warning",
      message: "mcp.json is not a regular file — MCP disabled for this plugin",
    });
    return { servers, problems };
  }

  const parsed = readJSON(realFile);
  if (parsed.error !== undefined) {
    problems.push({
      level: "warning",
      message: `mcp.json is not valid JSON (${parsed.error}) — MCP disabled for this plugin`,
    });
    return { servers, problems };
  }

  const doc = parsed.value;
  if (!isRecord(doc)) {
    problems.push({ level: "warning", message: "mcp.json must be a JSON object — MCP disabled" });
    return { servers, problems };
  }

  // --- top-level validation ---
  const topLevelProblems: string[] = [];
  const schema = doc.$schema;
  if (schema !== MCP_SCHEMA) {
    topLevelProblems.push(
      typeof schema === "string" && schema !== ""
        ? `unsupported $schema ${JSON.stringify(schema)}`
        : "missing $schema"
    );
  }
  if (!isRecord(doc.mcpServers)) topLevelProblems.push("missing mcpServers object");
  for (const key of Object.keys(doc)) {
    if (key !== "$schema" && key !== "mcpServers") {
      topLevelProblems.push(`unknown top-level field ${JSON.stringify(key)}`);
    }
  }
  if (topLevelProblems.length > 0) {
    problems.push({
      level: "warning",
      message: `mcp.json invalid (${topLevelProblems.join("; ")}) — MCP disabled for this plugin`,
    });
    return { servers, problems };
  }

  // --- per-entry validation ---
  const entries = doc.mcpServers as Record<string, unknown>;
  for (const [name, entry] of Object.entries(entries)) {
    const parsedEntry = validateServerEntry(name, entry);
    if ("error" in parsedEntry) {
      problems.push({
        level: "warning",
        message: `mcp server ${JSON.stringify(name)}: ${parsedEntry.error} — skipped`,
      });
      continue;
    }
    if (parsedEntry.server.type === "sse") {
      problems.push({
        level: "warning",
        message: `mcp server ${JSON.stringify(name)}: legacy sse transport is not supported — skipped`,
      });
      continue;
    }
    servers.push(parsedEntry.server);
  }

  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { servers, problems };
}

type ServerEntryResult = { server: McpServer } | { error: string };

function validateServerEntry(name: string, entry: unknown): ServerEntryResult {
  if (!isRecord(entry)) return { error: "entry must be a JSON object" };
  const type = entry.type;
  if (type !== "stdio" && type !== "streamable-http" && type !== "sse") {
    return { error: `unknown or missing transport type ${JSON.stringify(String(type))}` };
  }

  if (type === "stdio") {
    if (typeof entry.command !== "string" || entry.command === "") {
      return { error: "stdio server requires a non-empty command string" };
    }
    const command = entry.command;
    // Portable command rules: one token, either a bare executable name or a
    // `./` path. Variables, separators, whitespace, `..`, and absolute
    // paths are not portable and are rejected here.
    if (command.startsWith("./")) {
      if (command.split("/").some((segment) => segment === "..")) {
        return { error: "command must not contain .. segments" };
      }
      if (/\s/.test(command)) return { error: "command must be a single token" };
    } else if (!BARE_COMMAND_PATTERN.test(command)) {
      return { error: "command must be a bare executable name or a ./ path" };
    }
    if (entry.args !== undefined) {
      if (!Array.isArray(entry.args) || !entry.args.every((item) => typeof item === "string")) {
        return { error: "args must be an array of strings" };
      }
    }
    if (entry.env !== undefined) {
      if (
        !isRecord(entry.env) ||
        !Object.values(entry.env).every((item) => typeof item === "string")
      ) {
        return { error: "env must be an object of string values" };
      }
      for (const key of Object.keys(entry.env)) {
        if (RESERVED_ENV_KEYS.has(key)) {
          return { error: `env must not set reserved variable ${key} (it is client-controlled)` };
        }
      }
    }
    if (entry.cwd !== undefined) {
      if (typeof entry.cwd !== "string" || !CWD_PATTERN.test(entry.cwd)) {
        return { error: "cwd must start with ./, ${PLUGIN_ROOT}, or ${PLUGIN_DATA}" };
      }
      if (entry.cwd.split(/[\\/]/).some((segment) => segment === "..")) {
        return { error: "cwd must not contain .. segments" };
      }
    }
    const unknown = Object.keys(entry).filter(
      (key) => !["type", "command", "args", "env", "cwd"].includes(key)
    );
    if (unknown.length > 0)
      return { error: `unknown field(s) ${unknown.map((k) => JSON.stringify(k)).join(", ")}` };
    return {
      server: {
        name,
        type: "stdio",
        command,
        args: entry.args as string[] | undefined,
        env: entry.env as Record<string, string> | undefined,
        cwd: entry.cwd as string | undefined,
      },
    };
  }

  // streamable-http and sse share the url/headers shape
  if (typeof entry.url !== "string" || entry.url === "") {
    return { error: `${type} server requires a non-empty url string` };
  }
  if (entry.headers !== undefined) {
    if (
      !isRecord(entry.headers) ||
      !Object.values(entry.headers).every((item) => typeof item === "string")
    ) {
      return { error: "headers must be an object of string values" };
    }
  }
  const unknown = Object.keys(entry).filter((key) => !["type", "url", "headers"].includes(key));
  if (unknown.length > 0)
    return { error: `unknown field(s) ${unknown.map((k) => JSON.stringify(k)).join(", ")}` };
  return {
    server: {
      name,
      type,
      url: entry.url,
      headers: entry.headers as Record<string, string> | undefined,
    },
  };
}

/**
 * Expand plugin variables. Only ${PLUGIN_ROOT} and ${PLUGIN_DATA} are
 * defined by the specification.
 */
export function expandVariables(value: string, root: string, dataDir: string): string {
  return value.replaceAll("${PLUGIN_ROOT}", root).replaceAll("${PLUGIN_DATA}", dataDir);
}

export type McpMappingResult = { config: OpenCodeMcpConfig } | { error: string };

/**
 * Map a validated MCP entry to an OpenCode configuration value.
 * `./` commands become absolute (post-containment) paths so the runtime cwd
 * can never redirect which executable runs; `cwd` is containment-checked.
 */
export function mapMcpServer(server: McpServer, root: string, dataDir: string): McpMappingResult {
  if (server.type === "stdio") {
    const command = server.command ?? "";
    const args = server.args ?? [];

    // Defense in depth: parse validation rejects these, but a caller that
    // constructs McpServer objects directly must not bypass the rules.
    if (command.includes("${") || /\s/.test(command)) {
      return {
        error: `command ${JSON.stringify(command)} must be a single token without variables`,
      };
    }
    if (!command.startsWith("./") && !BARE_COMMAND_PATTERN.test(command)) {
      return {
        error: `command ${JSON.stringify(command)} must be a bare executable name or a ./ path`,
      };
    }
    if (command.split("/").some((segment) => segment === "..")) {
      return { error: `command ${JSON.stringify(command)} must not contain .. segments` };
    }

    let commandToken = command;
    if (command.startsWith("./")) {
      const candidate = path.join(root, command);
      const realRoot = realpathOrNull(root) ?? root;
      const realCommand = realpathOrNull(candidate);
      if (realCommand !== null) {
        if (!isInside(realCommand, realRoot)) {
          return { error: `command ${JSON.stringify(command)} resolves outside the plugin root` };
        }
        const commandStat = lstatOrNull(realCommand);
        if (commandStat === null || !commandStat.isFile()) {
          return { error: `command ${JSON.stringify(command)} is not a regular file` };
        }
        commandToken = realCommand;
      } else {
        // A ./ command must exist as a regular file inside the root: the
        // executable is what will be spawned, so it cannot be frozen
        // lexically without a TOCTOU window.
        return {
          error: `command ${JSON.stringify(command)} does not resolve to an existing file inside the plugin root`,
        };
      }
    }

    const commandTokens = [commandToken];
    for (const arg of args) commandTokens.push(expandVariables(arg, root, dataDir));

    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.env ?? {})) {
      environment[key] = expandVariables(value, root, dataDir);
    }
    // Client-controlled variables are set last, as required by the spec.
    environment.PLUGIN_ROOT = root;
    environment.PLUGIN_DATA = dataDir;

    const cwdResult = resolveCwd(server.cwd, root, dataDir);
    if ("error" in cwdResult) return cwdResult;

    return { config: { type: "local", command: commandTokens, environment, cwd: cwdResult.cwd } };
  }

  if (server.type === "streamable-http") {
    const url = server.url ?? "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: `url ${JSON.stringify(url)} is not a valid URL` };
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return { error: `url ${JSON.stringify(url)} must not embed credentials` };
    }
    if (parsed.hash !== "" || parsed.search !== "") {
      return { error: `url ${JSON.stringify(url)} must not contain a query or fragment` };
    }
    if (
      parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
    ) {
      return {
        error: `url ${JSON.stringify(url)} must use https (http is allowed on loopback only)`,
      };
    }
    // Optional fields must be absent, not undefined: the host validates the
    // object against its schema and undefined is not an object.
    const config: OpenCodeMcpConfig = { type: "remote", url };
    if (server.headers !== undefined) config.headers = server.headers;
    return { config };
  }

  return { error: `transport ${server.type} is not supported` };
}

/** Realpath of the deepest existing ancestor of `candidate`, or null. */
function deepestExistingAncestor(candidate: string): string | null {
  let probe = candidate;
  for (;;) {
    const real = realpathOrNull(probe);
    if (real !== null) return real;
    const parent = path.dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/**
 * Resolve and contain the working directory. Every form must exist at map
 * time and is emitted as its realpath, so a later leaf replacement cannot
 * redirect the spawn cwd. `${PLUGIN_DATA}` subdirectories are client-owned
 * and created here when missing.
 */
function resolveCwd(
  cwd: string | undefined,
  root: string,
  dataDir: string
): { cwd: string } | { error: string } {
  if (cwd === undefined || cwd === "./" || cwd === ".") return { cwd: root };

  let candidate: string;
  let boundary: string;
  if (cwd.startsWith("./")) {
    candidate = path.normalize(path.join(root, cwd.slice(2)));
    boundary = root;
  } else if (cwd === "${PLUGIN_ROOT}" || cwd.startsWith("${PLUGIN_ROOT}/")) {
    candidate = path.normalize(expandVariables(cwd, root, dataDir));
    boundary = root;
  } else if (cwd === "${PLUGIN_DATA}" || cwd.startsWith("${PLUGIN_DATA}/")) {
    candidate = path.normalize(expandVariables(cwd, root, dataDir));
    boundary = dataDir;
    // Validate the deepest existing ancestor BEFORE creating anything, so a
    // symlinked parent cannot make us create a directory outside PLUGIN_DATA.
    const realBoundary = realpathOrNull(dataDir) ?? dataDir;
    const ancestor = deepestExistingAncestor(candidate);
    if (ancestor === null || !isInside(ancestor, realBoundary)) {
      return { error: `cwd ${JSON.stringify(cwd)} resolves outside its permitted root` };
    }
    try {
      fs.mkdirSync(candidate, { recursive: true });
    } catch (error) {
      return { error: `cwd ${JSON.stringify(cwd)} cannot be created: ${String(error)}` };
    }
  } else {
    return { error: `cwd ${JSON.stringify(cwd)} is not a supported plugin-relative form` };
  }

  const realBoundary = realpathOrNull(boundary) ?? boundary;
  const realCandidate = realpathOrNull(candidate);
  if (realCandidate === null) {
    return { error: `cwd ${JSON.stringify(cwd)} does not exist` };
  }
  if (!isInside(realCandidate, realBoundary)) {
    return { error: `cwd ${JSON.stringify(cwd)} resolves outside its permitted root` };
  }
  return { cwd: realCandidate };
}
