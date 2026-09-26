// Shared CodingContextPack/CodingContextExcerpt test-fixture builders (KEIKO-0918). Previously
// generate-unit-tests.test.ts and renderRetrievedContext.test.ts each declared byte-for-byte
// identical `excerpt()` helpers and near-identical `pack()` helpers that had already drifted on
// usedBytes (one reduced over the excerpts' byteCount; the other hardcoded 0) — exactly the
// duplicated-fixture-formula drift class AGENTS.md section 7 calls out (epic #2285). Leading
// underscore keeps this out of vitest's `*.test.ts` include glob (see `_support.ts` for the same
// package-root convention) while staying co-located with its two consumers under tasks/.

import type { CodingContextExcerpt, CodingContextPack } from "@oscharko-dev/keiko-contracts";

export function excerpt(
  text: string,
  overrides: Partial<CodingContextExcerpt["citation"]> = {},
): CodingContextExcerpt {
  return {
    citation: {
      sourceKind: "repo-search",
      sourceTier: "first-party-workspace",
      id: "a-1",
      score: 0.9,
      rank: 0,
      citationRef: "foo.ts",
      byteCount: text.length,
      truncated: false,
      ...overrides,
    },
    text,
  };
}

// usedBytes reflects what a real assembled pack reports (the sum of its excerpts' byteCount),
// consolidating on the formula generate-unit-tests.test.ts already used rather than
// renderRetrievedContext.test.ts's hardcoded 0 (KEIKO-0918).
export function pack(excerpts: readonly CodingContextExcerpt[]): CodingContextPack {
  return {
    schemaVersion: "1",
    purpose: "test-generation",
    excerpts,
    usedBytes: excerpts.reduce((sum, e) => sum + e.citation.byteCount, 0),
    budgetBytes: 65_536,
    droppedForBudget: 0,
    omissions: [],
  };
}
