import { toolCallingConfigurationFingerprint } from "@oscharko-dev/keiko-model-gateway";
import { codingSidecarDisabledByPolicy } from "./coding-sidecar-gateway.js";
import { newCorrelationId } from "./correlation.js";
import type { UiHandlerDeps } from "./deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import {
  catalogConnectionMatches,
  liteLlmDiscoveryConnections,
  refreshLiteLlmGatewayCatalog,
} from "./gateway-setup.js";
import {
  cancellableConversationProbeDeps,
  initializeConfiguredConversationReadiness,
  initializeLiteLlmCodingReadiness,
  isLiteLlmCodingReadinessPending,
  WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS,
  withReadinessParentCorrelation,
} from "./gateway-readiness.js";

const STARTUP_RETRY_DELAY_MS = WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS + 1;

export function createGatewayStartupChecks(deps: UiHandlerDeps): {
  readonly start: (correlationId?: string) => void;
  readonly refresh: (correlationId?: string) => void;
  readonly stop: () => Promise<void>;
} {
  const checks = new GatewayStartupChecks(deps);
  return {
    start: (correlationId): void => {
      checks.start(correlationId);
    },
    refresh: (correlationId): void => {
      checks.refresh(correlationId);
    },
    stop: (): Promise<void> => checks.stop(),
  };
}

class GatewayStartupChecks {
  private readonly controller = new AbortController();
  private readonly discovered = new Map<string, CatalogDiscoveryState>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly refreshingGenerations = new Set<number>();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private startedGeneration = -1;
  private retryAttempt = 0;

  public constructor(private readonly deps: UiHandlerDeps) {}

  private initializeConversationReadiness(
    deps: UiHandlerDeps,
    correlationId: string,
    parentCorrelationId: string | undefined,
  ): void {
    initializeConfiguredConversationReadiness(deps, parentCorrelationId ?? correlationId);
  }

  public start(parentCorrelationId?: string): void {
    const correlationId = newCorrelationId();
    const observedDeps = withReadinessParentCorrelation(this.deps, parentCorrelationId);
    const holder = this.deps.gatewayConfig;
    if (this.controller.signal.aborted || holder?.current() === undefined) return;
    if (this.startedGeneration === holder.generation()) return;
    this.startedGeneration = holder.generation();
    this.initializeConversationReadiness(observedDeps, correlationId, parentCorrelationId);
    this.track(this.run(observedDeps, correlationId, parentCorrelationId), correlationId);
  }

  public refresh(parentCorrelationId?: string): void {
    const holder = this.deps.gatewayConfig;
    if (this.controller.signal.aborted || holder?.current() === undefined) return;
    const generation = holder.generation();
    if (this.refreshingGenerations.has(generation)) return;
    this.refreshingGenerations.add(generation);
    // A browser reload renews completed discovery; an in-flight query or retry backoff is shared.
    for (const [key, discovery] of this.discovered) {
      if (discovery.retryAt === Infinity) this.discovered.delete(key);
    }
    const correlationId = newCorrelationId();
    const deps = withReadinessParentCorrelation(this.deps, parentCorrelationId);
    this.initializeConversationReadiness(deps, correlationId, parentCorrelationId);
    const task = this.catalog(deps, correlationId)
      .finally(() => {
        this.refreshingGenerations.delete(generation);
      })
      .then((retryCatalog) =>
        this.finishInitialization(deps, correlationId, parentCorrelationId, retryCatalog),
      );
    this.track(task, correlationId);
  }

  private track(pending: Promise<void>, correlationId: string): void {
    const task = pending
      .catch((error: unknown): void => {
        emitServerDiagnostic(
          this.deps.diagnostics,
          serverDiagnosticFromError({
            correlationId,
            operation: "gateway.readiness",
            source: "gateway-startup.initialize",
            error,
            redact: () => "Background model initialization failed.",
          }),
        );
      })
      .finally(() => {
        this.tasks.delete(task);
      });
    this.tasks.add(task);
  }

  public async stop(): Promise<void> {
    this.controller.abort();
    clearTimeout(this.retry);
    await Promise.allSettled(this.tasks);
  }

