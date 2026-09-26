// Closed coding-context wrapper over the pillar-neutral assembly pipeline (Issue #2570,
// ADR-0152 D6). Provider behavior and the public assembleCodingContext signature stay unchanged.

import type {
  CodingContextExcerpt,
  CodingContextPack,
  CodingContextRequest,
  CodingContextSourceKind,
  RetrievalContextBudget,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_CONTEXT_BUDGETS,
  embeddingProvidersAllowed,
  tierForCodingContextSource,
} from "@oscharko-dev/keiko-contracts/runtime/coding-context";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { currentGatewayConfig, type UiHandlerDeps } from "../deps.js";
import { rerankSelection } from "../grounded-rerank-facade.js";
import {
  assembleRetrievalContext,
  effectiveRetrievalContextBudget,
  type RetrievalContextProvider,
} from "../retrieval/contextAssembly.js";
import {
  acquireEditorStateContextLease,
  runConnectedContextProvider,
  runEditorStateProvider,
  runGitContextProvider,
  runLocalKnowledgeProvider,
  runMemoryProvider,
  runRepoSearchProvider,
  type EditorStateContextLease,
  type GitContextReader,
  type ProviderContext,
} from "./codingContextProviders.js";

// Connected context is wired (Epic #2556 Target Outcome 6); quality intelligence and workflow
// context stay deferred and are recorded as auditable `unavailable` omissions.
const DEFERRED_CONTEXT_PROVIDERS: readonly CodingContextSourceKind[] = [
  "quality-intelligence",
  "workflow-context",
];
const CONNECTED_CONTEXT_ORDER = 5;
const DEFERRED_CONTEXT_ORDER_BASE = 6;

export interface AssembleCodingContextDeps {
  readonly deps: UiHandlerDeps;
  readonly realRoot: string;
  readonly fs: WorkspaceFs;
  readonly signal: AbortSignal;
  readonly nowMs: number;
  readonly currentTimeMs?: (() => number) | undefined;
  readonly budgetBytes?: number | undefined;
  readonly allowEmbeddingProviders?: boolean | undefined;
  readonly gitContextReader?: GitContextReader | undefined;
  /**
   * The originating request's correlation id; see ProviderContext for why the git context
   * needs it. REQUIRED: this field being optional is what let a fourth entry point
   * (`inlineCompletionRoutes.ts`) omit it silently and still type-check.
   */
  readonly correlationId: string | undefined;
}

function buildProviderContext(
  context: AssembleCodingContextDeps,
  budget: RetrievalContextBudget,
  currentTimeMs: () => number,
): ProviderContext {
  return {
    deps: context.deps,
    realRoot: context.realRoot,
    fs: context.fs,
    signal: context.signal,
    maxBytesPerExcerpt: budget.maxBytesPerSource,
    currentTimeMs,
    nowMs: context.nowMs,
    gitContextReader: context.gitContextReader,
    correlationId: context.correlationId,
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

// The intake performs outbound connector reads, so it carries the same cost gate as the embedding
// providers: excluded purposes record `too-expensive` instead of being silently skipped.
function connectedContextProvider(
  request: CodingContextRequest,
  providerContext: ProviderContext,
): RetrievalContextProvider<CodingContextSourceKind> {
  return {
    sourceKind: "connected-context",
    order: CONNECTED_CONTEXT_ORDER,
    requiresEmbedding: true,
    run: () => runConnectedContextProvider(providerContext, { queryText: request.queryText }),
  };
}

function deferredProviders(): readonly RetrievalContextProvider<CodingContextSourceKind>[] {
  return DEFERRED_CONTEXT_PROVIDERS.map((sourceKind, index) => ({
    sourceKind,
    order: DEFERRED_CONTEXT_ORDER_BASE + index,
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
    connectedContextProvider(request, providerContext),
    ...deferredProviders(),
  ];
}

function codingContextQuery(request: CodingContextRequest): string {
  return request.queryText ?? request.symbol ?? request.documentPath;
}

function completeRerankOrder(
  candidates: readonly CodingContextExcerpt[],
  selected: readonly CodingContextExcerpt[],
): readonly CodingContextExcerpt[] {
  const selectedSet = new Set(selected);
  return [...selected, ...candidates.filter((candidate) => !selectedSet.has(candidate))];
}

function withContextRanks(
  excerpts: readonly CodingContextExcerpt[],
): readonly CodingContextExcerpt[] {
  return excerpts.map((excerpt, rank) => ({
    ...excerpt,
    citation: { ...excerpt.citation, rank },
  }));
}

async function rerankCodingContext(
  request: CodingContextRequest,
  context: AssembleCodingContextDeps,
  pack: CodingContextPack,
  gatewayConfig: GatewayConfig | undefined,
  externalRerankingAllowed: boolean,
): Promise<CodingContextPack> {
  const selection = await rerankSelection({
    deps: context.deps,
    gatewayConfig: gatewayConfig ?? null,
    query: codingContextQuery(request),
    candidates: pack.excerpts,
    documentFor: (excerpt) => excerpt.text,
    topN: pack.excerpts.length,
    signal: context.signal,
    policy: {
      externalReranking: externalRerankingAllowed && !context.signal.aborted ? "allow" : "deny",
      localReranking: "allow",
    },
    fallbackMode: "identity",
  });
  const ordered = completeRerankOrder(pack.excerpts, selection.selected);
  return { ...pack, excerpts: withContextRanks(ordered) };
}

export async function assembleCodingContext(
  request: CodingContextRequest,
  context: AssembleCodingContextDeps,
): Promise<CodingContextPack> {
  const currentTimeMs = context.currentTimeMs ?? Date.now;
  const baseBudget = CODING_CONTEXT_BUDGETS[request.purpose];
  const budget = effectiveRetrievalContextBudget(baseBudget, context.budgetBytes);
  const allowEmbeddingProviders =
    context.allowEmbeddingProviders ?? embeddingProvidersAllowed(request.purpose);
  const gatewayConfig = currentGatewayConfig(context.deps);
  const providerContext = buildProviderContext(context, budget, currentTimeMs);
  const lease =
    request.editorSessionId === undefined
      ? undefined
      : acquireEditorStateContextLease(request.editorSessionId, currentTimeMs());
  const pack = await assembleRetrievalContext({
    purpose: request.purpose,
    budget: baseBudget,
    requestedBudgetBytes: context.budgetBytes,
    allowEmbeddingProviders,
    signal: context.signal,
    providers: codingProviders(request, providerContext, lease),
    tierForSourceKind: tierForCodingContextSource,
  });
  return rerankCodingContext(request, context, pack, gatewayConfig, allowEmbeddingProviders);
}
