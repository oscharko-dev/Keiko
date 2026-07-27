import { describe, expect, it } from "vitest";

import {
  VECTOR_INDEX_NAMESPACES,
  embeddingIdentityKey,
  isValidVectorIndexQuery,
  type VectorIndexQuery,
} from "./vector-index-port.js";
import type { EmbeddingModelIdentity } from "./local-knowledge.js";

const IDENTITY: EmbeddingModelIdentity = {
  provider: "openai",
  modelId: "text-embedding-3-small",
  vectorDimensions: 4,
  vectorMetric: "cosine",
};

function query(overrides: Partial<VectorIndexQuery> = {}): VectorIndexQuery {
  return {
    namespace: "knowledge",
    partitionKey: "capsule-1",
    identity: IDENTITY,
    queryVector: new Float32Array([1, 0, 0, 0]),
    candidateLimit: 10,
    ...overrides,
  };
}

describe("embeddingIdentityKey", () => {
  it("excludes modelRevision so a re-validated capsule keeps its embedding space", () => {
    expect(embeddingIdentityKey({ ...IDENTITY, modelRevision: "r2" })).toBe(
      embeddingIdentityKey(IDENTITY),
    );
  });

  // Each hardening field decides whether two vectors may be compared at all, so each must change
  // the key. Without this, an identity mismatch would fail OPEN and compare incomparable vectors.
  it.each([
    ["normalization", { normalization: "l2" } as const],
    ["instructionVersion", { instructionVersion: "v2" } as const],
    ["embeddingSpaceFingerprint", { embeddingSpaceFingerprint: "abc" } as const],
    ["dimensionsParam", { dimensionsParam: 256 } as const],
    ["provider", { provider: "azure" } as const],
    ["modelId", { modelId: "other" } as const],
    ["vectorDimensions", { vectorDimensions: 8 } as const],
    ["vectorMetric", { vectorMetric: "dot" } as const],
  ])("changes when %s changes", (_field, patch) => {
    expect(embeddingIdentityKey({ ...IDENTITY, ...patch })).not.toBe(
      embeddingIdentityKey(IDENTITY),
    );
  });

  it("distinguishes absent fields, former sentinel values, and delimiter-bearing values", () => {
    for (const patch of [
      { instructionVersion: "legacy" },
      { embeddingSpaceFingerprint: "unverified" },
      { modelId: "model|with|delimiters" },
      { instructionVersion: "a|b" },
    ] as const) {
      expect(embeddingIdentityKey({ ...IDENTITY, ...patch })).not.toBe(
        embeddingIdentityKey(IDENTITY),
      );
    }
  });

  it("has an explicit format version and preserves typed tuple members", () => {
    expect(embeddingIdentityKey(IDENTITY)).toBe(
      'keiko-embedding-identity:v2:["openai","text-embedding-3-small",4,"cosine",null,null,null,null]',
    );
  });
});

describe("isValidVectorIndexQuery", () => {
  it("accepts a well-formed query in every declared namespace", () => {
    for (const namespace of VECTOR_INDEX_NAMESPACES) {
      expect(isValidVectorIndexQuery(query({ namespace }))).toBe(true);
    }
  });

  // The permissive reading of an empty partition key is "every partition", which is exactly the
  // global pool the no-global-pool invariant forbids. It must fail closed instead.
  it("rejects an empty partition key rather than treating it as unscoped", () => {
    expect(isValidVectorIndexQuery(query({ partitionKey: "" }))).toBe(false);
  });

  it.each([
    ["a zero candidate limit", { candidateLimit: 0 }],
    ["a negative candidate limit", { candidateLimit: -1 }],
    ["a fractional candidate limit", { candidateLimit: 1.5 }],
    ["an excessive candidate limit", { candidateLimit: 10_001 }],
    ["a query vector of the wrong width", { queryVector: new Float32Array([1, 0]) }],
    ["a non-finite query vector", { queryVector: new Float32Array([1, Number.NaN, 0]) }],
    ["a zero query vector", { queryVector: new Float32Array(3) }],
    ["duplicate candidate ids", { candidateIds: ["a", "a"] }],
    ["an overlong candidate id", { candidateIds: ["a".repeat(4_097)] }],
    ["an overlong partition key", { partitionKey: "p".repeat(4_097) }],
  ])("rejects %s", (_case, patch) => {
    expect(isValidVectorIndexQuery(query(patch))).toBe(false);
  });

  it("rejects a namespace outside the closed union", () => {
    const rogue = { ...query(), namespace: "graph" } as unknown as VectorIndexQuery;
    expect(isValidVectorIndexQuery(rogue)).toBe(false);
  });
});