  private async run(
    deps: UiHandlerDeps,
    correlationId: string,
    parentCorrelationId: string | undefined,
  ): Promise<void> {
    const retryCatalog = await this.catalog(deps, correlationId);
    await this.finishInitialization(deps, correlationId, parentCorrelationId, retryCatalog);
  }

  private catalog(deps: UiHandlerDeps, correlationId: string): Promise<boolean> {
    return refreshCatalogs(
      deps,
      this.controller.signal,
      this.discovered,
      correlationId,
      this.retryDelay(),
    );
  }

  private async finishInitialization(
    deps: UiHandlerDeps,
    correlationId: string,
    parentCorrelationId: string | undefined,
    retryCatalog: boolean,
  ): Promise<void> {
    if (this.controller.signal.aborted) return;
    this.initializeConversationReadiness(deps, correlationId, parentCorrelationId);
    const source =
      deps.codingSidecarGatewayModelSourceResolver?.() ??
      deps.codingSidecarGatewayModelSource ??
      "keiko-model-gateway";
    const coding = source === "keiko-model-gateway" && !codingSidecarDisabledByPolicy(deps.env);
    if (coding)
      await initializeLiteLlmCodingReadiness(
        cancellableConversationProbeDeps(deps, this.controller.signal),
        correlationId,
      );
    if (retryCatalog || (coding && isLiteLlmCodingReadinessPending(deps))) {
      this.scheduleRetry(parentCorrelationId);
    } else {
      this.retryAttempt = 0;
      clearTimeout(this.retry);
      this.retry = undefined;
    }
  }

  private scheduleRetry(parentCorrelationId: string | undefined): void {
    if (this.controller.signal.aborted) return;
    if (this.retry !== undefined) return;
    const delay = this.retryDelay();
    this.retryAttempt += 1;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.startedGeneration = -1;
      this.start(parentCorrelationId);
    }, delay);
    this.retry.unref();
  }
  private retryDelay(): number {
    return Math.min(STARTUP_RETRY_DELAY_MS * 2 ** Math.min(this.retryAttempt, 3), 300_001);
  }
}

async function refreshCatalogs(
  deps: UiHandlerDeps,
  signal: AbortSignal,
  discovered: Map<string, CatalogDiscoveryState>,
  correlationId: string,
  retryDelayMs: number,
): Promise<boolean> {
  const holder = deps.gatewayConfig;
  const config = holder?.configured?.() ?? holder?.current();
  if (config === undefined) return false;
  let retry = false;
  const connections = liteLlmDiscoveryConnections(config);
  pruneCatalogConnections(discovered, connections);
  for (const provider of connections) {
    if (signal.aborted) break;
    retry =
      (await refreshCatalogConnection(
        deps,
        signal,
        discovered,
        provider,
        correlationId,
        retryDelayMs,
      )) || retry;
  }
  return retry;
}

async function refreshCatalogConnection(
  deps: UiHandlerDeps,
  signal: AbortSignal,
  discovered: Map<string, CatalogDiscoveryState>,
  provider: Parameters<typeof toolCallingConfigurationFingerprint>[0],
  correlationId: string,
  retryDelayMs: number,
): Promise<boolean> {
  const key = toolCallingConfigurationFingerprint(provider);
  const retryAt = discovered.get(key)?.retryAt;
  if (retryAt !== undefined && (retryAt === 0 || retryAt > Date.now()))
    return Number.isFinite(retryAt);
  const pending = { provider, retryAt: 0 };
  discovered.set(key, pending);
  const result = await refreshLiteLlmGatewayCatalog(deps, provider, signal, correlationId);
  if (discovered.get(key) !== pending) return false;
  pending.retryAt = result.retryable ? Date.now() + retryDelayMs : Infinity;
  return result.retryable;
}

interface CatalogDiscoveryState {
  readonly provider: Parameters<typeof toolCallingConfigurationFingerprint>[0];
  retryAt: number;
}

function pruneCatalogConnections(
  discovered: Map<string, CatalogDiscoveryState>,
  connections: readonly Parameters<typeof toolCallingConfigurationFingerprint>[0][],
): void {
  for (const [key, state] of discovered) {
    const current = connections.find(
      (provider) => toolCallingConfigurationFingerprint(provider) === key,
    );
    if (current === undefined || !catalogConnectionMatches(current, state.provider))
      discovered.delete(key);
  }
}
