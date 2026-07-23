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

  // The absent-field sentinels are literal strings, so a free-text field carrying the sentinel
  // value collides with "field absent". `normalization` cannot collide (its union excludes
  // "legacy"), but `instructionVersion` and `embeddingSpaceFingerprint` are unconstrained strings.
  // This pins the collision as known and accepted rather than leaving it undiscovered: an
  // instructionVersion of literally "legacy" is indistinguishable from having none.
  it("collides only where a hardening field is free text carrying the sentinel", () => {
    expect(embeddingIdentityKey({ ...IDENTITY, instructionVersion: "legacy" })).toBe(
      embeddingIdentityKey(IDENTITY),
    );
    expect(embeddingIdentityKey({ ...IDENTITY, embeddingSpaceFingerprint: "unverified" })).toBe(
      embeddingIdentityKey(IDENTITY),
    );
    expect(embeddingIdentityKey({ ...IDENTITY, instructionVersion: "v1" })).not.toBe(
      embeddingIdentityKey(IDENTITY),
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
    ["a query vector of the wrong width", { queryVector: new Float32Array([1, 0]) }],
  ])("rejects %s", (_case, patch) => {
    expect(isValidVectorIndexQuery(query(patch))).toBe(false);
  });

  it("rejects a namespace outside the closed union", () => {
    const rogue = { ...query(), namespace: "graph" } as unknown as VectorIndexQuery;
    expect(isValidVectorIndexQuery(rogue)).toBe(false);
  });
});
