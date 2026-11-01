import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  grantOthersWrite,
  makeOwnerPrivateDirectory,
} from "../test-support/owner-private-fixture.js";
import {
  configuredInstructionEntries,
  discoverInstructionSources,
  globalOpenCodeConfigDirectory,
  instructionAncestorDirectories,
} from "./codingRuntimeInstructionSources.js";
import type {
  SecureWorkspaceNativeFileIO,
  SecureWorkspaceTextReadPort,
  SecureWorkspaceTextReadResult,
} from "./secureWorkspaceTextRead.js";

/** The secure workspace read, answered plainly from the fixture workspace. */
function workspacePort(workspace: string): SecureWorkspaceTextReadPort {
  const nativeFileIO: SecureWorkspaceNativeFileIO = {
    readBytes: () => Promise.reject(new Error("unused")),
    stat: () => Promise.reject(new Error("unused")),
    list: ({ relativePath }) => {
      try {
        const directory = join(workspace, relativePath);
        const entries = readdirSync(directory, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        }));
        const info = statSync(directory);
        return Promise.resolve({
          ok: true,
          entries,
          info: { type: "directory", size: info.size, mtimeMs: info.mtimeMs },
        } as never);
      } catch {
        return Promise.resolve({ ok: false, reason: "not-found" } as never);
      }
    },
  };
  return {
    nativeFileIO,
    readText: ({ relativePath }): Promise<SecureWorkspaceTextReadResult> => {
      try {
        return Promise.resolve({
          ok: true,
          text: readFileSync(join(workspace, relativePath), "utf8"),
        });
      } catch {
        return Promise.resolve({ ok: false, reason: "not-found" });
      }
    },
  };
}

