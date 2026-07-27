// The `knowledge` and `repo` namespace implementations of `VectorIndexPort` (ADR-0152 D1/D3).
//
// The port is the pillar-neutral contract in `keiko-contracts`; this module is the Local
// Knowledge backing that composes it onto the two namespaces whose vectors live in the LK
// capsule store. Memory is intentionally excluded from this store adapter because its vectors live
// in keiko-memory-vault; the server composes those already authorized/decrypted candidates onto the
// same USearch service through the port's tighten-only candidate allow-list (ADR-0163 D1).
//
// Both a port implementation and a matching `VectorIndexAdapter` shim are exported here. The
// port is what pillar-neutral consumers call; the shim is what the LK retrieval path consumes
// through the existing `VectorIndexOptions.adapter` seam, so activating composition does not
// require touching `tryVectorIndexForCapsule` or `searchVectorIndex`. Every refusal is
// content-free `ok: false` — never an exception, never a body, never a path.

import {
  embeddingIdentityKey,
  isValidVectorIndexQuery,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
  type VectorIndexCandidateRef,
  type VectorIndexDiagnostics,
  type VectorIndexPort,
  type VectorIndexQuery,
  type VectorIndexResult,
} from "@oscharko-dev/keiko-contracts";

import { getCapsule } from "../capsule-lifecycle.js";
import type { KnowledgeStore } from "../store.js";

