/**
 * Live smoke test against a real OpenCode installation.
 *
 * Runs the plugin in an isolated HOME/XDG environment, starts the managed
 * service, and asserts the two contracts that matter:
 *   1. a portable Agent Plugin's skill is registered in the real skill list;
 *   2. its MCP server is registered but reports status "disabled" (trust-first).
 *
 * Usage:
 *   bun run smoke                 # uses `opencode` from PATH
 *   OPENCODE_BIN=/path bun run smoke
 *
 * Not part of CI: requires an OpenCode binary and starts a local service.
 * Exits 0 on success, 1 on failure; prints evidence for every assertion.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
const OPENCODE = process.env.OPENCODE_BIN ?? "opencode";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function run(
  args: string[],
  env: NodeJS.ProcessEnv
): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({ cmd: [OPENCODE, ...args], env, cwd: env.HOME });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocap-smoke-"));
// Strip host/plugin overrides so the run cannot touch the developer's setup.
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("AGENT_PLUGINS_") && !key.startsWith("OPENCODE_") && !key.startsWith("XDG_")
  )
);
env.HOME = path.join(root, "home");
env.XDG_CONFIG_HOME = path.join(root, "config");
env.XDG_DATA_HOME = path.join(root, "data");
env.XDG_CACHE_HOME = path.join(root, "cache");
env.XDG_RUNTIME_DIR = path.join(root, "runtime");

function cleanup(): void {
  try {
    run(["service", "stop"], env);
  } catch {
    // best effort
  }
  fs.rmSync(root, { recursive: true, force: true });
}

process.on("exit", cleanup);

// --- fixtures -------------------------------------------------------------
fs.mkdirSync(env.HOME as string, { recursive: true });
fs.mkdirSync(env.XDG_DATA_HOME as string, { recursive: true });
fs.mkdirSync(env.XDG_CACHE_HOME as string, { recursive: true });

const pluginDir = path.join(root, "plugins", "demo");
fs.mkdirSync(path.join(pluginDir, "skills", "demo-skill"), { recursive: true });
fs.writeFileSync(
  path.join(pluginDir, "plugin.json"),
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "demo",
  })
);
fs.writeFileSync(
  path.join(pluginDir, "skills", "demo-skill", "SKILL.md"),
  "---\nname: demo-skill\ndescription: Smoke-test skill from a portable plugin\n---\n\nSay hello.\n"
);
fs.writeFileSync(
  path.join(pluginDir, "mcp.json"),
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { "smoke-remote": { type: "streamable-http", url: "https://example.com/mcp" } },
  })
);

fs.mkdirSync(path.join(env.XDG_CONFIG_HOME as string, "opencode"), { recursive: true });
fs.writeFileSync(
  path.join(env.XDG_CONFIG_HOME as string, "opencode", "opencode.json"),
  JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [
      {
        package: PLUGIN_ROOT,
        options: { directories: [path.join(root, "plugins")], logLevel: "debug" },
      },
    ],
  })
);

// --- start the isolated service ------------------------------------------
const port = 49600 + (process.pid % 300);
const setPort = run(["service", "set", "port", String(port)], env);
if (setPort.code !== 0) fail(`cannot configure the isolated service port: ${setPort.stderr}`);

const first = run(["api", "get", "/api/info"], env);
if (first.code !== 0) fail(`isolated OpenCode service did not start: ${first.stderr}`);

function api(pathname: string): unknown {
  const response = run(["api", "get", pathname], env);
  if (response.code !== 0) fail(`GET ${pathname} failed: ${response.stderr}`);
  return JSON.parse(response.stdout);
}

function waitFor<T>(label: string, probe: () => T | undefined, timeoutMs = 30_000): T {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    Bun.sleepSync(500);
  }
  fail(`timed out waiting for ${label}`);
}

// --- assertion 1: skill registered ---------------------------------------
const skills = waitFor("the demo skill", () => {
  const data = (api("/api/skill") as { data: { name: string }[] }).data;
  return data.some((skill) => skill.name === "demo-skill") ? data : undefined;
}) as { name: string }[];
console.log(`PASS skills: ${skills.map((skill) => skill.name).join(", ")}`);

// --- assertion 2: MCP registered and disabled ----------------------------
const servers = waitFor("the demo MCP server", () => {
  const data = (api("/api/mcp") as { data: { name: string; status?: { status?: string } }[] }).data;
  return data.find((server) => server.name === "smoke-remote") ? data : undefined;
}) as { name: string; status?: { status?: string } }[];
const server = servers.find((candidate) => candidate.name === "smoke-remote");
if (server?.status?.status !== "disabled") {
  fail(`expected smoke-remote status "disabled", got ${JSON.stringify(server?.status)}`);
}
console.log(`PASS mcp: smoke-remote status=${server.status.status}`);

console.log(`PASS live smoke against ${OPENCODE}`);
