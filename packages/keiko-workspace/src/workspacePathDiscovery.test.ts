import { describe, expect, it, vi } from "vitest";
import { memFs } from "./_memfs.js";
import { createStructuralExecutionControl } from "./structuralExecution.js";
import type { WorkspaceInfo } from "./types.js";
import { WORKSPACE_PATH_DISCOVERY_LIMITS } from "./types.js";
import { RepoSearchInvalidQueryError } from "./errors.js";
import { discoverWorkspacePaths } from "./workspacePathDiscovery.js";

const WORKSPACE: WorkspaceInfo = {
  root: "/repo",
  selectedRoot: "/repo",
  name: "fixture",
  version: "1",
  testFramework: "vitest",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};

function entries(prefix: string, count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`${prefix}/file-${String(index)}.ts`, "source"]),
  );
}

describe("workspace path discovery completeness", () => {
  it("finds a late matching file beyond the former 20k whole-inventory ceiling", async () => {
    const fs = memFs(WORKSPACE.root, {
      ...entries("a", 10_000),
      ...entries("b", 10_000),
      "z/late-target.ts": "target",
    });
    const result = await discoverWorkspacePaths(
      WORKSPACE,
      { mode: "keywords", directory: "", query: "late-target", maxResults: 10 },
      createStructuralExecutionControl(null),
      fs,
    );
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["z/late-target.ts"]);
    expect(result.coverageIncomplete).toBe(false);
    expect(result.stats.filesDiscovered).toBe(20_001);
  });

  it("finds a matching file below 41 directories", async () => {
    const target = `${Array.from({ length: 41 }, () => "deep").join("/")}/target.ts`;
    const result = await discoverWorkspacePaths(
      WORKSPACE,
      { mode: "keywords", directory: "", query: "target", maxResults: 10 },
      createStructuralExecutionControl(null),
      memFs(WORKSPACE.root, { [target]: "target" }),
    );
    expect(result.entries.map((entry) => entry.relativePath)).toEqual([target]);
    expect(result.coverageIncomplete).toBe(false);
  });

  it("streams a directory with more than 10k entries without discarding its match", async () => {
    const result = await discoverWorkspacePaths(
      WORKSPACE,
      { mode: "keywords", directory: "", query: "target", maxResults: 10 },
      createStructuralExecutionControl(null),
      memFs(WORKSPACE.root, { ...entries("wide", 10_001), "wide/target.ts": "target" }),
    );
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["wide/target.ts"]);
    expect(result.coverageIncomplete).toBe(false);
    expect(result.stats.filesDiscovered).toBe(10_002);
  });
});

