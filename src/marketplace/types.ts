/**
 * opencode-agent-plugins — marketplace model types.
 */

import type { Problem } from "../types.ts";

export interface MarketplaceSourceLocal {
  type: "local";
  path: string;
}

export interface MarketplaceSourceGit {
  type: "url" | "git-subdir";
  url: string;
  path?: string;
  ref?: string;
  sha?: string;
}

export interface MarketplaceSourceNpm {
  type: "npm";
  package: string;
  version?: string;
  registry?: string;
}

export type MarketplaceSource =
  | MarketplaceSourceLocal
  | MarketplaceSourceGit
  | MarketplaceSourceNpm;

export interface MarketplaceEntry {
  name: string;
  source: MarketplaceSource;
  category?: string;
  installation?: "AVAILABLE" | "INSTALLED_BY_DEFAULT" | "NOT_AVAILABLE";
  authentication?: "ON_INSTALL" | "ON_USE";
  description?: string;
  version?: string;
}

export interface Marketplace {
  /** Realpath of the directory owning `.agents/plugins/marketplace.json`. */
  root: string;
  file: string;
  name: string;
  displayName?: string;
  entries: MarketplaceEntry[];
  problems: Problem[];
}

export interface Provenance {
  name: string;
  marketplace: string;
  source: MarketplaceSourceGit;
  commit: string;
  installedAt: string;
}

export const MARKETPLACE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const SAFE_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;
export const SAFE_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

export const INSTALLATION_VALUES = new Set(["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"]);
export const AUTHENTICATION_VALUES = new Set(["ON_INSTALL", "ON_USE"]);

export interface MarketplaceDiscovery {
  marketplaces: Marketplace[];
  problems: Problem[];
}

export interface Installer {
  /** Run git with an argument array (never a shell). */
  git(args: string[], cwd: string): Promise<{ code: number; output: string }>;
  /** Root of the managed install store. */
  storeRoot: string;
  /** Project directory used to resolve npm sources. */
  projectDir: string;
  now?(): Date;
}

export interface InstallResult {
  ok: boolean;
  directory?: string;
  commit?: string;
  message: string;
}
