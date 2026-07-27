// The one vector-index port (Issue #2556, ADR-0152 D1).
//
// M2 collapsed three structurally different vector paths onto one owned service layer. This module
// is the contract half of that: a single candidate-generation seam every pillar indexes through, so
// no pillar can add a second index interface. It generalizes the `VectorIndexAdapter` shape that
// already existed inside keiko-local-knowledge; the implementations stay in their owning packages
// and the server is the only composition root that wires namespaces to them.
//
// The port is deliberately narrow. It generates CANDIDATES and nothing else: it never returns
// content, never performs final ranking, never opens a store, and never widens a scope. Rank-only
// fusion (ADR-0036 RRF) stays where it is, so activating an index changes candidate-generation cost
// and never scoring semantics.
//
// `ok: false` is a NORMAL answer, not an error channel. Unavailability, stale index state, identity
// mismatch, invalid scores, and partition mismatch all resolve to it, and the caller answers from
// its existing brute-force path. An implementation must never turn one of those conditions into an
// empty successful result: that would silently suppress candidates the caller would otherwise have
// scored, which is the failure mode ADR-0152 D3 forbids by name.

import type { EmbeddingModelIdentity } from "./local-knowledge.js";

// Closed by design. A new namespace is a deliberate contract decision, not a free addition: each one
// carries its own partition semantics and its own owning package.
export type VectorIndexNamespace = "knowledge" | "memory" | "repo";

export const VECTOR_INDEX_NAMESPACES: readonly VectorIndexNamespace[] = Object.freeze([
  "knowledge",
  "memory",
  "repo",
]);

// Why a mandatory partition key rather than an optional filter: this promotes the no-global-pool
// invariant into the contract. A query is confined to exactly one partition, so an implementation
// cannot answer from a cross-partition pool even by accident. An empty key is rejected rather than
// treated as "all partitions" — the permissive reading is the dangerous one.
export interface VectorIndexQuery {
  readonly namespace: VectorIndexNamespace;
  readonly partitionKey: string;
  readonly identity: EmbeddingModelIdentity;
  readonly queryVector: Float32Array;
  readonly candidateLimit: number;
  // Optional request-owned allow-list. This narrows the partition; it can never widen it. Memory
  // uses it for its already pre-selected signal candidates, and repository freshness uses it for
  // live-file chunks. An empty list therefore means no candidates, not the whole partition.
  readonly candidateIds?: readonly string[];
}

export interface VectorIndexCandidateRef {
  readonly id: string;
  readonly score: number;
}

// Content-free by construction: a provider label, a status, and an optional redacted reason code.
// Never a body, a path, an endpoint, or a query string.
export interface VectorIndexDiagnostics {
  readonly provider: string;
  readonly status: string;
  readonly reason?: string;
  readonly indexName?: string;
  readonly vectorCount?: number;
  readonly searchMode?: "exact" | "ann";
  readonly examinedCandidateCount?: number;
  readonly estimatedIndexBytes?: number;
}

export type VectorIndexResult =
  | {
      readonly ok: true;
      readonly candidates: readonly VectorIndexCandidateRef[];
      readonly diagnostics: VectorIndexDiagnostics;
    }
  | { readonly ok: false; readonly diagnostics: VectorIndexDiagnostics };

export interface VectorIndexPort {
  readonly search: (query: VectorIndexQuery) => Promise<VectorIndexResult>;
}

// The canonical embedding-identity key. Two byte-equivalent copies of this existed in
// keiko-local-knowledge before M2 (`embeddingIdentityKey` in retrieval/vector-index.ts and
// `identityKey` in retrieval/scoped-vector-search.ts); both now import this one, and a third copy is
// forbidden — a drifting identity key is a silent fail-open, because vectors from incompatible
// embedding spaces would compare as if they were comparable.
//
// `modelRevision` is intentionally excluded: two capsules sharing the structural identity tuple
// share an embedding space even if one has been re-validated with a newer revision. The hardening
// fields ARE included, because normalization, instruction shaping, and the embedding-space
// fingerprint are what decide whether two vectors may be compared at all.
export function embeddingIdentityKey(identity: EmbeddingModelIdentity): string {
  const tuple = [
    identity.provider,
    identity.modelId,
    identity.vectorDimensions,
    identity.vectorMetric,
    identity.normalization ?? null,
    identity.instructionVersion ?? null,
    identity.embeddingSpaceFingerprint ?? null,
    identity.dimensionsParam ?? null,
  ] as const;
  return `keiko-embedding-identity:v2:${JSON.stringify(tuple)}`;
}

const MAX_VECTOR_INDEX_CANDIDATES = 10_000;
const MAX_VECTOR_INDEX_DIMENSIONS = 65_536;
const MAX_VECTOR_INDEX_OPAQUE_ID_LENGTH = 4_096;

function validQueryVector(query: VectorIndexQuery): boolean {
  if (
    !Number.isSafeInteger(query.identity.vectorDimensions) ||
    query.identity.vectorDimensions <= 0 ||
    query.identity.vectorDimensions > MAX_VECTOR_INDEX_DIMENSIONS ||
    query.queryVector.length !== query.identity.vectorDimensions
  ) {
    return false;
  }
  let nonZero = false;
  for (const value of query.queryVector) {
    if (!Number.isFinite(value)) return false;
    if (value !== 0) nonZero = true;
  }
  return nonZero;
}

function validCandidateIds(candidateIds: readonly string[] | undefined): boolean {
  if (candidateIds === undefined) return true;
  if (candidateIds.length > MAX_VECTOR_INDEX_CANDIDATES) return false;
  const unique = new Set(candidateIds);
  return (
    unique.size === candidateIds.length &&
    candidateIds.every(
      (candidateId) =>
        candidateId.length > 0 && candidateId.length <= MAX_VECTOR_INDEX_OPAQUE_ID_LENGTH,
    )
  );
}

// Fail-closed validation for the port's own preconditions, so every implementation rejects the same
// inputs the same way instead of each inventing its own guard.
export function isValidVectorIndexQuery(query: VectorIndexQuery): boolean {
  return (
    VECTOR_INDEX_NAMESPACES.includes(query.namespace) &&
    query.partitionKey.length > 0 &&
    query.partitionKey.length <= MAX_VECTOR_INDEX_OPAQUE_ID_LENGTH &&
    query.candidateLimit > 0 &&
    query.candidateLimit <= MAX_VECTOR_INDEX_CANDIDATES &&
    Number.isSafeInteger(query.candidateLimit) &&
    validQueryVector(query) &&
    validCandidateIds(query.candidateIds)
  );
}
