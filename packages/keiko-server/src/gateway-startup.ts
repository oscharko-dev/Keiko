import { toolCallingConfigurationFingerprint } from "@oscharko-dev/keiko-model-gateway";
import { codingSidecarDisabledByPolicy } from "./coding-sidecar-gateway.js";
import { newCorrelationId } from "./correlation.js";
import type { UiHandlerDeps } from "./deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { liteLlmDiscoveryConnections, refreshLiteLlmGatewayCatalog } from "./gateway-setup.js";
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
  readonly stop: () => Promise<void>;
} {
  const checks = new GatewayStartupChecks(deps);
  return {
    start: (correlationId): void => {
      checks.start(correlationId);
    },
    stop: (): Promise<void> => checks.stop(),
  };
}

class GatewayStartupChecks {
  private readonly controller = new AbortController();
  private readonly discovered = new Map<string, number>();
  private readonly tasks = new Set<Promise<void>>();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private startedGeneration = -1;
  private retryAttempt = 0;

  public constructor(private readonly deps: UiHandlerDeps) {}

  public start(parentCorrelationId?: string): void {
    const correlationId = newCorrelationId();
    const observedDeps = withReadinessParentCorrelation(this.deps, parentCorrelationId);
    const holder = this.deps.gatewayConfig;
    if (this.controller.signal.aborted || holder?.current() === undefined) return;
    if (this.startedGeneration === holder.generation()) return;
    this.startedGeneration = holder.generation();
    initializeConfiguredConversationReadiness(observedDeps, correlationId);
    const task = this.run(observedDeps, correlationId, parentCorrelationId)
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
    const retryCatalog = await refreshCatalogs(
      deps,
      this.controller.signal,
      this.discovered,
      correlationId,
      this.retryDelay(),
    );
    if (this.controller.signal.aborted) return;
    initializeConfiguredConversationReadiness(deps, correlationId);
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
  discovered: Map<string, number>,
  correlationId: string,
  retryDelayMs: number,
): Promise<boolean> {
  const config = deps.gatewayConfig?.current();
  if (config === undefined) return false;
  let retry = false;
  const connections = liteLlmDiscoveryConnections(config);
  pruneCatalogConnections(discovered, connections);
  for (const provider of connections) {
    const key = toolCallingConfigurationFingerprint(provider);
    if (signal.aborted) continue;
    const retryAt = discovered.get(key);
    if (retryAt !== undefined && (retryAt === 0 || retryAt > Date.now())) {
      retry ||= Number.isFinite(retryAt);
      continue;
    }
    discovered.set(key, 0);
    const result = await refreshLiteLlmGatewayCatalog(deps, provider, signal, correlationId);
    if (result.retryable) {
      discovered.set(key, Date.now() + retryDelayMs);
      retry = true;
    } else {
      discovered.set(key, Infinity);
    }
  }
  return retry;
}

function pruneCatalogConnections(
  discovered: Map<string, number>,
  connections: readonly Parameters<typeof toolCallingConfigurationFingerprint>[0][],
): void {
  const active = new Set(connections.map(toolCallingConfigurationFingerprint));
  for (const key of discovered.keys()) if (!active.has(key)) discovered.delete(key);
}
