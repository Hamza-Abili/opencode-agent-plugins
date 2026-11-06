import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_SCHEMA } from "../src/manifest.ts";
import {
  cleanupInternalDirs,
  discoverMarketplaces,
  type Installer,
  installEntry,
  listInstalled,
  type MarketplaceEntry,
  normalizeGitUrl,
  parseMarketplace,
  readProvenance,
  uninstallEntry,
  updateEntry,
} from "../src/marketplace.ts";
import { isSafePackageName, resolvePackages } from "../src/packages.ts";
import { makeTempDir, writeFile } from "./helpers.ts";

function writeMarketplace(root: string, doc: unknown): string {
  const file = path.join(root, ".agents", "plugins", "marketplace.json");
  writeFile(file, JSON.stringify(doc));
  return file;
}

function writePlugin(dir: string, name: string): void {
  writeFile(path.join(dir, "plugin.json"), JSON.stringify({ $schema: PLUGIN_SCHEMA, name }));
}

function fakeInstaller(storeRoot: string, projectDir: string, commit = "abcdef1234567890") {
  const calls: string[][] = [];
  const installer: Installer = {
    storeRoot,
    projectDir,
    now: () => new Date("2026-11-06T00:00:00Z"),
    async git(args, _cwd) {
      calls.push(args);
      if (args[0] === "clone") {
        const target = args.at(-1) as string;
        writePlugin(target, "installed-plugin");
        writePlugin(path.join(target, "plugins", "demo"), "installed-plugin");
        return { code: 0, output: "" };
      }
      if (args[0] === "checkout") return { code: 0, output: "" };
      if (args[0] === "rev-parse") return { code: 0, output: `${commit}\n` };
      return { code: 1, output: "unexpected" };
    },
  };
  return { installer, calls };
}

