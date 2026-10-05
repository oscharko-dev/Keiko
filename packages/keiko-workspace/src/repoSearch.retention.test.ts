import { describe, expect, it } from "vitest";
import { memFs } from "./_memfs.js";
import { searchText, type SearchScope } from "./repoSearch.js";
import type { WorkspaceDirEntry } from "./fs.js";

const ROOT = "/stream-retention";

function scope(): SearchScope {
  return {
    scopeId: "retention",
    relativePaths: [],
    workspace: {
      root: ROOT,
      selectedRoot: ROOT,
      name: "retention",
      version: "1",
      languages: ["typescript"],
      sourceDirs: [],
      testDirs: [],
      testFramework: "unknown",
      ignoreLines: [],
    },
  };
}

function reversedEntries(count: number): AsyncIterable<WorkspaceDirEntry> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<WorkspaceDirEntry> {
      await Promise.resolve();
      for (let index = count - 1; index >= 0; index -= 1) {
        yield {
          name: `${String(index).padStart(6, "0")}.ts`,
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
        };
      }
      yield { name: "StreamProbe.ts", isFile: true, isDirectory: false, isSymbolicLink: false };
      yield { name: ".env", isFile: true, isDirectory: false, isSymbolicLink: false };
    },
  };
}

describe("streamed retained results", () => {
  it("keeps deterministic path and line ordering for equal content ranks", async (): Promise<void> => {
    const fs = memFs(ROOT, {
      "zeta.txt": "EqualTargetProbe one\nEqualTargetProbe two\n",
      "alpha.txt": "EqualTargetProbe three\nEqualTargetProbe four\n",
      "middle.txt": "EqualTargetProbe five\n",
    });
    const result = await searchText(
      scope(),
      {
        kind: "exact-symbol",
        text: "EqualTargetProbe",
        caseSensitive: true,
        maxResults: 3,
        emittedAtMs: 1,
      },
      {
        maxFilesScanned: null,
        maxMatchesReturned: 3,
        maxBytesPerFileScanned: 2_097_152,
        elapsedMsMax: null,
      },
      { fs, nowMs: () => 1 },
    );
    expect(result.atoms.map((atom) => [atom.scopePath, atom.lineRange?.startLine])).toEqual([
      ["alpha.txt", 1],
      ["middle.txt", 1],
      ["zeta.txt", 1],
    ]);
    const wider = await searchText(
      scope(),
      {
        kind: "exact-symbol",
        text: "EqualTargetProbe",
        caseSensitive: true,
        maxResults: 4,
        emittedAtMs: 1,
      },
      {
        maxFilesScanned: null,
        maxMatchesReturned: 4,
        maxBytesPerFileScanned: 2_097_152,
        elapsedMsMax: null,
      },
      { fs, nowMs: () => 1 },
    );
    expect(wider.atoms.map((atom) => [atom.scopePath, atom.lineRange?.startLine])).toEqual([
      ["alpha.txt", 1],
      ["alpha.txt", 2],
      ["middle.txt", 1],
      ["zeta.txt", 1],
    ]);
    expect(result.coverage.reasons).toContain("match-cap");
  });

  it("keeps the result cap and a late high-rank target after adversarial arrival", async (): Promise<void> => {
    // The 100k-arrival storage and comparison bound is pinned directly in repoSearchRetention.test.ts.
    const count = 4096;
    const files: Record<string, string> = {
      "StreamProbe.ts": "export const StreamProbe = 2;\n",
      ".env": "StreamProbe=denied\n",
    };
    for (let index = 0; index < count; index += 1)
      files[`${String(index).padStart(6, "0")}.ts`] = "export const StreamProbe = 1;\n";
    const fs = {
      ...memFs(ROOT, files),
      iterateDirectory: (): AsyncIterable<WorkspaceDirEntry> => reversedEntries(count),
    };
    const result = await searchText(
      scope(),
      {
        kind: "exact-symbol",
        text: "StreamProbe",
        caseSensitive: true,
        maxResults: 1024,
        emittedAtMs: 1,
      },
      {
        maxFilesScanned: null,
        maxMatchesReturned: 1024,
        maxBytesPerFileScanned: 2_097_152,
        elapsedMsMax: null,
      },
      { fs, nowMs: () => 1 },
    );
    expect(result.filesScanned).toBe(count + 1);
    expect(result.atoms).toHaveLength(1024);
    expect(result.atoms[0]?.scopePath).toBe("StreamProbe.ts");
    expect(result.atoms.some((atom) => atom.scopePath === ".env")).toBe(false);
    expect(result.coverage.reasons).toContain("match-cap");
  });
});
