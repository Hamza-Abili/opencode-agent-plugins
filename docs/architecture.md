# Architecture

The plugin is deliberately split into a host-agnostic core and two thin
adapters. The core owns every portable rule; adapters only translate those
rules into what each OpenCode line understands.

```text
src/
├── types.ts            shared model (manifest, skills, MCP entries, options)
├── fs.ts               realpath containment helpers, JSON reads, XDG paths
├── frontmatter.ts      SKILL.md frontmatter (flat subset + block scalars)
├── manifest.ts         plugin.json validation (1.0.0 rules in code)
├── skills.ts           skills/ discovery and per-skill failure isolation
├── mcp.ts              mcp.json validation + mapping (containment, variables)
├── discovery.ts        scanning, plugin loading, client-extension diagnostics
├── options.ts          v2 object options / v1 environment options
├── packages.ts         npm package resolution (project node_modules, cache)
├── marketplace/        catalog parse, managed store, install/update
├── legacy.ts           OpenCode v1 adapter (factory + skill symlink farm)
├── v2/                 OpenCode v2 adapter
│   ├── host.ts         structural host surfaces (probed, degradable)
│   ├── state.ts        plugin state, canonical ids, alias resolution
│   ├── format.ts       pure command output
│   ├── storage.ts      enabled set + installed sources persistence
│   ├── reload.ts       discovery reload and registry reconcile
│   ├── commands.ts     /ap command layer (the only install entry point)
│   ├── git.ts          argument-array git runner (timeout, fallbacks)
│   └── app.ts          registration + application entry
├── index.ts            v2 plugin entry
└── v2.ts, marketplace.ts  compatibility barrels
```

## Invariants

1. **Core has no OpenCode imports.** Everything under the core modules is
   plain Node/Bun code with no host dependency, so it is unit-tested directly.
2. **Adapters probe, never assume.** A missing `ctx.skill` / `ctx.mcp` /
   `ctx.command` / `ctx.storage` surface degrades to a warning; setup never
   throws into the host.
3. **Containment is realpath-based and checked before reads.** `plugin.json`,
   `skills/`, `SKILL.md`, `mcp.json` must resolve inside the plugin root;
   `./` commands must be regular files inside it and are emitted as absolute
   resolved paths; `cwd` must exist (or is created under `PLUGIN_DATA`) and is emitted as a realpath.
4. **MCP servers are opt-in.** The v2 transform always sets `disabled: true`
   unless the user enabled the canonical `<slug>::<server>` id. `enabledMcp` is
a session seed; explicit enables/disables persist in one versioned value and
a disable wins. Aliases that resolve to more than one server fail closed.
5. **User configuration wins.** Colliding skill ids and MCP names are skipped,
   never overwritten. The v1 adapter never edits `opencode.json`; the v2
   adapter registers through transforms only.
6. **Installs are explicit and atomic.** Only `/ap install` runs git; clones
   are validated with the full loader, copied through staging, swapped with a
   backup, and recorded with provenance. Crash leftovers are recovered or
   removed at startup.
7. **No runtime dependencies.** The published package imports only Node/Bun
   built-ins and host-resolved module specifiers.
8. **Client extensions are reported, never executed.** `ai.opencode/` is not
   loaded: a package that ships only those components gets one warning naming
   them, while a package that also contributes skills or MCP servers stays
   silent about the unloaded components. The namespace is contained like every
   other package path before it is listed, so a malformed path is still
   reported.

## Testing

- `bun test` — the full unit/regression suite over the core and both adapters,
  including a fake host that reproduces transform replay semantics.
- `bun run smoke` — live test against an installed OpenCode binary in an
  isolated HOME/XDG environment: verifies a real skill registration and the
  MCP `disabled` status. Not part of CI (needs the binary).
- `AGENT_PLUGINS_TRACE=/path` writes a JSONL trace of discovery and MCP
  registration for field debugging; it is inert when unset.
