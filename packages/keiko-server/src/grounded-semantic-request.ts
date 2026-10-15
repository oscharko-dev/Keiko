import type {
  ConnectedContextPack,
  ExplorationUsage,
  UncertaintyMarker,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { SemanticSearchProvider, WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { currentGatewayConfig, type UiHandlerDeps } from "./deps.js";
import { configuredEmbeddingProviders } from "./local-knowledge-handlers.js";
import {
  configuredRepoSemanticSearchProviderLeaseFor,
  createSemanticRefreshDocumentBudget,
  type ConfiguredRepoSemanticSearchProviderLease,
  type RepositorySemanticFreshnessObservation,
  type SemanticRefreshDocumentBudget,
} from "./grounded-repo-semantic-search.js";

export type SemanticRefreshUsageGrant = (delta: Readonly<Partial<ExplorationUsage>>) => boolean;

export interface GroundedSemanticRequest {
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly deadlineAtMs: number;
  readonly correlationId: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly tryReserveRefreshUsage: SemanticRefreshUsageGrant;
  readonly observeSemanticFreshness: (observation: RepositorySemanticFreshnessObservation) => void;
}

export type GroundedSemanticProviderFactory = (
  request: GroundedSemanticRequest,
) => SemanticSearchProvider | undefined;

export interface GroundedSemanticFreshnessSummary {
  readonly semanticStaleFallbackCount: number;
  readonly semanticRefreshedFileCount: number;
  readonly semanticRefreshEmbeddingCallCount?: number;
  readonly semanticRefreshReadFileCount?: number;
  readonly semanticRefreshReadBytesUpperBound?: number;
  readonly semanticRefreshInputTokenUpperBound?: number;
}

export function groundedSemanticFreshnessSummary(
  observations: readonly RepositorySemanticFreshnessObservation[],
  pack: ConnectedContextPack,
): GroundedSemanticFreshnessSummary | undefined {
  if (observations.length === 0) return undefined;
  const stale = new Set(observations.flatMap((observation) => observation.stalePaths));
  const refreshed = new Set(observations.flatMap((observation) => observation.refreshedPaths));
  const sent = pack.files.filter((file) => file.excerpts.length > 0);
  return {
    semanticStaleFallbackCount: sent.filter(
      (file) => stale.has(file.scopePath) && !refreshed.has(file.scopePath),
    ).length,
    semanticRefreshedFileCount: sent.filter((file) => refreshed.has(file.scopePath)).length,
    ...refreshUsageSummary(observations),
  };
}

function refreshUsageSummary(
  observations: readonly RepositorySemanticFreshnessObservation[],
): Partial<GroundedSemanticFreshnessSummary> {
  const usage = observations.flatMap((observation) =>
    observation.refreshUsage === undefined ? [] : [observation.refreshUsage],
  );
  if (usage.length === 0) return {};
  return {
    semanticRefreshEmbeddingCallCount: usage.reduce(
      (sum, item) => sum + item.embeddingCallCount,
      0,
    ),
    semanticRefreshReadFileCount: usage.reduce((sum, item) => sum + item.readFileCount, 0),
    semanticRefreshReadBytesUpperBound: usage.reduce((sum, item) => sum + item.readBytes, 0),
    semanticRefreshInputTokenUpperBound: usage.reduce((sum, item) => sum + item.inputTokens, 0),
  };
}

export function staleSemanticMarker(
  summary: GroundedSemanticFreshnessSummary | undefined,
  nowMs: number,
): readonly UncertaintyMarker[] {
  if (summary === undefined || summary.semanticStaleFallbackCount === 0) return [];
  return [
    {
      kind: "stale-evidence",
      claim: `stale-semantic: ${String(summary.semanticStaleFallbackCount)} changed source file(s) retain current lexical evidence while indexed vectors are stale`,
      impactedAtomIds: [],
      emittedAtMs: nowMs,
    },
  ];
}

/** Leases open only for an admitted semantic lookup and settle with their owning request. */
export function configuredGroundedSemanticRequest(
  deps: UiHandlerDeps,
  repositoryRoot: string,
  semanticRefreshDocumentBudget: SemanticRefreshDocumentBudget = createSemanticRefreshDocumentBudget(
    deps,
  ),
): {
  readonly providerFor: GroundedSemanticProviderFactory | undefined;
  readonly close: () => void;
} {
  if (configuredEmbeddingProviders(currentGatewayConfig(deps)).length === 0)
    return { providerFor: undefined, close: (): void => undefined };
  const leases: ConfiguredRepoSemanticSearchProviderLease[] = [];
  return {
    providerFor: (request): SemanticSearchProvider | undefined => {
      const lease = configuredRepoSemanticSearchProviderLeaseFor(
        deps,
        request.signal,
        repositoryRoot,
        { ...request, semanticRefreshDocumentBudget },
      );
      leases.push(lease);
      return lease.provider;
    },
    close: (): void => {
      for (const lease of leases.splice(0)) lease.close();
    },
  };
}
