import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverWithStats, discoverWithStatsAsync } from "./discovery.js";
import { DEFAULT_SEARCH_LIMITS, readExcerpt, searchText, type SearchScope } from "./repoSearch.js";
import { DEFAULT_DISCOVERY_OPTIONS } from "./types.js";
import { createWorkspaceIndex } from "./workspaceIndex.js";

let root = "";
const validPaths = ["nested/valid.csproj", "x/y.csproj", "überprüfung/hand book.txt"];
const invalidPaths = [
  "~old.csproj",
  ".env",
  ...(process.platform === "win32" ? [] : ["x\\y.csproj", "nested/x\\y.csproj"]),
];
function put(path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
function scope(): SearchScope {
  return {
    scopeId: "portable-discovery",
    relativePaths: [],
    workspace: {
      root,
      selectedRoot: root,
      name: "fixture",
      version: "0",
      testFramework: "vitest",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-portable-path-"));
  for (const path of validPaths) put(path, "PortableReadingProbe=ACTUAL_VALID_VALUE\n");
  for (const path of invalidPaths) put(path, "PortableReadingProbe=INVALID_DECOY_VALUE\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("portable directory entry admission", () => {
  it("retains unsupported-entry coverage on a warm index and clears it after rediscovery", async () => {
    const options = { workspaceIndex: createWorkspaceIndex() };
    const limits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 100 };
    const query = {
      kind: "exact-symbol" as const,
      text: "PortableReadingProbe",
      maxResults: 20,
      caseSensitive: true,
      emittedAtMs: 0,
    };
    const cold = await searchText(scope(), query, limits, options);
    const warm = await searchText(scope(), query, limits, options);
    expect(warm.coverage).toMatchObject({
      incomplete: true,
      reasons: ["unrepresentable-path"],
      unrepresentablePathsByDiscovery: cold.diagnostics?.unrepresentablePathsByDiscovery,
    });
    expect(warm.workspaceIndex?.reusedRecords).toBe(validPaths.length);
    for (const path of invalidPaths) rmSync(join(root, path));
    const refreshed = await searchText(scope(), query, limits, options);
    expect(refreshed.atoms.map((atom) => atom.scopePath).sort()).toEqual(validPaths);
    expect(refreshed.coverage).toMatchObject({ incomplete: false, reasons: [] });
    expect(refreshed.coverage.unrepresentablePathsByDiscovery).toBeUndefined();
  });

  it.each([null, 100])(
    "reports unsupported subtrees separately with file budget %s",
    async (maxFilesScanned) => {
      put("~archive/deep/hidden.txt", "PortableReadingProbe=UNSEARCHED_SUBTREE_VALUE\n");
      const result = await searchText(
        scope(),
        {
          kind: "exact-symbol",
          text: "PortableReadingProbe",
          maxResults: 20,
          caseSensitive: true,
          emittedAtMs: 0,
        },
        { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned },
      );
      expect(result.atoms.map((atom) => atom.scopePath).sort()).toEqual(validPaths);
      expect(result.coverage.incomplete).toBe(true);
      expect(result.coverage.reasons).toContain("unrepresentable-path");
      expect(result.coverage.deniedByDiscovery).toBe(1);
      expect(result.coverage.unrepresentablePathsByDiscovery).toBe(invalidPaths.length);
      expect(result.diagnostics?.unrepresentablePathsByDiscovery).toBe(invalidPaths.length);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps an explicitly selected subfolder partial",
    async () => {
      put("nested/bad\\directory/hidden.txt", "PortableReadingProbe=UNSEARCHED_SUBTREE_VALUE\n");
      for (const maxFilesScanned of [null, 100]) {
        const result = await searchText(
          { ...scope(), relativePaths: ["nested"] },
          {
            kind: "exact-symbol",
            text: "PortableReadingProbe",
            maxResults: 20,
            caseSensitive: true,
            emittedAtMs: 0,
          },
          { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned },
        );
        expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["nested/valid.csproj"]);
        expect(result.coverage).toMatchObject({
          incomplete: true,
          reasons: ["unrepresentable-path"],
          unrepresentablePathsByDiscovery: 2,
        });
      }
    },
  );

  it("excludes raw unsupported names before synchronous contained discovery", () => {
    const result = discoverWithStats(scope().workspace, DEFAULT_DISCOVERY_OPTIONS);
    expect(result.files.map((file) => file.relativePath).sort()).toEqual(validPaths);
    expect(result.stats.denied).toBe(1);
    expect(result.stats.unrepresentablePaths).toBe(invalidPaths.length - 1);
  });
  it("uses the same raw-path admission in asynchronous discovery", async () => {
    const result = await discoverWithStatsAsync(scope().workspace, DEFAULT_DISCOVERY_OPTIONS);
    expect(result.files.map((file) => file.relativePath).sort()).toEqual(validPaths);
    expect(result.stats.denied).toBe(1);
    expect(result.stats.unrepresentablePaths).toBe(invalidPaths.length - 1);
  });
  it("finishes ordinary recursive text search without normalizing a name to a different file", async () => {
    const result = await searchText(scope(), {
      kind: "exact-symbol",
      text: "PortableReadingProbe",
      maxResults: 20,
      caseSensitive: true,
      emittedAtMs: 0,
    });
    expect(result.atoms.map((atom) => atom.scopePath).sort()).toEqual(validPaths);
    for (const atom of result.atoms) {
      const excerpt = await readExcerpt(scope(), {
        scopePath: atom.scopePath,
        startLine: 1,
        endLine: 1,
        maxBytes: 1024,
      });
      expect(excerpt.content).toContain("ACTUAL_VALID_VALUE");
      expect(excerpt.content).not.toContain("INVALID_DECOY_VALUE");
    }
    // Unsupported names are still safely excluded, but they prevent a complete absence claim.
    expect(result.coverage.incomplete).toBe(true);
    expect(result.coverage.reasons).toContain("unrepresentable-path");
    expect(result.coverage.deniedByDiscovery).toBe(1);
    expect(result.coverage.unrepresentablePathsByDiscovery).toBe(invalidPaths.length - 1);
  });
});
