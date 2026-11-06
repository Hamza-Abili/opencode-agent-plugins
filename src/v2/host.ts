/**
 * opencode-agent-plugins — OpenCode v2 host surfaces.
 *
 * Structural subsets of the plugin context. Every surface is probed at
 * runtime so an older host degrades instead of breaking.
 */

export interface V2SkillEditor {
  list(): readonly { id: string }[];
  add(skill: unknown): void;
}

export interface V2SkillCtx {
  transform(callback: (editor: V2SkillEditor) => void): Promise<unknown>;
  reload(): Promise<unknown>;
}

export interface V2McpEditor {
  get(name: string): unknown;
  set(name: string, config: unknown): void;
}

export interface V2McpCtx {
  transform(callback: (editor: V2McpEditor) => void): Promise<unknown>;
  reload(): Promise<unknown>;
}

export interface V2StorageCtx {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
}

export interface V2CommandEditor {
  add(command: {
    name: string;
    description?: string;
    execute(input: { sessionID: string; prompt: { text: string } }): Promise<void>;
  }): void;
}

export interface V2CommandCtx {
  transform(callback: (editor: V2CommandEditor) => void): Promise<unknown>;
}

export interface V2SessionCtx {
  synthetic(input: { sessionID: string; text: string }): Promise<unknown>;
}

export interface V2Context {
  location?: { directory?: string };
  options?: unknown;
  app?: { version?: string };
  skill?: V2SkillCtx;
  mcp?: V2McpCtx;
  storage?: V2StorageCtx;
  command?: V2CommandCtx;
  session?: V2SessionCtx;
}
