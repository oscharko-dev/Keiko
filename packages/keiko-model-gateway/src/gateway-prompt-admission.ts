import {
  ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { CancelledError, TimeoutError } from "@oscharko-dev/keiko-security/errors/gateway";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import type { GatewayCallRequest } from "./gateway.js";
import type { ModelCapability, ModelProviderConfig } from "./types.js";
import {
  withCorrelationId,
  activityLogErrorKind,
  gatewayFailureEvidence,
  GATEWAY_FAILURE_EVIDENCE_FIELDS,
  type ModelGatewayLogSink,
} from "./observability.js";
import { createGatewayToolCatalogBridge } from "./toolCatalogBridge.js";
import {
  countGatewayPromptTokens,
  type GatewayPromptTokenInput,
} from "./prompt-token-accounting.js";
import { admitGatewayPrompt } from "./prompt-admission.js";
import { countProviderPromptTokens, type ProviderTokenCount } from "./provider-token-counter.js";

const COUNTER_COOLDOWN_MS = 60_000;
const COUNTER_COOLDOWN = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.prompt.counter-cooldown",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "gateway-prompt-admission.ProviderPromptCounter.logCooldown",
  fields: {
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["activated", "suppressed", "expired"],
    },
    modelIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 16 },
    remainingMs: { type: "number", dataClass: "duration", required: true },
    cooldownMs: { type: "number", dataClass: "duration", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-context-admission"],
  proofIds: ["gateway.prompt.counter-cooldown.lifecycle"],
  releaseImpact: "patch",
});

const ADMISSION_FAILED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.prompt.admission-failed",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "gateway-prompt-admission.GatewayPromptAdmission.refuseBudget",
  fields: {
    ...GATEWAY_FAILURE_EVIDENCE_FIELDS,
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["counter", "validation"],
    },
    budgetMs: { type: "number", dataClass: "duration", required: true },
    elapsedMs: { type: "number", dataClass: "duration", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["gateway-context-admission"],
  proofIds: ["gateway.prompt.admission-failed.budget"],
  releaseImpact: "patch",
});

/** A generation-authorized key need not have access to LiteLLM's management counter. */
export class ProviderPromptCounter {
  private readonly unavailableUntil = new Map<string, number>();
  constructor(private readonly now: () => number) {}

  async count(
    request: GatewayCallRequest,
    provider: ModelProviderConfig,
    log: ModelGatewayLogSink,
    fetchImpl?: typeof fetch,
  ): Promise<ProviderTokenCount> {
    const remaining = (this.unavailableUntil.get(provider.modelId) ?? 0) - this.now();
    if (remaining > 0) {
      this.logCooldown(request, provider, log, "suppressed", remaining);
      return { status: "unavailable" };
    }
    if (this.unavailableUntil.delete(provider.modelId))
      this.logCooldown(request, provider, log, "expired", 0);
    const result = await countProviderPromptTokens(request, provider, log, fetchImpl);
    if (
      (result.status === "unavailable" || result.status === "invalid") &&
      !request.cancellationSignal?.aborted
    ) {
      this.unavailableUntil.set(provider.modelId, this.now() + COUNTER_COOLDOWN_MS);
      this.logCooldown(request, provider, log, "activated", COUNTER_COOLDOWN_MS);
    }
    return result;
  }

  private logCooldown(
    request: GatewayCallRequest,
    provider: ModelProviderConfig,
    log: ModelGatewayLogSink,
    state: "activated" | "suppressed" | "expired",
    remainingMs: number,
  ): void {
    log.write(
      activityLogEvent(
        COUNTER_COOLDOWN,
        {
          correlationId:
            request.logContext?.correlationId ??
            log.correlationId ??
            ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
        },
        {
          state,
          remainingMs: Math.max(0, Math.ceil(remainingMs)),
          cooldownMs: COUNTER_COOLDOWN_MS,
          modelIdDigest: sha256Hex(provider.modelId).slice(0, 16),
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  }
}

interface AdmissionOptions {
  readonly capability: ModelCapability;
  readonly provider: ModelProviderConfig;
  readonly log: ModelGatewayLogSink;
  readonly correlationId: string;
  readonly now: () => number;
  readonly counter: ProviderPromptCounter;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** One logical call, including corrective retries. Retains the measured floor if counting degrades. */
export class GatewayPromptAdmission {
  private previous: { estimated: number; measured: number } | undefined;
  private readonly log: ModelGatewayLogSink;
  constructor(private readonly options: AdmissionOptions) {
    this.log = withCorrelationId(options.log, options.correlationId);
  }

  async admit(request: GatewayCallRequest, budgetMs: number): Promise<number> {
    const start = this.options.now();
    const tools = createGatewayToolCatalogBridge(request, this.options.now, this.log, false).tools;
    const projected = {
      ...request,
      tools,
      logContext: { correlationId: this.options.correlationId },
      cancellationSignal: AbortSignal.any([
        AbortSignal.timeout(Math.max(1, Math.floor(budgetMs))),
        ...(request.cancellationSignal === undefined ? [] : [request.cancellationSignal]),
      ]),
    };
    const measured = await this.options.counter.count(
      projected,
      this.options.provider,
      this.log,
      this.options.fetchImpl,
    );
    this.remainingBudget(request, budgetMs, start, "counter");
    admitGatewayPrompt(
      projected,
      this.options.capability,
      this.log,
      this.options.correlationId,
      measured,
      this.retainedTokenFloor(projected, measured),
    );
    return this.remainingBudget(request, budgetMs, start, "validation");
  }

  private remainingBudget(
    request: GatewayCallRequest,
    budgetMs: number,
    start: number,
    phase: "counter" | "validation",
  ): number {
    const elapsedMs = Math.max(0, this.options.now() - start);
    if (request.cancellationSignal?.aborted)
      return this.refuseBudget(
        new CancelledError("request cancelled during prompt admission"),
        phase,
        budgetMs,
        elapsedMs,
      );
    const remaining = budgetMs - elapsedMs;
    if (remaining <= 0)
      return this.refuseBudget(
        new TimeoutError("request budget exhausted during prompt admission"),
        phase,
        budgetMs,
        elapsedMs,
      );
    return remaining;
  }

  private refuseBudget(
    error: CancelledError | TimeoutError,
    phase: "counter" | "validation",
    budgetMs: number,
    elapsedMs: number,
  ): never {
    this.log.write(
      activityLogEvent(
        ADMISSION_FAILED,
        {
          correlationId: this.options.correlationId,
          errorKind: activityLogErrorKind(error),
        },
        {
          phase,
          budgetMs: Math.ceil(budgetMs),
          elapsedMs: Math.ceil(elapsedMs),
          ...gatewayFailureEvidence(this.log, error),
          completeness: "complete",
          loss: "none",
        },
      ),
    );
    throw error;
  }

  private retainedTokenFloor(
    request: GatewayCallRequest & GatewayPromptTokenInput,
    count: ProviderTokenCount,
  ): number | undefined {
    const profile = deriveContextProfileFromCapability(this.options.capability);
    // The remote payload omits responseFormat, so the retained floor must omit it too.
    const estimated = countGatewayPromptTokens(
      { messages: request.messages, tools: request.tools },
      profile.tokenAccounting,
      { contextWindow: profile.maxInputTokens },
    );
    const retained =
      this.previous === undefined
        ? 0
        : this.previous.measured + Math.max(0, estimated - this.previous.estimated);
    const measured = Math.max(retained, count.tokens ?? 0);
    if (measured === 0) return undefined;
    this.previous = { estimated, measured };
    return retained > 0 ? retained : undefined;
  }
}
