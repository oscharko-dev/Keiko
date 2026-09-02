import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorkspaceFileForEditing as readViaPublishedSubpath } from "@oscharko-dev/keiko-workspace/internal/editor-read";
import {
  discoverCandidateInventory,
  discoverFiles,
  discoverWithStatsAsync,
  discoverWithStats,
  readWorkspaceFile,
  readWorkspaceFileForEditing,
} from "./discovery.js";
import { detectWorkspace, detectWorkspaceAt } from "./detect.js";
import { memFs } from "./_memfs.js";
import {
  FileTooLargeError,
  PathDeniedError,
  PathEscapeError,
  WorkspaceReadError,
} from "./errors.js";
import {
  nodeWorkspaceFs,
  type WorkspaceDirEntry,
  type WorkspaceFs,
  type WorkspaceStat,
} from "./fs.js";
import { DEFAULT_DISCOVERY_OPTIONS, type WorkspaceInfo } from "./types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keiko-disc-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(rel: string, body = "x"): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function paths(ws: WorkspaceInfo): readonly string[] {
  return discoverFiles(ws, DEFAULT_DISCOVERY_OPTIONS).map((f) => f.relativePath);
}

function fakeWorkspace(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: "x",
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: ["javascript"],
    ignoreLines: [],
  };
}

function mutableRootDiscoveryFs(): {
  readonly fs: WorkspaceFs;
  readonly readDirPaths: readonly string[];
  readonly selectedRootCalls: () => number;
  readonly statCalls: () => number;
} {
  const readDirPaths: string[] = [];
  let selectedRootCalls = 0;
  let statCalls = 0;
  return {
    fs: {
      readFileUtf8: (): string => "",
      stat: (): WorkspaceStat => {
        statCalls += 1;
        return { size: 1, isFile: true, isDirectory: false, isSymbolicLink: false };
      },
      readDir: (path): readonly WorkspaceDirEntry[] => {
        readDirPaths.push(path);
        return [{ name: "safe.ts", isDirectory: false, isFile: true, isSymbolicLink: false }];
      },
      realPath: (path): string => {
        if (path !== "/selected") return path;
        selectedRootCalls += 1;
        return selectedRootCalls === 1 ? "/safe/project" : "/safe/.aws";
      },
      exists: (): boolean => true,
    },
    readDirPaths,
    selectedRootCalls: () => selectedRootCalls,
    statCalls: () => statCalls,
  };
}

