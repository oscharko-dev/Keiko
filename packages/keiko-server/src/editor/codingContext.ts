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
import type { UiHandlerDeps } from "../deps.js";
import {
  runLocalKnowledgeProvider,
  runMemoryProvider,
  runRepoSearchProvider,
  type ProviderContext,
  type ProviderOutcome,
  type RawExcerpt,
} from "./codingContextProviders.js";

export interface AssembleCodingContextDeps {
  readonly deps: UiHandlerDeps;
  readonly realRoot: string;
  readonly signal: AbortSignal;
  readonly nowMs: number;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

// Greedy byte-budget packer: highest score first, ties broken by id for determinism, dropped when the
// pack byte budget is exhausted. Mirrors keiko-workspace contextPack assembly.
function packExcerpts(
  candidates: readonly RawExcerpt[],
  budgetBytes: number,
): { excerpts: CodingContextExcerpt[]; usedBytes: number; droppedForBudget: number } {
  const ordered = [...candidates].sort(
    (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const excerpts: CodingContextExcerpt[] = [];
  let usedBytes = 0;
  let droppedForBudget = 0;
  for (const candidate of ordered) {
    const byteCount = utf8Bytes(candidate.text);
    if (usedBytes + byteCount > budgetBytes) {
      droppedForBudget += 1;
      continue;
    }
    excerpts.push({
      citation: {
        sourceKind: candidate.sourceKind,
        sourceTier: tierForCodingContextSource(candidate.sourceKind),
        id: candidate.id,
        score: candidate.score,
        rank: excerpts.length,
        citationRef: candidate.citationRef,
        byteCount,
        truncated: candidate.truncated,
      },
      text: candidate.text,
    });
    usedBytes += byteCount;
  }
  return { excerpts, usedBytes, droppedForBudget };
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
