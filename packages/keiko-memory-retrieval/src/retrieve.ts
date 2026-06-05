// Top-level scoped-memory retrieval orchestrator.
//
// Cross-scope isolation is structural: the function ONLY iterates `request.scopes` when
// calling port.listByScope. A caller cannot trick this layer into surfacing records from
// a scope it did not authorise because no other code path reaches the port.
//
// Pipeline:
//   1. Validate request (non-empty scopes, non-negative budget + weights).
//   2. For each scope in request.scopes -> port.listByScope(scope, {maxResults}).
//      Wrap any port throw as RetrievalError('port-failure', cause: original).
//   3. Dedupe by memoryId (a record reachable from multiple scopes appears once).
//   4. Apply suppression (status / validity / confidence) -> "suppressed-by-status".
//      Apply type filter when request.types is set -> "type-filtered".
//   5. Build an edges-by-memory map for the candidate set if the port exposes
//      listOutgoingEdges (bounded fetch — we only ask about the candidates we still hold).
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
import { RetrievalError } from "./errors.js";
import { rankMemories } from "./ranking.js";
import { isMemorySuppressed } from "./suppression.js";
import {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_LIST_BY_SCOPE_MAX_RESULTS,
  DEFAULT_MAX_INCLUDED,
  DEFAULT_RANKING_WEIGHTS,
  DEFAULT_STALE_CONFIDENCE_THRESHOLD,
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
  readonly staleConfidenceThreshold: number;
}

function resolveWeights(request: MemoryRetrievalRequest): RankingWeights {
  return {
    relevance: request.relevanceWeight ?? DEFAULT_RANKING_WEIGHTS.relevance,
    recency: request.recencyWeight ?? DEFAULT_RANKING_WEIGHTS.recency,
    confidence: request.confidenceWeight ?? DEFAULT_RANKING_WEIGHTS.confidence,
    pinned: request.pinnedBoost ?? DEFAULT_RANKING_WEIGHTS.pinned,
    correction: request.correctionBoost ?? DEFAULT_RANKING_WEIGHTS.correction,
    graph: request.graphProximityBoost ?? DEFAULT_RANKING_WEIGHTS.graph,
  };
}

function assertNonNegativeWeights(weights: RankingWeights): void {
  for (const [name, value] of Object.entries(weights) as readonly [string, number][]) {
    if (value < 0) {
      throw new RetrievalError(
        "invalid-weight",
        `weight ${name} must be >= 0 (got ${String(value)})`,
      );
    }
  }
}

function assertNonNegativeBudget(budgetTokens: number, maxIncluded: number): void {
  if (budgetTokens < 0) {
    throw new RetrievalError(
      "invalid-budget",
      `budgetTokens must be >= 0 (got ${String(budgetTokens)})`,
    );
  }
  if (maxIncluded < 0) {
    throw new RetrievalError(
      "invalid-budget",
      `maxIncluded must be >= 0 (got ${String(maxIncluded)})`,
    );
  }
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
  return {
    budgetTokens,
    maxIncluded,
    weights,
    staleConfidenceThreshold:
      request.staleConfidenceThreshold ?? DEFAULT_STALE_CONFIDENCE_THRESHOLD,
  };
}

function fetchScoped(
  port: MemoryQueryPort,
  scopes: readonly MemoryScope[],
): readonly MemoryRecord[] {
  const all: MemoryRecord[] = [];
  for (const scope of scopes) {
    try {
      const batch = port.listByScope(scope, { maxResults: DEFAULT_LIST_BY_SCOPE_MAX_RESULTS });
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
  if (port.listOutgoingEdges === undefined) return undefined;
  const map = new Map<MemoryId, readonly MemoryEdge[]>();
  for (const c of candidates) {
    try {
      // Call through the port object directly so `this` binds correctly on a class-based
      // port implementation (avoids the @typescript-eslint/unbound-method trap).
      const edges = port.listOutgoingEdges(c.id);
      if (edges.length > 0) map.set(c.id, edges);
    } catch (cause) {
      throw new RetrievalError("port-failure", `listOutgoingEdges threw for ${c.id}`, { cause });
    }
  }
  return map;
}

export function retrieveMemoryContext(
  request: MemoryRetrievalRequest,
  port: MemoryQueryPort,
): MemoryRetrievalResult {
  const resolved = validateAndResolve(request);
  const fetched = fetchScoped(port, request.scopes);
  const deduped = dedupeById(fetched);
  const filtered = applyFilters(deduped, request, resolved);
  const edgesByMemory = buildEdgesIndex(port, filtered.candidates);
  const rankQuery =
    request.queryText === undefined
      ? { nowMs: request.nowMs, weights: resolved.weights }
      : { queryText: request.queryText, nowMs: request.nowMs, weights: resolved.weights };
  const ranked = rankMemories(
    filtered.candidates,
    rankQuery,
    edgesByMemory === undefined ? {} : { edgesByMemory },
  );
  const assembled = assembleContextBlock(ranked, filtered.candidates, {
    budgetTokens: resolved.budgetTokens,
    maxIncluded: resolved.maxIncluded,
  });
  return {
    ...assembled,
    omitted: [...filtered.omitted, ...assembled.omitted],
    request,
  };
}
