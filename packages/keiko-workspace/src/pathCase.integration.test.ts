import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { detectWorkspaceAt } from "./detect.js";
import { discoverFiles } from "./discovery.js";
import { platformPathCase } from "./pathCase.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import { createStructuralExecutionControl } from "./structuralExecution.js";
import { DEFAULT_DISCOVERY_OPTIONS, type WorkspaceInfo, type WorkspacePathCase } from "./types.js";
import { createWorkspaceIndex, workspaceIgnorePolicyFingerprint } from "./workspaceIndex.js";
import { discoverWorkspacePaths } from "./workspacePathDiscovery.js";

// #4436: one letter-case rule for `.gitignore`, Coding search globs and path discovery. Each
// workspace states its rule explicitly, so every branch runs on every CI platform.

function workspace(pathCase?: WorkspacePathCase): WorkspaceInfo {
  return {
    root: resolve("/repo"),
    selectedRoot: resolve("/repo"),
    name: "fixture",
    version: "1",
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: ["build/", "*.tmp"],
    ...(pathCase === undefined ? {} : { pathCase }),
  };
}

const FILES = {
  "Build/out.md": "needle\n",
  "notes/GUIDE.MD": "needle\n",
  "notes/plain.md": "needle\n",
  "notes/Scratch.TMP": "needle\n",
  "notes/SECRET-1.md": "needle\n",
  "src/main.ts": "needle\n",
};

const QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "needle",
  caseSensitive: false,
  maxResults: 50,
  emittedAtMs: 0,
};

function scope(info: WorkspaceInfo): SearchScope {
  return { scopeId: "path-case", relativePaths: [], workspace: info };
}

const GLOBS = {
  include: ["**/*.md"],
  exclude: ["**/secret-*.md"],
  excludeLiteralPaths: ["NOTES/Plain.md"],
};

async function searchedPaths(
  info: WorkspaceInfo,
  workspaceIndex?: ReturnType<typeof createWorkspaceIndex>,
): Promise<readonly string[]> {
  const result = await searchText(scope(info), QUERY, DEFAULT_SEARCH_LIMITS, {
    fs: memFs(info.root, FILES),
    nowMs: (): number => 0,
    candidatePathGlobs: GLOBS,
    ...(workspaceIndex === undefined ? {} : { workspaceIndex }),
  });
  return result.atoms.map((atom) => atom.scopePath).sort();
}

