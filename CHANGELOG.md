# Changelog

## Unreleased — compatibility watchdog automation

- `upstream-watch` now closes its own compatibility loop: it installs the
  exact new OpenCode version, runs `bun run compat` (CI plus live smoke),
  moves the `tested on X.Y.Z;` README anchor with a docs-only commit,
  comments the evidence and closes the issue. A failed check leaves the
  issue open for the next scheduled run; the anchor never moves backwards.

## 1.3.1 — packaging and discoverability only

- No runtime changes: `src/` and `index.ts` are identical to 1.3.0.
- Added `homepage` and search keywords (`agent-skills`, `marketplace`,
  `plugin-manager`) to `package.json`, and a short cross-link section for the
  other plugins by the same author.

## 1.3.0 — unloaded client extensions are reported

- A package that ships only `ai.opencode/` client extensions (JS entry,
  agents, commands, modes, hooks) now gets one warning naming the components,
  instead of loading nothing and saying nothing. Packages that also ship
  skills or MCP servers stay silent: they already contribute, and the warning
  would turn into a false alarm once core loads the namespace.
- The namespace is realpath-contained before it is listed, and only entry
  names are read: escaping, dangling and unreadable namespaces are reported
  without being listed.
- 192 tests (was 183).

## 1.2.0 — closing the two accepted limitations

- `cwd` no longer has a lexical fallback: plugin-root forms must exist and
  `${PLUGIN_DATA}` forms are created client-side, then both are contained and
  emitted as realpaths. A missing leaf is rejected instead of frozen.
- `enabledMcp` is now a session seed, not persisted state. Explicit decisions
  live in one versioned `mcp-state` value (`{version, enabled, disabled}`),
  so writes are atomic, removing an option disables a seeded server, and
  `/ap disable` wins over the seed across restarts. Legacy two-key storage is
  migrated once (option-derived entries removed); canonical ids take
  precedence over shadowing short names, and an ambiguous persisted disable
  disables every candidate rather than fail open.
- 183 tests; live smoke unchanged and re-run before release.


## 1.1.1 — packaging only

- `docs/` is contributor documentation: it stays in the repository but is no
  longer shipped in the npm tarball.
- The README architecture link is absolute, so it also works on npm.
- No code or behavior changes (173 tests unchanged).


## 1.1.0 — live-host hardening and module split

- Fixed a real-host schema rejection: remote MCP configs no longer include
  `headers: undefined`; the v2 host validates the object and threw
  `SchemaError(Expected object at ["headers"])`, silently skipping the server.
  Optional fields are now omitted when absent.
- MCP transforms are reconciled once at startup (`ctx.mcp.reload()`), because
  the host applies them lazily; registration is materialized before the first
  session.
- Added a live smoke test (`bun run smoke`) that runs the plugin against a real
  OpenCode binary in an isolated HOME/XDG environment and asserts a registered
  skill plus the trust-first `disabled` MCP status (verified on 2.2.5).
- Added opt-in JSONL tracing (`AGENT_PLUGINS_TRACE=/path`) for field debugging.
- Split the two monoliths into cohesive modules: `src/marketplace/`
  (types, parse, store, install) and `src/v2/` (host, state, format, storage,
  reload, commands, git, app); the old paths are compatibility barrels.
- Internal-only refactor: public behavior unchanged; 173 tests.


## 1.0.0 — full Agent Plugins client: discovery, trust-first MCP, marketplace, npm sources

- Agent Plugins 1.0.0 client for OpenCode v1 and v2, zero runtime dependencies.
- Auto-discovery from `~/.agents/plugins/**` (global, incl. XDG data dir) and
  `<project>/.agents/plugins/**` walked up to the git worktree root, with
  realpath deduplication and configurable extra directories.
- Spec-conformant loading with the canonical 1.0.0 failure boundaries
  (semantics implemented in code, nothing fetched at runtime): fatal manifest
  violations reject the plugin; unknown top-level fields and non-object
  `extensions` are non-fatal warnings; `mcp.json` must be a regular file
  inside the plugin root; invalid MCP entries skip that entry only; legacy
  `sse` is skipped with a warning.
- Containment for every package path (realpath after symlink resolution):
  `plugin.json`, `skills/`, each `SKILL.md`, `mcp.json`, `./` MCP commands
  (emitted as absolute paths so the spawn cwd cannot redirect execution) and
  `cwd` (root or `PLUGIN_DATA`). `../` and out-of-root absolute paths are
  rejected; `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` never expand in `command` and
  are always set client-side last.
- Remote MCP URLs require https (http only on loopback), without embedded
  credentials, query or fragment.
- v2: skills through the native skill transform; MCP servers through the MCP
  transform with the host's real contract (`disabled: true`) until explicitly
  enabled; enabled state is
  keyed by a canonical `<plugin>::<server>` identity and persisted through
  plugin storage; collisions with user configuration are skipped, never
  overwritten; every transform is isolated so one failure cannot disable the
  rest.
- v2 commands: `/ap status`, `list`, `enable`, `disable`, `marketplace`,
  `install`, `update`, `uninstall`, `packages`, `reload`; ambiguous names are
  reported instead of guessed.
- Marketplace catalogs (`.agents/plugins/marketplace.json`, Codex-compatible)
  with per-entry failure isolation; `local`, `url`, `git-subdir` and `npm`
  sources. Installs run only on explicit command, accept https/ssh git URLs
  without credentials/query/fragment, validate the target as an Agent Plugin
  before completing, copy through a staging path (never a half-installed
  directory), pin the resolved commit and record provenance; `update` reports
  old → new commit; `uninstall` only removes directories inside the managed
  store.
- npm-shipped Agent Plugins: the `packages` option resolves bundled plugins
  from the project's `node_modules` (the missing `skills.paths` wiring for
  packages such as `@dodopayments/opencode-plugin`).
- v1 (`./legacy`): skills through a state-tracked symlink farm that only
  touches entries it created (dangling entries included), replaces its own
  link when a skill source changes and never adopts an untracked link;
  `AGENT_PLUGINS_PACKAGES` loads npm-shipped plugins; MCP servers surfaced as
  an explicit opt-in config block (duplicate names keep the first entry),
  gated by `AGENT_PLUGINS_MCP`; the adapter never edits user configuration.
- 170 tests: validation/discovery/mapping units, every containment escape
  (manifest, `skills/` directory, `SKILL.md`, `mcp.json`, `./` command with
  symlinked parents, cwd), marketplace parsing, install/update/uninstall
  lifecycles (including failed-fetch and provenance-failure rollback, and
  refusal of post-parse local escapes), npm resolution, registration
  isolation, the v1 skill farm (ownership, replacement, dangling links,
  read-only directories, kill switches across recorded directories) and both
  adapters.