import type { RetrievalVectorIndexDiagnostics } from "./types.js";
import {
  searchVectorIndex,
  usearchIndexName,
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
//   * `capsuleId`                                  – the whole capsule (no source restriction).
//   * `capsuleId + "|" + encoded(sourceId)`        – that capsule narrowed to the named source.
//
// The composite form is what the LK adapter shim uses to preserve the current per-source KNN
// semantic in the store-backed vector query: one port call per source, with the port narrowing the
// shared index query with `sourceFilter` accordingly. The port itself never widens
// beyond what its partition key names — the partition invariant lives in the SQL.
//
// Both components are percent-encoded with `encodeURIComponent` and the SEPARATOR itself is a
// character that percent-encoding always escapes when present in an input (`|`). That makes the
// encoding injective across every branded string a `KnowledgeCapsuleId` or `KnowledgeSourceId`
// can carry — including opaque ids that happen to contain the separator, colons, or any other
// URI-reserved character — so a rogue id can never mis-parse into someone else's partition.
const PARTITION_KEY_SEPARATOR = "|";

function encodeIdComponent(id: string): string {
  return encodeURIComponent(id);
}

export function encodePartitionKey(
  capsuleId: KnowledgeCapsuleId,
  sourceId?: KnowledgeSourceId,
): string {
  const encodedCapsule = encodeIdComponent(String(capsuleId));
  if (sourceId === undefined) return encodedCapsule;
  return `${encodedCapsule}${PARTITION_KEY_SEPARATOR}${encodeIdComponent(String(sourceId))}`;
}

interface ParsedPartitionKey {
  readonly capsuleId: string;
  readonly sourceId?: string;
}

// `parsePartitionKey` returns `undefined` when the key cannot be decoded — a malformed key MUST
// fail closed instead of silently narrowing to a partial parse, because a mis-parsed key would
// address the wrong capsule and cross the partition boundary the port exists to enforce.
function parsePartitionKey(partitionKey: string): ParsedPartitionKey | undefined {
  const separatorAt = partitionKey.indexOf(PARTITION_KEY_SEPARATOR);
  try {
    if (separatorAt < 0) return { capsuleId: decodeURIComponent(partitionKey) };
    return {
      capsuleId: decodeURIComponent(partitionKey.slice(0, separatorAt)),
      sourceId: decodeURIComponent(
        partitionKey.slice(separatorAt + PARTITION_KEY_SEPARATOR.length),
      ),
    };
  } catch {
    return undefined;
  }
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

function portInvalidPartitionKey(): VectorIndexResult {
  return {
    ok: false,
    diagnostics: diagnostic("brute-force", "port-invalid-query", "invalid-partition-key"),
  };
}

// Emitted when the caller-declared `query.identity` and the target capsule's stored identity are
// not byte-compatible (canonical `embeddingIdentityKey` comparison). Uses the LK-native status
// `fallback-incompatible-identity` so the adapter shim reconstructs `sawIdentityIncompatible:
// true` and lane state stays consistent with what the LK-native path would have done.
function portIdentityMismatch(): VectorIndexResult {
  return {
    ok: false,
    diagnostics: diagnostic("usearch", "fallback-incompatible-identity", "identity-mismatch"),
  };
}

function toPortDiagnostics(source: RetrievalVectorIndexDiagnostics): VectorIndexDiagnostics {
  return {
    ...diagnostic(source.provider, source.status, source.reason),
    ...(source.indexName !== undefined ? { indexName: source.indexName } : {}),
    ...(source.vectorCount !== undefined ? { vectorCount: source.vectorCount } : {}),
    ...(source.searchMode !== undefined ? { searchMode: source.searchMode } : {}),
    ...(source.examinedCandidateCount !== undefined
      ? { examinedCandidateCount: source.examinedCandidateCount }
      : {}),
    ...(source.estimatedIndexBytes !== undefined
      ? { estimatedIndexBytes: source.estimatedIndexBytes }
      : {}),
  };
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
//   3. `parsePartitionKey(query.partitionKey)` yields a decodable key.
//   4. The capsule addressed by that key exists in the store.
//   5. `embeddingIdentityKey(query.identity) === embeddingIdentityKey(capsule.identity)`. The
//      port contract classes identity mismatch as a normal fail-closed condition; without this
//      check, a caller declaring an incompatible identity (same dimensions) would still receive
//      candidates scored against the capsule's index, which is a silent fail-OPEN.
//
// Every refusal is `ok: false` with content-free diagnostics. Runtime availability, metric
// support, dimension checks against the STORE, and the encrypted-store TEMP-store gate all fall
// through to `searchVectorIndex`, whose fallback vocabulary is the observable surface AC1 pins.
export function createLocalKnowledgeStoreVectorIndexPort(
  options: CreateLocalKnowledgeStoreVectorIndexPortOptions,
): VectorIndexPort {
  const { namespace, store } = options;
  return {
    async search(query: VectorIndexQuery): Promise<VectorIndexResult> {
      if (!isValidVectorIndexQuery(query)) return portInvalidQuery();
      if (query.namespace !== namespace) return portNamespaceMismatch(namespace);
      const parsed = parsePartitionKey(query.partitionKey);
      if (parsed === undefined) return portInvalidPartitionKey();
      const capsule = getCapsule(store, parsed.capsuleId as KnowledgeCapsuleId);
      if (capsule === undefined) return portCapsuleAbsent();
      if (
        embeddingIdentityKey(query.identity) !==
        embeddingIdentityKey(capsule.embeddingModelIdentity)
      ) {
        return portIdentityMismatch();
      }
      const request: VectorIndexSearchRequest = {
        store,
        capsule,
        ...(parsed.sourceId !== undefined
          ? { sourceFilter: [parsed.sourceId as KnowledgeSourceId] }
          : {}),
        ...(query.candidateIds !== undefined ? { chunkFilter: query.candidateIds } : {}),
        queryVector: query.queryVector,
        candidateLimit: query.candidateLimit,
      };
      // Any inbound adapter is cleared: the LK adapter shim wraps this port, so leaving one in
      // place would loop back through the shim indefinitely. `exactOptionalPropertyTypes` makes
      // an explicit `adapter: undefined` illegal, so destructure the field out entirely.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-sibling omit of adapter
      const { adapter: _adapter, ...flattened } = options.vectorIndexOptions ?? {};
      return toPortResult(await searchVectorIndex(request, flattened));
    },
  };
}

// Reconstruct the LK-native `sawDimensionCompatible` / `sawIdentityIncompatible` flags from the
// port's status vocabulary. These flags are what `tryVectorIndexForCapsule` uses to mark lane
// state, so the shim must produce them the same way the LK-native service does.
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
  "usearch",
]);

function toLkProvider(provider: string): RetrievalVectorIndexDiagnostics["provider"] {
  return LK_PROVIDER_VALUES.has(provider as RetrievalVectorIndexDiagnostics["provider"])
    ? (provider as RetrievalVectorIndexDiagnostics["provider"])
    : "usearch";
}

function toLkDiagnostics(source: VectorIndexDiagnostics): RetrievalVectorIndexDiagnostics {
  return {
    provider: toLkProvider(source.provider),
    status: toLkStatus(source.status),
    ...(source.reason !== undefined ? { reason: source.reason } : {}),
    ...(source.indexName !== undefined ? { indexName: source.indexName } : {}),
    ...(source.vectorCount !== undefined ? { vectorCount: source.vectorCount } : {}),
    ...(source.searchMode !== undefined ? { searchMode: source.searchMode } : {}),
    ...(source.examinedCandidateCount !== undefined
      ? { examinedCandidateCount: source.examinedCandidateCount }
      : {}),
    ...(source.estimatedIndexBytes !== undefined
      ? { estimatedIndexBytes: source.estimatedIndexBytes }
      : {}),
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

// The outer merge sort matches the store-backed query's tiebreak exactly (`localeCompare`, not
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
// against `capsuleId`; with a source filter we make ONE call per source against the encoded
// composite key. Merging + slicing to `candidateLimit` happens on the union, matching the
// current `sourceFilter.flatMap` + sort + slice pattern in the store-backed query.
//
// The two adapter shims (knowledge/repo) share this function; the only difference is the
// namespace label the port sees on its query. Parameterising here removes a duplicate branch
// that would otherwise be maintained in lockstep across both shims.
//
// Short-circuit on the first fail-closed dispatch: every port.search call re-enters the LK
// pipeline (precheck, runtime probe, `writeUnavailable(...)` on the fallback path). When the
// first source returns `ok: false`, the remaining calls would repeat the same precondition
// failure — same store, same identity, same runtime absence — and re-write the same
// `vector_index_state` row. Stop after the first failure so the merged result stays
// fail-closed exactly as it would after N calls, without N-1 wasted round-trips.
async function dispatchPortCalls(
  port: VectorIndexPort,
  namespace: LocalKnowledgeStoreNamespace,
  request: VectorIndexSearchRequest,
): Promise<readonly PortDispatch[]> {
  const capsulePartition = encodePartitionKey(request.capsule.id);
  const dispatchOne = async (partitionKey: string): Promise<PortDispatch> => {
    const result = await port.search({
      namespace,
      partitionKey,
      identity: request.capsule.embeddingModelIdentity,
      queryVector: request.queryVector,
      candidateLimit: request.candidateLimit,
      ...(request.chunkFilter !== undefined ? { candidateIds: request.chunkFilter } : {}),
    });
    return { partitionKey, result };
  };
  if (request.sourceFilter === undefined || request.sourceFilter.length === 0) {
    return [await dispatchOne(capsulePartition)];
  }
  const dispatches: PortDispatch[] = [];
  for (const sourceId of request.sourceFilter) {
    const dispatch = await dispatchOne(encodePartitionKey(request.capsule.id, sourceId));
    dispatches.push(dispatch);
    if (!dispatch.result.ok) break;
  }
  return dispatches;
}

// Adapt a `VectorIndexPort` to the `VectorIndexAdapter` shape the LK retrieval path consumes
// via `VectorIndexOptions.adapter` (ADR-0152 D3). The shim converts each LK request into one
// or more port queries, merges the candidate sets, applies `minScore`, sorts, and slices to
// `candidateLimit` — the same steps the store-backed query performs internally today.
export function vectorIndexPortAsKnowledgeAdapter(port: VectorIndexPort): VectorIndexAdapter {
  return {
    async searchCapsule(request: VectorIndexSearchRequest): Promise<VectorIndexSearchResult> {
      return mergePortDispatches(await dispatchPortCalls(port, "knowledge", request), request);
    },
  };
}

// The repo shim reuses `dispatchPortCalls` with a `namespace: "repo"` label so the port sees
// the correct partition-name origin. Behaviour is otherwise identical — merging, minScore,
// sort, slice, and diagnostic reconstruction stay symmetric between the two shims.
export function vectorIndexPortAsRepoAdapter(port: VectorIndexPort): VectorIndexAdapter {
  return {
    async searchCapsule(request: VectorIndexSearchRequest): Promise<VectorIndexSearchResult> {
      return mergePortDispatches(await dispatchPortCalls(port, "repo", request), request);
    },
  };
}

function firstNotOk(dispatches: readonly PortDispatch[]): VectorIndexResult | undefined {
  for (const dispatch of dispatches) {
    if (!dispatch.result.ok) return dispatch.result;
  }
  return undefined;
}

function preferredSearchMode(
  diagnostics: readonly VectorIndexDiagnostics[],
): "ann" | "exact" | undefined {
  if (diagnostics.some((entry) => entry.searchMode === "ann")) return "ann";
  if (diagnostics.some((entry) => entry.searchMode === "exact")) return "exact";
  return undefined;
}

function successfulDiagnostics(
  dispatches: readonly PortDispatch[],
): Pick<
  RetrievalVectorIndexDiagnostics,
  "searchMode" | "examinedCandidateCount" | "estimatedIndexBytes"
> {
  const diagnostics = dispatches
    .filter((dispatch) => dispatch.result.ok)
    .map((dispatch) => dispatch.result.diagnostics);
  const searchMode = preferredSearchMode(diagnostics);
  const examinedCandidateCount = diagnostics.reduce(
    (sum, entry) => sum + (entry.examinedCandidateCount ?? 0),
    0,
  );
  const estimatedIndexBytes = diagnostics.reduce(
    (sum, entry) => sum + (entry.estimatedIndexBytes ?? 0),
    0,
  );
  return {
    ...(searchMode !== undefined ? { searchMode } : {}),
    ...(examinedCandidateCount > 0 ? { examinedCandidateCount } : {}),
    ...(estimatedIndexBytes > 0 ? { estimatedIndexBytes } : {}),
  };
}

function combinedPortCandidates(
  dispatches: readonly PortDispatch[],
  capsuleId: KnowledgeCapsuleId,
): VectorIndexCandidate[] {
  const combined: VectorIndexCandidate[] = [];
  for (const dispatch of dispatches) {
    if (!dispatch.result.ok) continue;
    for (const ref of dispatch.result.candidates) {
      combined.push(toLkCandidate(ref, capsuleId));
    }
  }
  return combined;
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
  const filtered = combinedPortCandidates(dispatches, request.capsule.id)
    .filter((candidate) => request.minScore === undefined || candidate.score >= request.minScore)
    .sort(candidateScoreDesc)
    .slice(0, request.candidateLimit);
  const combinedDiagnostics: RetrievalVectorIndexDiagnostics = {
    provider: "usearch",
    status: "available",
    indexName: usearchIndexName(request.capsule.embeddingModelIdentity),
    vectorCount: filtered.length,
    ...successfulDiagnostics(dispatches),
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
