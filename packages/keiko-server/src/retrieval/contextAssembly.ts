// Pillar-neutral retrieval-context assembly (Issue #2570, ADR-0152 D6). Providers collect already
// redacted, byte-bounded candidates; this module owns deterministic provider order, auditable
// omission handling, the total budget clamp, and final score/id packing through keiko-workspace.

import {
  RETRIEVAL_CONTEXT_SCHEMA_VERSION,
  type RetrievalContextBudget,
  type RetrievalContextExcerpt,
  type RetrievalContextOmission,
  type RetrievalContextPack,
  type RetrievalContextSourceKind,
  type RetrievalContextSourceTier,
  type RetrievalPurpose,
} from "@oscharko-dev/keiko-contracts";
import { selectScoredTextByByteBudget } from "@oscharko-dev/keiko-workspace";

export interface RetrievalContextCandidate<
  SourceKind extends RetrievalContextSourceKind = RetrievalContextSourceKind,
> {
  readonly sourceKind: SourceKind;
  readonly id: string;
  readonly score: number;
  readonly citationRef: string | undefined;
  readonly text: string;
  readonly truncated: boolean;
}

export interface RetrievalContextProviderOutcome<
  SourceKind extends RetrievalContextSourceKind = RetrievalContextSourceKind,
> {
  readonly excerpts: readonly RetrievalContextCandidate<SourceKind>[];
  readonly omission: RetrievalContextOmission<SourceKind> | undefined;
}

export interface RetrievalContextProvider<
  SourceKind extends RetrievalContextSourceKind = RetrievalContextSourceKind,
> {
  readonly sourceKind: SourceKind;
  readonly order: number;
  readonly requiresEmbedding: boolean;
  readonly runWhenAborted?: boolean | undefined;
  readonly run?:
    | ((
        budget: RetrievalContextBudget,
      ) =>
        | RetrievalContextProviderOutcome<SourceKind>
        | Promise<RetrievalContextProviderOutcome<SourceKind>>)
    | undefined;
}

export interface AssembleRetrievalContextInput<
  SourceKind extends RetrievalContextSourceKind,
  Purpose extends RetrievalPurpose,
  SourceTier extends RetrievalContextSourceTier = RetrievalContextSourceTier,
> {
  readonly purpose: Purpose;
  readonly budget: RetrievalContextBudget;
  readonly requestedBudgetBytes?: number | undefined;
  readonly allowEmbeddingProviders: boolean;
  readonly signal: AbortSignal;
  readonly providers: readonly RetrievalContextProvider<SourceKind>[];
  readonly tierForSourceKind: (kind: SourceKind) => SourceTier;
}

interface AssemblyState<SourceKind extends RetrievalContextSourceKind> {
  readonly candidates: RetrievalContextCandidate<SourceKind>[];
  readonly omissions: RetrievalContextOmission<SourceKind>[];
}

function normalizedRequestedBudget(requestedBudgetBytes: number): number {
  return Number.isFinite(requestedBudgetBytes) ? Math.max(0, Math.trunc(requestedBudgetBytes)) : 0;
}

export function effectiveRetrievalContextBudget(
  baseBudget: RetrievalContextBudget,
  requestedBudgetBytes: number | undefined,
): RetrievalContextBudget {
  const requested =
    requestedBudgetBytes === undefined
      ? baseBudget.budgetBytes
      : normalizedRequestedBudget(requestedBudgetBytes);
  const budgetBytes = Math.min(baseBudget.budgetBytes, requested);
  return {
    ...baseBudget,
    budgetBytes,
    maxBytesPerSource: Math.min(baseBudget.maxBytesPerSource, budgetBytes),
  };
}

function orderedProviders<SourceKind extends RetrievalContextSourceKind>(
  providers: readonly RetrievalContextProvider<SourceKind>[],
): readonly RetrievalContextProvider<SourceKind>[] {
  return [...providers].sort(
    (left, right) => left.order - right.order || left.sourceKind.localeCompare(right.sourceKind),
  );
}

function collectOutcome<SourceKind extends RetrievalContextSourceKind>(
  outcome: RetrievalContextProviderOutcome<SourceKind>,
  state: AssemblyState<SourceKind>,
): void {
  state.candidates.push(...outcome.excerpts);
  if (outcome.omission !== undefined) state.omissions.push(outcome.omission);
}

async function collectProvider<SourceKind extends RetrievalContextSourceKind>(
  provider: RetrievalContextProvider<SourceKind>,
  budget: RetrievalContextBudget,
  input: AssembleRetrievalContextInput<SourceKind, RetrievalPurpose>,
  state: AssemblyState<SourceKind>,
): Promise<void> {
  if (provider.requiresEmbedding && !input.allowEmbeddingProviders) {
    state.omissions.push({ sourceKind: provider.sourceKind, reason: "too-expensive" });
    return;
  }
  if (provider.run === undefined) {
    state.omissions.push({ sourceKind: provider.sourceKind, reason: "unavailable" });
    return;
  }
  if (input.signal.aborted && provider.runWhenAborted !== true) return;
  collectOutcome(await provider.run(budget), state);
}

function packCandidates<
  SourceKind extends RetrievalContextSourceKind,
  SourceTier extends RetrievalContextSourceTier,
>(
  candidates: readonly RetrievalContextCandidate<SourceKind>[],
  budgetBytes: number,
  tierForSourceKind: (kind: SourceKind) => SourceTier,
): {
  readonly excerpts: readonly RetrievalContextExcerpt<SourceKind, SourceTier>[];
  readonly usedBytes: number;
  readonly droppedForBudget: number;
} {
  const packed = selectScoredTextByByteBudget(candidates, budgetBytes, {
    id: (candidate) => candidate.id,
    score: (candidate) => candidate.score,
    text: (candidate) => candidate.text,
  });
  return {
    excerpts: packed.selected.map(({ item: candidate, byteCount }, rank) => ({
      citation: {
        sourceKind: candidate.sourceKind,
        sourceTier: tierForSourceKind(candidate.sourceKind),
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

export async function assembleRetrievalContext<
  SourceKind extends RetrievalContextSourceKind,
  Purpose extends RetrievalPurpose,
  SourceTier extends RetrievalContextSourceTier = RetrievalContextSourceTier,
>(
  input: AssembleRetrievalContextInput<SourceKind, Purpose, SourceTier>,
): Promise<RetrievalContextPack<SourceKind, Purpose, SourceTier>> {
  const budget = effectiveRetrievalContextBudget(input.budget, input.requestedBudgetBytes);
  const state: AssemblyState<SourceKind> = { candidates: [], omissions: [] };
  for (const provider of orderedProviders(input.providers)) {
    await collectProvider(provider, budget, input, state);
  }
  const packed = packCandidates(state.candidates, budget.budgetBytes, input.tierForSourceKind);
  return {
    schemaVersion: RETRIEVAL_CONTEXT_SCHEMA_VERSION,
    purpose: input.purpose,
    excerpts: packed.excerpts,
    usedBytes: packed.usedBytes,
    budgetBytes: budget.budgetBytes,
    droppedForBudget: packed.droppedForBudget,
    omissions: state.omissions,
  };
}
