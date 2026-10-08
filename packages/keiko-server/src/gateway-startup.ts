import type { GatewayConfig, ModelProviderConfig } from "@oscharko-dev/keiko-model-gateway";
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

import {
  logStartupRetryDecision,
  type CatalogBackgroundAttempt,
} from "./gateway-startup-activity.js";

// A finite initialization burst; an explicit reload or a new configuration starts another burst.
const MAX_STARTUP_ATTEMPTS = 3;
const MAX_STARTUP_RETRY_DELAY_MS = 300_001;
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
  private readonly discovered = new Set<CatalogDiscoveryState>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly refreshingGenerations = new Set<number>();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private startedGeneration = -1;
  private retryAttempt = 0;
  private retryGeneration = -1;

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
    const generation = holder.generation();
    this.initializeGeneration(generation);
    this.startedGeneration = generation;
    this.initializeConversationReadiness(observedDeps, correlationId, parentCorrelationId);
    this.track(
      this.run(observedDeps, correlationId, parentCorrelationId, generation),
      correlationId,
    );
  }

  public refresh(parentCorrelationId?: string): void {
    const holder = this.deps.gatewayConfig;
    if (this.controller.signal.aborted || holder?.current() === undefined) return;
    const generation = holder.generation();
    if (this.refreshingGenerations.has(generation)) return;
    this.initializeGeneration(generation);
    if (this.retry === undefined) this.retryAttempt = 0;
    this.refreshingGenerations.add(generation);
    // A browser reload renews completed discovery; an in-flight query or retry backoff is shared.
    for (const discovery of this.discovered) {
      if (discovery.retryAt === Infinity) this.discovered.delete(discovery);
    }
    const correlationId = newCorrelationId();
    const deps = withReadinessParentCorrelation(this.deps, parentCorrelationId);
    this.initializeConversationReadiness(deps, correlationId, parentCorrelationId);
    const task = this.catalog(deps, correlationId)
      .finally(() => {
        this.refreshingGenerations.delete(generation);
      })
      .then((retryCatalog) =>
        this.finishInitialization(
          deps,
          correlationId,
          parentCorrelationId,
          retryCatalog,
          generation,
        ),
      );
    this.track(task, correlationId);
  }

  private initializeGeneration(generation: number): void {
    if (this.retryGeneration === generation) return;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.retryAttempt = 0;
    this.retryGeneration = generation;
  }

  private currentGeneration(generation: number): boolean {
    return !this.controller.signal.aborted && this.deps.gatewayConfig?.generation() === generation;
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
    generation: number,
  ): Promise<void> {
    const retryCatalog = await this.catalog(deps, correlationId);
    await this.finishInitialization(
      deps,
      correlationId,
      parentCorrelationId,
      retryCatalog,
      generation,
    );
  }

  private catalog(deps: UiHandlerDeps, correlationId: string): Promise<boolean> {
    return refreshCatalogs(
      deps,
      this.controller.signal,
      this.discovered,
      correlationId,
      this.retryDelay(),
      { backgroundAttempt: this.retryAttempt + 1, configurationGeneration: this.retryGeneration },
    );
  }

  private async finishInitialization(
    deps: UiHandlerDeps,
    correlationId: string,
    parentCorrelationId: string | undefined,
    retryCatalog: boolean,
    generation: number,
  ): Promise<void> {
    if (!this.currentGeneration(generation)) return;
    this.initializeConversationReadiness(deps, correlationId, parentCorrelationId);
    const coding = codingStartupEnabled(deps);
    if (coding)
      await initializeLiteLlmCodingReadiness(
        cancellableConversationProbeDeps(deps, this.controller.signal),
        correlationId,
      );
    if (!this.currentGeneration(generation)) return;
    if (retryCatalog || (coding && isLiteLlmCodingReadinessPending(deps))) {
      this.scheduleRetry(deps, correlationId, parentCorrelationId, generation);
    } else {
      this.retryAttempt = 0;
      clearTimeout(this.retry);
      this.retry = undefined;
    }
  }

  private scheduleRetry(
    deps: UiHandlerDeps,
    correlationId: string,
    parentCorrelationId: string | undefined,
    generation: number,
  ): void {
    if (!this.currentGeneration(generation)) return;
    const decision = {
      correlationId,
      backgroundAttempt: this.retryAttempt + 1,
      configurationGeneration: generation,
      configuredModelCount:
        (deps.gatewayConfig?.configured?.() ?? deps.gatewayConfig?.current())?.providers.length ??
        0,
    };
    if (this.retry !== undefined) {
      logStartupRetryDecision(deps, { ...decision, retryDisposition: "coalesced" });
      return;
    }
    if (this.retryAttempt + 1 >= MAX_STARTUP_ATTEMPTS) {
      logStartupRetryDecision(deps, { ...decision, retryDisposition: "exhausted" });
      return;
    }
    const delay = this.scheduledRetryDelay();
    logStartupRetryDecision(deps, {
      ...decision,
      retryDisposition: "scheduled",
      retryDelayMs: delay,
      retryDeadlineMs: Date.now() + delay,
    });
    this.retryAttempt += 1;
    this.retry = setTimeout(() => {
      if (!this.currentGeneration(generation)) return;
      this.retry = undefined;
      this.startedGeneration = -1;
      this.start(parentCorrelationId);
    }, delay);
    this.retry.unref();
  }
  private scheduledRetryDelay(): number {
    const now = Date.now();
    const nextRetryAt = Math.min(
      ...[...this.discovered]
        .map((state) => state.retryAt)
        .filter((at) => Number.isFinite(at) && at > now),
    );
    const remaining = Number.isFinite(nextRetryAt) ? nextRetryAt - now : 0;
    return Math.min(Math.max(this.retryDelay(), remaining), MAX_STARTUP_RETRY_DELAY_MS);
  }

  private retryDelay(): number {
    return Math.min(
      STARTUP_RETRY_DELAY_MS * 2 ** Math.min(this.retryAttempt, 3),
      MAX_STARTUP_RETRY_DELAY_MS,
    );
  }
}

