import { describe, expect, it } from "vitest";

import {
  isCodingRepositorySearchProvenance,
  type CodingRepositorySearchProvenance,
} from "./coding-repository-search.js";

const DIGEST = "a".repeat(64);

function lexical(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ranking: "lexical",
    indexIdentityDigest: null,
    indexFreshness: "absent",
    rerankedHits: 0,
    lexicalHits: 3,
    ...overrides,
  };
}

function hybrid(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ranking: "hybrid",
    indexIdentityDigest: DIGEST,
    indexFreshness: "fresh",
    rerankedHits: 2,
    lexicalHits: 1,
    ...overrides,
  };
}

describe("coding repository search provenance (#3416)", () => {
  it("accepts a lexical order that read no index", () => {
    expect(isCodingRepositorySearchProvenance(lexical())).toBe(true);
  });

  it("accepts a hybrid order with the index it read", () => {
    const value = hybrid();
    expect(isCodingRepositorySearchProvenance(value)).toBe(true);
    const provenance = value as unknown as CodingRepositorySearchProvenance;
    expect(provenance.indexIdentityDigest).toBe(DIGEST);
  });

  it("accepts a lexical order that states why the rerank did not happen", () => {
    expect(
      isCodingRepositorySearchProvenance(lexical({ fallbackReason: "pod-no-fresh-candidates" })),
    ).toBe(true);
  });

  // The two ways a disclosure could contradict itself. Both are the point of validating it at all:
  // an order that claims both a lexical ranking and reranked hits tells the reader nothing true.
  it("refuses a lexical order that claims reranked hits", () => {
    expect(isCodingRepositorySearchProvenance(lexical({ rerankedHits: 1 }))).toBe(false);
  });

  it("refuses a fallback reason on an order that did rerank", () => {
    expect(isCodingRepositorySearchProvenance(hybrid({ fallbackReason: "pod-absent" }))).toBe(
      false,
    );
  });

  it("refuses a ranking, a freshness or a reason outside the closed vocabulary", () => {
    expect(isCodingRepositorySearchProvenance(hybrid({ ranking: "semantic-ish" }))).toBe(false);
    expect(isCodingRepositorySearchProvenance(hybrid({ indexFreshness: "warm" }))).toBe(false);
    expect(isCodingRepositorySearchProvenance(lexical({ fallbackReason: "because" }))).toBe(false);
  });

  it("refuses an index identity that is not a 64-hex digest", () => {
    expect(isCodingRepositorySearchProvenance(hybrid({ indexIdentityDigest: "abc" }))).toBe(false);
    expect(
      isCodingRepositorySearchProvenance(hybrid({ indexIdentityDigest: DIGEST.toUpperCase() })),
    ).toBe(false);
    expect(isCodingRepositorySearchProvenance(hybrid({ indexIdentityDigest: 1 }))).toBe(false);
  });

  it("refuses counts that are negative, fractional or past the returned-hit ceiling", () => {
    expect(isCodingRepositorySearchProvenance(hybrid({ rerankedHits: -1 }))).toBe(false);
    expect(isCodingRepositorySearchProvenance(hybrid({ lexicalHits: 1.5 }))).toBe(false);
    expect(isCodingRepositorySearchProvenance(hybrid({ lexicalHits: 51 }))).toBe(false);
  });

  // A rerank that placed hits while naming no index claims both that an index answered and that none
  // was read; a resolver whose lease carries no digest can reach exactly that state.
  it("refuses a non-lexical order that names no index", () => {
    expect(
      isCodingRepositorySearchProvenance(
        hybrid({ indexIdentityDigest: null, indexFreshness: "absent" }),
      ),
    ).toBe(false);
    expect(isCodingRepositorySearchProvenance(hybrid({ indexIdentityDigest: null }))).toBe(false);
  });

  it("refuses an unknown key, an empty record and a foreign prototype", () => {
    expect(isCodingRepositorySearchProvenance({ ...hybrid(), scores: [0.9] })).toBe(false);
    expect(isCodingRepositorySearchProvenance({})).toBe(false);
    expect(isCodingRepositorySearchProvenance(Object.create(hybrid()) as unknown)).toBe(false);
    expect(isCodingRepositorySearchProvenance(undefined)).toBe(false);
  });
});
