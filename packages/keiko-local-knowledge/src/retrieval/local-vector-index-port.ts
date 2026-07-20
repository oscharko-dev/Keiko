// The `knowledge` and `repo` namespace implementations of `VectorIndexPort` (ADR-0152 D1/D3).
//
// The port is the pillar-neutral contract in `keiko-contracts`; this module is the Local
// Knowledge backing that composes it onto the two namespaces whose vectors live in the LK
// capsule store. Memory is intentionally excluded — its vectors live in keiko-memory-vault
// under a different bounded seam, and its retrieval is a score-map producer over pre-selected
// candidates rather than a candidate generator (see ADR-0152 D3 activation record).
//
// Both a port implementation and a matching `VectorIndexAdapter` shim are exported here. The
// port is what pillar-neutral consumers call; the shim is what the LK retrieval path consumes
// through the existing `VectorIndexOptions.adapter` seam, so activating composition does not
// require touching `tryVectorIndexForCapsule` or `searchVectorIndex`. Every refusal is
// content-free `ok: false` — never an exception, never a body, never a path.

import {
  isValidVectorIndexQuery,
  type VectorIndexCandidateRef,
  type VectorIndexDiagnostics,
  type VectorIndexPort,
  type VectorIndexQuery,
  type VectorIndexResult,
} from "@oscharko-dev/keiko-contracts";
import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";

import { getCapsule } from "../capsule-lifecycle.js";
import type { KnowledgeStore } from "../store.js";

import type { RetrievalVectorIndexDiagnostics } from "./types.js";
import {
  searchVectorIndex,
  sqliteVecIndexName,
  type VectorIndexAdapter,
  type VectorIndexCandidate,
  type VectorIndexOptions,
  type VectorIndexSearchRequest,
  type VectorIndexSearchResult,
} from "./vector-index.js";

// Two closed namespaces are backed by the LK store: `knowledge` (capsules the pillar owns)
// and `repo` (repository-pod capsules governed by ADR-0152 D8). Every other value in the port's
// closed union is served elsewhere; a rogue namespace is refused via `isValidVectorIndexQuery`.
export type LocalKnowledgeStoreNamespace = "knowledge" | "repo";

// Partition-key layout accepted by the port:
//   * `capsuleId`               – the whole capsule (no source restriction).
//   * `capsuleId::sourceId`     – that capsule narrowed to the named source.
//
// The composite form is what the LK adapter shim uses to preserve the current per-source KNN
// semantic in `querySqliteVecIndex`: one port call per source, with the port narrowing the
// underlying sqlite-vec query with `sourceFilter` accordingly. The port itself never widens
// beyond what its partition key names — the partition invariant lives in the SQL.
const PARTITION_KEY_SEPARATOR = "::";

export function encodePartitionKey(
  capsuleId: KnowledgeCapsuleId,
  sourceId?: KnowledgeSourceId,
): string {
  const cid = String(capsuleId);
  if (sourceId === undefined) return cid;
  return `${cid}${PARTITION_KEY_SEPARATOR}${String(sourceId)}`;
}

interface ParsedPartitionKey {
  readonly capsuleId: string;
  readonly sourceId?: string;
}

function parsePartitionKey(partitionKey: string): ParsedPartitionKey {
  const separatorAt = partitionKey.indexOf(PARTITION_KEY_SEPARATOR);
  if (separatorAt < 0) return { capsuleId: partitionKey };
  return {
    capsuleId: partitionKey.slice(0, separatorAt),
    sourceId: partitionKey.slice(separatorAt + PARTITION_KEY_SEPARATOR.length),
  };
}

function diagnostic(provider: string, status: string, reason?: string): VectorIndexDiagnostics {
  return reason === undefined ? { provider, status } : { provider, status, reason };
}

function portInvalidQuery(): VectorIndexResult {
  return {
    ok: false,
    diagnostics: diagnostic("brute-force", "port-invalid-query", "invalid-query"),
  };
}

function portNamespaceMismatch(namespace: LocalKnowledgeStoreNamespace): VectorIndexResult {
  return {
    ok: false,
    diagnostics: diagnostic("brute-force", "port-namespace-mismatch", `expected-${namespace}`),
  };
}

function portCapsuleAbsent(): VectorIndexResult {
  return {
    ok: false,
    diagnostics: diagnostic("brute-force", "port-capsule-absent", "capsule-not-found"),
  };
}

