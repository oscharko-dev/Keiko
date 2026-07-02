import { describe, expect, it } from "vitest";
import {
  fuseLexicalAndSemanticRanks,
  semanticSearchTool,
  SEMANTIC_RRF_K,
} from "./repoSearchSemantic.js";

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
});
