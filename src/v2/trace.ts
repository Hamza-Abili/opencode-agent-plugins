/**
 * opencode-agent-plugins — opt-in diagnostics.
 *
 * `AGENT_PLUGINS_TRACE=/path` appends one JSON object per line. Inert when
 * unset; never lets a tracing failure affect plugin loading. Only messages,
 * never configuration payloads, are written.
 */

import fs from "node:fs";

export function trace(step: string, data?: Record<string, unknown>): void {
  const file = process.env.AGENT_PLUGINS_TRACE;
  if (file === undefined || file === "") return;
  try {
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), step, data })}\n`);
  } catch {
    // tracing must never affect loading
  }
}