describe("parseMarketplace", () => {
  test("parses a full marketplace with every source type", () => {
    const dir = makeTempDir();
    const file = writeMarketplace(dir, {
      name: "acme-market",
      interface: { displayName: "Acme" },
      plugins: [
        { name: "local-plugin", source: "./plugins/local-plugin" },
        { name: "remote", source: { source: "url", url: "owner/repo", ref: "v1.0.0" } },
        {
          name: "subdir",
          source: {
            source: "git-subdir",
            url: "https://github.com/acme/mono.git",
            path: "plugins/x",
            sha: "a".repeat(40),
          },
          category: "dev-tools",
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        },
        { name: "npm-plugin", source: { source: "npm", package: "@acme/plugin" } },
      ],
    });
    const result = parseMarketplace(file);
    expect("entry" in result).toBe(true);
    if ("entry" in result) {
      expect(result.entry.name).toBe("acme-market");
      expect(result.entry.displayName).toBe("Acme");
      expect(result.entry.entries.map((entry) => entry.name)).toEqual([
        "local-plugin",
        "remote",
        "subdir",
        "npm-plugin",
      ]);
      const remote = result.entry.entries[1].source;
      expect(remote.type).toBe("url");
      if (remote.type === "url") expect(remote.url).toBe("https://github.com/owner/repo.git");
      expect(result.entry.entries[2].installation).toBe("AVAILABLE");
      expect(result.entry.entries[2].authentication).toBe("ON_USE");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("skips invalid entries without failing the marketplace", () => {
    const dir = makeTempDir();
    const file = writeMarketplace(dir, {
      name: "m",
      plugins: [
        { name: "Bad Name", source: "./x" },
        { name: "traversal", source: "./../outside" },
        { name: "unknown-source", source: { source: "ftp", url: "x" } },
        { name: "bad-policy", source: "./x", policy: { installation: "MAYBE" } },
        { name: "good", source: "./plugins/good" },
      ],
    });
    const result = parseMarketplace(file);
    expect("entry" in result).toBe(true);
    if ("entry" in result) {
      expect(result.entry.entries.map((entry) => entry.name)).toEqual(["good"]);
      expect(result.entry.problems.length).toBe(4);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("duplicate names keep the first entry", () => {
    const dir = makeTempDir();
    const file = writeMarketplace(dir, {
      name: "m",
      plugins: [
        { name: "dup", source: "./a" },
        { name: "dup", source: "./b" },
      ],
    });
    const result = parseMarketplace(file);
    if ("entry" in result) {
      expect(result.entry.entries.length).toBe(1);
      expect(result.entry.problems.some((problem) => problem.message.includes("duplicated"))).toBe(
        true
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a marketplace without a valid name or plugins array", () => {
    const dir = makeTempDir();
    const file = writeMarketplace(dir, { plugins: [] });
    expect("problems" in parseMarketplace(file)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("normalizeGitUrl", () => {
  test("normalizes owner/repo shorthand", () => {
    expect(normalizeGitUrl("owner/repo")).toEqual({ url: "https://github.com/owner/repo.git" });
  });

  test("accepts https and scp-like ssh", () => {
    expect(normalizeGitUrl("https://github.com/x/y.git")).toEqual({
      url: "https://github.com/x/y.git",
    });
    expect(normalizeGitUrl("git@github.com:x/y.git")).toEqual({ url: "git@github.com:x/y.git" });
  });

  test("rejects insecure protocols, credentials and fragments", () => {
    expect("error" in normalizeGitUrl("http://example.com/x.git")).toBe(true);
    expect("error" in normalizeGitUrl("git://example.com/x.git")).toBe(true);
    expect("error" in normalizeGitUrl("https://user:pass@example.com/x.git")).toBe(true);
    expect("error" in normalizeGitUrl("https://example.com/x.git#main")).toBe(true);
  });
});

describe("discoverMarketplaces", () => {
  test("walks up to the worktree root and dedupes", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const deep = path.join(repo, "a", "b");
    fs.mkdirSync(deep, { recursive: true });
    writeMarketplace(repo, { name: "repo-market", plugins: [] });
    const found = discoverMarketplaces(deep, repo);
    expect(found.marketplaces.map((marketplace) => marketplace.name)).toContain("repo-market");
    expect(
      found.marketplaces.filter((marketplace) => marketplace.name === "repo-market").length
    ).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("installEntry", () => {
  test("installs a git entry into the managed store with provenance", async () => {
    const dir = makeTempDir();
    const store = path.join(dir, "installed");
    const { installer, calls } = fakeInstaller(store, dir);
    const marketplace = { root: dir, file: "", name: "m", entries: [], problems: [] };
    const entry: MarketplaceEntry = {
      name: "demo",
      source: {
        type: "git-subdir",
        url: "https://github.com/o/r.git",
        path: "plugins/demo",
        ref: "v1",
      },
    };
    const result = await installEntry(installer, marketplace, entry);
    expect(result.ok).toBe(true);
    expect(result.commit).toBe("abcdef1234567890");
    expect(fs.existsSync(path.join(store, "demo", "plugin.json"))).toBe(true);
    expect(calls.some((args) => args[0] === "clone")).toBe(true);
    const provenance = readProvenance(store, "demo");
    expect(provenance?.commit).toBe("abcdef1234567890");
    expect(provenance?.marketplace).toBe("m");
    expect(listInstalled(store)).toEqual(["demo"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rejects an install whose target is not a valid Agent Plugin", async () => {
    const dir = makeTempDir();
    const store = path.join(dir, "installed");
    const installer: Installer = {
      storeRoot: store,
      projectDir: dir,
      async git(args) {
        if (args[0] === "clone") {
          writeFile(
            path.join(args.at(-1) as string, "plugin.json"),
            JSON.stringify({ name: "no-schema" })
          );
          return { code: 0, output: "" };
        }
        if (args[0] === "checkout") return { code: 0, output: "" };
        return { code: 0, output: "abc\n" };
      },
    };
    const marketplace = { root: dir, file: "", name: "m", entries: [], problems: [] };
    const result = await installEntry(installer, marketplace, {
      name: "bad",
      source: { type: "url", url: "https://github.com/o/r.git" },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("valid Agent Plugin");
    expect(fs.existsSync(path.join(store, "bad"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("never overwrites an existing install", async () => {
    const dir = makeTempDir();
    const store = path.join(dir, "installed");
    writePlugin(path.join(store, "demo"), "demo");
    const { installer } = fakeInstaller(store, dir);
    const marketplace = { root: dir, file: "", name: "m", entries: [], problems: [] };
    const result = await installEntry(installer, marketplace, {
      name: "demo",
      source: { type: "url", url: "https://github.com/o/r.git" },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already installed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("resolves npm sources from project node_modules", async () => {
    const dir = makeTempDir();
    writePlugin(path.join(dir, "node_modules", "@acme", "plugin"), "npm-plugin");
    const { installer } = fakeInstaller(path.join(dir, "installed"), dir);
    const marketplace = { root: dir, file: "", name: "m", entries: [], problems: [] };
    const result = await installEntry(installer, marketplace, {
      name: "npm-plugin",
      source: { type: "npm", package: "@acme/plugin" },
    });
    expect(result.ok).toBe(true);
    expect(result.directory).toContain(path.join("node_modules", "@acme", "plugin"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("uninstallEntry", () => {
  test("removes installed copies and provenance", async () => {
    const dir = makeTempDir();
    const store = path.join(dir, "installed");
    const { installer } = fakeInstaller(store, dir);
    const marketplace = { root: dir, file: "", name: "m", entries: [], problems: [] };
    await installEntry(installer, marketplace, {
      name: "demo",
      source: { type: "url", url: "https://github.com/o/r.git" },
    });
    const result = uninstallEntry(store, "demo");
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(store, "demo"))).toBe(false);
    expect(readProvenance(store, "demo")).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("refuses invalid names and unknown installs", () => {
    const dir = makeTempDir();
    expect(uninstallEntry(dir, "../etc").ok).toBe(false);
    expect(uninstallEntry(dir, "missing").ok).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("resolvePackages", () => {
  test("resolves project packages and reports missing ones", () => {
    const dir = makeTempDir();
    writePlugin(path.join(dir, "node_modules", "pkg-a"), "pkg-a");
    const results = resolvePackages(["pkg-a", "pkg-missing"], dir);
    expect(results[0].directory).toContain(path.join("node_modules", "pkg-a"));
    expect(results[1].error).toContain("bun add pkg-missing");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rejects path-like package names", () => {
    for (const name of ["../evil", "./evil", "/abs", "a/../b", ""]) {
      expect(isSafePackageName(name)).toBe(false);
    }
    expect(isSafePackageName("@scope/name")).toBe(true);
    expect(isSafePackageName("plain")).toBe(true);
  });
});

describe("updateEntry", () => {
  function entry(): MarketplaceEntry {
    return { name: "demo", source: { type: "url", url: "https://github.com/o/r.git" } };
  }

  test("swaps atomically and reports the previous commit", async () => {
    const dir = makeTempDir();
    const store = path.join(dir, "installed");
    const marketplace = { root: dir, file: "", name: "m", entries: [], problems: [] };
    const first = fakeInstaller(store, dir, "aaaaaaaaaaaa");
    expect((await installEntry(first.installer, marketplace, entry())).ok).toBe(true);

    const second = fakeInstaller(store, dir, "bbbbbbbbbbbb");
    const result = await updateEntry(second.installer, marketplace, entry());
    expect(result.ok).toBe(true);
    expect(result.previousCommit).toBe("aaaaaaaaaaaa");
    expect(result.commit).toBe("bbbbbbbbbbbb");
    expect(readProvenance(store, "demo")?.commit).toBe("bbbbbbbbbbbb");
    expect(fs.existsSync(path.join(store, "demo", "plugin.json"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("keeps the old install when the new checkout fails", async () => {
    const dir = makeTempDir();
    const store = path.join(dir, "installed");
    const marketplace = { root: dir, file: "", name: "m", entries: [], problems: [] };
    const first = fakeInstaller(store, dir, "aaaaaaaaaaaa");
    expect((await installEntry(first.installer, marketplace, entry())).ok).toBe(true);

    const broken: Installer = {
      storeRoot: store,
      projectDir: dir,
      async git() {
        return { code: 1, output: "network down" };
      },
    };
    const result = await updateEntry(broken, marketplace, entry());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("network down");
    expect(fs.existsSync(path.join(store, "demo", "plugin.json"))).toBe(true);
    expect(readProvenance(store, "demo")?.commit).toBe("aaaaaaaaaaaa");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("parseMarketplace — git ref/sha validation", () => {
  test("rejects option-like refs and non-hex shas", () => {
    const dir = makeTempDir();
    const file = writeMarketplace(dir, {
      name: "m",
      plugins: [
        {
          name: "bad-ref",
          source: { source: "url", url: "https://x.example.com/r.git", ref: "--upload-pack=evil" },
        },
        {
          name: "bad-sha",
          source: { source: "url", url: "https://x.example.com/r.git", sha: "not-hex!" },
        },
        {
          name: "good",
          source: { source: "url", url: "https://x.example.com/r.git", ref: "v1.2.3" },
        },
      ],
    });
    const result = parseMarketplace(file);
    expect("entry" in result).toBe(true);
    if ("entry" in result) {
      expect(result.entry.entries.map((e) => e.name)).toEqual(["good"]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("installEntry — containment at copy time", () => {
  function marketplaceStub(dir: string) {
    return { root: dir, file: "", name: "m", entries: [], problems: [] as never[] };
  }

  test("rejects a plugin containing a symlink that escapes the tree", async () => {
    const dir = makeTempDir();
    const store = path.join(dir, "installed");
    const outside = path.join(dir, "outside");
    writeFile(path.join(outside, "SKILL.md"), "---\nname: leaky\ndescription: D\n---\n");
    const installer: Installer = {
      storeRoot: store,
      projectDir: dir,
      async git(args) {
        if (args[0] === "clone") {
          const target = args.at(-1) as string;
          writePlugin(target, "leaky");
          fs.mkdirSync(path.join(target, "skills"), { recursive: true });
          fs.symlinkSync(outside, path.join(target, "skills", "leaky"), "dir");
          return { code: 0, output: "" };
        }
        if (args[0] === "checkout") return { code: 0, output: "" };
        return { code: 0, output: "abc\n" };
      },
    };
    const result = await installEntry(installer, marketplaceStub(dir), {
      name: "leaky",
      source: { type: "url", url: "https://github.com/o/r.git" },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("escapes the plugin tree");
    expect(fs.existsSync(path.join(store, "leaky"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a git-subdir path that resolves outside the clone", async () => {
    const dir = makeTempDir();
    const store = path.join(dir, "installed");
    const outside = path.join(dir, "outside-plugin");
    writePlugin(outside, "outside");
    const installer: Installer = {
      storeRoot: store,
      projectDir: dir,
      async git(args) {
        if (args[0] === "clone") {
          const target = args.at(-1) as string;
          writePlugin(target, "wrapper");
          fs.mkdirSync(path.join(target, "plugins"), { recursive: true });
          fs.symlinkSync(outside, path.join(target, "plugins", "x"), "dir");
          return { code: 0, output: "" };
        }
        if (args[0] === "checkout") return { code: 0, output: "" };
        return { code: 0, output: "abc\n" };
      },
    };
    const result = await installEntry(installer, marketplaceStub(dir), {
      name: "subdir-escape",
      source: { type: "git-subdir", url: "https://github.com/o/r.git", path: "plugins/x" },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("escapes the repository");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rejects NOT_AVAILABLE entries", async () => {
    const dir = makeTempDir();
    const store = path.join(dir, "installed");
    const plugin = path.join(dir, "plugins", "demo");
    writePlugin(plugin, "demo");
    const { installer } = fakeInstaller(store, dir);
    const result = await installEntry(installer, marketplaceStub(dir), {
      name: "demo",
      installation: "NOT_AVAILABLE",
      source: { type: "local", path: plugin },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("NOT_AVAILABLE");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("leaves nothing installed when provenance cannot be written", async () => {
    const dir = makeTempDir();
    const store = path.join(dir, "installed");
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, ".provenance"), "not a directory");
    const { installer } = fakeInstaller(store, dir, "abcdef1234567890");
    const result = await installEntry(installer, marketplaceStub(dir), {
      name: "demo",
      source: { type: "url", url: "https://github.com/o/r.git" },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("provenance");
    expect(fs.existsSync(path.join(store, "demo"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("updateEntry — provenance rollback", () => {
  test("restores the old code when provenance cannot be written", async () => {
    const dir = makeTempDir();
    const store = path.join(dir, "installed");
    const marketplace = { root: dir, file: "", name: "m", entries: [], problems: [] as never[] };
    const entry: MarketplaceEntry = {
      name: "demo",
      source: { type: "url", url: "https://github.com/o/r.git" },
    };

    const first: Installer = {
      storeRoot: store,
      projectDir: dir,
      async git(args) {
        if (args[0] === "clone") {
          writeFile(
            path.join(args.at(-1) as string, "plugin.json"),
            JSON.stringify({
              $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
              name: "old-version",
            })
          );
          return { code: 0, output: "" };
        }
        if (args[0] === "checkout") return { code: 0, output: "" };
        return { code: 0, output: "aaaaaaaaaaaa\n" };
      },
    };
    expect((await installEntry(first, marketplace, entry)).ok).toBe(true);

    // Make the provenance directory unwritable by replacing it with a file.
    fs.rmSync(path.join(store, ".provenance"), { recursive: true, force: true });
    fs.writeFileSync(path.join(store, ".provenance"), "blocked");

    const second: Installer = {
      storeRoot: store,
      projectDir: dir,
      async git(args) {
        if (args[0] === "clone") {
          writeFile(
            path.join(args.at(-1) as string, "plugin.json"),
            JSON.stringify({
              $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
              name: "new-version",
            })
          );
          return { code: 0, output: "" };
        }
        if (args[0] === "checkout") return { code: 0, output: "" };
        return { code: 0, output: "bbbbbbbbbbbb\n" };
      },
    };
    const result = await updateEntry(second, marketplace, entry);
    expect(result.ok).toBe(false);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(store, "demo", "plugin.json"), "utf8")
    ) as { name: string };
    expect(manifest.name).toBe("old-version");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("installEntry — local containment is rechecked at install time", () => {
  test("rejects a local path that became a symlink escape after parsing", async () => {
    const dir = makeTempDir();
    const market = path.join(dir, "market");
    const outside = path.join(dir, "outside-plugin");
    writePlugin(outside, "outside");
    writeFile(
      path.join(market, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({ name: "m", plugins: [{ name: "demo", source: "./plugins/demo" }] })
    );
    writePlugin(path.join(market, "plugins", "demo"), "demo");
    const parsed = parseMarketplace(path.join(market, ".agents", "plugins", "marketplace.json"));
    expect("entry" in parsed).toBe(true);
    if (!("entry" in parsed)) return;
    // Swap the directory for an escaping symlink after parsing.
    fs.rmSync(path.join(market, "plugins", "demo"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(market, "plugins", "demo"), "dir");

    const { installer } = fakeInstaller(path.join(dir, "installed"), dir);
    const result = await installEntry(installer, parsed.entry, parsed.entry.entries[0]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("escapes its marketplace root");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("listInstalled — internal directories", () => {
  test("ignores staging/backup leftovers and cleans them", () => {
    const dir = makeTempDir();
    const store = path.join(dir, "installed");
    writePlugin(path.join(store, "demo"), "demo");
    writePlugin(path.join(store, "demo.staging-1234"), "staging");
    writePlugin(path.join(store, "demo.backup-1234"), "backup");
    expect(listInstalled(store)).toEqual(["demo"]);
    cleanupInternalDirs(store);
    expect(fs.existsSync(path.join(store, "demo.staging-1234"))).toBe(false);
    expect(fs.existsSync(path.join(store, "demo.backup-1234"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cleanupInternalDirs — crash recovery", () => {
  test("restores the only working copy from a backup directory", () => {
    const dir = makeTempDir();
    const store = path.join(dir, "installed");
    writePlugin(path.join(store, "demo.backup-1234"), "demo");
    cleanupInternalDirs(store);
    expect(fs.existsSync(path.join(store, "demo", "plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(store, "demo.backup-1234"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("normalizeGitUrl — option injection", () => {
  test("rejects leading-dash scp-like URLs", () => {
    expect("error" in normalizeGitUrl("-u.evil@host:path")).toBe(true);
    expect("error" in normalizeGitUrl("--upload-pack=evil")).toBe(true);
    expect(normalizeGitUrl("git@host:path")).toEqual({ url: "git@host:path" });
  });
});

describe("uninstallEntry — interrupted update leftovers", () => {
  test("removing a backup-only install prevents resurrection", () => {
    const dir = makeTempDir();
    const store = path.join(dir, "installed");
    writePlugin(path.join(store, "demo.backup-1234"), "demo");
    const result = uninstallEntry(store, "demo");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("leftovers");
    expect(fs.existsSync(path.join(store, "demo.backup-1234"))).toBe(false);
    cleanupInternalDirs(store);
    expect(fs.existsSync(path.join(store, "demo"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("discoverMarketplaces — catalog containment", () => {
  test("ignores a catalog symlinked outside the project roots", () => {
    const dir = makeTempDir();
    const project = path.join(dir, "project");
    const outside = path.join(dir, "outside.json");
    writeFile(outside, JSON.stringify({ name: "outside", plugins: [] }));
    fs.mkdirSync(path.join(project, ".agents", "plugins"), { recursive: true });
    fs.symlinkSync(outside, path.join(project, ".agents", "plugins", "marketplace.json"));
    const result = discoverMarketplaces(project, project);
    expect(result.marketplaces).toEqual([]);
    expect(result.problems.some((problem) => problem.message.includes("outside the project"))).toBe(
      true
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