async function refreshCatalogs(
  deps: UiHandlerDeps,
  signal: AbortSignal,
  discovered: Set<CatalogDiscoveryState>,
  correlationId: string,
  retryDelayMs: number,
  background: CatalogBackgroundAttempt,
): Promise<boolean> {
  const holder = deps.gatewayConfig;
  const config = configuredStartupGateway(deps);
  if (config === undefined) return false;
  let retry = false;
  const connections = liteLlmDiscoveryConnections(config);
  pruneCatalogConnections(discovered, connections);
  for (const provider of connections) {
    if (signal.aborted || holder?.generation() !== background.configurationGeneration) break;
    retry =
      (await refreshCatalogConnection(
        deps,
        signal,
        discovered,
        provider,
        correlationId,
        retryDelayMs,
        background,
      )) || retry;
  }
  return retry;
}

async function refreshCatalogConnection(
  deps: UiHandlerDeps,
  signal: AbortSignal,
  discovered: Set<CatalogDiscoveryState>,
  provider: ModelProviderConfig,
  correlationId: string,
  retryDelayMs: number,
  background: CatalogBackgroundAttempt,
): Promise<boolean> {
  const previous = [...discovered].find((state) =>
    catalogConnectionMatches(provider, state.provider),
  );
  const retryAt = previous?.retryAt;
  if (retryAt !== undefined && (retryAt === 0 || retryAt > Date.now())) {
    logCatalogCacheDecision(deps, provider, previous, correlationId, background);
    return Number.isFinite(retryAt);
  }
  const pending: CatalogDiscoveryState = { provider, retryAt: 0 };
  if (previous !== undefined) discovered.delete(previous);
  discovered.add(pending);
  const result = await refreshLiteLlmGatewayCatalog(
    deps,
    provider,
    signal,
    correlationId,
    background,
  );
  if (!discovered.has(pending)) return false;
  pending.conclusive = !result.succeeded && !result.retryable;
  pending.retryAt = result.retryable ? Date.now() + retryDelayMs : Infinity;
  return result.retryable;
}

interface CatalogDiscoveryState {
  readonly provider: ModelProviderConfig;
  retryAt: number;
  conclusive?: boolean;
}

function pruneCatalogConnections(
  discovered: Set<CatalogDiscoveryState>,
  connections: readonly ModelProviderConfig[],
): void {
  for (const state of discovered) {
    if (!connections.some((provider) => catalogConnectionMatches(provider, state.provider)))
      discovered.delete(state);
  }
}

function logCatalogCacheDecision(
  deps: UiHandlerDeps,
  provider: ModelProviderConfig,
  state: CatalogDiscoveryState | undefined,
  correlationId: string,
  background: CatalogBackgroundAttempt,
): void {
  if (state === undefined) return;
  const config = configuredStartupGateway(deps);
  const retryAt = state.retryAt;
  logStartupRetryDecision(deps, {
    correlationId,
    ...background,
    configuredModelCount:
      config?.providers.filter((candidate) => catalogConnectionMatches(candidate, provider))
        .length ?? 0,
    retryDisposition: catalogCacheDisposition(state),
    ...(retryAt > 0 && Number.isFinite(retryAt)
      ? { retryDelayMs: Math.max(0, retryAt - Date.now()), retryDeadlineMs: retryAt }
      : {}),
  });
}

function configuredStartupGateway(deps: UiHandlerDeps): GatewayConfig | undefined {
  const holder = deps.gatewayConfig;
  return holder?.configured?.() ?? holder?.current();
}

function codingStartupEnabled(deps: UiHandlerDeps): boolean {
  const source =
    deps.codingSidecarGatewayModelSourceResolver?.() ??
    deps.codingSidecarGatewayModelSource ??
    "keiko-model-gateway";
  return source === "keiko-model-gateway" && !codingSidecarDisabledByPolicy(deps.env);
}

function catalogCacheDisposition(
  state: CatalogDiscoveryState,
): "in-flight" | "backoff" | "conclusive" | "complete" {
  if (state.retryAt === 0) return "in-flight";
  if (Number.isFinite(state.retryAt)) return "backoff";
  return state.conclusive === true ? "conclusive" : "complete";
}
