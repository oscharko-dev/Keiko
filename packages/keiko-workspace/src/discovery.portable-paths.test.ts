import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverWithStats, discoverWithStatsAsync } from "./discovery.js";
import { readExcerpt, searchText, type SearchScope } from "./repoSearch.js";
import { DEFAULT_DISCOVERY_OPTIONS } from "./types.js";

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
  it("excludes raw unsupported names before synchronous contained discovery", () => {
    const result = discoverWithStats(scope().workspace, DEFAULT_DISCOVERY_OPTIONS);
    expect(result.files.map((file) => file.relativePath).sort()).toEqual(validPaths);
    expect(result.stats.denied).toBe(invalidPaths.length);
  });
  it("uses the same raw-path admission in asynchronous discovery", async () => {
    const result = await discoverWithStatsAsync(scope().workspace, DEFAULT_DISCOVERY_OPTIONS);
    expect(result.files.map((file) => file.relativePath).sort()).toEqual(validPaths);
    expect(result.stats.denied).toBe(invalidPaths.length);
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
    expect(result.coverage.incomplete).toBe(false);
    expect(result.coverage.deniedByDiscovery).toBe(invalidPaths.length);
  });
});
