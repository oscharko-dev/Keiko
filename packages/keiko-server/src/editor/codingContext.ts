// Governed coding-context assembly orchestrator (Issue #1211, ADR-0042 D6). `assembleCodingContext`
// composes the existing retrieval seams into a single bounded, redacted CodingContextPack for an
// editor-originated request. Provider eligibility and the byte budget are purpose-driven: the
// keystroke-sensitive purposes (inline, diagnostic) run only the cheap deterministic repo-search and
// EXCLUDE the embedding-cost providers (Local Knowledge, memory), which are recorded as a
// `too-expensive` omission rather than silently skipped. The pack is content-bearing and stays
// server-internal; the BFF route projects it to a content-free wire pack before it leaves the process.
// Cancellation is cooperative: the AbortSignal is checked between providers and passed into the
// embedding retrieval path.

import {
  CODING_CONTEXT_BUDGETS,
  CODING_CONTEXT_SCHEMA_VERSION,
  embeddingProvidersAllowed,
  tierForCodingContextSource,
  type CodingContextExcerpt,
  type CodingContextOmission,
  type CodingContextPack,
  type CodingContextRequest,
} from "@oscharko-dev/keiko-contracts";
import { selectScoredTextByByteBudget } from "@oscharko-dev/keiko-workspace";
import type { UiHandlerDeps } from "../deps.js";
import {
  runLocalKnowledgeProvider,
  runMemoryProvider,
  runRepoSearchProvider,
  type ProviderContext,
  type ProviderOutcome,
  type RawExcerpt,
} from "./codingContextProviders.js";

const DEFERRED_CONTEXT_PROVIDERS: readonly CodingContextOmission["sourceKind"][] = [
  "connected-context",
  "quality-intelligence",
  "workflow-context",
];

export interface AssembleCodingContextDeps {
  readonly deps: UiHandlerDeps;
  readonly realRoot: string;
  readonly signal: AbortSignal;
  readonly nowMs: number;
}

// Greedy byte-budget packer: highest score first, ties broken by id for determinism, dropped when the
// pack byte budget is exhausted. Reuses the keiko-workspace context-pack budget selector.
function packExcerpts(
  candidates: readonly RawExcerpt[],
  budgetBytes: number,
): { excerpts: CodingContextExcerpt[]; usedBytes: number; droppedForBudget: number } {
  const packed = selectScoredTextByByteBudget(candidates, budgetBytes, {
    id: (candidate) => candidate.id,
    score: (candidate) => candidate.score,
    text: (candidate) => candidate.text,
  });
  return {
    excerpts: packed.selected.map(({ item: candidate, byteCount }, rank) => ({
      citation: {
        sourceKind: candidate.sourceKind,
        sourceTier: tierForCodingContextSource(candidate.sourceKind),
        id: candidate.id,
        score: candidate.score,
        rank,
        citationRef: candidate.citationRef,
        byteCount,
        truncated: candidate.truncated,
      },
      text: candidate.text,
    })),
    usedBytes: packed.usedBytes,
    droppedForBudget: packed.droppedForBudget,
  };
}

export async function assembleCodingContext(
  request: CodingContextRequest,
  context: AssembleCodingContextDeps,
): Promise<CodingContextPack> {
  const budget = CODING_CONTEXT_BUDGETS[request.purpose];
  const providerCtx: ProviderContext = {
    deps: context.deps,
    realRoot: context.realRoot,
    signal: context.signal,
    maxBytesPerExcerpt: budget.maxBytesPerSource,
    nowMs: context.nowMs,
  };

  const candidates: RawExcerpt[] = [];
  const omissions: CodingContextOmission[] = [];

  const repo = await runRepoSearchProvider(providerCtx, {
    documentPath: request.documentPath,
    symbol: request.symbol,
    queryText: request.queryText,
    changedFiles: request.changedFiles,
  });
  collect(repo, candidates, omissions);

  if (embeddingProvidersAllowed(request.purpose)) {
    if (!context.signal.aborted) {
      const knowledge = await runLocalKnowledgeProvider(providerCtx, {
        queryText: request.queryText,
        capsuleId: request.capsuleId,
        capsuleSetId: request.capsuleSetId,
      });
      collect(knowledge, candidates, omissions);
    }
    if (!context.signal.aborted) {
      const memory = await runMemoryProvider(providerCtx, { queryText: request.queryText });
      collect(memory, candidates, omissions);
    }
  } else {
    // Per-keystroke exclusion (AC3): embedding-cost providers are not silently skipped; they are
    // recorded as a content-free `too-expensive` omission so the exclusion is auditable.
    omissions.push({ sourceKind: "local-knowledge", reason: "too-expensive" });
    omissions.push({ sourceKind: "memory", reason: "too-expensive" });
  }

  collectDeferredProviderOmissions(omissions);
  const packed = packExcerpts(candidates, budget.budgetBytes);
  return {
    schemaVersion: CODING_CONTEXT_SCHEMA_VERSION,
    purpose: request.purpose,
    excerpts: packed.excerpts,
    usedBytes: packed.usedBytes,
    budgetBytes: budget.budgetBytes,
    droppedForBudget: packed.droppedForBudget,
    omissions,
  };
}

function collect(
  outcome: ProviderOutcome,
  candidates: RawExcerpt[],
  omissions: CodingContextOmission[],
): void {
  candidates.push(...outcome.excerpts);
  if (outcome.omission !== undefined) {
    omissions.push(outcome.omission);
  }
}

function collectDeferredProviderOmissions(omissions: CodingContextOmission[]): void {
  const seen = new Set(omissions.map((entry) => entry.sourceKind));
  for (const sourceKind of DEFERRED_CONTEXT_PROVIDERS) {
    if (!seen.has(sourceKind)) {
      omissions.push({ sourceKind, reason: "unavailable" });
    }
  }
}
