/**
 * opencode-agent-plugins — shared types.
 *
 * Everything here is host-agnostic: both the OpenCode v2 adapter and the v1
 * adapter consume the same discovery/validation model, so the interop rules
 * are implemented and tested exactly once.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** A validation finding. Errors reject a plugin/component; warnings do not. */
export interface Problem {
  level: "error" | "warning";
  message: string;
}

/** Subset of the Agent Plugins 1.0.0 manifest we consume. */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
}

/** A validated, loadable Agent Skill (SKILL.md). */
export interface AgentSkill {
  /** Skill name — also the directory name and the OpenCode skill id. */
  name: string;
  description: string;
  /** Absolute, symlink-resolved path of the SKILL.md file. */
  path: string;
  /** Raw SKILL.md contents. */
  content: string;
}

/**
 * A parsed, schema-valid MCP server entry from mcp.json. Values are still
 * in portable form (plugin variables unexpanded, `./` command unresolved).
 */
export interface McpServer {
  name: string;
  type: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * An MCP server entry mapped to an OpenCode configuration value. Produced by
 * `mapMcpServer`; `enabled` is deliberately absent — the adapters own it.
 */
export type OpenCodeMcpConfig =
  | {
      type: "local";
      command: string[];
      environment: Record<string, string>;
      cwd: string;
    }
  | {
      type: "remote";
      url: string;
      headers?: Record<string, string>;
    };

/** A fully discovered and validated Agent Plugin. */
export interface DiscoveredPlugin {
  /** Absolute, symlink-resolved plugin root. */
  root: string;
  /** Manifest name — safe as a filesystem slug and an OpenCode id. */
  slug: string;
  manifest: PluginManifest;
  skills: AgentSkill[];
  mcpServers: McpServer[];
  /** Non-fatal findings collected while loading this plugin. */
  problems: Problem[];
}

/** A candidate root that failed validation and was rejected as a whole. */
export interface RejectedPlugin {
  root: string;
  problems: Problem[];
}

export interface DiscoveryResult {
  plugins: DiscoveredPlugin[];
  rejected: RejectedPlugin[];
}

/** Resolved plugin options (v2 object options; v1 derives them from env). */
export interface PluginOptions {
  /** Directories scanned for Agent Plugins (defaults computed when empty). */
  directories: string[];
  /** Whether the directories came from explicit configuration. */
  directoriesExplicit: boolean;
  /** Load skills. */
  skills: boolean;
  /** Load MCP servers (registered disabled until explicitly enabled). */
  mcp: boolean;
  /** Namespace MCP server names as `<slug>-<server>`. */
  prefix: boolean;
  /** MCP server names to enable at startup. */
  enabledMcp: string[];
  logLevel: LogLevel;
  /** npm packages that carry a bundled Agent Plugin (resolved from node_modules). */
  packages: string[];
  /** Read `.agents/plugins/marketplace.json` catalogs. */
  marketplaces: boolean;
  /** Managed install store for marketplace entries. */
  installRoot: string;
}

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"] as const;

export const DEFAULT_OPTIONS: PluginOptions = {
  directories: [],
  directoriesExplicit: false,
  skills: true,
  mcp: true,
  prefix: false,
  enabledMcp: [],
  logLevel: "info",
  packages: [],
  marketplaces: true,
  installRoot: "",
};