function toPortDiagnostics(source: RetrievalVectorIndexDiagnostics): VectorIndexDiagnostics {
  return diagnostic(source.provider, source.status, source.reason);
}

function toPortCandidate(candidate: VectorIndexCandidate): VectorIndexCandidateRef {
  return { id: candidate.chunkId, score: candidate.score };
}

function toPortResult(source: VectorIndexSearchResult): VectorIndexResult {
  const diagnostics = toPortDiagnostics(source.diagnostics);
  if (!source.ok) return { ok: false, diagnostics };
  return {
    ok: true,
    diagnostics,
    candidates: source.candidates.map(toPortCandidate),
  };
}

export interface CreateLocalKnowledgeStoreVectorIndexPortOptions {
  readonly namespace: LocalKnowledgeStoreNamespace;
  readonly store: KnowledgeStore;
  // `VectorIndexOptions` passed through to the LK-native search. Any `adapter` field the caller
  // set here is cleared before dispatch: the LK adapter shim wraps THIS port, so keeping an
  // adapter would re-enter the port through itself.
  readonly vectorIndexOptions?: VectorIndexOptions | undefined;
}

// Build the `VectorIndexPort` implementation over an owned Local Knowledge store.
//
// Preconditions on every `.search(query)` invocation, in order:
//   1. `isValidVectorIndexQuery(query)` — the single canonical port precondition (ADR-0152 D1).
//      No implementation re-invents this guard.
//   2. `query.namespace === namespace` — the port refuses cross-namespace answers even for an
//      opaque caller that hands the wrong label in.
//   3. The capsule addressed by `partitionKey` exists in the store.
//
// Every refusal is `ok: false` with content-free diagnostics; identity/dimension checks and
// runtime availability fall through to `searchVectorIndex`, whose fallback vocabulary is the
// observable surface AC1 pins.
export function createLocalKnowledgeStoreVectorIndexPort(
  options: CreateLocalKnowledgeStoreVectorIndexPortOptions,
): VectorIndexPort {
  const { namespace, store } = options;
  return {
    search(query: VectorIndexQuery): VectorIndexResult {
      if (!isValidVectorIndexQuery(query)) return portInvalidQuery();
      if (query.namespace !== namespace) return portNamespaceMismatch(namespace);
      const parsed = parsePartitionKey(query.partitionKey);
      const capsule = getCapsule(store, parsed.capsuleId as KnowledgeCapsuleId);
      if (capsule === undefined) return portCapsuleAbsent();
      const request: VectorIndexSearchRequest = {
        store,
        capsule,
        ...(parsed.sourceId !== undefined
          ? { sourceFilter: [parsed.sourceId as KnowledgeSourceId] }
          : {}),
        queryVector: query.queryVector,
        candidateLimit: query.candidateLimit,
      };
      // Any inbound adapter is cleared: the LK adapter shim wraps this port, so leaving one in
      // place would loop back through the shim indefinitely. `exactOptionalPropertyTypes` makes
      // an explicit `adapter: undefined` illegal, so destructure the field out entirely.
      const { adapter: _adapter, ...flattened } = options.vectorIndexOptions ?? {};
      void _adapter;
      return toPortResult(searchVectorIndex(request, flattened));
    },
  };
}

// Reconstruct the LK-native `sawDimensionCompatible` / `sawIdentityIncompatible` flags from the
// port's status vocabulary. These flags are what `tryVectorIndexForCapsule` uses to mark lane
// state, so the shim must produce them the same way `searchSqliteVecIndex` did.
const IDENTITY_INCOMPATIBLE_STATUSES = new Set<string>(["fallback-incompatible-identity"]);

function reconstructLkFlags(result: VectorIndexResult): {
  readonly sawDimensionCompatible: boolean;
  readonly sawIdentityIncompatible: boolean;
} {
  if (result.ok) {
    return { sawDimensionCompatible: true, sawIdentityIncompatible: false };
  }
  return {
    sawDimensionCompatible: false,
    sawIdentityIncompatible: IDENTITY_INCOMPATIBLE_STATUSES.has(result.diagnostics.status),
  };
}