describe("path-case rule across workspace matchers", () => {
  it("applies .gitignore rules to every case spelling when case-insensitive", () => {
    const fs = memFs(resolve("/repo"), FILES);
    const found = (pathCase: WorkspacePathCase): readonly string[] =>
      discoverFiles(workspace(pathCase), DEFAULT_DISCOVERY_OPTIONS, fs)
        .map((file) => file.relativePath)
        .sort();
    expect(found("case-insensitive")).toEqual([
      "notes/GUIDE.MD",
      "notes/SECRET-1.md",
      "notes/plain.md",
      "src/main.ts",
    ]);
    expect(found("case-sensitive")).toEqual([
      "Build/out.md",
      "notes/GUIDE.MD",
      "notes/SECRET-1.md",
      "notes/Scratch.TMP",
      "notes/plain.md",
      "src/main.ts",
    ]);
  });

  it("folds Coding search include, exclude and literal exclusions together", async () => {
    // Insensitive: `**/*.md` admits GUIDE.MD, `secret-*` excludes SECRET-1, the literal
    // `NOTES/Plain.md` excludes notes/plain.md, and `build/` ignores Build/out.md.
    expect(await searchedPaths(workspace("case-insensitive"))).toEqual(["notes/GUIDE.MD"]);
    expect(await searchedPaths(workspace("case-sensitive"))).toEqual([
      "Build/out.md",
      "notes/SECRET-1.md",
      "notes/plain.md",
    ]);
  });

  // Path handling itself follows the real platform, so only the matcher default is compared here;
  // pathCase.test.ts covers both platform branches of the default.
  it("uses the platform default when the workspace records no repository rule", async () => {
    expect(await searchedPaths(workspace())).toEqual(
      await searchedPaths(workspace(platformPathCase())),
    );
  });

  it("does not reuse a persistent snapshot across letter-case rules", async () => {
    const workspaceIndex = createWorkspaceIndex();
    expect(await searchedPaths(workspace("case-sensitive"), workspaceIndex)).toHaveLength(3);
    expect(await searchedPaths(workspace("case-insensitive"), workspaceIndex)).toEqual([
      "notes/GUIDE.MD",
    ]);
    expect(await searchedPaths(workspace("case-sensitive"), workspaceIndex)).toHaveLength(3);
  });

  it("keeps the existing ignore-policy identity for the case-sensitive rule", () => {
    const lines = ["build/"];
    expect(workspaceIgnorePolicyFingerprint(lines, "case-sensitive")).toBe(
      workspaceIgnorePolicyFingerprint(lines),
    );
    expect(workspaceIgnorePolicyFingerprint(lines, "case-insensitive")).not.toBe(
      workspaceIgnorePolicyFingerprint(lines),
    );
  });

  it("matches path-discovery globs and exact basenames by the rule", async () => {
    const fs = memFs(resolve("/repo"), FILES);
    const discover = async (
      pathCase: WorkspacePathCase,
      request: unknown,
      exactBasename?: string,
    ): Promise<readonly string[]> => {
      const control = {
        ...createStructuralExecutionControl(null),
        ...(exactBasename === undefined ? {} : { exactBasename }),
      };
      const result = await discoverWorkspacePaths(workspace(pathCase), request, control, fs);
      return result.entries.map((entry) => entry.relativePath).sort();
    };
    const glob = { mode: "glob", directory: "notes", query: "*.md", maxResults: 10 };
    expect(await discover("case-insensitive", glob)).toEqual([
      "notes/GUIDE.MD",
      "notes/SECRET-1.md",
      "notes/plain.md",
    ]);
    expect(await discover("case-sensitive", glob)).toEqual(["notes/SECRET-1.md", "notes/plain.md"]);
    const any = { mode: "keywords", directory: "", query: "guide", maxResults: 10 };
    expect(await discover("case-insensitive", any, "guide.md")).toEqual(["notes/GUIDE.MD"]);
    expect(await discover("case-sensitive", any, "guide.md")).toEqual([]);
    // An ignored directory cannot be selected in any case spelling under the folding rule.
    const ignored = { mode: "glob", directory: "BUILD", query: "*", maxResults: 10 };
    await expect(discover("case-insensitive", ignored)).rejects.toThrow(/excluded/u);
  });
});

describe("repository core.ignorecase during detection", () => {
  let dir = "";

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-path-case-")));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(relative: string, content: string): void {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  it.each([
    ["[core]\n\tignorecase = true\n", "case-insensitive"],
    ["[core]\n\tignorecase = false\n", "case-sensitive"],
  ] as const)("records %j as %s", (config, expected) => {
    file(".git/config", config);
    file(".git/HEAD", "ref: refs/heads/dev\n");
    expect(detectWorkspaceAt(dir).pathCase).toBe(expected);
  });

  it("records nothing without a Git repository or without the setting", () => {
    expect(detectWorkspaceAt(dir).pathCase).toBeUndefined();
    file(".git/config", "[core]\n\tbare = false\n");
    expect(detectWorkspaceAt(dir).pathCase).toBeUndefined();
  });

  it("ignores an oversized config instead of reading part of it", () => {
    file(".git/config", `[core]\n\tignorecase = false\n#${"x".repeat(70_000)}\n`);
    expect(detectWorkspaceAt(dir).pathCase).toBeUndefined();
  });

  it("reads a linked worktree's setting from its repository's common config", () => {
    const repository = join(dir, "repository");
    const worktree = join(dir, "worktree");
    file("repository/.git/config", "[core]\n\tignorecase = true\n");
    file("repository/.git/HEAD", "ref: refs/heads/dev\n");
    file("repository/.git/worktrees/wt/HEAD", "ref: refs/heads/feature\n");
    file("repository/.git/worktrees/wt/gitdir", `${join(worktree, ".git")}\n`);
    file("worktree/.git", `gitdir: ${join(repository, ".git", "worktrees", "wt")}\n`);
    expect(detectWorkspaceAt(worktree).pathCase).toBe("case-insensitive");
  });

  it("applies the recorded rule to the workspace's own .gitignore", () => {
    file(".git/config", "[core]\n\tignorecase = true\n");
    file(".gitignore", "build/\n");
    file("BUILD/out.ts", "x\n");
    file("src/main.ts", "x\n");
    const found = discoverFiles(detectWorkspaceAt(dir), DEFAULT_DISCOVERY_OPTIONS).map(
      (entry) => entry.relativePath,
    );
    expect(found).toContain("src/main.ts");
    expect(found).not.toContain("BUILD/out.ts");
  });
});
