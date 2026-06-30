// Shared conversation-retrieval signal builder (#204, O-F4).
//
// Both conversation retrieval surfaces — the desktop chat path (chat-handlers) and the BFF
// /api/memory/context route (memory-conv-handlers) — need the same two model/usage-derived ranking
// signals on top of the pure lexical ranker:
//   - semanticById: per-memory cosine of the query embedding to each candidate's stored vector
//     (embedding-based recall), gated by the secondary-model egress check.
//   - strengthById: per-memory reinforcement strength from the vault's access counters (O-P1).
// Previously only the chat path built them; the BFF route silently ran lexical-only. Centralising
// them here keeps the two surfaces from drifting (the same class of duplication C3 guards for
// suppression) and gives any future consumer of the route the stronger embedding signal by default.
//
// Policy-aware but content-free in diagnostics: the caller builds a gate from local policy/provider
// locality, then this module degrades without echoing queries or memory bodies. Graceful: no
// embedding model => semanticById undefined (lexical fallback); empty access history => strengthById
// empty (the ranker zeroes its weight).

import type { MemoryId, MemoryScope } from "@oscharko-dev/keiko-contracts/memory";
import type { EmbeddingModelIdentity } from "@oscharko-dev/keiko-contracts";
import { assertCompatibleEmbeddingIdentity } from "@oscharko-dev/keiko-model-gateway";
import {
  buildStrengthById,
  DEFAULT_LIST_BY_SCOPE_MAX_RESULTS,
  DEFAULT_STALE_CONFIDENCE_THRESHOLD,
  type RankingFusionMode,
} from "@oscharko-dev/keiko-memory-retrieval";
import type {
  MemoryEmbeddingInput,
  MemoryEmbeddingRow,
  MemoryMetadata,
  MemoryVaultStore,
} from "@oscharko-dev/keiko-memory-vault";
import {
  memoryTextEgressRejectionReason,
  type CapturePolicyOptions,
  type RejectionReason,
} from "@oscharko-dev/keiko-memory-capture";
import { isIP } from "node:net";

import { currentGatewayConfig, type UiHandlerDeps } from "./deps.js";
import { configuredEmbeddingProviders } from "./local-knowledge-handlers.js";
import {
  cosineSimilarity,
  embedMemoryText,
  memoryEmbeddingCalibrationFor,
} from "./memory-embedding.js";

export type SemanticRetrievalGateReason =
  | "allowed"
  | "blocked-by-policy"
  | "no-query"
  | "no-embeddings"
  | "no-embedder"
  | "identity-mismatch";

export interface SemanticRetrievalGate {
  readonly allowed: boolean;
  readonly reason: SemanticRetrievalGateReason;
}

const SECRET_EGRESS_REJECTION_REASONS = new Set<RejectionReason>([
  "credential-shape",
  "private-credential-path",
  "provider-base-url",
  "raw-log-content",
  "customer-identifier",
]);

const SEMANTIC_SWEEP_MAX_CANDIDATES = 160;
const SEMANTIC_RECENCY_HALF_LIFE_MS = 45 * 24 * 60 * 60 * 1000;

function normalizedEndpointHost(baseUrl: string): string | undefined {
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname.toLocaleLowerCase("en-US").replace(/^\[|\]$/gu, "");
  } catch {
    return undefined;
  }
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts as [number, number, number, number];
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLocaleLowerCase("en-US");
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

function isInTenantEndpoint(baseUrl: string): boolean {
  const host = normalizedEndpointHost(baseUrl);
  if (host === undefined) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) return isPrivateIpv6(host);
  return false;
}

function hasInTenantEmbeddingProvider(deps: UiHandlerDeps): boolean {
  return configuredEmbeddingProviders(currentGatewayConfig(deps)).some((provider) =>
    isInTenantEndpoint(provider.baseUrl),
  );
}

function hasEmbeddingProvider(deps: UiHandlerDeps): boolean {
  return configuredEmbeddingProviders(currentGatewayConfig(deps)).length > 0;
}

export function semanticRetrievalGateForText(
  deps: UiHandlerDeps,
  queryText: string | undefined,
  policy: CapturePolicyOptions,
): SemanticRetrievalGate {
  if (queryText === undefined || queryText.trim().length === 0) {
    return { allowed: false, reason: "no-query" };
  }
  const rejection = memoryTextEgressRejectionReason(queryText, policy);
  if (rejection === null) {
    return { allowed: true, reason: "allowed" };
  }
  if (SECRET_EGRESS_REJECTION_REASONS.has(rejection)) {
    return { allowed: false, reason: "blocked-by-policy" };
  }
  if (hasInTenantEmbeddingProvider(deps)) {
    return { allowed: true, reason: "allowed" };
  }
  return {
    allowed: false,
    reason: hasEmbeddingProvider(deps) ? "blocked-by-policy" : "no-embedder",
  };
}

function isSemanticRetrievalMetadataCandidate(record: MemoryMetadata, nowMs: number): boolean {
  if (record.status !== "accepted") return false;
  if (record.validity.validUntil !== undefined && record.validity.validUntil <= nowMs) return false;
  return record.confidence > DEFAULT_STALE_CONFIDENCE_THRESHOLD;
}