// The `RetrievalVectorIndexDiagnostics.status` union is a closed enum. The port's diagnostics
// status is a plain string (contracts stays out of LK's private vocabulary). This function
// projects the port's status back into an LK-recognised value, defaulting to
// `fallback-query-error` for anything the port emitted that the LK vocabulary does not name.
// The port's OWN refusal reasons (`port-invalid-query`, `port-namespace-mismatch`,
// `port-capsule-absent`) all map through this default — they express caller-side breakage the
// LK path never sees, and calling `searchVectorIndex` directly would not have produced them.
const LK_STATUS_VALUES: ReadonlySet<RetrievalVectorIndexDiagnostics["status"]> = new Set([
  "disabled",
  "available",
  "fallback-unavailable",
  "fallback-encrypted-store",
  "fallback-unsupported-metric",
  "fallback-incompatible-identity",
  "fallback-index-too-large",
  "fallback-query-error",
]);

function toLkStatus(status: string): RetrievalVectorIndexDiagnostics["status"] {
  return LK_STATUS_VALUES.has(status as RetrievalVectorIndexDiagnostics["status"])
    ? (status as RetrievalVectorIndexDiagnostics["status"])
    : "fallback-query-error";
}

const LK_PROVIDER_VALUES: ReadonlySet<RetrievalVectorIndexDiagnostics["provider"]> = new Set([
  "brute-force",
  "sqlite-vec",
]);

function toLkProvider(provider: string): RetrievalVectorIndexDiagnostics["provider"] {
  return LK_PROVIDER_VALUES.has(provider as RetrievalVectorIndexDiagnostics["provider"])
    ? (provider as RetrievalVectorIndexDiagnostics["provider"])
    : "sqlite-vec";
}

function toLkDiagnostics(source: VectorIndexDiagnostics): RetrievalVectorIndexDiagnostics {
  return {
    provider: toLkProvider(source.provider),
    status: toLkStatus(source.status),
    ...(source.reason !== undefined ? { reason: source.reason } : {}),
  };
}

function toLkCandidate(
  candidate: VectorIndexCandidateRef,
  capsuleId: KnowledgeCapsuleId,
): VectorIndexCandidate {
  return {
    chunkId: candidate.id,
    capsuleId,
    score: candidate.score,
  };
}

// The outer merge sort matches `querySqliteVecIndex`'s tiebreak exactly (`localeCompare`, not
// code-unit `<`). The two produce different orderings for non-ASCII chunk ids on hosts with
// different ICU collations; matching what shipped before preserves observable candidate order.
function candidateScoreDesc(a: VectorIndexCandidate, b: VectorIndexCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.chunkId.localeCompare(b.chunkId);
}

interface PortDispatch {
  readonly result: VectorIndexResult;
  readonly partitionKey: string;
}

// Preserve the current per-source KNN cadence: without a source filter we make ONE port call
// against `capsuleId`; with a source filter we make ONE call per source against
// `capsuleId::sourceId`. Merging + slicing to `candidateLimit` happens on the union, matching
// the current `sourceFilter.flatMap` + sort + slice pattern in `querySqliteVecIndex`.
function dispatchPortCalls(
  port: VectorIndexPort,
  request: VectorIndexSearchRequest,
): readonly PortDispatch[] {
  const capsulePartition = String(request.capsule.id);
  if (request.sourceFilter === undefined || request.sourceFilter.length === 0) {
    return [
      {
        partitionKey: capsulePartition,
        result: port.search({
          namespace: "knowledge",
          partitionKey: capsulePartition,
          identity: request.capsule.embeddingModelIdentity,
          queryVector: request.queryVector,
          candidateLimit: request.candidateLimit,
        }),
      },
    ];
  }
  return request.sourceFilter.map((sourceId) => {
    const partitionKey = encodePartitionKey(request.capsule.id, sourceId);
    return {
      partitionKey,
      result: port.search({
        namespace: "knowledge",
        partitionKey,
        identity: request.capsule.embeddingModelIdentity,
        queryVector: request.queryVector,
        candidateLimit: request.candidateLimit,
      }),
    };
  });
}

