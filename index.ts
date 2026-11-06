/**
 * Root re-export — keeps the plugin loadable whether the consumer resolves
 * `main` from package.json (`./src/index.ts`) or an `index.ts` at the root.
 */

export { default } from "./src/index.ts";
