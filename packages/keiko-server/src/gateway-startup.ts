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
} from "./gateway-readiness.js";

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
  private readonly discovered = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private startedGeneration = -1;

  public constructor(private readonly deps: UiHandlerDeps) {}

  public start(correlationId = newCorrelationId()): void {
    const holder = this.deps.gatewayConfig;
    if (this.controller.signal.aborted || holder?.current() === undefined) return;
    if (this.startedGeneration === holder.generation()) return;
    this.startedGeneration = holder.generation();
    initializeConfiguredConversationReadiness(this.deps, correlationId);
    const task = this.run(correlationId)
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

  private async run(correlationId: string): Promise<void> {
    const retryCatalog = await refreshCatalogs(
      this.deps,
      this.controller.signal,
      this.discovered,
      correlationId,
    );
    if (this.controller.signal.aborted) return;
    initializeConfiguredConversationReadiness(this.deps, correlationId);
    const source =
      this.deps.codingSidecarGatewayModelSourceResolver?.() ??
      this.deps.codingSidecarGatewayModelSource ??
      "keiko-model-gateway";
    const coding =
      source === "keiko-model-gateway" && !codingSidecarDisabledByPolicy(this.deps.env);
    if (coding)
      await initializeLiteLlmCodingReadiness(
        cancellableConversationProbeDeps(this.deps, this.controller.signal),
        correlationId,
      );
    if (retryCatalog || (coding && isLiteLlmCodingReadinessPending(this.deps)))
      this.scheduleRetry(correlationId);
  }

  private scheduleRetry(correlationId: string): void {
    if (this.controller.signal.aborted) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.startedGeneration = -1;
      this.start(correlationId);
    }, WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS + 1);
    this.retry.unref();
  }
}

async function refreshCatalogs(
  deps: UiHandlerDeps,
  signal: AbortSignal,
  discovered: Set<string>,
  correlationId: string,
): Promise<boolean> {
  const config = deps.gatewayConfig?.current();
  if (config === undefined) return false;
  let retry = false;
  for (const provider of liteLlmDiscoveryConnections(config)) {
    const key = toolCallingConfigurationFingerprint(provider);
    if (discovered.has(key) || signal.aborted) continue;
    discovered.add(key);
    if (!(await refreshLiteLlmGatewayCatalog(deps, provider, signal, correlationId))) {
      discovered.delete(key);
      retry = true;
    }
  }
  return retry;
}
