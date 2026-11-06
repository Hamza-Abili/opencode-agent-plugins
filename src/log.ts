/**
 * opencode-agent-plugins — leveled logger.
 *
 * OpenCode captures plugin console output; we keep a single prefix and an
 * ordered level so users can raise/lower noise without losing structure.
 */

import type { LogLevel } from "./types.ts";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let current: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function write(level: LogLevel, message: string): void {
  if (ORDER[level] < ORDER[current]) return;
  const line = `[opencode-agent-plugins] [${level}] ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string) => write("debug", message),
  info: (message: string) => write("info", message),
  warn: (message: string) => write("warn", message),
  error: (message: string) => write("error", message),
};