// Adapt a `VectorIndexPort` to the `VectorIndexAdapter` shape the LK retrieval path consumes
// via `VectorIndexOptions.adapter` (ADR-0152 D3). The shim converts each LK request into one
// or more port queries, merges the candidate sets, applies `minScore`, sorts, and slices to
// `candidateLimit` — the same steps `querySqliteVecIndex` performs internally today.
//
// The shim always calls the port with `namespace: "knowledge"` because the LK request comes
// from LK retrieval, which is the knowledge-namespace consumer. A repo-namespace shim would
// call the port with `namespace: "repo"` (see `createRepoVectorIndexAdapter` below).
export function vectorIndexPortAsKnowledgeAdapter(port: VectorIndexPort): VectorIndexAdapter {
  return {
    searchCapsule(request: VectorIndexSearchRequest): VectorIndexSearchResult {
      return mergePortDispatches(dispatchPortCalls(port, request), request);
    },
  };
}

// `dispatchPortCalls` labels every partition key as `knowledge`; for repo the shim relabels the
// call by making its own dispatch. The two shims share `mergePortDispatches` so behaviour stays
// symmetric between namespaces.
export function vectorIndexPortAsRepoAdapter(port: VectorIndexPort): VectorIndexAdapter {
  return {
    searchCapsule(request: VectorIndexSearchRequest): VectorIndexSearchResult {
      const capsulePartition = String(request.capsule.id);
      const dispatches: PortDispatch[] =
        request.sourceFilter === undefined || request.sourceFilter.length === 0
          ? [
              {
                partitionKey: capsulePartition,
                result: port.search({
                  namespace: "repo",
                  partitionKey: capsulePartition,
                  identity: request.capsule.embeddingModelIdentity,
                  queryVector: request.queryVector,
                  candidateLimit: request.candidateLimit,
                }),
              },
            ]
          : request.sourceFilter.map((sourceId) => {
              const partitionKey = encodePartitionKey(request.capsule.id, sourceId);
              return {
                partitionKey,
                result: port.search({
                  namespace: "repo",
                  partitionKey,
                  identity: request.capsule.embeddingModelIdentity,
                  queryVector: request.queryVector,
                  candidateLimit: request.candidateLimit,
                }),
              };
            });
      return mergePortDispatches(dispatches, request);
    },
  };
}

function firstNotOk(dispatches: readonly PortDispatch[]): VectorIndexResult | undefined {
  for (const dispatch of dispatches) {
    if (!dispatch.result.ok) return dispatch.result;
  }
  return undefined;
}

function mergePortDispatches(
  dispatches: readonly PortDispatch[],
  request: VectorIndexSearchRequest,
): VectorIndexSearchResult {
  const failing = firstNotOk(dispatches);
  if (failing !== undefined) {
    const flags = reconstructLkFlags(failing);
    return {
      ok: false,
      candidates: [],
      sawDimensionCompatible: flags.sawDimensionCompatible,
      sawIdentityIncompatible: flags.sawIdentityIncompatible,
      diagnostics: toLkDiagnostics(failing.diagnostics),
    };
  }
  const combined: VectorIndexCandidate[] = [];
  for (const dispatch of dispatches) {
    if (!dispatch.result.ok) continue;
    for (const ref of dispatch.result.candidates) {
      combined.push(toLkCandidate(ref, request.capsule.id));
    }
  }
  const filtered = combined
    .filter((candidate) => request.minScore === undefined || candidate.score >= request.minScore)
    .sort(candidateScoreDesc)
    .slice(0, request.candidateLimit);
  // Rebuild the LK-native diagnostics fields the port shape does not carry (`vectorCount`,
  // `indexName`). `vectorCount` is what `querySqliteVecIndex` reports today: the size of the
  // final candidate set. `indexName` is derived from the capsule's embedding identity the same
  // way `sqliteVecIndexName` derives it inside `vector-index.ts` — kept in lockstep here so
  // the observable diagnostic stays the same string.
  const combinedDiagnostics: RetrievalVectorIndexDiagnostics = {
    provider: "sqlite-vec",
    status: "available",
    indexName: sqliteVecIndexName(request.capsule.embeddingModelIdentity),
    vectorCount: filtered.length,
    ...(dispatches[0]?.result.ok === true && dispatches[0].result.diagnostics.reason !== undefined
      ? { reason: dispatches[0].result.diagnostics.reason }
      : {}),
  };
  return {
    ok: true,
    candidates: filtered,
    sawDimensionCompatible: true,
    sawIdentityIncompatible: false,
    diagnostics: combinedDiagnostics,
  };
}
