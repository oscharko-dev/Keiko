import { describe, expect, it } from "vitest";
import type { EvidenceAtom } from "@oscharko-dev/keiko-contracts/connected-context";
import { rankCandidates } from "./rank.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "@oscharko-dev/keiko-workspace";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
function atom(scopePath: string, score: number, tool = "repo.searchText"): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId: scopePath,
    scopePath,
    score,
    lineRange: { startLine: 1, endLine: 1 },
    redactionState: "redacted",
    emittedAtMs: 1,
    ledgerRef: undefined,
    provenance: { kind: "lexical-search", tool, queryFingerprint: "floor-test" },
  };
}

function lexicalProducerScope(): SearchScope {
  return {
    scopeId: "lexical-floor-producer",
    relativePaths: [],
    workspace: {
      root: "/lexical-floor-producer",
      selectedRoot: "/lexical-floor-producer",
      name: "Lexical floor producer",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: [],
      languages: ["typescript"],
      ignoreLines: [],
    },
  };
}

describe("intent-derived absolute relevance floor", () => {
  it("retains a full lexical hit at depth six alongside a definition outlier, rejecting a half-hit decoy", () => {
    const deep = atom("src/a/b/c/d/e/full.ts", 1);
    const decoy = atom("half.ts", 0.5);
    const outlier = atom("definition.ts", 1, "discovered-symbol-definition");
    const result = rankCandidates(
      {
        atoms: [outlier, deep, decoy],
        anchors: [],
        context: { retrievalIntent: "targeted-code-search" },
      },
      { nowMs: () => 1 },
    );
    expect(result.kept.map((entry) => entry.scopePath)).toContain(deep.scopePath);
    expect(result.omitted).toContainEqual({
      scopePath: decoy.scopePath,
      reason: "low-relevance",
      omittedAtMs: 1,
    });
  });

  it("retains a producer-derived full lexical hit at depth six and rejects a half-hit decoy", async () => {
    const deep = "src/a/b/c/d/e/full.ts";
    const half = "half.ts";
    const scope = lexicalProducerScope();
    const fs = memFs(scope.workspace.root, {
      [deep]: 'const message = "cobalt balance";\n',
      "near.ts": 'const message = "cobalt balance";\n',
      [half]: 'const message = "cobalt";\n',
    });
    const lexical = await searchText(
      scope,
      {
        kind: "natural-language",
        text: "cobalt balance",
        caseSensitive: false,
        maxResults: 50,
        emittedAtMs: 1,
      },
      DEFAULT_SEARCH_LIMITS,
      { fs, nowMs: () => 1 },
    );
    expect(lexical.atoms.map((entry) => entry.scopePath)).toEqual(
      expect.arrayContaining([deep, "near.ts", half]),
    );
    const result = rankCandidates(
      { atoms: lexical.atoms, anchors: [], context: { retrievalIntent: "targeted-code-search" } },
      { nowMs: () => 1 },
    );
    expect(result.kept.map((entry) => entry.scopePath)).toEqual(
      expect.arrayContaining([deep, "near.ts"]),
    );
    expect(result.omitted).toContainEqual({
      scopePath: half,
      reason: "low-relevance",
      omittedAtMs: 1,
    });
  });
});
