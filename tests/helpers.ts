/**
 * Test helpers — a fake OpenCode v2 plugin context.
 *
 * Mirrors the structural subset the v2 adapter consumes and reproduces the
 * host's transform semantics: every transform run (including `reload()`)
 * starts from a fresh working set seeded only with user-owned entries, and
 * re-applies the registered callback. This keeps collision checks honest —
 * the adapter's own previous registrations never count as collisions.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  V2CommandCtx,
  V2Context,
  V2McpCtx,
  V2SessionCtx,
  V2SkillCtx,
  V2StorageCtx,
} from "../src/v2.ts";

export interface FakeSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  content: string;
}

export interface FakeCommand {
  name: string;
  execute(input: { sessionID: string; prompt: { text: string } }): Promise<void>;
}

export interface FakeContext {
  ctx: V2Context;
  /** Seed a user-owned skill (counts as a collision for the adapter). */
  seedSkill(skill: FakeSkill): void;
  /** Seed a user-owned MCP server (counts as a collision for the adapter). */
  seedMcp(name: string, config: Record<string, unknown>): void;
  skills: Map<string, FakeSkill>;
  mcp: Map<string, Record<string, unknown>>;
  commands: FakeCommand[];
  storage: Map<string, unknown>;
  synthetic: string[];
  skillReloads: () => number;
  mcpReloads: () => number;
}

export function createFakeContext(directory: string, options: unknown = {}): FakeContext {
  const skillBase = new Map<string, FakeSkill>();
  const mcpBase = new Map<string, Record<string, unknown>>();
  const commands: FakeCommand[] = [];
  const storage = new Map<string, unknown>();
  const synthetic: string[] = [];
  const counters = { skill: 0, mcp: 0 };

  let skills = new Map<string, FakeSkill>();
  let mcp = new Map<string, Record<string, unknown>>();

  let skillCallback:
    | ((editor: { list(): { id: string }[]; add(skill: unknown): void }) => void)
    | null = null;
  let mcpCallback:
    | ((editor: { get(name: string): unknown; set(name: string, config: unknown): void }) => void)
    | null = null;

  const skillEditor = {
    list: () => [...skills.values()].map((skill) => ({ id: skill.id })),
    add: (skill: unknown) => {
      const added = skill as FakeSkill;
      skills.set(added.id, added);
    },
  };
  const mcpEditor = {
    get: (name: string) => mcp.get(name),
    set: (name: string, config: unknown) => {
      mcp.set(name, config as Record<string, unknown>);
    },
  };

  const runSkills = () => {
    skills = new Map(skillBase);
    skillCallback?.(skillEditor);
  };
  const runMcp = () => {
    mcp = new Map(mcpBase);
    mcpCallback?.(mcpEditor);
  };

  const skillCtx: V2SkillCtx = {
    transform: async (callback) => {
      skillCallback = callback;
      runSkills();
    },
    reload: async () => {
      counters.skill += 1;
      runSkills();
    },
  };
  const mcpCtx: V2McpCtx = {
    transform: async (callback) => {
      mcpCallback = callback;
      runMcp();
    },
    reload: async () => {
      counters.mcp += 1;
      runMcp();
    },
  };
  const storageCtx: V2StorageCtx = {
    get: async (key) => storage.get(key),
    set: async (key, value) => {
      storage.set(key, value);
    },
  };
  const commandCtx: V2CommandCtx = {
    transform: async (callback) => {
      callback({ add: (command) => commands.push(command) });
    },
  };
  const sessionCtx: V2SessionCtx = {
    synthetic: async ({ text }) => {
      synthetic.push(text);
    },
  };

  const ctx: V2Context = {
    location: { directory },
    options,
    app: { version: "2.2.5-test" },
    skill: skillCtx,
    mcp: mcpCtx,
    storage: storageCtx,
    command: commandCtx,
    session: sessionCtx,
  };

  return {
    ctx,
    seedSkill(skill) {
      skillBase.set(skill.id, skill);
      skills.set(skill.id, skill);
    },
    seedMcp(name, config) {
      mcpBase.set(name, config);
      mcp.set(name, config);
    },
    get skills() {
      return skills;
    },
    get mcp() {
      return mcp;
    },
    commands,
    storage,
    synthetic,
    skillReloads: () => counters.skill,
    mcpReloads: () => counters.mcp,
  };
}

/** Unique temp directory for a test, cleaned up via `using` (or manually). */
export function makeTempDir(prefix = "ocap-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export const FIXTURES = path.join(import.meta.dir, "fixtures", "plugins");
