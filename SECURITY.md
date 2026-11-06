# Security

Loading third-party packages into an agent that runs tools is a security
decision. This plugin's posture is the product.

## Model

- **Skills are inert data** (markdown + frontmatter). Loading a skill never
  executes code, but skill *content* enters the agent's context — treat it as
  untrusted prompt material, like any file an agent reads.
- **MCP servers are executable code** (local processes or remote endpoints).
  They are always registered **disabled**; enabling one (`/ap enable` or a
  pasted block on v1) is an explicit, per-server decision. `/ap enable` and
  `/ap disable` persist; `enabledMcp` is only a per-session seed.
- **Containment** (realpath, after symlink resolution):
  - `plugin.json` must resolve inside the plugin root, or the plugin is
    rejected.
  - `skills/`, each `SKILL.md` and `mcp.json` must resolve inside the plugin
    root, or that component/skill is skipped with a reported warning.
  - `./` MCP commands must exist as regular files inside the plugin root and are
    emitted as absolute post-containment paths, so the spawn `cwd` cannot
    redirect which executable runs. `../` and out-of-root absolute paths are
    rejected; bare commands resolve through `PATH` like any local tool.
  - `cwd` must exist and resolve inside the plugin root (plugin-relative and
    `${PLUGIN_ROOT}` forms) or inside the plugin data directory
    (`${PLUGIN_DATA}` forms, created when missing); `..` and escaping symlinks
    are rejected. The emitted value is always a realpath.
  - `env` may not set `PLUGIN_ROOT` or `PLUGIN_DATA`; the client sets them
    last, so a plugin can never re-point another server's runtime.
  - `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` are expanded in args/env/cwd only —
    never in `command`.
- **Remote MCP URLs** must use https; plain http is allowed on loopback only.
  Embedded credentials, query strings and fragments are rejected.
- **Marketplace installs** run only on explicit `/ap install`, accept
  https/ssh git URLs without credentials/query/fragment, reject `..`
  traversal and marketplace-root escapes, validate the target as an Agent
  Plugin before completing, install through a staging path (never a
  half-installed directory), pin the resolved commit, and record provenance.
  `uninstall` only removes directories inside the managed store.
- **No silent configuration mutation.** The v1 adapter only manages symlinks
  it created (state in `$XDG_DATA_HOME/opencode-agent-plugins/v1-skills.json`,
  recording both the source and the skills directory); it never edits
  `opencode.json`. The v2 adapter registers exclusively through plugin
  transforms.
- **User configuration always wins.** Skill ids and MCP server names that
  already exist are skipped, never overwritten.
- **Zero runtime dependencies** — no transitive supply chain.

## Known limitations

- Skill content is not sanitized; a malicious skill can try prompt injection
  against the agent (same exposure as any untrusted file an agent reads).
  Review skills before installing.
- On v1, MCP opt-in is a manual config edit; the plugin prints the block but
  does not verify it after you add it. The kill switches
  (`AGENT_PLUGINS_DISABLED`, `AGENT_PLUGINS_SKILLS=0`) remove owned links
  from the recorded and current skills directories, but a directory that is
  not writable at that moment keeps its ownership record for a later retry.
- Symlinked plugin directories are resolved before containment checks, so a
  plugin whose *root itself* is a symlink into another directory is loaded
  from its real location.
- `./` commands must exist as regular files and `cwd` must exist at map time;
  both are emitted as realpaths. Local/npm plugin trees are assumed not to be
  mutated concurrently by an attacker; only marketplace git installs are
  copied into a managed store.
- A marketplace entry's `policy.authentication` is informational: this client
  never auto-authenticates or auto-enables anything.

## Reporting

Report vulnerabilities privately via GitHub's "Report a vulnerability" flow
on the repository. Do not open a public issue for suspected vulnerabilities.
