# Distribution notes

Prepared submission payloads. Both directories are curated; submit only when
the project has real usage.

## opencode.cafe

Submission page: <https://opencode.cafe/submit> (Clerk login required).

| Field | Value |
| --- | --- |
| Type | `plugin` |
| Product ID | `@hamzaabili/opencode-agent-plugins` |
| Display name | `Agent Plugins for OpenCode` |
| Repository | `https://github.com/Hamza-Abili/opencode-agent-plugins` |
| Homepage | `https://www.npmjs.com/package/@hamzaabili/opencode-agent-plugins` |
| Tags | `agent-plugins, skills, mcp, marketplace, interoperability, v1, v2` |

Description:

> First-class Agent Plugins 1.0 client for OpenCode V1 and V2: filesystem and
> npm discovery, native skills, trust-first MCP registration (disabled until
> explicitly enabled). Marketplace catalogs and `/ap` install/update are
> V2-only; V1 provides filesystem/npm discovery, skills, MCP registration and
> npm sources. Zero runtime dependencies.

Installation:

```sh
opencode plugin add @hamzaabili/opencode-agent-plugins@1.3.1
```

or, for V1:

```jsonc
{
  "plugin": ["@hamzaabili/opencode-agent-plugins/legacy"]
}
```

## awesome-opencode

Guidelines: <https://github.com/awesome-opencode/awesome-opencode/blob/main/contributing.md>

**Eligibility gate:** at least 30 days old and at least 25 stars. Check both
before submitting.

File: `data/plugins/opencode-agent-plugins.yaml`

```yaml
name: Agent Plugins for OpenCode
repo: https://github.com/Hamza-Abili/opencode-agent-plugins
tagline: Agent Plugins 1.0 discovery, native skills and trust-first MCP for OpenCode V1/V2.
description: >-
  First-class Agent Plugins 1.0 client for OpenCode V1 and V2. Discovers plugins
  from .agents/plugins and npm packages, loads native skills, registers MCP
  servers disabled by default, and keeps installation behind an explicit /ap
  install with manifest containment and rollback. Marketplace catalogs and
  /ap install/update are V2-only; V1 covers filesystem/npm discovery, skills,
  MCP registration and npm sources. Zero runtime dependencies.
```

## OpenCode official ecosystem docs

Add one row under `## Plugins` on <https://opencode.ai/docs/ecosystem/>:

```markdown
| [opencode-agent-plugins](https://github.com/Hamza-Abili/opencode-agent-plugins) | Agent Plugins 1.0 client: discovery, skills, trust-first MCP (V1+V2; /ap and marketplace on V2) |
```

## Tracking

```sh
npm view @hamzaabili/opencode-agent-plugins version
gh repo view Hamza-Abili/opencode-agent-plugins --json stargazerCount
gh issue list --repo Hamza-Abili/opencode-agent-plugins --state open
```