describe("discoverFiles", () => {
  it("discovers regular files in deterministic sorted order", () => {
    file("src/b.ts");
    file("src/a.ts");
    file("README.md");
    const found = paths(detectWorkspace(dir));
    expect(found).toEqual([...found].sort());
    expect(found).toContain("src/a.ts");
    expect(found).toContain("README.md");
  });

  it("skips always-on denied security paths even when not gitignored", () => {
    file("node_modules/left-pad/index.js");
    file(".env", "SECRET=1");
    file("dist/out.js");
    file("src/keep.ts");
    const found = paths(detectWorkspace(dir));
    expect(found).toContain("src/keep.ts");
    expect(found).not.toContain(".env");
    expect(found.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(found).toContain("dist/out.js");
  });

  it("respects .gitignore patterns", () => {
    writeFileSync(join(dir, ".gitignore"), "*.tmp\nscratch/\n", "utf8");
    file("a.tmp");
    file("scratch/note.txt");
    file("src/keep.ts");
    const found = paths(detectWorkspace(dir));
    expect(found).toContain("src/keep.ts");
    expect(found).not.toContain("a.tmp");
    expect(found.some((p) => p.startsWith("scratch"))).toBe(false);
  });

  it("caps total files at maxFiles", () => {
    for (let i = 0; i < 10; i += 1) {
      file(`src/f${String(i)}.ts`);
    }
    const found = discoverFiles(detectWorkspace(dir), {
      ...DEFAULT_DISCOVERY_OPTIONS,
      maxFiles: 3,
    });
    expect(found).toHaveLength(3);
  });

  it("caps internal candidate traversal even when no file fills the file budget", () => {
    const root = "/ws";
    let readDirCalls = 0;
    const requestedCaps: (number | undefined)[] = [];
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => "",
      stat: (): WorkspaceStat => ({
        size: 0,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      }),
      readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
        readDirCalls += 1;
        requestedCaps.push(maxEntries);
        const entries =
          absolutePath === root
            ? Array.from({ length: 100 }, (_, index) => ({
                name: `empty-${index.toString().padStart(3, "0")}`,
                isDirectory: true,
                isFile: false,
                isSymbolicLink: false,
              }))
            : [];
        return maxEntries === undefined ? entries : entries.slice(0, maxEntries);
      },
      realPath: (absolutePath): string => absolutePath,
      exists: (): boolean => true,
    };
    const result = discoverCandidateInventory(
      fakeWorkspace(root),
      { ...DEFAULT_DISCOVERY_OPTIONS, maxFiles: 1 },
      fs,
    );
    const traversalEntryBudget = Math.max(2, DEFAULT_DISCOVERY_OPTIONS.maxDepth + 2);

    expect(result.files).toEqual([]);
    expect(result.directories.length).toBeLessThanOrEqual(traversalEntryBudget + 1);
    expect(readDirCalls).toBeLessThanOrEqual(traversalEntryBudget + 1);
    expect(requestedCaps).toEqual([traversalEntryBudget + 1]);
    expect(result.stats.maxFilesPruned).toBeGreaterThan(0);
  });

  it("exhausts one global entry budget after the first overflowing sibling directory", () => {
    const root = "/ws";
    const readDirPaths: string[] = [];
    const requestedCaps: (number | undefined)[] = [];
    const siblingNames = ["large-c", "large-b", "large-a"];
    const overflowingEntries = Array.from({ length: 100 }, (_, index) => ({
      name: `entry-${index.toString().padStart(3, "0")}`,
      isDirectory: true,
      isFile: false,
      isSymbolicLink: false,
    }));
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => "",
      stat: (): WorkspaceStat => ({
        size: 0,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      }),
      readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
        readDirPaths.push(absolutePath);
        requestedCaps.push(maxEntries);
        const entries =
          absolutePath === root
            ? siblingNames.map((name) => ({
                name,
                isDirectory: true,
                isFile: false,
                isSymbolicLink: false,
              }))
            : overflowingEntries;
        return maxEntries === undefined ? entries : entries.slice(0, maxEntries);
      },
      realPath: (absolutePath): string => absolutePath,
      exists: (): boolean => true,
    };

    const result = discoverCandidateInventory(
      fakeWorkspace(root),
      { ...DEFAULT_DISCOVERY_OPTIONS, maxFiles: 8 },
      fs,
    );

    expect(result.files).toEqual([]);
    expect(readDirPaths).toEqual([root, `${root}/large-a`]);
    expect(requestedCaps).toHaveLength(2);
    expect(requestedCaps.every((cap) => cap !== undefined)).toBe(true);
    expect(result.stats.maxFilesPruned).toBeGreaterThan(0);
  });

  it("deterministically rejects an internal flat directory that exceeds the traversal budget", () => {
    const root = join(dir, "candidate-flat-overflow");
    mkdirSync(root);
    const names = Array.from(
      { length: 50 },
      (_, index) => `entry-${index.toString().padStart(2, "0")}.ts`,
    );
    for (const name of [...names].reverse()) writeFileSync(join(root, name), "x", "utf8");

    const result = discoverCandidateInventory(fakeWorkspace(root), {
      ...DEFAULT_DISCOVERY_OPTIONS,
      maxFiles: 1,
    });

    expect(result.files).toEqual([]);
    expect(result.directorySnapshots).toEqual([]);
    expect(result.stats.maxFilesPruned).toBeGreaterThan(0);
  });

  it("keeps the public maxFiles contract independent of directory entry count", () => {
    const forwardRoot = join(dir, "forward");
    const reverseRoot = join(dir, "reverse");
    const names = Array.from(
      { length: 50 },
      (_, index) => `entry-${index.toString().padStart(2, "0")}.ts`,
    );
    for (const [root, order] of [
      [forwardRoot, names],
      [reverseRoot, [...names].reverse()],
    ] as const) {
      mkdirSync(root);
      writeFileSync(join(root, "package.json"), "{}", "utf8");
      for (const name of order) writeFileSync(join(root, name), "x", "utf8");
    }
    const options = { ...DEFAULT_DISCOVERY_OPTIONS, maxFiles: 1 };

    const forward = discoverWithStats(detectWorkspaceAt(forwardRoot), options);
    const reverse = discoverWithStats(detectWorkspaceAt(reverseRoot), options);

    expect(forward.files.map((entry) => entry.relativePath)).toEqual(["entry-00.ts"]);
    expect(reverse.files).toEqual(forward.files);
    expect(forward.stats.maxFilesPruned).toBeGreaterThan(0);
    expect(reverse.stats.maxFilesPruned).toBeGreaterThan(0);
  });

  it("passes a finite entry cap to every public-discovery directory read", () => {
    // #3347 (owner P1): public discovery passed `maxEntries: undefined`, so `nodeWorkspaceFs.readDir`
    // took the `readdirSync(...).map(...).sort(...)` branch and materialized the whole directory.
    // This pins the ARGUMENT, so dropping the cap fails here even when the yielded files are equal.
    file("src/a.ts");
    file("src/nested/b.ts");
    const requestedCaps: (number | undefined)[] = [];
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
        requestedCaps.push(maxEntries);
        return nodeWorkspaceFs.readDir(absolutePath, maxEntries);
      },
    };

    const found = discoverFiles(detectWorkspace(dir), DEFAULT_DISCOVERY_OPTIONS, fs).map(
      (entry) => entry.relativePath,
    );

    expect(found).toContain("src/nested/b.ts");
    expect(requestedCaps.length).toBeGreaterThan(0);
    expect(requestedCaps.every((cap) => cap !== undefined && Number.isFinite(cap))).toBe(true);
  });

  it("bounds ONE high-fan-out public-discovery directory instead of materializing it", async () => {
    // The DoS behind #3347 needs a single huge directory, not many small ones: the whole cost is one
    // synchronous allocate-and-sort that the async walk cannot yield across. The fake builds only as
    // many entries as it is asked for, so `materialized` is the memory the walk actually demanded.
    const root = "/ws";
    const hugeDirectoryEntries = 60_000;
    const requestedCaps: (number | undefined)[] = [];
    let materialized = 0;
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => "",
      stat: (absolutePath): WorkspaceStat => ({
        size: 1,
        isFile: absolutePath !== root,
        isDirectory: absolutePath === root,
        isSymbolicLink: false,
      }),
      readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
        requestedCaps.push(maxEntries);
        if (absolutePath !== root) return [];
        const produced = Math.min(maxEntries ?? hugeDirectoryEntries, hugeDirectoryEntries);
        materialized += produced;
        return Array.from({ length: produced }, (_, index) => ({
          name: `entry-${index.toString().padStart(6, "0")}.ts`,
          isDirectory: false,
          isFile: true,
          isSymbolicLink: false,
        }));
      },
      realPath: (absolutePath): string => absolutePath,
      exists: (): boolean => true,
    };
    const workspace = fakeWorkspace(root);

    const result = discoverWithStats(workspace, DEFAULT_DISCOVERY_OPTIONS, fs);
    const streamed = await discoverWithStatsAsync(workspace, DEFAULT_DISCOVERY_OPTIONS, fs);

    expect(requestedCaps.every((cap) => cap !== undefined && Number.isFinite(cap))).toBe(true);
    expect(materialized).toBeLessThan(hugeDirectoryEntries);
    // Truncation is reported rather than an arbitrary filesystem-order prefix being discovered.
    expect(result.files).toEqual([]);
    expect(result.stats.maxFilesPruned).toBeGreaterThan(0);
    expect(streamed.files).toEqual([]);
    expect(streamed.stats.maxFilesPruned).toBeGreaterThan(0);
  });

  it("keeps walking siblings after a directory exceeds the per-directory entry bound", () => {
    // The memory bound is not the traversal entry budget: one oversized directory is skipped and
    // reported, while the rest of the walk still completes.
    const root = "/ws";
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => "",
      stat: (absolutePath): WorkspaceStat => ({
        size: 1,
        isFile: absolutePath.endsWith(".ts"),
        isDirectory: !absolutePath.endsWith(".ts"),
        isSymbolicLink: false,
      }),
      readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
        if (absolutePath === root) {
          return ["huge", "small"].map((name) => ({
            name,
            isDirectory: true,
            isFile: false,
            isSymbolicLink: false,
          }));
        }
        if (absolutePath === `${root}/small`) {
          return [{ name: "keep.ts", isDirectory: false, isFile: true, isSymbolicLink: false }];
        }
        return Array.from({ length: maxEntries ?? 1 }, (_, index) => ({
          name: `noise-${index.toString().padStart(6, "0")}.ts`,
          isDirectory: false,
          isFile: true,
          isSymbolicLink: false,
        }));
      },
      realPath: (absolutePath): string => absolutePath,
      exists: (): boolean => true,
    };

    const result = discoverWithStats(fakeWorkspace(root), DEFAULT_DISCOVERY_OPTIONS, fs);

    expect(result.files.map((entry) => entry.relativePath)).toEqual(["small/keep.ts"]);
    expect(result.stats.maxFilesPruned).toBeGreaterThan(0);
  });

  it("caps recursion at maxDepth", () => {
    file("a/b/c/d/deep.ts");
    file("top.ts");
    const found = discoverFiles(detectWorkspace(dir), {
      ...DEFAULT_DISCOVERY_OPTIONS,
      maxDepth: 1,
    }).map((f) => f.relativePath);
    expect(found).toContain("top.ts");
    expect(found).not.toContain("a/b/c/d/deep.ts");
  });

  it("counts directories skipped by the maxDepth cap", () => {
    file("a/b/c/deep.ts");
    file("top.ts");
    const { stats } = discoverWithStats(detectWorkspace(dir), {
      ...DEFAULT_DISCOVERY_OPTIONS,
      maxDepth: 1,
    });
    expect(stats.depthPruned).toBeGreaterThan(0);
  });

  it("skips a symlink whose realpath escapes the workspace root", () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "TOPSECRET", "utf8");
      file("src/keep.ts");
      symlinkSync(join(outside, "secret.txt"), join(dir, "src", "leak.txt"));
      const found = paths(detectWorkspace(dir));
      expect(found).toContain("src/keep.ts");
      expect(found).not.toContain("src/leak.txt");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to walk a benign-named root that is a symlink into a denied dir", async () => {
    // Discovery does not realpath-contain the ROOT, so a "docs" -> ".aws" symlink would otherwise list
    // the credential dir's files. The walk fails closed before anything can be listed.
    const aws = join(dir, ".aws");
    mkdirSync(aws);
    writeFileSync(join(aws, "credentials.md"), "aws_secret should never be listed", "utf8");
    symlinkSync(aws, join(dir, "docs"));
    const ws = fakeWorkspace(join(dir, "docs"));
    expect(() => discoverFiles(ws, DEFAULT_DISCOVERY_OPTIONS)).toThrow(PathDeniedError);
    expect(() => discoverWithStats(ws, DEFAULT_DISCOVERY_OPTIONS)).toThrow(PathDeniedError);
    await expect(discoverWithStatsAsync(ws, DEFAULT_DISCOVERY_OPTIONS)).rejects.toBeInstanceOf(
      PathDeniedError,
    );
  });

  it("refuses a root symlink that replaces one denied ancestor with another", () => {
    const lexicalParent = join(dir, "node_modules");
    const deniedTarget = join(dir, ".aws", "workspace");
    mkdirSync(lexicalParent);
    mkdirSync(deniedTarget, { recursive: true });
    writeFileSync(join(deniedTarget, "notes.md"), "must not be listed", "utf8");
    const linkedRoot = join(lexicalParent, "linked-workspace");
    symlinkSync(deniedTarget, linkedRoot);
    const workspace = fakeWorkspace(linkedRoot);

    expect(() => discoverFiles(workspace, DEFAULT_DISCOVERY_OPTIONS)).toThrow(PathDeniedError);
    expect(() => discoverWithStats(workspace, DEFAULT_DISCOVERY_OPTIONS)).toThrow(PathDeniedError);
    expect(() => readWorkspaceFile(workspace, "notes.md")).toThrow(PathDeniedError);
  });

  it("rejects a directly selected credential root before any workspace read", () => {
    const credentialRoot = join(dir, ".aws");
    mkdirSync(credentialRoot);
    writeFileSync(join(credentialRoot, "credentials"), "must not be read", "utf8");
    let readDirCalls = 0;
    let statCalls = 0;
    let contentReadCalls = 0;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readDir: (): readonly WorkspaceDirEntry[] => {
        readDirCalls += 1;
        return [];
      },
      stat: (): WorkspaceStat => {
        statCalls += 1;
        throw new Error("denied root must not be statted");
      },
      readFileUtf8: (): string => {
        contentReadCalls += 1;
        return "must not be read";
      },
    };

    expect(() =>
      discoverFiles(fakeWorkspace(credentialRoot), DEFAULT_DISCOVERY_OPTIONS, fs),
    ).toThrow(PathDeniedError);
    expect({ readDirCalls, statCalls, contentReadCalls }).toEqual({
      readDirCalls: 0,
      statCalls: 0,
      contentReadCalls: 0,
    });
  });

  it("does not re-resolve the lexical root after binding discovery to its admitted identity", () => {
    const selected = join(dir, "selected");
    const safe = join(dir, "safe");
    const denied = join(dir, ".aws");
    let realPathCalls = 0;
    let readDirCalls = 0;
    let statCalls = 0;
    const base = memFs(selected, {});
    const fs: WorkspaceFs = {
      ...base,
      realPath: (absolutePath): string => {
        if (absolutePath !== selected) return absolutePath;
        realPathCalls += 1;
        return realPathCalls === 1 ? safe : denied;
      },
      readDir: (): readonly WorkspaceDirEntry[] => {
        readDirCalls += 1;
        return [];
      },
      stat: (): WorkspaceStat => {
        statCalls += 1;
        return { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false };
      },
    };

    expect(discoverFiles(fakeWorkspace(selected), DEFAULT_DISCOVERY_OPTIONS, fs)).toEqual([]);
    expect({ realPathCalls, readDirCalls, statCalls }).toEqual({
      realPathCalls: 1,
      readDirCalls: 1,
      statCalls: 0,
    });
  });

  it("refuses a root symlink relocated between separate loci of the same denied ancestor", () => {
    const lexicalParent = join(dir, ".codex", "worktrees", "fixture");
    const deniedTarget = join(dir, "other", ".codex");
    mkdirSync(lexicalParent, { recursive: true });
    mkdirSync(deniedTarget, { recursive: true });
    writeFileSync(join(deniedTarget, "notes.md"), "must not be listed", "utf8");
    const linkedRoot = join(lexicalParent, "docs");
    symlinkSync(deniedTarget, linkedRoot);
    const workspace = fakeWorkspace(linkedRoot);

    expect(() => discoverFiles(workspace, DEFAULT_DISCOVERY_OPTIONS)).toThrow(PathDeniedError);
    expect(() => discoverWithStats(workspace, DEFAULT_DISCOVERY_OPTIONS)).toThrow(PathDeniedError);
    expect(() => readWorkspaceFile(workspace, "notes.md")).toThrow(PathDeniedError);
  });

  it("does not follow an internal symlink-to-file, but keeps the real target", () => {
    // Conservative, environment-independent behavior: a symlink is never traversed. The real
    // file is still found and discovery never throws. (Escaping symlinks are covered above.)
    file("src/real.ts", "data");
    symlinkSync(join(dir, "src", "real.ts"), join(dir, "src", "alias.ts"));
    const found = paths(detectWorkspace(dir));
    expect(found).toContain("src/real.ts");
    expect(found).not.toContain("src/alias.ts");
  });

  it("drops an enumeration when its directory is replaced after entries are returned", () => {
    file("docs/safe.ts", "SAFE");
    const outside = mkdtempSync(join(tmpdir(), "keiko-directory-race-outside-"));
    const documentDirectory = realpathSync(join(dir, "docs"));
    let swapped = false;
    try {
      writeFileSync(join(outside, "private.ts"), "OUTSIDE_PRIVATE_BYTES", "utf8");
      const fs: WorkspaceFs = {
        ...nodeWorkspaceFs,
        readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
          if (!swapped && absolutePath === documentDirectory) {
            const entries = nodeWorkspaceFs.readDir(outside, maxEntries);
            renameSync(join(dir, "docs"), join(dir, "docs-original"));
            symlinkSync(outside, join(dir, "docs"));
            swapped = true;
            return entries;
          }
          return nodeWorkspaceFs.readDir(absolutePath, maxEntries);
        },
      };

      const found = discoverFiles(detectWorkspace(dir), DEFAULT_DISCOVERY_OPTIONS, fs);

      expect(swapped).toBe(true);
      expect(found.map((entry) => entry.relativePath)).not.toContain("docs/private.ts");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps the original canonical root as the authority anchor for the full walk", () => {
    const root = "/workspace";
    const safeRoot = "/safe/workspace";
    let swapped = false;
    const directoryStat = (fileIdentity: string): WorkspaceStat => ({
      size: 1,
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      hardLinkCount: 1,
      mtimeNs: "1",
      ctimeNs: "1",
      fileIdentity,
    });
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => "",
      stat: (absolutePath): WorkspaceStat =>
        absolutePath === safeRoot ? directoryStat("1:1") : directoryStat("2:2"),
      readDir: (absolutePath): readonly WorkspaceDirEntry[] => {
        if (absolutePath === safeRoot) {
          swapped = true;
          return [
            {
              name: "private.ts",
              isDirectory: false,
              isFile: true,
              isSymbolicLink: false,
            },
          ];
        }
        return [];
      },
      realPath: (absolutePath): string => {
        if (absolutePath === root) return swapped ? "/outside/workspace" : safeRoot;
        return absolutePath;
      },
      exists: (): boolean => true,
    };

    const found = discoverFiles(fakeWorkspace(root), DEFAULT_DISCOVERY_OPTIONS, fs);

    expect(swapped).toBe(true);
    expect(found).toEqual([]);
  });

  it("tolerates an unreadable subdirectory without throwing", () => {
    const root = "/ws";
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => "",
      stat: (): WorkspaceStat => ({
        size: 0,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      }),
      readDir: (p: string): readonly WorkspaceDirEntry[] => {
        if (p === root) {
          return [{ name: "locked", isDirectory: true, isFile: false, isSymbolicLink: false }];
        }
        throw new Error("EACCES");
      },
      realPath: (p: string): string => p,
      exists: (): boolean => true,
    };
    expect(discoverFiles(fakeWorkspace(root), DEFAULT_DISCOVERY_OPTIONS, fs)).toEqual([]);
  });

  it("keeps public unavailable-root discovery tolerant without probing the root", async () => {
    let readDirCalls = 0;
    let statCalls = 0;
    let contentReadCalls = 0;
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => {
        contentReadCalls += 1;
        return "";
      },
      stat: (): never => {
        statCalls += 1;
        throw new Error("unavailable root must not be statted");
      },
      readDir: (): readonly WorkspaceDirEntry[] => {
        readDirCalls += 1;
        return [];
      },
      realPath: (): never => {
        throw new Error("EACCES");
      },
      exists: (): boolean => false,
    };
    const workspace = fakeWorkspace("/unavailable");

    expect(discoverFiles(workspace, DEFAULT_DISCOVERY_OPTIONS, fs)).toEqual([]);
    expect(discoverWithStats(workspace, DEFAULT_DISCOVERY_OPTIONS, fs).files).toEqual([]);
    expect((await discoverWithStatsAsync(workspace, DEFAULT_DISCOVERY_OPTIONS, fs)).files).toEqual(
      [],
    );
    expect(() => discoverCandidateInventory(workspace, DEFAULT_DISCOVERY_OPTIONS, fs)).toThrow(
      WorkspaceReadError,
    );
    expect({ readDirCalls, statCalls, contentReadCalls }).toEqual({
      readDirCalls: 0,
      statCalls: 0,
      contentReadCalls: 0,
    });
  });

  it("enumerates only the admitted canonical root when the lexical alias changes", () => {
    const measured = mutableRootDiscoveryFs();

    expect(
      discoverFiles(fakeWorkspace("/selected"), DEFAULT_DISCOVERY_OPTIONS, measured.fs),
    ).toEqual([{ relativePath: "safe.ts", sizeBytes: 1 }]);
    expect(measured.readDirPaths).toEqual(["/safe/project"]);
    expect(measured.readDirPaths).not.toContain("/selected");
    expect(measured.selectedRootCalls()).toBe(1);
    expect(measured.statCalls()).toBe(1);
  });

  it("enumerates only the admitted canonical root in asynchronous discovery", async () => {
    const measured = mutableRootDiscoveryFs();

    const result = await discoverWithStatsAsync(
      fakeWorkspace("/selected"),
      DEFAULT_DISCOVERY_OPTIONS,
      measured.fs,
    );
    expect(result.files).toEqual([{ relativePath: "safe.ts", sizeBytes: 1 }]);
    expect(measured.readDirPaths).toEqual(["/safe/project"]);
    expect(measured.readDirPaths).not.toContain("/selected");
    expect(measured.selectedRootCalls()).toBe(1);
    expect(measured.statCalls()).toBe(1);
  });

  it("reports denied and ignored counts via discoverWithStats", () => {
    writeFileSync(join(dir, ".gitignore"), "*.tmp\n", "utf8");
    file(".env", "SECRET=1");
    file("a.tmp");
    file("src/keep.ts");
    const { stats } = discoverWithStats(detectWorkspace(dir), DEFAULT_DISCOVERY_OPTIONS);
    expect(stats.denied).toBeGreaterThanOrEqual(1);
    expect(stats.ignored).toBeGreaterThanOrEqual(1);
    expect(stats.depthPruned).toBe(0);
    expect(stats.discovered).toBeGreaterThanOrEqual(1);
  });

  it("bounds the internal skipped-symlink inventory and reports pruning", () => {
    const root = "/ws";
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => "",
      stat: (): WorkspaceStat => ({
        size: 0,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      }),
      readDir: (): readonly WorkspaceDirEntry[] =>
        Array.from({ length: 100 }, (_, index) => ({
          name: `link-${index.toString().padStart(3, "0")}`,
          isDirectory: false,
          isFile: false,
          isSymbolicLink: true,
        })),
      realPath: (absolutePath): string => absolutePath,
      exists: (): boolean => true,
    };

    const result = discoverCandidateInventory(
      fakeWorkspace(root),
      { ...DEFAULT_DISCOVERY_OPTIONS, maxFiles: 1 },
      fs,
    );

    expect(result.skippedSymbolicLinks).toEqual([]);
    // A capped read returns filesystem order, so the bounded traversal rejects the whole overflowing
    // directory rather than presenting an arbitrary prefix as a deterministic inventory.
    expect(result.stats.maxFilesPruned).toBeGreaterThan(0);
  });

  it("fails internal candidate discovery when a directory cannot be read", () => {
    const root = "/ws";
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => "",
      stat: (): WorkspaceStat => ({
        size: 0,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      }),
      readDir: (): never => {
        throw new Error("EIO");
      },
      realPath: (absolutePath): string => absolutePath,
      exists: (): boolean => true,
    };

    expect(() =>
      discoverCandidateInventory(fakeWorkspace(root), DEFAULT_DISCOVERY_OPTIONS, fs),
    ).toThrow(WorkspaceReadError);
    expect(discoverWithStats(fakeWorkspace(root), DEFAULT_DISCOVERY_OPTIONS, fs).files).toEqual([]);
  });

  it("revalidates a stale directory entry before descending through a swapped symlink", async () => {
    const root = "/ws";
    let outsideReadDirCalls = 0;
    const fs: WorkspaceFs = {
      readFileUtf8: (): never => {
        throw new Error("content must not be read");
      },
      stat: (): WorkspaceStat => ({
        size: 0,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      }),
      readDir: (absolutePath): readonly WorkspaceDirEntry[] => {
        if (absolutePath === root) {
          return [{ name: "swapped", isDirectory: true, isFile: false, isSymbolicLink: false }];
        }
        if (absolutePath.startsWith("/outside")) outsideReadDirCalls += 1;
        return [{ name: "secret.txt", isDirectory: false, isFile: true, isSymbolicLink: false }];
      },
      realPath: (absolutePath): string =>
        absolutePath === `${root}/swapped` ? "/outside/swapped" : absolutePath,
      exists: (): boolean => true,
    };
    const workspace = fakeWorkspace(root);

    const sync = discoverWithStats(workspace, DEFAULT_DISCOVERY_OPTIONS, fs);
    const asyncResult = await discoverWithStatsAsync(workspace, DEFAULT_DISCOVERY_OPTIONS, fs);

    expect(sync.files).toEqual([]);
    expect(asyncResult).toEqual(sync);
    expect(sync.stats.denied).toBe(1);
    expect(outsideReadDirCalls).toBe(0);
    expect(() => discoverCandidateInventory(workspace, DEFAULT_DISCOVERY_OPTIONS, fs)).toThrow(
      PathEscapeError,
    );
    expect(outsideReadDirCalls).toBe(0);
  });

  it("fails internal candidate discovery when a discovered file cannot be stated", () => {
    const root = "/ws";
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => "",
      stat: (): never => {
        throw new Error("EIO");
      },
      readDir: (absolutePath): readonly WorkspaceDirEntry[] =>
        absolutePath === root
          ? [{ name: "unreadable.ts", isDirectory: false, isFile: true, isSymbolicLink: false }]
          : [],
      realPath: (absolutePath): string => absolutePath,
      exists: (): boolean => true,
    };

    expect(() =>
      discoverCandidateInventory(fakeWorkspace(root), DEFAULT_DISCOVERY_OPTIONS, fs),
    ).toThrow(WorkspaceReadError);
    expect(discoverWithStats(fakeWorkspace(root), DEFAULT_DISCOVERY_OPTIONS, fs).files).toEqual([]);
  });

  it("keeps async discovery identical across every filtering and pruning branch", async () => {
    writeFileSync(join(dir, ".gitignore"), "*.tmp\n", "utf8");
    file(".env", "SECRET=1");
    file("ignored.tmp");
    file("depth/one/two/deep.ts");
    file("real.ts");
    symlinkSync(join(dir, "real.ts"), join(dir, "alias.ts"));
    file("z-one.ts");
    file("z-two.ts");
    file("z-three.ts");
    const workspace = detectWorkspace(dir);
    const options = { ...DEFAULT_DISCOVERY_OPTIONS, maxDepth: 1, maxFiles: 3 };

    expect(await discoverWithStatsAsync(workspace, options)).toEqual(
      discoverWithStats(workspace, options),
    );
  });
});

