import { describe, expect, it } from "vitest";
import type { EvidenceAtom } from "@oscharko-dev/keiko-contracts/connected-context";
import { rankCandidates } from "./rank.js";
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
});
