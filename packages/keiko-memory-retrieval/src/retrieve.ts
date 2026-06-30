// Top-level scoped-memory retrieval orchestrator.
//
// Cross-scope isolation is structural: the function ONLY iterates `request.scopes` when
// calling port.listByScope. A caller cannot trick this layer into surfacing records from
// a scope it did not authorise because no other code path reaches the port.
//
// Pipeline:
//   1. Validate request (non-empty scopes, finite non-negative weights, finite integer
//      budget/maxIncluded).
//   2. For each scope in request.scopes -> port.listByScope(scope, {maxResults, include*}).
//      Wrap any port throw as RetrievalError('port-failure', cause: original).
//   3. Dedupe by memoryId (a record reachable from multiple scopes appears once).
//   4. Apply suppression (status / validity / confidence) -> "suppressed-by-status".
//      Apply type filter when request.types is set -> "type-filtered".
//   5. Build an edges-by-memory map for the candidate set if the port exposes
//      listOutgoingEdges/listIncomingEdges (bounded fetch — only candidates we still hold).
//   6. Rank with the hybrid ranker; assemble with the token-budgeted greedy assembler.
//   7. Attach request to the assembler's result and return.
//
// Determinism: every step is pure given the port's return values, so identical port
// responses + identical request -> identical output. The cross-scope isolation test pins
// this with a spy port that records every listByScope call.

import type {
  MemoryEdge,
  MemoryId,
  MemoryRecord,
  MemoryScope,
} from "@oscharko-dev/keiko-contracts/memory";

import { assembleContextBlock } from "./context.js";
import { DEFAULT_MMR_LAMBDA, reorderByMmr } from "./diversity.js";
import { RetrievalError } from "./errors.js";
import { tokenize } from "./relevance.js";
import { rankMemories, type RankMemoriesQuery } from "./ranking.js";
import { isMemorySuppressed } from "./suppression.js";
import {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_LIST_BY_SCOPE_MAX_RESULTS,
  DEFAULT_MAX_INCLUDED,
  DEFAULT_RANKING_WEIGHTS,
  DEFAULT_SEMANTIC_MIN_SCORE,
  DEFAULT_STALE_CONFIDENCE_THRESHOLD,
  type IncludedMemory,
  type MemoryQueryPort,
  type MemoryRetrievalRequest,
  type MemoryRetrievalResult,
  type OmittedMemory,
  type RankingWeights,
} from "./types.js";

interface ResolvedRequest {
  readonly budgetTokens: number;
  readonly maxIncluded: number;
  readonly weights: RankingWeights;
  readonly semanticMinScore: number;
  readonly staleConfidenceThreshold: number;
}

function emptyResult(request: MemoryRetrievalRequest, budgetTokens: number): MemoryRetrievalResult {
  return {
    contextBlock: {
      text: "",
      memories: [],
    },
    included: [],
    omitted: [],
    budget: {
      tokens: budgetTokens,
      used: 0,
    },
    request,
  };
}

function resolveWeights(request: MemoryRetrievalRequest): RankingWeights {
  return {
    relevance: request.relevanceWeight ?? DEFAULT_RANKING_WEIGHTS.relevance,
    recency: request.recencyWeight ?? DEFAULT_RANKING_WEIGHTS.recency,
    confidence: request.confidenceWeight ?? DEFAULT_RANKING_WEIGHTS.confidence,
    pinned: request.pinnedBoost ?? DEFAULT_RANKING_WEIGHTS.pinned,
    correction: request.correctionBoost ?? DEFAULT_RANKING_WEIGHTS.correction,
    graph: request.graphProximityBoost ?? DEFAULT_RANKING_WEIGHTS.graph,
    semantic: request.semanticWeight ?? DEFAULT_RANKING_WEIGHTS.semantic,
    strength: request.strengthWeight ?? DEFAULT_RANKING_WEIGHTS.strength,
    importance: request.importanceWeight ?? DEFAULT_RANKING_WEIGHTS.importance,
  };
}

