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
import { sharedInformativeWordCountInText, tokenize } from "./relevance.js";
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
  // #2906 KEIKO-0574 — nowMs is a REQUIRED field on MemoryRetrievalRequest but was never
  // validated here. exponentialDecay's `ageMs <= 0` guard is false for NaN, so an invalid
  // clock silently produces a NaN decay score that propagates into the ranking sort
  // comparator instead of failing closed at the boundary.
  // #2906 round-3 review — finiteness alone still accepted a negative epoch (e.g. nowMs = -1):
  // every normal positive validUntil then reads as "in the future" and every record reads as
  // future/fresh for recency, silently re-admitting already-expired memories. Require a finite,
  // non-negative timestamp, matching the same "finite non-negative number" contract every other
  // durable memory timestamp is held to (see isFiniteNonNegativeNumber's callers across
  // keiko-contracts's memory-*-validation modules).
  if (!Number.isFinite(request.nowMs) || request.nowMs < 0) {
    throw new RetrievalError(
      "invalid-clock",
      `nowMs must be a finite non-negative number (got ${String(request.nowMs)})`,
    );
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
  // #2906 KEIKO-0696 — mmrLambda is optional (defaults to DEFAULT_MMR_LAMBDA at the read site)
  // but must be a unit threshold when supplied so NaN cannot silently degrade reorderByMmr
  // to always-pick-first-remaining. Mirrors the staleConfidenceThreshold/semanticMinScore
  // pattern above.
  if (request.mmrLambda !== undefined) {
    assertUnitThreshold("mmrLambda", request.mmrLambda);
  }
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

function strictMinSharedWords(request: MemoryRetrievalRequest): number {
  const value = request.lexicalMinSharedWords ?? 1;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RetrievalError(
      "invalid-threshold",
      `lexicalMinSharedWords must be a positive integer, got ${String(value)}`,
    );
  }
  return value;
}

// A correction is still about what it corrected: "Ab jetzt bevorzuge ich Listen." answers "Wie
// sollst du mir Zahlen zeigen?" because the fact it superseded spoke of numbers (lab 2026-11-11,
// update-lists-de). Under the strict floor a memory therefore also shares the informative words of
// the facts it superseded, up to this many steps back. Only the match reads them; a superseded fact
// never reaches the answer, and a forgotten one contributes nothing.
const SUPERSEDED_WORD_DEPTH = 4;

interface Lineage {
  readonly origin: MemoryId;
  readonly record: MemoryRecord;
}

function supersededPredecessors(
  lineage: Lineage,
  edges: ReadonlyMap<MemoryId, readonly MemoryEdge[]>,
  byId: ReadonlyMap<MemoryId, MemoryRecord>,
): readonly Lineage[] {
  return (edges.get(lineage.record.id) ?? [])
    .filter((edge) => edge.kind === "supersedes" && edge.toMemoryId === lineage.record.id)
    .map((edge) => byId.get(edge.fromMemoryId))
    .filter((record): record is MemoryRecord => record?.status === "superseded")
    .map((record) => ({ origin: lineage.origin, record }));
}

// The candidates' own edges are already fetched for ranking; only older generations cost a fetch.
function supersededBodies(
  port: MemoryQueryPort,
  candidates: readonly MemoryRecord[],
  fetched: readonly MemoryRecord[],
  candidateEdges: ReadonlyMap<MemoryId, readonly MemoryEdge[]> | undefined,
): ReadonlyMap<MemoryId, readonly string[]> {
  const byId = new Map(fetched.map((record) => [record.id, record]));
  const bodies = new Map<MemoryId, string[]>();
  const seen = new Set(candidates.map((record) => record.id));
  let frontier: readonly Lineage[] = candidates.map((record) => ({ origin: record.id, record }));
  for (let depth = 0; depth < SUPERSEDED_WORD_DEPTH && frontier.length > 0; depth += 1) {
    const edges =
      depth === 0
        ? candidateEdges
        : buildEdgesIndex(
            port,
            frontier.map((lineage) => lineage.record),
          );
    if (edges === undefined) break;
    const next = frontier
      .flatMap((lineage) => supersededPredecessors(lineage, edges, byId))
      .filter((lineage) => !seen.has(lineage.record.id));
    for (const { origin, record } of next) {
      seen.add(record.id);
      bodies.set(origin, [...(bodies.get(origin) ?? []), record.body]);
    }
    frontier = next;
  }
  return bodies;
}

