import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  collectSemanticSearchDocument,
  createSemanticSearchSession,
  fuseLexicalAndSemanticRanks,
  runSemanticSearchSession,
  semanticSearchTool,
  SEMANTIC_RRF_K,
  type SemanticSearchMatch,
  type SemanticSearchProvider,
} from "./repoSearchSemantic.js";

function query(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "charge card",
    caseSensitive: false,
    maxResults: 10,
    emittedAtMs: 0,
  };
}

function providerReturning(matches: readonly SemanticSearchMatch[]): SemanticSearchProvider {
  return { name: "fixture", search: () => Promise.resolve(matches) };
}

describe("repoSearchSemantic", () => {
  it("keeps the RRF constant stable and sanitizes provider names", () => {
    expect(SEMANTIC_RRF_K).toBe(60);
    expect(semanticSearchTool("Local Fixture Provider")).toBe(
      "repo.semanticSearch:local-fixture-provider",
    );
    expect(semanticSearchTool("---Enterprise@@Provider---")).toBe(
      "repo.semanticSearch:enterprise-provider",
    );
    expect(semanticSearchTool("!!!")).toBe("repo.semanticSearch:unnamed");
  });

  it("fuses lexical and semantic ranks deterministically without comparing raw scores", () => {
    const fused = fuseLexicalAndSemanticRanks(
      [
        { scopePath: "README.md", score: 10 },
        { scopePath: "src/charge.ts", score: 1 },
      ],
      [{ scopePath: "src/charge.ts", score: 0.97 }],
    );

    expect(fused[0]?.scopePath).toBe("src/charge.ts");
    expect(fused[0]?.lexicalRank).toBe(2);
    expect(fused[0]?.semanticRank).toBe(1);
    expect(fused[0]?.signals.map((signal) => signal.name)).toEqual([
      "rrf:lexical",
      "rrf:semantic",
      "rrf:fused",
    ]);
  });

  it("drops a NaN-scored match so it never fuses into a positive score (GEN-DUP-SEMANTIC-003)", async () => {
    // The score clamp is now the canonical contracts clampUnit, which maps NaN -> 0. A provider match
    // whose score is NaN is rejected up-front and thus contributes no semantic rank, so the path fuses
    // with only its lexical contribution — the semantic side is 0, never a NaN that would poison sorting.
    const session = createSemanticSearchSession(
      providerReturning([{ scopePath: "src/charge.ts", score: Number.NaN }]),
      query(),
    );
    collectSemanticSearchDocument(session, { scopePath: "src/charge.ts", text: "charge card" });
    const matches = await runSemanticSearchSession(session, query(), undefined);
    expect(matches).toEqual([]);

    const fused = fuseLexicalAndSemanticRanks(
      [{ scopePath: "src/charge.ts", score: 1 }],
      [...matches.map((match) => ({ scopePath: match.scopePath, score: match.score }))],
    );
    expect(fused[0]?.semanticRank).toBeUndefined();
    expect(fused[0]?.semanticContribution).toBe(0);
    expect(Number.isFinite(fused[0]?.fusedScore)).toBe(true);
  });

  it("clamps an out-of-range provider score into the unit interval", async () => {
    const session = createSemanticSearchSession(
      providerReturning([{ scopePath: "src/charge.ts", score: 4.2 }]),
      query(),
    );
    collectSemanticSearchDocument(session, { scopePath: "src/charge.ts", text: "charge card" });
    const matches = await runSemanticSearchSession(session, query(), undefined);
    expect(matches[0]?.score).toBe(1);
  });
});