function assertNonNegativeWeights(weights: RankingWeights): void {
  for (const [name, value] of Object.entries(weights) as readonly [string, number][]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RetrievalError(
        "invalid-weight",
        `weight ${name} must be a finite number >= 0 (got ${String(value)})`,
      );
    }
  }
}

function assertNonNegativeBudget(budgetTokens: number, maxIncluded: number): void {
  if (!Number.isFinite(budgetTokens) || !Number.isInteger(budgetTokens) || budgetTokens < 0) {
    throw new RetrievalError(
      "invalid-budget",
      `budgetTokens must be a finite integer >= 0 (got ${String(budgetTokens)})`,
    );
  }
  if (!Number.isFinite(maxIncluded) || !Number.isInteger(maxIncluded) || maxIncluded < 0) {
    throw new RetrievalError(
      "invalid-budget",
      `maxIncluded must be a finite integer >= 0 (got ${String(maxIncluded)})`,
    );
  }
}

function assertUnitThreshold(name: string, value: number): void {
  if (Number.isFinite(value) && value >= 0 && value <= 1) {
    return;
  }
  throw new RetrievalError(
    "invalid-threshold",
    `${name} must be a finite number in [0, 1] (got ${String(value)})`,
  );
}

function validateAndResolve(request: MemoryRetrievalRequest): ResolvedRequest {
  if (request.scopes.length === 0) {
    throw new RetrievalError("empty-scopes", "request.scopes must contain at least one scope");
  }
  const budgetTokens = request.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const maxIncluded = request.maxIncluded ?? DEFAULT_MAX_INCLUDED;
  assertNonNegativeBudget(budgetTokens, maxIncluded);
  const weights = resolveWeights(request);
  assertNonNegativeWeights(weights);
  const staleConfidenceThreshold =
    request.staleConfidenceThreshold ?? DEFAULT_STALE_CONFIDENCE_THRESHOLD;
  assertUnitThreshold("staleConfidenceThreshold", staleConfidenceThreshold);
  const semanticMinScore = request.semanticMinScore ?? DEFAULT_SEMANTIC_MIN_SCORE;
  assertUnitThreshold("semanticMinScore", semanticMinScore);
  return {
    budgetTokens,
    maxIncluded,
    weights,
    semanticMinScore,
    staleConfidenceThreshold,
  };
}

function fetchScoped(
  port: MemoryQueryPort,
  scopes: readonly MemoryScope[],
): readonly MemoryRecord[] {
  const all: MemoryRecord[] = [];
  for (const scope of scopes) {
    try {
      const batch = port.listByScope(scope, {
        includeForgotten: true,
        includeArchived: true,
        includeExpired: true,
        maxResults: DEFAULT_LIST_BY_SCOPE_MAX_RESULTS,
      });
      for (const r of batch) all.push(r);
    } catch (cause) {
      throw new RetrievalError("port-failure", `listByScope threw for scope.kind=${scope.kind}`, {
        cause,
      });
    }
  }
  return all;
}

