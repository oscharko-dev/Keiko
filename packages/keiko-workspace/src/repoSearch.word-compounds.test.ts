import { describe, expect, it } from "vitest";
import { memFs } from "./_memfs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";

const TARGETS = ["backend/RefundPolicy.java", "frontend/RefundSummary.tsx"];

function scope(): SearchScope {
  return {
    scopeId: "word-compounds",
    relativePaths: [],
    workspace: {
      root: "/ws",
      selectedRoot: "/ws",
      name: "word-compounds",
      version: undefined,
      testFramework: "unknown",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
  };
}

function corpus(): Record<string, string> {
  const files = Object.fromEntries(
    TARGETS.map((path) => [path, "// Maple partner refunds: 21 days, EUR 7500 inclusive.\n"]),
  );
  for (let index = 0; index < 40; index += 1) {
    files[`modules/backend/Catalog${String(index)}.java`] =
      "// Inventory catalogue: unrelated to partner refunds.\n";
  }
  return files;
}

describe("word compounds through bounded repository search", () => {
  it.each([null, 100])(
    "keeps both subject sources ahead of generic fragments with scan cap %s",
    async (maxFilesScanned) => {
      const result = await searchText(
        scope(),
        {
          kind: "natural-language",
          text: "Welche Rückerstattungsfrist gilt für Maple-Partner? Prüfe Backend und Frontend.",
          caseSensitive: false,
          maxResults: 2,
          emittedAtMs: 0,
        },
        { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned },
        { fs: memFs("/ws", corpus()), nowMs: () => 0 },
      );
      expect(new Set(result.atoms.map((atom) => atom.scopePath))).toEqual(new Set(TARGETS));
      expect(result.atoms).toHaveLength(2);
      expect(result.coverage.filesScanned).toBe(42);
    },
  );
});