interface StrictFloorInput {
  readonly request: MemoryRetrievalRequest;
  readonly candidates: ReadonlyMap<MemoryId, MemoryRecord>;
  readonly superseded: ReadonlyMap<MemoryId, readonly string[]>;
}

function sharedWords(input: StrictFloorInput, memoryId: MemoryId): number {
  const record = input.candidates.get(memoryId);
  if (record === undefined) return 0;
  const texts = [record.body, ...(input.superseded.get(memoryId) ?? [])];
  return Math.max(
    ...texts.map((text) => sharedInformativeWordCountInText(input.request.queryText, text)),
  );
}

// The strict floor of #4228: only a memory the question is about is retrieved. The standing
// profile carries standing facts to every answer, so no record-derived signal is exempt here, and
// a profile fact needs the question's own words (see standingProfileIds).
function applyStrictRelevanceFloor(
  ranked: readonly IncludedMemory[],
  input: StrictFloorInput,
): ThresholdStep {
  const minShared = strictMinSharedWords(input.request);
  const profileIds = input.request.standingProfileIds;
  const kept: IncludedMemory[] = [];
  const omitted: OmittedMemory[] = [];
  for (const entry of ranked) {
    const semantic = entry.subscores.semantic > 0 && profileIds?.has(entry.memoryId) !== true;
    if (semantic || sharedWords(input, entry.memoryId) >= minShared) kept.push(entry);
    else omitted.push({ memoryId: entry.memoryId, reason: "below-threshold" });
  }
  return { ranked: kept, omitted };
}

function applyRelevanceFloor(
  ranked: readonly IncludedMemory[],
  request: MemoryRetrievalRequest,
  candidates: readonly MemoryRecord[],
  superseded: () => ReadonlyMap<MemoryId, readonly string[]>,
): ThresholdStep {
  if (request.strictRelevanceFloor === true) {
    return applyStrictRelevanceFloor(ranked, {
      request,
      candidates: new Map(candidates.map((record) => [record.id, record])),
      superseded: superseded(),
    });
  }
  if (!hasQuerySignal(request)) {
    return { ranked, omitted: [] };
  }
  const kept: IncludedMemory[] = [];
  const omitted: OmittedMemory[] = [];
  for (const entry of ranked) {
    // relevance/semantic/graph are the query-derived subscores, so a zero across all three means
    // "this turn does not touch that memory". pinned and correction are NOT query-derived — the
    // ranker computes them from the record alone precisely so the user's standing rules and
    // accepted corrections apply regardless of wording — so they are exempt from a floor that
    // only reasons about query overlap. Exemption is by subscore, not by MemoryType: `pinned` is
    // a boolean flag that can elevate any type (keiko-contracts/memory.ts), and `correction`
    // covers both type "correction" and sourceKind "accepted-correction".
    if (entry.subscores.pinned > 0 || entry.subscores.correction > 0) {
      kept.push(entry);
      continue;
    }
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
  const relevanceRequest = requestWithSemanticFloor(
    request,
    semanticById,
    resolved.semanticMinScore,
  );
  const rankQuery = buildRankQuery(request, resolved, semanticById);
  const ranked = rankMemories(
    filtered.candidates,
    rankQuery,
    edgesByMemory === undefined ? {} : { edgesByMemory },
  );
  const thresholded = applyRelevanceFloor(ranked, relevanceRequest, filtered.candidates, () =>
    supersededBodies(port, filtered.candidates, deduped, edgesByMemory),
  );
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
