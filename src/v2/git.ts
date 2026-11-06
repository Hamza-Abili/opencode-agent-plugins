/**
 * opencode-agent-plugins — git runner for marketplace installs.
 *
 * Argument arrays only (never a shell), a hard timeout, concurrent pipe
 * draining, and a fallback for servers without partial-clone support.
 */

import fs from "node:fs";

const GIT_TIMEOUT_MS = 120_000;

export async function runGit(
  args: string[],
  cwd: string
): Promise<{ code: number; output: string }> {
  const first = await spawnGit(["git", ...args], cwd);
  if (first.code !== 0 && args[0] === "clone" && args.includes("--filter=blob:none")) {
    // Older servers do not support partial clone — retry a plain clone.
    const fallback = ["git", ...args.filter((arg) => arg !== "--filter=blob:none")];
    return spawnGit(fallback, cwd);
  }
  return first;
}

export async function spawnGit(
  command: string[],
  cwd: string
): Promise<{ code: number; output: string }> {
  try {
    fs.mkdirSync(cwd, { recursive: true });
    const proc = Bun.spawn({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
    }, GIT_TIMEOUT_MS);
    // Drain both pipes before waiting on exit so a large error output
    // cannot fill the pipe and stall the process until the timeout.
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const code = await proc.exited;
    clearTimeout(timer);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const output = stderr.trim() !== "" ? stderr : stdout;
    return { code, output };
  } catch (error) {
    return { code: 1, output: String(error) };
  }
}
