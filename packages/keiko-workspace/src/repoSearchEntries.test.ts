import { describe, expect, it } from "vitest";
import { collectFromEntries } from "./repoSearchEntries.js";
import type { WorkspaceDirEntry, WorkspaceFs, WorkspaceStat } from "./fs.js";
import type { WorkspaceInfo } from "./types.js";

function fakeWorkspace(root: string): WorkspaceInfo {
  return {
    root,
    name: "x",
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: ["javascript"],
    ignoreLines: [],
  };
}

// Models a root symlink that is admitted safely once (resolving "/selected" -> "/safe/project")
// and is then repointed to a denied location ("/safe/.aws") before the entry walk actually reads
// anything. collectFromEntries must admit the canonical root exactly once and never re-derive it
// from the caller's raw fs port for any later containment check -- see repoSearchEntries.ts's
// createEntryWalk, which binds fs to the admitted realRoot the same way discovery.ts's createWalk
// does (workspaceFsBoundToCanonicalRoot). A `path !== "/selected"` mock branch that just echoes
// its input still resolves realistically, because a bound fs only ever calls into the underlying
// port for a path other than the already-admitted canonical root.
function mutableRootEntryWalkFs(
  secondCallRealPathTarget: string,
  entryStat: WorkspaceStat,
  directoryEntries: readonly WorkspaceDirEntry[] = [],
): {
  readonly fs: WorkspaceFs;
  readonly readDirPaths: readonly string[];
  readonly selectedRootCalls: () => number;
} {
  const readDirPaths: string[] = [];
  let selectedRootCalls = 0;
  const fs: WorkspaceFs = {
    readFileUtf8: (): never => {
      throw new Error("content must not be read");
    },
    stat: (absolutePath): WorkspaceStat =>
      absolutePath === "/safe/project/dir"
        ? { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false }
        : entryStat,
    readDir: (absolutePath): readonly WorkspaceDirEntry[] => {
      readDirPaths.push(absolutePath);
      return directoryEntries;
    },
    realPath: (absolutePath): string => {
      if (absolutePath !== "/selected") return absolutePath;
      selectedRootCalls += 1;
      // The FIRST admission call sees the safe target. Any FURTHER call to resolve the same
      // lexical root -- which must never happen once the walk is bound to its admitted identity
      // -- would see the root repointed to a denied credential path.
      return selectedRootCalls === 1 ? "/safe/project" : secondCallRealPathTarget;
    },
    exists: (): boolean => true,
  };
  return { fs, readDirPaths, selectedRootCalls: () => selectedRootCalls };
}

describe("collectFromEntries", () => {
  it("does not re-resolve the lexical root after binding the entry walk to its admitted identity", () => {
    const measured = mutableRootEntryWalkFs("/safe/.aws", {
      size: 7,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    });
    const scope = { workspace: fakeWorkspace("/selected"), relativePaths: ["file.ts"] };

    const result = collectFromEntries(scope, { maxFilesScanned: 10 }, measured.fs);

    expect(result.files).toEqual([{ relativePath: "file.ts", sizeBytes: 7 }]);
    expect(measured.selectedRootCalls()).toBe(1);
  });

  it("walks only the admitted canonical root's directory tree when the lexical alias later moves to a denied location", () => {
    const measured = mutableRootEntryWalkFs(
      "/safe/.aws",
      { size: 5, isFile: true, isDirectory: false, isSymbolicLink: false },
      [{ name: "keep.ts", isDirectory: false, isFile: true, isSymbolicLink: false }],
    );
    const scope = { workspace: fakeWorkspace("/selected"), relativePaths: ["dir"] };

    const result = collectFromEntries(scope, { maxFilesScanned: 10 }, measured.fs);

    expect(result.files).toEqual([{ relativePath: "dir/keep.ts", sizeBytes: 5 }]);
    expect(result.directories).toEqual(["dir"]);
    expect(measured.readDirPaths).toEqual(["/safe/project/dir"]);
    expect(measured.selectedRootCalls()).toBe(1);
  });
});