function recencySignal(updatedAt: number, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - updatedAt);
  return 1 / (1 + ageMs / SEMANTIC_RECENCY_HALF_LIFE_MS);
}

function cleartextCandidateScore(
  record: MemoryMetadata,
  nowMs: number,
  strengthById: ReadonlyMap<MemoryId, number>,
): number {
  return (
    record.confidence * 0.35 +
    recencySignal(record.updatedAt, nowMs) * 0.25 +
    (record.pinned ? 0.25 : 0) +
    (strengthById.get(record.id) ?? 0) * 0.15
  );
}

function gatherCandidateIds(
  vault: MemoryVaultStore,
  scopes: readonly MemoryScope[],
  nowMs: number,
  strengthById: ReadonlyMap<MemoryId, number>,
  signal?: AbortSignal,
): readonly MemoryId[] {
  const candidates: MemoryMetadata[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    throwIfAborted(signal);
    for (const record of vault.listMemoryMetadataByScope(scope, {
      includeExpired: true,
      limit: DEFAULT_LIST_BY_SCOPE_MAX_RESULTS,
    })) {
      throwIfAborted(signal);
      if (!isSemanticRetrievalMetadataCandidate(record, nowMs)) continue;
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      candidates.push(record);
    }
  }
  return candidates
    .sort((a, b) => {
      const scoreDelta =
        cleartextCandidateScore(b, nowMs, strengthById) -
        cleartextCandidateScore(a, nowMs, strengthById);
      if (scoreDelta !== 0) return scoreDelta;
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      return a.id.localeCompare(b.id);
    })
    .slice(0, SEMANTIC_SWEEP_MAX_CANDIDATES)
    .map((record) => record.id);
}

// Per-memory semantic score map for the candidate set, or undefined when no embedding model is
// configured (query embedding null) — that undefined drives the byte-identical lexical fallback in
// the ranker. A candidate whose stored vector is missing is omitted (semantic subscore 0 for it).
// Query-cosine scores for the candidate set, computed from the already-fetched embeddings. Gated by
// the egress check (it embeds the query). Returns undefined when no model / no query embedding.
function inputIdentity(input: MemoryEmbeddingInput): EmbeddingModelIdentity {
  return {
    provider: input.provider,
    modelId: input.modelId,
    ...(input.modelRevision !== undefined ? { modelRevision: input.modelRevision } : {}),
    vectorDimensions: input.vector.length,
    vectorMetric: input.metric,
  };
}

function rowIdentity(row: MemoryEmbeddingRow): EmbeddingModelIdentity {
  return {
    provider: row.provider,
    modelId: row.modelId,
    ...(row.modelRevision !== undefined ? { modelRevision: row.modelRevision } : {}),
    vectorDimensions: row.dimensions,
    vectorMetric: row.metric,
  };
}

function semanticScoreForRow(
  queryEmbedding: MemoryEmbeddingInput,
  queryIdentity: EmbeddingModelIdentity,
  stored: MemoryEmbeddingRow,
): number | null {
  const compatibility = assertCompatibleEmbeddingIdentity(rowIdentity(stored), queryIdentity);
  if (!compatibility.ok || !vectorsComparable(queryEmbedding.vector, stored.vector)) return null;
  return cosineSimilarity(queryEmbedding.vector, stored.vector);
}

function warnSkippedIncompatible(skipped: number, candidates: number, queryModelId: string): void {
  if (skipped === 0) return;
  // Safe diagnostic: counts and model ids only, never query text or memory bodies.
  // eslint-disable-next-line no-console
  console.warn("memory semantic scores skipped for incompatible embeddings", {
    reason: "identity-mismatch",
    skipped,
    candidates,
    queryModelId,
  });
}

async function semanticScoresFrom(
  deps: UiHandlerDeps,
  queryText: string,
  candidateIds: readonly MemoryId[],
  embeddings: ReadonlyMap<MemoryId, MemoryEmbeddingRow>,
  signal?: AbortSignal,
): Promise<ReadonlyMap<MemoryId, number> | undefined> {
  throwIfAborted(signal);
  const queryEmbedding = await embedMemoryText(deps, queryText, "query");
  if (queryEmbedding === null) {
    warnSemanticRetrievalDisabled("no-embedder", { candidates: candidateIds.length });
    return undefined;
  }
  throwIfAborted(signal);
  const queryIdentity = inputIdentity(queryEmbedding);
  const scores = new Map<MemoryId, number>();
  let skippedIncompatible = 0;
  for (const id of candidateIds) {
    throwIfAborted(signal);
    const stored = embeddings.get(id);
    if (stored === undefined) continue;
    const score = semanticScoreForRow(queryEmbedding, queryIdentity, stored);
    if (score === null) {
      skippedIncompatible += 1;
      continue;
    }
    scores.set(id, score);
  }
  warnSkippedIncompatible(skippedIncompatible, candidateIds.length, queryEmbedding.modelId);
  return scores;
}

