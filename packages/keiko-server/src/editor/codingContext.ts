// Closed coding-context wrapper over the pillar-neutral assembly pipeline (Issue #2570,
// ADR-0152 D6). Provider behavior and the public assembleCodingContext signature stay unchanged.

import {
  CODING_CONTEXT_BUDGETS,
  embeddingProvidersAllowed,
  tierForCodingContextSource,
  type CodingContextPack,
  type CodingContextRequest,
  type CodingContextSourceKind,
  type RetrievalContextBudget,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import {
  assembleRetrievalContext,
  effectiveRetrievalContextBudget,
  type RetrievalContextProvider,
} from "../retrieval/contextAssembly.js";
import {
  acquireEditorStateContextLease,
  runEditorStateProvider,
  runGitContextProvider,
  runLocalKnowledgeProvider,
  runMemoryProvider,
  runRepoSearchProvider,
  type EditorStateContextLease,
  type GitContextReader,
  type ProviderContext,
} from "./codingContextProviders.js";

const DEFERRED_CONTEXT_PROVIDERS: readonly CodingContextSourceKind[] = [
  "connected-context",
  "quality-intelligence",
  "workflow-context",
];

export interface AssembleCodingContextDeps {
  readonly deps: UiHandlerDeps;
  readonly realRoot: string;
  readonly signal: AbortSignal;
  readonly nowMs: number;
  readonly currentTimeMs?: (() => number) | undefined;
  readonly budgetBytes?: number | undefined;
  readonly allowEmbeddingProviders?: boolean | undefined;
  readonly gitContextReader?: GitContextReader | undefined;
}

function buildProviderContext(
  context: AssembleCodingContextDeps,
  budget: RetrievalContextBudget,
  currentTimeMs: () => number,
): ProviderContext {
  return {
    deps: context.deps,
    realRoot: context.realRoot,
    signal: context.signal,
    maxBytesPerExcerpt: budget.maxBytesPerSource,
    currentTimeMs,
    nowMs: context.nowMs,
    gitContextReader: context.gitContextReader,
  };
}

function repositoryProvider(
  request: CodingContextRequest,
  providerContext: ProviderContext,
): RetrievalContextProvider<CodingContextSourceKind> {
  return {
    sourceKind: "repo-search",
    order: 0,
    requiresEmbedding: false,
    runWhenAborted: true,
    run: () =>
      runRepoSearchProvider(providerContext, {
        documentPath: request.documentPath,
        symbol: request.symbol,
        queryText: request.queryText,
        changedFiles: request.changedFiles,
      }),
  };
}

function sessionProviders(
  request: CodingContextRequest,
  providerContext: ProviderContext,
  lease: EditorStateContextLease | undefined,
): readonly RetrievalContextProvider<CodingContextSourceKind>[] {
  if (request.editorSessionId === undefined) return [];
  const input = { sessionId: request.editorSessionId, lease };
  return [
    {
      sourceKind: "editor-state",
      order: 1,
      requiresEmbedding: false,
      runWhenAborted: true,
      run: () => runEditorStateProvider(providerContext, input),
    },
    {
      sourceKind: "git-context",
      order: 2,
      requiresEmbedding: false,
      runWhenAborted: true,
      run: () => runGitContextProvider(providerContext, input),
    },
  ];
}

function embeddingProviders(
  request: CodingContextRequest,
  providerContext: ProviderContext,
): readonly RetrievalContextProvider<CodingContextSourceKind>[] {
  return [
    {
      sourceKind: "local-knowledge",
      order: 3,
      requiresEmbedding: true,
      run: () =>
        runLocalKnowledgeProvider(providerContext, {
          queryText: request.queryText,
          capsuleId: request.capsuleId,
          capsuleSetId: request.capsuleSetId,
        }),
    },
    {
      sourceKind: "memory",
      order: 4,
      requiresEmbedding: true,
      run: () => runMemoryProvider(providerContext, { queryText: request.queryText }),
    },
  ];
}

function deferredProviders(): readonly RetrievalContextProvider<CodingContextSourceKind>[] {
  return DEFERRED_CONTEXT_PROVIDERS.map((sourceKind, index) => ({
    sourceKind,
    order: 5 + index,
    requiresEmbedding: false,
  }));
}

function codingProviders(
  request: CodingContextRequest,
  providerContext: ProviderContext,
  lease: EditorStateContextLease | undefined,
): readonly RetrievalContextProvider<CodingContextSourceKind>[] {
  return [
    repositoryProvider(request, providerContext),
    ...sessionProviders(request, providerContext, lease),
    ...embeddingProviders(request, providerContext),
    ...deferredProviders(),
  ];
}

export async function assembleCodingContext(
  request: CodingContextRequest,
  context: AssembleCodingContextDeps,
): Promise<CodingContextPack> {
  const currentTimeMs = context.currentTimeMs ?? Date.now;
  const baseBudget = CODING_CONTEXT_BUDGETS[request.purpose];
  const budget = effectiveRetrievalContextBudget(baseBudget, context.budgetBytes);
  const providerContext = buildProviderContext(context, budget, currentTimeMs);
  const lease =
    request.editorSessionId === undefined
      ? undefined
      : acquireEditorStateContextLease(request.editorSessionId, currentTimeMs());
  return assembleRetrievalContext({
    purpose: request.purpose,
    budget: baseBudget,
    requestedBudgetBytes: context.budgetBytes,
    allowEmbeddingProviders:
      context.allowEmbeddingProviders ?? embeddingProvidersAllowed(request.purpose),
    signal: context.signal,
    providers: codingProviders(request, providerContext, lease),
    tierForSourceKind: tierForCodingContextSource,
  });
}