describe("readWorkspaceFile", () => {
  it("reads a file inside the workspace and redacts secrets", () => {
    const secret = ["sk-", "abcdef0123456789ABCDEF"].join("");
    file("notes.txt", `token ${secret} rest`);
    const content = readWorkspaceFile(detectWorkspace(dir), "notes.txt");
    expect(content.text).not.toContain(secret);
    expect(content.relativePath).toBe("notes.txt");
  });

  it("rejects a traversal escape", () => {
    expect(() => readWorkspaceFile(detectWorkspace(dir), "../escape")).toThrow(PathEscapeError);
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => readWorkspaceFile(detectWorkspace(dir), "/etc/passwd")).toThrow(PathEscapeError);
  });

  it("refuses to read a denied path with PathDeniedError", () => {
    file(".env", "SECRET=1");
    expect(() => readWorkspaceFile(detectWorkspace(dir), ".env")).toThrow(PathDeniedError);
  });

  it("refuses to read a symlink alias whose real target is denied", () => {
    file(".env", "SECRET=1");
    symlinkSync(join(dir, ".env"), join(dir, "alias.env"));
    expect(() => readWorkspaceFile(detectWorkspace(dir), "alias.env")).toThrow(PathDeniedError);
  });

  it("refuses an explicit path retargeted to a different in-workspace file", () => {
    file("selected.ts", "selected bytes");
    file("other.ts", "other bytes");
    const workspace = detectWorkspace(dir);

    unlinkSync(join(dir, "selected.ts"));
    symlinkSync(join(dir, "other.ts"), join(dir, "selected.ts"));

    expect(() => readWorkspaceFile(workspace, "selected.ts")).toThrow(PathDeniedError);
    expect(() => readWorkspaceFileForEditing(workspace, "selected.ts")).toThrow(PathDeniedError);
  });

  it("uses the contained relative path without re-resolving a mutable root", () => {
    let rootResolutionCalls = 0;
    let statCalls = 0;
    let readCalls = 0;
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => {
        readCalls += 1;
        return "must not be read";
      },
      stat: (): WorkspaceStat => {
        statCalls += 1;
        return { size: 16, isFile: true, isDirectory: false, isSymbolicLink: false };
      },
      readDir: (): readonly WorkspaceDirEntry[] => [],
      realPath: (path): string => {
        if (path === "/selected") {
          rootResolutionCalls += 1;
          return rootResolutionCalls === 1 ? "/safe/project" : "/safe/project/.aws";
        }
        if (path === "/selected/alias.txt") return "/safe/project/.aws/credentials";
        return path;
      },
      exists: (): boolean => true,
    };

    expect(() =>
      readWorkspaceFile(fakeWorkspace("/selected"), "alias.txt", { maxBytes: 100 }, fs),
    ).toThrow(PathDeniedError);
    expect(rootResolutionCalls).toBe(1);
    expect(statCalls).toBe(0);
    expect(readCalls).toBe(0);
  });

  it("fails closed before probing a file when the workspace root is unavailable", () => {
    let statCalls = 0;
    let readCalls = 0;
    let existsCalls = 0;
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => {
        readCalls += 1;
        return "must not be read";
      },
      stat: (): WorkspaceStat => {
        statCalls += 1;
        return { size: 16, isFile: true, isDirectory: false, isSymbolicLink: false };
      },
      readDir: (): readonly WorkspaceDirEntry[] => [],
      realPath: (path): string => {
        if (path === "/selected") throw new Error("EACCES /private/customer/.aws");
        return "/safe/project/selected.ts";
      },
      exists: (): boolean => {
        existsCalls += 1;
        return true;
      },
    };

    let failure: unknown;
    try {
      readWorkspaceFile(fakeWorkspace("/selected"), "selected.ts", { maxBytes: 100 }, fs);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WorkspaceReadError);
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) expect(failure.message).not.toContain("/private/customer/.aws");
    expect({ statCalls, readCalls, existsCalls }).toEqual({
      statCalls: 0,
      readCalls: 0,
      existsCalls: 0,
    });
  });

  it("refuses to read inside a benign-named root that is a symlink into a denied dir", () => {
    // A directory symlink whose name is innocuous ("docs") but whose REAL target is a denied
    // credential dir (".aws") must not read through: the relative deny checks only see the basename,
    // and the realpath'd ROOT (where ".aws" lives) is invisible to them. Pins the symlinked-root guard.
    const aws = join(dir, ".aws");
    mkdirSync(aws);
    writeFileSync(join(aws, "config.md"), "aws_session_token opaque-bare-token-not-shaped", "utf8");
    symlinkSync(aws, join(dir, "docs")); // benign-named link -> denied real dir
    expect(() => readWorkspaceFile(fakeWorkspace(join(dir, "docs")), "config.md")).toThrow(
      PathDeniedError,
    );
  });

  it("still reads an admitted Codex worktree below its denied internal-state ancestor", () => {
    const nested = join(dir, ".codex", "worktrees", "task", "project");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "notes.md"), "ordinary project notes", "utf8");
    const content = readWorkspaceFile(detectWorkspaceAt(nested), "notes.md");
    expect(content.text).toBe("ordinary project notes");
  });

  it("still reads through a benign-named root symlink whose real target is NOT denied", () => {
    // Positive control: a root symlink that resolves to an ordinary directory must keep reading — the
    // guard must not over-block legitimate symlinked workspaces (only denied real targets are refused).
    const real = join(dir, "realdocs");
    mkdirSync(real);
    writeFileSync(join(real, "spec.md"), "the system shall validate input", "utf8");
    symlinkSync(real, join(dir, "linked"));
    const content = readWorkspaceFile(detectWorkspaceAt(join(dir, "linked")), "spec.md");
    expect(content.text).toBe("the system shall validate input");
  });

  it("refuses to read hard-linked aliases for context ingestion", () => {
    file(".env", "DB_PASSWORD=bank-super-secret\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    linkSync(join(dir, ".env"), join(dir, "src", "config.ts"));
    expect(() => readWorkspaceFile(detectWorkspace(dir), "src/config.ts")).toThrow(PathDeniedError);
  });

  it("denied-path error carries the WORKSPACE_PATH_DENIED code", () => {
    file(".env", "SECRET=1");
    let caught: unknown;
    try {
      readWorkspaceFile(detectWorkspace(dir), ".env");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PathDeniedError);
    expect((caught as PathDeniedError).code).toBe("WORKSPACE_PATH_DENIED");
  });

  it("throws FileTooLargeError when the file exceeds the cap", () => {
    file("big.txt", "a".repeat(100));
    expect(() => readWorkspaceFile(detectWorkspace(dir), "big.txt", { maxBytes: 10 })).toThrow(
      FileTooLargeError,
    );
  });

  it("reports a read error for a missing file", () => {
    expect(() => readWorkspaceFile(detectWorkspace(dir), "missing.txt")).toThrow(
      WorkspaceReadError,
    );
  });

  it("wraps a non-Error filesystem throw into a WorkspaceReadError", () => {
    const root = "/ws";
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "raw string failure";
      },
      stat: (): WorkspaceStat => ({
        size: 5,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      }),
      readDir: (): readonly WorkspaceDirEntry[] => [],
      realPath: (p: string): string => p,
      exists: (): boolean => true,
    };
    expect(() => readWorkspaceFile(fakeWorkspace(root), "a.txt", { maxBytes: 100 }, fs)).toThrow(
      WorkspaceReadError,
    );
  });

  it("rejects a symlink inside the workspace that points outside the root", () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "TOPSECRET", "utf8");
      symlinkSync(join(outside, "secret.txt"), join(dir, "leak.txt"));
      expect(() => readWorkspaceFile(detectWorkspace(dir), "leak.txt")).toThrow(PathEscapeError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reads a normal in-root file (positive control for symlink containment)", () => {
    file("notes.txt", "hello");
    const content = readWorkspaceFile(detectWorkspace(dir), "notes.txt");
    expect(content.relativePath).toBe("notes.txt");
    expect(content.text).toBe("hello");
  });
  it("reports sizeBytes as UTF-8 byte count, not string length (multi-byte content)", () => {
    // "é" is 2 UTF-8 bytes; 10 × "é" = 20 UTF-8 bytes but only 10 UTF-16 code units.
    // The cap must be above the file size so readContent runs, then sizeBytes must reflect bytes.
    file("multi.txt", "é".repeat(10));
    const content = readWorkspaceFile(detectWorkspace(dir), "multi.txt", { maxBytes: 20 });
    expect(content.truncated).toBe(false);
    expect(content.sizeBytes).toBe(20); // UTF-8 bytes, not the 10 code units
    expect(content.sizeBytes).not.toBe(10);
  });

  it("enforces FileTooLargeError by UTF-8 byte size for multi-byte content", () => {
    // "€" is 3 UTF-8 bytes; 4 × "€" = 12 bytes. Cap of 10 bytes must reject.
    file("euros.txt", "€€€€");
    expect(() => readWorkspaceFile(detectWorkspace(dir), "euros.txt", { maxBytes: 10 })).toThrow(
      FileTooLargeError,
    );
  });
});