function warnSemanticRetrievalDisabled(
  reason: SemanticRetrievalGateReason,
  extra: Record<string, unknown> = {},
): void {
  if (reason === "allowed") return;
  // Safe diagnostic: reason and counts only, never query text, memory bodies, endpoints, or keys.
  // eslint-disable-next-line no-console
  console.warn("memory semantic scores disabled", { reason, ...extra });
}

function hasNonZeroMagnitude(vector: Float32Array): boolean {
  for (const value of vector) {
    if (value !== 0) return true;
  }
  return false;
}

function vectorsComparable(query: Float32Array, stored: Float32Array): boolean {
  return (
    query.length > 0 &&
    query.length === stored.length &&
    hasNonZeroMagnitude(query) &&
    hasNonZeroMagnitude(stored)
  );
}

// Signal-fusion mode for the conversation retrieval surfaces (#204, O-F2). Conversation recall now
// defaults to rank-based Reciprocal Rank Fusion; set KEIKO_MEMORY_FUSION=weighted-sum to force the
// legacy weighted scorer for rollout comparison.
export function conversationFusionMode(deps: UiHandlerDeps): RankingFusionMode {
  return deps.env.KEIKO_MEMORY_FUSION === "weighted-sum" ? "weighted-sum" : "rrf";
}

export interface ConversationRetrievalSignals {
  readonly semanticById?: ReadonlyMap<MemoryId, number> | undefined;
  readonly strengthById: ReadonlyMap<MemoryId, number>;
  // Raw candidate vectors for MMR diversity (#204, O-F3). Built from the SAME getEmbeddings call as
  // semanticById (no extra IO, no egress — local vectors), so MMR works even when the query itself is
  // not egress-safe. Empty when the vault has no embeddings.
  readonly embeddingById: ReadonlyMap<MemoryId, Float32Array>;
  readonly mmrLambda?: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new Error("memory retrieval aborted");
  }
}

interface EmbeddingSignals {
  readonly embeddingById: ReadonlyMap<MemoryId, Float32Array>;
  readonly mmrLambda?: number;
}

function collectEmbeddingSignals(
  deps: UiHandlerDeps,
  embeddings: ReadonlyMap<MemoryId, MemoryEmbeddingRow>,
  signal?: AbortSignal,
): EmbeddingSignals {
  const embeddingById = new Map<MemoryId, Float32Array>();
  let mmrLambda: number | undefined;
  for (const [id, row] of embeddings) {
    throwIfAborted(signal);
    embeddingById.set(id, row.vector);
    mmrLambda ??= memoryEmbeddingCalibrationFor(deps.env, row).mmrLambda;
  }
  return {
    embeddingById,
    ...(mmrLambda !== undefined ? { mmrLambda } : {}),
  };
}

function warnSemanticGate(
  semanticGate: SemanticRetrievalGate,
  embeddings: ReadonlyMap<MemoryId, MemoryEmbeddingRow>,
  candidateCount: number,
): void {
  if (semanticGate.allowed && embeddings.size === 0) {
    warnSemanticRetrievalDisabled("no-embeddings", { candidates: candidateCount });
  } else if (!semanticGate.allowed && semanticGate.reason !== "no-query") {
    warnSemanticRetrievalDisabled(semanticGate.reason, { candidates: candidateCount });
  }
}

function shouldComputeSemanticScores(
  semanticGate: SemanticRetrievalGate,
  queryText: string | undefined,
  embeddings: ReadonlyMap<MemoryId, MemoryEmbeddingRow>,
): queryText is string {
  return semanticGate.allowed && queryText !== undefined && queryText.length > 0 && embeddings.size > 0;
}

export async function buildConversationRetrievalSignals(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  queryText: string | undefined,
  scopes: readonly MemoryScope[],
  nowMs: number,
  semanticGate: SemanticRetrievalGate,
  signal?: AbortSignal,
): Promise<ConversationRetrievalSignals> {
  throwIfAborted(signal);
  const strengthById = buildStrengthById(vault.getAccessStats(), nowMs);
  throwIfAborted(signal);
  const candidateIds = gatherCandidateIds(vault, scopes, nowMs, strengthById, signal);
  throwIfAborted(signal);
  const embeddings =
    candidateIds.length > 0
      ? vault.getEmbeddings(candidateIds)
      : new Map<MemoryId, MemoryEmbeddingRow>();
  throwIfAborted(signal);
  const embeddingSignals = collectEmbeddingSignals(deps, embeddings, signal);
  warnSemanticGate(semanticGate, embeddings, candidateIds.length);
  const semanticById = shouldComputeSemanticScores(semanticGate, queryText, embeddings)
    ? await semanticScoresFrom(deps, queryText, candidateIds, embeddings, signal)
    : undefined;
  return {
    strengthById,
    embeddingById: embeddingSignals.embeddingById,
    ...(embeddingSignals.mmrLambda !== undefined ? { mmrLambda: embeddingSignals.mmrLambda } : {}),
    ...(semanticById !== undefined ? { semanticById } : {}),
  };
}
