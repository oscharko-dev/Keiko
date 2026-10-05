import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import type { SemanticSearchInput } from "./repoSearchSemantic.js";
import * as searchPolicy from "./repoSearchPolicy.js";

const FILES = {
  "src/a.ts": "export const ordinary = 1;\n",
  "src/b.ts": "export function rotate() {\n  return advance();\n}\n",
  "deep/c.ts": "export const unrelated = 2;\n",
};

function scope(): SearchScope {
  return {
    scopeId: "semantic-ranking",
    relativePaths: [],
    workspace: {
      root: "/ws",
      selectedRoot: "/ws",
      name: "semantic-ranking",
      version: undefined,
      testFramework: "unknown",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
  };
}

const QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "session renewal",
  maxResults: 20,
  caseSensitive: false,
  emittedAtMs: 0,
};

afterEach(() => vi.restoreAllMocks());

describe("semantic document scoring through the public search producer", () => {
  it("does not add unused content scoring to an explicitly finite semantic session", async () => {
    const score = vi.spyOn(searchPolicy, "scoreContentForSearch");
    const rank = vi.spyOn(searchPolicy, "orderCandidatesForSearch");
    const limits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 16 };
    const baseline = await searchText(scope(), QUERY, limits, { fs: memFs("/ws", FILES) });
    const ordinaryScoringCalls = score.mock.calls.length;
    const ordinaryRankingCalls = rank.mock.calls.length;
    score.mockClear();
    rank.mockClear();
    const provider = vi.fn((input: SemanticSearchInput) => {
      expect(new Map(input.documents.map((file) => [file.scopePath, file.text]))).toEqual(
        new Map(Object.entries(FILES)),
      );
      return Promise.resolve([{ scopePath: "src/b.ts", line: 2, score: 1 }]);
    });
    const result = await searchText(scope(), QUERY, limits, {
      fs: memFs("/ws", FILES),
      semanticSearchProvider: { name: "finite-session", search: provider },
    });
    expect(provider).toHaveBeenCalledOnce();
    expect(
      result.atoms.find((atom) => atom.provenance.tool === "repo.semanticSearch:finite-session"),
    ).toMatchObject({
      scopePath: "src/b.ts",
      lineRange: { startLine: 2, endLine: 2 },
    });
    expect(result.coverage.filesScanned).toBe(baseline.coverage.filesScanned);
    expect(result.coverage).toMatchObject({ filesScanned: 3, incomplete: false, reasons: [] });
    expect(score).toHaveBeenCalledTimes(ordinaryScoringCalls);
    expect(rank).toHaveBeenCalledTimes(ordinaryRankingCalls);
  });

  it("still scores documents for the bounded sampler on an uncapped traversal", async () => {
    const score = vi.spyOn(searchPolicy, "scoreContentForSearch");
    const provider = vi.fn(() => Promise.resolve([]));
    const result = await searchText(scope(), QUERY, undefined, {
      fs: memFs("/ws", FILES),
      semanticSearchProvider: { name: "bounded-sampler", search: provider },
    });
    expect(provider).toHaveBeenCalledOnce();
    expect(result.coverage).toMatchObject({ filesScanned: 3, incomplete: false });
    expect(new Set(score.mock.calls.map((call) => call[3]))).toEqual(new Set(Object.keys(FILES)));
  });
});