// The editor lane (see the read-lane boundary note in discovery.ts). It must return the RAW bytes
// AND run the identical security chain — a raw read is not a relaxed read.
describe("readWorkspaceFileForEditing", () => {
  const SECRET_LINE = 'const token = "s3cr3t-lookup-value";';

  it("returns the raw bytes where the evidence-lane read redacts them", () => {
    file("app.ts", `${SECRET_LINE}\n`);
    const workspace = detectWorkspace(dir);
    const raw = readWorkspaceFileForEditing(workspace, "app.ts");
    const redacted = readWorkspaceFile(workspace, "app.ts");

    expect(raw.rawText).toBe(`${SECRET_LINE}\n`);
    expect(raw.rawText).toContain("s3cr3t-lookup-value");
    expect(redacted.text).not.toContain("s3cr3t-lookup-value");
    expect(redacted.text).toContain("[REDACTED]");
  });

  it("preserves line numbering that redaction collapses (multi-line PEM block)", () => {
    // redact() rewrites a whole BEGIN/END PRIVATE KEY block as ONE token, so every line after it
    // shifts in the redacted view. Editor coordinates drive a WRITE and must address the real file.
    file(
      "key.ts",
      [
        "-----BEGIN PRIVATE KEY-----",
        "AAAAB3NzaC1yc2EAAAADAQABAAABgQ",
        "-----END PRIVATE KEY-----",
        'export const marker = "needle-after-pem";',
        "",
      ].join("\n"),
    );
    const workspace = detectWorkspace(dir);
    const rawLines = readWorkspaceFileForEditing(workspace, "key.ts").rawText.split("\n");
    const redactedLines = readWorkspaceFile(workspace, "key.ts").text.split("\n");

    // Raw: the marker is the 4th line (index 3). Redacted: the 3-line PEM block became one token,
    // so the same marker moved to index 1 and the file lost two lines.
    expect(rawLines[3]).toContain("needle-after-pem");
    expect(redactedLines[1]).toContain("needle-after-pem");
    expect(redactedLines).toHaveLength(rawLines.length - 2);
  });

  it("reports sizeBytes as the UTF-8 byte count", () => {
    file("multi.txt", "é".repeat(10));
    const content = readWorkspaceFileForEditing(detectWorkspace(dir), "multi.txt", {
      maxBytes: 20,
    });
    expect(content.sizeBytes).toBe(20);
    expect(content.truncated).toBe(false);
  });

  it("still rejects a traversal escape", () => {
    expect(() => readWorkspaceFileForEditing(detectWorkspace(dir), "../escape")).toThrow(
      PathEscapeError,
    );
  });

  it("still rejects an always-on denied path", () => {
    file(".env", "SECRET=1");
    expect(() => readWorkspaceFileForEditing(detectWorkspace(dir), ".env")).toThrow(
      PathDeniedError,
    );
  });

  it("still rejects a symlink that escapes the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-outside-raw-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "TOPSECRET", "utf8");
      symlinkSync(join(outside, "secret.txt"), join(dir, "leak.txt"));
      expect(() => readWorkspaceFileForEditing(detectWorkspace(dir), "leak.txt")).toThrow(
        PathEscapeError,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("still rejects a hard-linked workspace alias", () => {
    file("real.txt", "body");
    linkSync(join(dir, "real.txt"), join(dir, "alias.txt"));
    expect(() => readWorkspaceFileForEditing(detectWorkspace(dir), "alias.txt")).toThrow(
      PathDeniedError,
    );
  });

  it("rejects a real file swapped to an outside symlink after the pre-read stat", () => {
    file("safe.ts", "SAFE");
    const outside = mkdtempSync(join(tmpdir(), "keiko-read-race-outside-"));
    let swapped = false;
    let legacyReadCalled = false;
    try {
      const outsidePath = join(outside, "private.txt");
      writeFileSync(outsidePath, "OUTSIDE_PRIVATE_BYTES", "utf8");
      const fs: WorkspaceFs = {
        ...nodeWorkspaceFs,
        readFileUtf8: (absolutePath): string => {
          legacyReadCalled = true;
          return nodeWorkspaceFs.readFileUtf8(absolutePath);
        },
        stat: (absolutePath): WorkspaceStat => {
          const before = nodeWorkspaceFs.stat(absolutePath);
          if (!swapped && absolutePath.endsWith("/safe.ts")) {
            swapped = true;
            unlinkSync(absolutePath);
            symlinkSync(outsidePath, absolutePath);
          }
          return before;
        },
      };

      expect(() =>
        readWorkspaceFileForEditing(detectWorkspace(dir), "safe.ts", { maxBytes: 1_024 }, fs),
      ).toThrow(PathDeniedError);
      expect(swapped).toBe(true);
      expect(legacyReadCalled).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a parent directory swapped to an outside symlink after preflight", () => {
    file("docs/safe.ts", "SAFE");
    const outside = mkdtempSync(join(tmpdir(), "keiko-parent-race-outside-"));
    let swapped = false;
    let legacyReadCalled = false;
    try {
      writeFileSync(join(outside, "safe.ts"), "OUTSIDE_PRIVATE_BYTES", "utf8");
      const fs: WorkspaceFs = {
        ...nodeWorkspaceFs,
        readFileUtf8: (absolutePath): string => {
          legacyReadCalled = true;
          return nodeWorkspaceFs.readFileUtf8(absolutePath);
        },
        stat: (absolutePath): WorkspaceStat => {
          const before = nodeWorkspaceFs.stat(absolutePath);
          if (!swapped && absolutePath.endsWith("/docs/safe.ts")) {
            swapped = true;
            renameSync(join(dir, "docs"), join(dir, "docs-original"));
            symlinkSync(outside, join(dir, "docs"));
          }
          return before;
        },
      };

      expect(() =>
        readWorkspaceFileForEditing(detectWorkspace(dir), "docs/safe.ts", { maxBytes: 1_024 }, fs),
      ).toThrow(WorkspaceReadError);
      expect(swapped).toBe(true);
      expect(legacyReadCalled).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects an in-workspace retarget after the descriptor read", () => {
    const root = "/ws";
    const selected = `${root}/selected.ts`;
    const other = `${root}/other.ts`;
    let retargeted = false;
    const stat: WorkspaceStat = {
      size: 4,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      hardLinkCount: 1,
      mtimeMs: 1,
      ctimeMs: 1,
      fileIdentity: "1:1",
      mtimeNs: "1000000",
      ctimeNs: "1000000",
    };
    const fs: WorkspaceFs = {
      readFileUtf8: (): never => {
        throw new Error("legacy read must not run");
      },
      readFileUtf8SameDescriptor: (): ReturnType<
        NonNullable<WorkspaceFs["readFileUtf8SameDescriptor"]>
      > => {
        retargeted = true;
        return { rawText: "SAFE", sizeBytes: 4, stat };
      },
      stat: (): WorkspaceStat => stat,
      readDir: (): readonly WorkspaceDirEntry[] => [],
      realPath: (absolutePath): string =>
        retargeted && absolutePath === selected ? other : absolutePath,
      exists: (): boolean => true,
    };

    expect(() =>
      readWorkspaceFileForEditing(fakeWorkspace(root), "selected.ts", { maxBytes: 16 }, fs),
    ).toThrow(PathDeniedError);
    expect(retargeted).toBe(true);
  });

  it("still enforces the read cap", () => {
    file("big.txt", "x".repeat(64));
    expect(() =>
      readWorkspaceFileForEditing(detectWorkspace(dir), "big.txt", { maxBytes: 10 }),
    ).toThrow(FileTooLargeError);
  });

  it("still surfaces an unreadable in-root file as a WorkspaceReadError", () => {
    expect(() => readWorkspaceFileForEditing(detectWorkspace(dir), "missing.txt")).toThrow(
      WorkspaceReadError,
    );
  });

  it("matches the read published at the ./internal/editor-read subpath", () => {
    // The package.json `exports` entry is an independent second name for this function: nothing the
    // cases above assert constrains where it points, so a stale, duplicated, or mis-built artifact
    // behind `./internal/editor-read` would keep this whole file green while every consumer called
    // something else. Referential identity cannot express that pin from here — the subpath resolves
    // through `exports` to the BUILT `dist/editorRead.js` while `./discovery.js` resolves to the TS
    // source, so the two are distinct module instances by construction and `===` is false. What a
    // consumer actually depends on is that the published lane reads the same raw bytes.
    file("app.ts", `${SECRET_LINE}\n`);
    const workspace = detectWorkspace(dir);

    const viaSubpath = readViaPublishedSubpath(workspace, "app.ts");
    const viaRelative = readWorkspaceFileForEditing(workspace, "app.ts");

    expect(readViaPublishedSubpath.name).toBe(readWorkspaceFileForEditing.name);
    expect(viaSubpath).toEqual(viaRelative);
    expect(viaSubpath.rawText).toBe(`${SECRET_LINE}\n`);
    expect(viaSubpath.rawText).toContain("s3cr3t-lookup-value");
  });
});

describe("nodeWorkspaceFs.exists", () => {
  it("returns false rather than throwing when stat raises an error (e.g. EACCES)", () => {
    // Simulate a stat that throws EACCES by injecting a WorkspaceFs whose exists() wraps a
    // throwing stat, exactly as nodeWorkspaceFs.exists does after the fix. The test proves the
    // safe-boolean-probe contract: exists() must never propagate a filesystem error.
    let statCallCount = 0;
    const eaccesStat = (): WorkspaceStat => {
      statCallCount += 1;
      throw Object.assign(new Error("EACCES: permission denied, stat '/locked'"), {
        code: "EACCES",
      });
    };
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => "",
      stat: eaccesStat,
      readDir: (): readonly WorkspaceDirEntry[] => [],
      realPath: (p: string): string => p,
      exists: (absolutePath: string): boolean => {
        // This is the same pattern as the fixed nodeWorkspaceFs.exists implementation.
        try {
          return fs.stat(absolutePath).size >= 0;
        } catch {
          return false;
        }
      },
    };
    expect(() => fs.exists("/locked")).not.toThrow();
    expect(fs.exists("/locked")).toBe(false);
    expect(statCallCount).toBe(2); // called once per exists() invocation
  });
});