describe("discoverInstructionSources", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function tree(): {
    readonly home: string;
    readonly config: string;
    readonly repository: string;
    readonly workspace: string;
  } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-instruction-sources-")));
    created.push(root);
    makeOwnerPrivateDirectory(root);
    const home = join(root, "home");
    const config = join(home, ".config", "opencode");
    const repository = join(home, "projects", "repo");
    const workspace = join(repository, "packages", "app");
    mkdirSync(config, { recursive: true });
    mkdirSync(join(repository, ".git"), { recursive: true });
    mkdirSync(join(workspace, "docs", "deep"), { recursive: true });
    return { home, config, repository, workspace };
  }

  it("finds the global, ancestor and configured sources in the producer's order", async () => {
    const { home, config, repository, workspace } = tree();
    writeFileSync(join(config, "AGENTS.md"), "GLOBAL-RULE\n");
    writeFileSync(join(home, "notes.md"), "GLOBAL-CONFIGURED-RULE\n");
    writeFileSync(
      join(config, "opencode.json"),
      JSON.stringify({ instructions: ["~/notes.md", "https://example.test/rules.md"] }),
    );
    writeFileSync(join(repository, "AGENTS.md"), "REPOSITORY-ROOT-RULE\n");
    writeFileSync(join(home, "AGENTS.md"), "HOME-RULE\n");
    writeFileSync(join(workspace, "AGENTS.md"), "WORKSPACE-RULE\n");
    writeFileSync(join(workspace, "docs", "style.md"), "STYLE-RULE\n");
    writeFileSync(join(workspace, "docs", "deep", "nested.md"), "NESTED-RULE\n");
    writeFileSync(
      join(workspace, "opencode.json"),
      JSON.stringify({ instructions: ["docs/*.md", "docs/**/nested.md", "AGENTS.md"] }),
    );
    const found = await discoverInstructionSources({
      workspaceRoot: workspace,
      home,
      globalConfigDirectory: config,
      workspace: workspacePort(workspace),
    });
    expect(found.sources.map((source) => [source.kind, source.label, source.text])).toEqual([
      ["global", "~/.config/opencode/AGENTS.md", "GLOBAL-RULE\n"],
      ["ancestor", "~/projects/repo/AGENTS.md", "REPOSITORY-ROOT-RULE\n"],
      ["ancestor", "~/AGENTS.md", "HOME-RULE\n"],
      ["configured", "~/notes.md", "GLOBAL-CONFIGURED-RULE\n"],
      ["configured", "docs/style.md", "STYLE-RULE\n"],
      ["configured", "docs/deep/nested.md", "NESTED-RULE\n"],
    ]);
    expect(found.remote).toEqual(["https://example.test/rules.md"]);
    expect(found.refused).toEqual([]);
  });

  it("never lets the project's configuration name a file outside the workspace", async () => {
    const { home, config, workspace } = tree();
    writeFileSync(join(home, "secret.md"), "OUTSIDE\n");
    writeFileSync(
      join(workspace, "opencode.json"),
      JSON.stringify({ instructions: ["~/secret.md", join(home, "secret.md"), "../../secret.md"] }),
    );
    const found = await discoverInstructionSources({
      workspaceRoot: workspace,
      home,
      globalConfigDirectory: config,
      workspace: workspacePort(workspace),
    });
    expect(found.sources).toEqual([]);
    expect(found.refused).toEqual(["outside-workspace", "outside-workspace", "outside-workspace"]);
  });

  it("refuses an ancestor with a second link, a writable-by-others file and a non-text file", async () => {
    const { home, config, repository, workspace } = tree();
    writeFileSync(join(home, "outside.txt"), "ALIASED\n");
    linkSync(join(home, "outside.txt"), join(repository, "AGENTS.md"));
    writeFileSync(join(config, "AGENTS.md"), "WORLD-WRITABLE\n");
    if (process.platform === "win32") grantOthersWrite(join(config, "AGENTS.md"));
    else chmodSync(join(config, "AGENTS.md"), 0o666);
    writeFileSync(join(home, "AGENTS.md"), Buffer.from([0xff, 0xfe, 0x00]));
    const found = await discoverInstructionSources({
      workspaceRoot: workspace,
      home,
      globalConfigDirectory: config,
      workspace: workspacePort(workspace),
    });
    expect(found.sources).toEqual([]);
    expect([...found.refused].sort()).toEqual(["linked-file", "not-owner-private", "not-text"]);
  });

  it("refuses a pattern the walker cannot express instead of approximating it", async () => {
    const { home, config, workspace } = tree();
    writeFileSync(join(workspace, "opencode.json"), JSON.stringify({ instructions: ["{a,b}.md"] }));
    const found = await discoverInstructionSources({
      workspaceRoot: workspace,
      home,
      globalConfigDirectory: config,
      workspace: workspacePort(workspace),
    });
    expect(found.refused).toEqual(["unsupported-format"]);
  });
});

describe("instruction discovery bounds", () => {
  it("walks to the home directory inside it, to the repository root outside it, else nowhere", () => {
    expect(instructionAncestorDirectories("/Users/me/work/repo", "/Users/me")).toEqual([
      "/Users/me/work",
      "/Users/me",
    ]);
    expect(instructionAncestorDirectories("/Users/me", "/Users/me")).toEqual([]);
    expect(instructionAncestorDirectories("/opt/nowhere/at/all", "/Users/me")).toEqual([]);
  });

  it("resolves the global configuration directory as the producer does", () => {
    expect(globalOpenCodeConfigDirectory({}, "/Users/me")).toBe(
      join("/Users/me", ".config", "opencode"),
    );
    expect(globalOpenCodeConfigDirectory({ XDG_CONFIG_HOME: "/x/config" }, "/Users/me")).toBe(
      join("/x/config", "opencode"),
    );
    expect(globalOpenCodeConfigDirectory({ XDG_CONFIG_HOME: "relative" }, "/Users/me")).toBe(
      join("/Users/me", ".config", "opencode"),
    );
  });

  it("reads only string entries of a configuration's instructions", () => {
    expect(configuredInstructionEntries({ instructions: ["a.md", 3, "", null, "b.md"] })).toEqual([
      "a.md",
      "b.md",
    ]);
    expect(configuredInstructionEntries({})).toEqual([]);
    expect(configuredInstructionEntries({ instructions: "a.md" })).toBe("config-malformed");
  });
});
