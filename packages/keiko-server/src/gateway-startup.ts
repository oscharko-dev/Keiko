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
  initializeConfiguredEmbeddingReadiness,
  conversationModelInUse,
  initializeLiteLlmCodingReadiness,
  settleStartupConversationReadiness,
  WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS,
  withReadinessParentCorrelation,
} from "./gateway-readiness.js";

import {
  logStartupRetryDecision,
  type CatalogBackgroundAttempt,
} from "./gateway-startup-activity.js";

// A finite initialization burst; only a new configuration starts another startup burst.
const MAX_STARTUP_ATTEMPTS = 3;
const MAX_STARTUP_RETRY_DELAY_MS = 300_001;
const STARTUP_RETRY_DELAY_MS = WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS + 1;

export function createGatewayStartupChecks(deps: UiHandlerDeps): {
  readonly start: (correlationId?: string) => void;
  readonly refresh: (correlationId?: string) => void;
  readonly catalogSettled: () => Promise<void>;
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
    catalogSettled: (): Promise<void> => checks.catalogSettled(),
    stop: (): Promise<void> => checks.stop(),
  };
}

class GatewayStartupChecks {
  private readonly controller = new AbortController();
  private readonly discovered = new Set<CatalogDiscoveryState>();
  private readonly tasks = new Set<Promise<void>>();
  private catalogRead: Promise<void> = Promise.resolve();
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
      initializeConfiguredEmbeddingReadiness(
        cancellableConversationProbeDeps(observedDeps, this.controller.signal),
        parentCorrelationId ?? correlationId,
      ),
      correlationId,
    );
    this.track(
      this.run(observedDeps, correlationId, parentCorrelationId, generation),
      correlationId,
    );
  }

  public refresh(parentCorrelationId?: string): void {
    // Browser reads consume configuration-owned startup discovery. Only a new configuration or
    // an explicit Settings operation may contact the provider again after startup settles.
    const holder = this.deps.gatewayConfig;
    if (this.controller.signal.aborted || holder?.current() === undefined) return;
    if (this.startedGeneration !== holder.generation()) {
      this.start(parentCorrelationId);
      return;
    }
    const deps = withReadinessParentCorrelation(this.deps, parentCorrelationId);
    const correlationId = newCorrelationId();
    for (const state of this.discovered)
      logCatalogCacheDecision(deps, state.provider, state, correlationId, {
        backgroundAttempt: this.retryAttempt + 1,
        configurationGeneration: this.retryGeneration,
      });
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

  public async catalogSettled(): Promise<void> {
    // Join only discovery that startup already owns. Configuration replacement may queue a new
    // generation while this read waits; never cache its predecessor's catalog in the browser.
    let pending: Promise<void>;
    do {
      pending = this.catalogRead;
      await /* NOSONAR typescript:S9382 -- observe replacement after the current catalog settles. */ pending;
    } while (pending !== this.catalogRead);
  }

  private async run(
    deps: UiHandlerDeps,
    correlationId: string,
    parentCorrelationId: string | undefined,
    generation: number,
  ): Promise<void> {
    const catalog = this.catalog(deps, correlationId);
    this.catalogRead = catalog.then(
      () => undefined,
      () => undefined,
    );
    const retryCatalog = await catalog;
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
    if (coding) await this.initializeCodingReadiness(deps, correlationId, generation);
    if (!this.currentGeneration(generation)) return;
    // Only catalog discovery is retried on a timer. Basic-chat readiness retains its startup
    // result until explicit Settings verification or connection replacement.
    if (retryCatalog) {
      this.scheduleRetry(deps, correlationId, parentCorrelationId, generation);
    } else {
      this.retryAttempt = 0;
      clearTimeout(this.retry);
      this.retry = undefined;
    }
  }

  // The tool-calling proof follows the chat model in use (#4351). It starts for the model elected
  // now; when the startup walk then moved to another model because the default was refused, that
  // model gets its proof too, and a model the first pass already proved is never proven again.
  private async initializeCodingReadiness(
    deps: UiHandlerDeps,
    correlationId: string,
    generation: number,
  ): Promise<void> {
    const probeDeps = cancellableConversationProbeDeps(deps, this.controller.signal);
    const first = conversationModelInUse(deps);
    await initializeLiteLlmCodingReadiness(probeDeps, correlationId);
    await settleStartupConversationReadiness(deps);
    if (!this.currentGeneration(generation) || conversationModelInUse(deps) === first) return;
    await initializeLiteLlmCodingReadiness(probeDeps, correlationId);
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

function refreshCatalogs(
  deps: UiHandlerDeps,
  signal: AbortSignal,
  discovered: Set<CatalogDiscoveryState>,
  correlationId: string,
  retryDelayMs: number,
  background: CatalogBackgroundAttempt,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const holder = deps.gatewayConfig;
    const config = configuredStartupGateway(deps);
    if (config === undefined) {
      resolve(false);
      return;
    }
    const connections = liteLlmDiscoveryConnections(config);
    pruneCatalogConnections(discovered, connections);
    refreshNextCatalogConnection({
      deps,
      signal,
      discovered,
      correlationId,
      retryDelayMs,
      background,
      holder,
      connections: connections.values(),
      retry: false,
      resolve,
      reject,
    });
  });
}

interface CatalogRefreshSequence {
  readonly deps: UiHandlerDeps;
  readonly signal: AbortSignal;
  readonly discovered: Set<CatalogDiscoveryState>;
  readonly correlationId: string;
  readonly retryDelayMs: number;
  readonly background: CatalogBackgroundAttempt;
  readonly holder: UiHandlerDeps["gatewayConfig"];
  readonly connections: Iterator<ModelProviderConfig>;
  readonly resolve: (retry: boolean) => void;
  readonly reject: (error: unknown) => void;
  retry: boolean;
}

function refreshNextCatalogConnection(sequence: CatalogRefreshSequence): void {
  if (
    sequence.signal.aborted ||
    sequence.holder?.generation() !== sequence.background.configurationGeneration
  ) {
    sequence.resolve(sequence.retry);
    return;
  }
  const next = sequence.connections.next();
  if (next.done === true) {
    sequence.resolve(sequence.retry);
    return;
  }
  void refreshCatalogConnection(
    sequence.deps,
    sequence.signal,
    sequence.discovered,
    next.value,
    sequence.correlationId,
    sequence.retryDelayMs,
    sequence.background,
  )
    .then((retry) => {
      sequence.retry = retry || sequence.retry;
      refreshNextCatalogConnection(sequence);
    })
    .catch(sequence.reject);
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