function dedupeById(records: readonly MemoryRecord[]): readonly MemoryRecord[] {
  const seen = new Set<MemoryId>();
  const out: MemoryRecord[] = [];
  for (const r of records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

interface FilterStep {
  readonly candidates: readonly MemoryRecord[];
  readonly omitted: readonly OmittedMemory[];
}

function applyFilters(
  records: readonly MemoryRecord[],
  request: MemoryRetrievalRequest,
  resolved: ResolvedRequest,
): FilterStep {
  const typeFilter = request.types;
  const candidates: MemoryRecord[] = [];
  const omitted: OmittedMemory[] = [];
  for (const r of records) {
    if (typeFilter !== undefined && !typeFilter.includes(r.type)) {
      omitted.push({ memoryId: r.id, reason: "type-filtered" });
      continue;
    }
    if (r.status === "superseded" && request.includeSuperseded !== true) {
      omitted.push({
        memoryId: r.id,
        reason: "suppressed-by-status",
        suppressionDetail: "superseded",
      });
      continue;
    }
    const sup = isMemorySuppressed(r, request.nowMs, resolved.staleConfidenceThreshold);
    if (sup.suppressed) {
      // sup.reason is optional on SuppressionResult; under exactOptionalPropertyTypes we
      // must conditionally add the field so we never write `suppressionDetail: undefined`.
      omitted.push(
        sup.reason === undefined
          ? { memoryId: r.id, reason: "suppressed-by-status" }
          : { memoryId: r.id, reason: "suppressed-by-status", suppressionDetail: sup.reason },
      );
      continue;
    }
    candidates.push(r);
  }
  return { candidates, omitted };
}

function buildEdgesIndex(
  port: MemoryQueryPort,
  candidates: readonly MemoryRecord[],
): ReadonlyMap<MemoryId, readonly MemoryEdge[]> | undefined {
  if (port.listEdgesForMemories !== undefined) {
    return buildBatchedEdgesIndex(port, candidates);
  }
  if (port.listOutgoingEdges === undefined && port.listIncomingEdges === undefined)
    return undefined;
  return buildPerCandidateEdgesIndex(port, candidates);
}

function buildBatchedEdgesIndex(
  port: MemoryQueryPort,
  candidates: readonly MemoryRecord[],
): ReadonlyMap<MemoryId, readonly MemoryEdge[]> {
  try {
    const ids = candidates.map((candidate) => candidate.id);
    const batched = port.listEdgesForMemories?.(ids) ?? new Map<MemoryId, readonly MemoryEdge[]>();
    return nonEmptyEdgesForCandidates(candidates, batched);
  } catch (cause) {
    throw new RetrievalError("port-failure", "listEdgesForMemories threw", { cause });
  }
}

function nonEmptyEdgesForCandidates(
  candidates: readonly MemoryRecord[],
  batched: ReadonlyMap<MemoryId, readonly MemoryEdge[]>,
): ReadonlyMap<MemoryId, readonly MemoryEdge[]> {
  const map = new Map<MemoryId, readonly MemoryEdge[]>();
  for (const candidate of candidates) {
    const edges = dedupeEdges(batched.get(candidate.id) ?? []);
    if (edges.length > 0) map.set(candidate.id, edges);
  }
  return map;
}

function buildPerCandidateEdgesIndex(
  port: MemoryQueryPort,
  candidates: readonly MemoryRecord[],
): ReadonlyMap<MemoryId, readonly MemoryEdge[]> {
  const map = new Map<MemoryId, readonly MemoryEdge[]>();
  for (const candidate of candidates) {
    try {
      // Call through the port object directly so `this` binds correctly on a class-based
      // port implementation (avoids the @typescript-eslint/unbound-method trap).
      const edges = dedupeEdges([
        ...(port.listOutgoingEdges?.(candidate.id) ?? []),
        ...(port.listIncomingEdges?.(candidate.id) ?? []),
      ]);
      if (edges.length > 0) map.set(candidate.id, edges);
    } catch (cause) {
      throw new RetrievalError("port-failure", `listEdges threw for ${candidate.id}`, { cause });
    }
  }
  return map;
}

function dedupeEdges(edges: readonly MemoryEdge[]): readonly MemoryEdge[] {
  const seen = new Set<string>();
  const out: MemoryEdge[] = [];
  for (const edge of edges) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    out.push(edge);
  }
  return out;
}

function hasPositiveSemanticSignal(semanticById: MemoryRetrievalRequest["semanticById"]): boolean {
  if (semanticById === undefined) return false;
  for (const score of semanticById.values()) {
    if (score > 0) return true;
  }
  return false;
}

function semanticScoresAboveFloor(
  semanticById: MemoryRetrievalRequest["semanticById"],
  minScore: number,
): ReadonlyMap<MemoryId, number> | undefined {
  if (semanticById === undefined) return undefined;
  const filtered = new Map<MemoryId, number>();
  for (const [id, score] of semanticById) {
    if (score >= minScore) filtered.set(id, score);
  }
  return filtered;
}

function hasQuerySignal(request: MemoryRetrievalRequest): boolean {
  const lexicalSignal = request.queryText !== undefined && tokenize(request.queryText).length > 0;
  return lexicalSignal || hasPositiveSemanticSignal(request.semanticById);
}

interface ThresholdStep {
  readonly ranked: readonly IncludedMemory[];
  readonly omitted: readonly OmittedMemory[];
}

function applyRelevanceFloor(
  ranked: readonly IncludedMemory[],
  request: MemoryRetrievalRequest,
): ThresholdStep {
  if (!hasQuerySignal(request)) {
    return { ranked, omitted: [] };
  }
  const kept: IncludedMemory[] = [];
  const omitted: OmittedMemory[] = [];
  for (const entry of ranked) {
    if (
      entry.subscores.relevance === 0 &&
      entry.subscores.semantic === 0 &&
      entry.subscores.graph === 0
    ) {
      omitted.push({ memoryId: entry.memoryId, reason: "below-threshold" });
      continue;
    }
    kept.push(entry);
  }
  return { ranked: kept, omitted };
}

function requestWithSemanticFloor(
  request: MemoryRetrievalRequest,
  semanticById: ReadonlyMap<MemoryId, number> | undefined,
  semanticMinScore: number,
): MemoryRetrievalRequest {
  return semanticById === undefined ? request : { ...request, semanticById, semanticMinScore };
}

function buildRankQuery(
  request: MemoryRetrievalRequest,
  resolved: ResolvedRequest,
  semanticById: ReadonlyMap<MemoryId, number> | undefined,
): RankMemoriesQuery {
  return {
    nowMs: request.nowMs,
    weights: resolved.weights,
    ...(request.queryText === undefined ? {} : { queryText: request.queryText }),
    ...(semanticById === undefined ? {} : { semanticById }),
    ...(request.strengthById === undefined ? {} : { strengthById: request.strengthById }),
    ...(request.fusion === undefined ? {} : { fusion: request.fusion }),
  };
}

function reorderSelection(
  ranked: readonly IncludedMemory[],
  request: MemoryRetrievalRequest,
): readonly IncludedMemory[] {
  if (request.embeddingById === undefined) return ranked;
  return reorderByMmr(ranked, request.embeddingById, request.mmrLambda ?? DEFAULT_MMR_LAMBDA);
}

export function retrieveMemoryContext(
  request: MemoryRetrievalRequest,
  port: MemoryQueryPort,
): MemoryRetrievalResult {
  const resolved = validateAndResolve(request);
  if (resolved.maxIncluded === 0 || resolved.budgetTokens === 0) {
    return emptyResult(request, resolved.budgetTokens);
  }
  const fetched = fetchScoped(port, request.scopes);
  const deduped = dedupeById(fetched);
  const filtered = applyFilters(deduped, request, resolved);
  const edgesByMemory = buildEdgesIndex(port, filtered.candidates);
  const semanticById = semanticScoresAboveFloor(request.semanticById, resolved.semanticMinScore);
  const relevanceRequest = requestWithSemanticFloor(request, semanticById, resolved.semanticMinScore);
  const rankQuery = buildRankQuery(request, resolved, semanticById);
  const ranked = rankMemories(
    filtered.candidates,
    rankQuery,
    edgesByMemory === undefined ? {} : { edgesByMemory },
  );
  const thresholded = applyRelevanceFloor(ranked, relevanceRequest);
  // MMR diversity (#204, O-F3): re-order the ranked candidates so near-duplicates do not all consume
  // the token budget. Inert (byte-identical greedy-by-rank) when the caller supplies no embeddings.
  const selectionOrder = reorderSelection(thresholded.ranked, request);
  const assembled = assembleContextBlock(selectionOrder, filtered.candidates, {
    budgetTokens: resolved.budgetTokens,
    maxIncluded: resolved.maxIncluded,
  });
  return {
    ...assembled,
    omitted: [...filtered.omitted, ...thresholded.omitted, ...assembled.omitted],
    request,
  };
}
