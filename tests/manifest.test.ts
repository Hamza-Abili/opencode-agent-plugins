import { describe, expect, test } from "bun:test";
import { PLUGIN_SCHEMA, validateManifest } from "../src/manifest.ts";

describe("validateManifest", () => {
  test("accepts a full valid manifest", () => {
    const result = validateManifest({
      $schema: PLUGIN_SCHEMA,
      name: "demo-tools",
      version: "1.2.0",
      description: "Demo",
      author: { name: "A", email: "a@example.com", url: "https://example.com" },
      homepage: "https://example.com",
      repository: "https://github.com/example/demo",
      license: "MIT",
      keywords: ["demo"],
      extensions: { "com.example.client": { anything: "goes" } },
    });
    expect(result.manifest).toBeDefined();
    expect(result.manifest?.name).toBe("demo-tools");
    expect(result.manifest?.author?.email).toBe("a@example.com");
    expect(result.problems).toEqual([]);
  });

  test("accepts a minimal manifest", () => {
    const result = validateManifest({ $schema: PLUGIN_SCHEMA, name: "minimal" });
    expect(result.manifest?.name).toBe("minimal");
    expect(result.problems).toEqual([]);
  });

  test("rejects a missing $schema", () => {
    const result = validateManifest({ name: "no-schema" });
    expect(result.manifest).toBeUndefined();
    expect(result.problems.some((p) => p.level === "error" && p.message.includes("$schema"))).toBe(
      true
    );
  });

  test("rejects an unsupported $schema", () => {
    const result = validateManifest({ $schema: "https://example.com/other.json", name: "x" });
    expect(result.manifest).toBeUndefined();
    expect(
      result.problems.some((p) => p.level === "error" && p.message.includes("unsupported"))
    ).toBe(true);
  });

  test("rejects invalid names", () => {
    for (const name of [
      "",
      "Bad Name!!",
      "UPPER",
      "a".repeat(65),
      "-leading",
      "trailing-",
      "two--hyphens",
      "..",
    ]) {
      const result = validateManifest({ $schema: PLUGIN_SCHEMA, name });
      expect(result.manifest).toBeUndefined();
    }
  });

  test("accepts dots in manifest names (schema allows them)", () => {
    const result = validateManifest({ $schema: PLUGIN_SCHEMA, name: "dodo.payments" });
    expect(result.manifest?.name).toBe("dodo.payments");
  });

  test("unknown top-level fields are non-fatal warnings", () => {
    const result = validateManifest({ $schema: PLUGIN_SCHEMA, name: "x", custom: "value" });
    expect(result.manifest?.name).toBe("x");
    expect(result.problems).toEqual([
      { level: "warning", message: 'plugin.json has unknown top-level field "custom" — ignored' },
    ]);
  });

  test("non-object extensions is non-fatal", () => {
    const result = validateManifest({ $schema: PLUGIN_SCHEMA, name: "x", extensions: "nope" });
    expect(result.manifest?.name).toBe("x");
    expect(
      result.problems.some((p) => p.level === "warning" && p.message.includes("extensions"))
    ).toBe(true);
  });

  test("extension namespace contents are never validated", () => {
    const result = validateManifest({
      $schema: PLUGIN_SCHEMA,
      name: "x",
      extensions: { "com.example.client": "not even an object" },
    });
    expect(result.manifest?.name).toBe("x");
    expect(result.problems).toEqual([]);
  });

  test("wrong types on optional fields are fatal", () => {
    const result = validateManifest({ $schema: PLUGIN_SCHEMA, name: "x", version: 5 });
    expect(result.manifest).toBeUndefined();
    expect(result.problems.some((p) => p.level === "error" && p.message.includes("version"))).toBe(
      true
    );
  });

  test("unknown author fields are fatal (schema additionalProperties: false)", () => {
    const result = validateManifest({
      $schema: PLUGIN_SCHEMA,
      name: "x",
      author: { name: "A", nickname: "B" },
    });
    expect(result.manifest).toBeUndefined();
    expect(result.problems.some((p) => p.level === "error" && p.message.includes("nickname"))).toBe(
      true
    );
  });

  test("non-object manifest is fatal", () => {
    const result = validateManifest("not-an-object");
    expect(result.manifest).toBeUndefined();
    expect(result.problems.some((p) => p.level === "error")).toBe(true);
  });
});
