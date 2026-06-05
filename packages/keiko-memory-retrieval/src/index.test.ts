import { describe, expect, it } from "vitest";

import * as api from "./index.js";

describe("public API surface", () => {
  it("exports the pinned version literal", () => {
    expect(api.KEIKO_MEMORY_RETRIEVAL_VERSION).toBe("0.1.0");
  });

  it("exports the documented default constants with the documented values", () => {
    expect(api.DEFAULT_BUDGET_TOKENS).toBe(1500);
    expect(api.DEFAULT_MAX_INCLUDED).toBe(12);
    expect(api.DEFAULT_STALE_CONFIDENCE_THRESHOLD).toBeCloseTo(0.3);
    expect(api.DEFAULT_LIST_BY_SCOPE_MAX_RESULTS).toBe(500);
    expect(api.TOKEN_PER_WORD_RATIO).toBeCloseTo(1.3);
    expect(api.RECENCY_HALF_LIFE_MS).toBe(7 * 86_400_000);
  });

  it("exports every public function as a callable", () => {
    const callable: readonly string[] = [
      "retrieveMemoryContext",
      "rankMemories",
      "assembleContextBlock",
      "estimateTokens",
      "tokenize",
      "lexicalRelevance",
      "recencyScore",
      "graphProximityScore",
      "isMemorySuppressed",
    ];
    const surface = api as unknown as Record<string, unknown>;
    for (const name of callable) {
      expect(typeof surface[name]).toBe("function");
    }
  });

  it("exports RetrievalError as a class", () => {
    expect(typeof api.RetrievalError).toBe("function");
    expect(new api.RetrievalError("empty-scopes", "x")).toBeInstanceOf(Error);
  });

  it("freezes DEFAULT_RANKING_WEIGHTS so downstream mutation is impossible", () => {
    expect(Object.isFrozen(api.DEFAULT_RANKING_WEIGHTS)).toBe(true);
  });
});
