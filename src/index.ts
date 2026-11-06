/**
 * opencode-agent-plugins — OpenCode v2 plugin entry.
 *
 * Contract (opencode v2): default export `{ id, setup }`; `setup` may be
 * async and returns a dispose function. OpenCode 2.x passes the client
 * directly, while early builds passed a promise — both are accepted.
 *
 * A failure inside `setup` must never break the host: the loader degrades
 * to a no-op plugin and reports through the logger.
 */

import { logger } from "./log.ts";
import { createV2App, type V2Context } from "./v2.ts";

function isPromiseLike(value: unknown): value is PromiseLike<V2Context> {
  return typeof (value as { then?: unknown } | undefined)?.then === "function";
}

export default {
  id: "opencode-agent-plugins",
  async setup(clientInput: unknown) {
    try {
      const ctx = isPromiseLike(clientInput) ? await clientInput : (clientInput as V2Context);
      const app = await createV2App(ctx);
      return () => app.dispose();
    } catch (error) {
      logger.error(`setup failed — plugin disabled: ${String(error)}`);
      return () => {};
    }
  },
};
