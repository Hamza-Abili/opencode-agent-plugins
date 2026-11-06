import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { trace } from "../src/v2/trace.ts";
import { makeTempDir } from "./helpers.ts";

describe("trace", () => {
  test("is inert when AGENT_PLUGINS_TRACE is unset", () => {
    const original = process.env.AGENT_PLUGINS_TRACE;
    delete process.env.AGENT_PLUGINS_TRACE;
    const dir = makeTempDir();
    trace("test", { value: 1 });
    expect(fs.readdirSync(dir)).toEqual([]);
    if (original !== undefined) process.env.AGENT_PLUGINS_TRACE = original;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("appends JSONL when set", () => {
    const original = process.env.AGENT_PLUGINS_TRACE;
    const dir = makeTempDir();
    const file = path.join(dir, "trace.log");
    process.env.AGENT_PLUGINS_TRACE = file;
    trace("one", { value: 1 });
    trace("two");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).step).toBe("one");
    expect(JSON.parse(lines[1]).step).toBe("two");
    if (original === undefined) delete process.env.AGENT_PLUGINS_TRACE;
    else process.env.AGENT_PLUGINS_TRACE = original;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
