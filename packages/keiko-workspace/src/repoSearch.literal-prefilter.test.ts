import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { searchText, type SearchScope } from "./repoSearch.js";
import * as sourceClassification from "./repoSearchSourceClassification.js";

function scope(): SearchScope {
  return {
    scopeId: "literal-prefilter",
    relativePaths: [],
    workspace: {
      root: "/ws",
      selectedRoot: "/ws",
      name: "literal-prefilter",
      version: undefined,
      testFramework: "unknown",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
  };
}

function query(caseSensitive: boolean): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "Locate the requested markers",
    maxResults: 20,
    caseSensitive,
    emittedAtMs: 0,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("literal content prefilter through the public search producer", () => {
  it.each([
    { caseSensitive: true, term: "Exact.Marker+", hit: "Exact.Marker+", miss: "exact.marker+" },
    { caseSensitive: false, term: "Exact.Marker+", hit: "EXACT.MARKER+", miss: "ExactXMarker" },
    { caseSensitive: false, term: "Ärger/İ", hit: "ÄRGER/İ", miss: "arger/I" },
  ])("preserves case and atomic alternatives: $term ($caseSensitive)", async (example) => {
    const classify = vi.spyOn(sourceClassification, "repositorySourceLines");
    const nonmatching = `const value = '${example.miss}';\n`.repeat(200);
    const partial = `const value = '${example.hit}';\n`;
    const files = { "nested/unmatched.ts": nonmatching, "nested/partial.ts": partial };
    const observed: string[] = [];
    const result = await searchText(scope(), query(example.caseSensitive), undefined, {
      fs: memFs("/ws", files),
      queryInterpretation: { kind: "literal", terms: ["AbsentAlternative", example.term] },
      onEligibleTextFile: (file) => observed.push(file.scopePath),
    });
    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["nested/partial.ts"]);
    expect(result.atoms[0]?.lineRange).toEqual({ startLine: 1, endLine: 1 });
    expect(result.coverage).toMatchObject({
      filesScanned: 2,
      matchesReturned: 1,
      incomplete: false,
    });
    expect(new Set(observed)).toEqual(new Set(Object.keys(files)));
    expect(classify.mock.calls.filter(([text]) => text === nonmatching)).toHaveLength(0);
    expect(classify.mock.calls.some(([text]) => text === partial)).toBe(true);
  });

  it("avoids line classification for every nonmatching file without dropping scan coverage", async () => {
    const classify = vi.spyOn(sourceClassification, "repositorySourceLines");
    const files = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `nested/group-${String(index)}/manual.txt`,
        "Ordinary handbook background.\n".repeat(100),
      ]),
    );
    const result = await searchText(scope(), query(false), undefined, {
      fs: memFs("/ws", files),
      queryInterpretation: { kind: "literal", terms: ["AbsentFirst", "AbsentSecond"] },
    });
    expect(result.atoms).toEqual([]);
    expect(result.coverage).toMatchObject({
      filesDiscovered: 64,
      filesScanned: 64,
      matchesReturned: 0,
      incomplete: false,
      reasons: [],
    });
    expect(classify).not.toHaveBeenCalled();
  });
});