describe("workspace path discovery scoped results", () => {
  it("prunes unrelated directories before structural traversal and performs no file reads", async () => {
    const fs = memFs(WORKSPACE.root, {
      "packages/app/deep/target.ts": "target",
      "packages/other/unrelated.ts": "unrelated",
      "unrelated/target.ts": "unrelated",
    });
    const iterate = vi.spyOn(fs, "iterateDirectory");
    const stat = vi.spyOn(fs, "stat");
    const read = vi.spyOn(fs, "readFileUtf8");
    const descriptor = vi.spyOn(fs, "readFileUtf8SameDescriptor");
    const result = await discoverWorkspacePaths(
      WORKSPACE,
      { mode: "keywords", directory: "packages/app", query: "target", maxResults: 10 },
      createStructuralExecutionControl(5_000),
      fs,
    );
    expect(result.entries.map((entry) => entry.relativePath)).toEqual([
      "packages/app/deep/target.ts",
    ]);
    expect(iterate.mock.calls.map(([path]) => path)).toEqual([
      "/repo/packages/app",
      "/repo/packages/app/deep",
    ]);
    expect(
      stat.mock.calls.some(([path]) => path.includes("unrelated") || path.includes("other")),
    ).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(descriptor).not.toHaveBeenCalled();
  });

  it("lists immediate files and directories without descending into children", async () => {
    const fs = memFs(WORKSPACE.root, {
      "src/a.ts": "a",
      "src/large.bin": "\0binary",
      "src/deep/target.ts": "target",
    });
    const originalStat = fs.stat;
    vi.spyOn(fs, "stat").mockImplementation((path) => {
      const observed = originalStat(path);
      return observed.isDirectory ? { ...observed, size: 4_096 } : observed;
    });
    const iterate = vi.spyOn(fs, "iterateDirectory");
    const result = await discoverWorkspacePaths(
      WORKSPACE,
      { mode: "directory", directory: "src", query: "*", maxResults: 10 },
      createStructuralExecutionControl(5_000),
      fs,
    );
    expect(result.entries).toEqual([
      { relativePath: "src/a.ts", kind: "file", sizeBytes: 1 },
      { relativePath: "src/deep", kind: "directory", sizeBytes: 0 },
      { relativePath: "src/large.bin", kind: "file", sizeBytes: 7 },
    ]);
    expect(iterate.mock.calls.map(([path]) => path)).toEqual(["/repo/src"]);
    expect(result.stats).toMatchObject({ filesDiscovered: 2, directoriesDiscovered: 1 });
    expect(result.coverageIncomplete).toBe(false);
  });

  it("matches a root-relative glob inside an admitted subtree", async () => {
    const result = await discoverWorkspacePaths(
      WORKSPACE,
      { mode: "glob", directory: "packages/app", query: "packages/**/Foo?.tsx", maxResults: 10 },
      createStructuralExecutionControl(5_000),
      memFs(WORKSPACE.root, {
        "packages/app/deep/Foo1.tsx": "target",
        "packages/app/deep/Foo10.tsx": "other",
        "packages/other/Foo2.tsx": "other",
      }),
    );
    expect(result.entries.map((entry) => entry.relativePath)).toEqual([
      "packages/app/deep/Foo1.tsx",
    ]);
    expect(result.stats.filesDiscovered).toBe(2);
  });

  it("retains a deterministic bounded sample and reports omitted matching paths", async () => {
    const result = await discoverWorkspacePaths(
      WORKSPACE,
      { mode: "keywords", directory: "", query: "*", maxResults: 2 },
      createStructuralExecutionControl(5_000),
      memFs(WORKSPACE.root, { "z.ts": "z", "b.ts": "b", "a.ts": "a" }),
    );
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["a.ts", "b.ts"]);
    expect(result.matchedCount).toBe(3);
    expect(result.coverageIncomplete).toBe(true);
    expect(result.truncationReasons).toEqual(["result-limit"]);
  });

  it("bounds serialized bytes independently from count without corrupting path names", async () => {
    const prefix = Array.from({ length: 16 }, () => "a".repeat(200)).join("/");
    const files = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`${prefix}/file${String(index)}.ts`, "x"]),
    );
    const result = await discoverWorkspacePaths(
      WORKSPACE,
      { mode: "keywords", directory: "", query: "*", maxResults: 100 },
      createStructuralExecutionControl(5_000),
      memFs(WORKSPACE.root, files),
    );
    expect(result.matchedCount).toBe(30);
    expect(result.entries.length).toBeLessThan(30);
    expect(result.byteCount).toBe(Buffer.byteLength(result.text));
    expect(result.byteCount).toBeLessThanOrEqual(WORKSPACE_PATH_DISCOVERY_LIMITS.outputBytes);
    expect(JSON.parse(result.text)).toEqual(result.entries);
    expect(result.truncationReasons).toEqual(["output-limit"]);
  });

  it("preserves newline filenames as one unambiguous JSON entry", async () => {
    const result = await discoverWorkspacePaths(
      WORKSPACE,
      { mode: "directory", directory: "", query: "*", maxResults: 10 },
      createStructuralExecutionControl(5_000),
      memFs(WORKSPACE.root, { "line\nbreak.ts": "source" }),
    );
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["line\nbreak.ts"]);
    expect(JSON.parse(result.text)).toEqual(result.entries);
    expect(result.text.split("\n")).toHaveLength(1);
  });

  it.each([
    { directory: "../outside" },
    { directory: "/outside" },
    { directory: "src\\other" },
    { query: "../*.ts", mode: "glob" },
    { query: "foo\n*.ts", mode: "glob" },
    { query: "*".repeat(201), mode: "glob" },
    { mode: "unknown" },
    { maxResults: 101 },
    { maxResults: 0 },
    { extra: "unsupported" },
  ])("refuses invalid input before directory IO: %j", async (change) => {
    const fs = memFs(WORKSPACE.root, {});
    const iterate = vi.spyOn(fs, "iterateDirectory");
    const request = { mode: "keywords", directory: "", query: "target", maxResults: 10, ...change };
    await expect(
      discoverWorkspacePaths(WORKSPACE, request, createStructuralExecutionControl(5_000), fs),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
    expect(iterate).not.toHaveBeenCalled();
  });

  it.each([null, undefined, [], Object.create(null)])(
    "refuses a non-record request before IO",
    async (request: unknown) => {
      const fs = memFs(WORKSPACE.root, {});
      const iterate = vi.spyOn(fs, "iterateDirectory");
      await expect(
        discoverWorkspacePaths(WORKSPACE, request, createStructuralExecutionControl(5_000), fs),
      ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
      expect(iterate).not.toHaveBeenCalled();
    },
  );

  it("refuses accessor fields without evaluating their contents", async () => {
    const getter = vi.fn(() => "target");
    const request = { mode: "keywords", directory: "", maxResults: 10 };
    Object.defineProperty(request, "query", { enumerable: true, get: getter });
    await expect(
      discoverWorkspacePaths(
        WORKSPACE,
        request,
        createStructuralExecutionControl(5_000),
        memFs(WORKSPACE.root, {}),
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
    expect(getter).not.toHaveBeenCalled();
  });
});
