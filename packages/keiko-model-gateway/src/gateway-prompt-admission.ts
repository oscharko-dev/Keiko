import { CancelledError, TimeoutError } from "@oscharko-dev/keiko-security/errors/gateway";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import type { GatewayCallRequest } from "./gateway.js";
import type { ModelCapability, ModelProviderConfig } from "./types.js";
import { withCorrelationId, type ModelGatewayLogSink } from "./observability.js";
import { createGatewayToolCatalogBridge } from "./toolCatalogBridge.js";
import {
  countGatewayPromptTokens,
  type GatewayPromptTokenInput,
} from "./prompt-token-accounting.js";
import { admitGatewayPrompt } from "./prompt-admission.js";
import { countProviderPromptTokens, type ProviderTokenCount } from "./provider-token-counter.js";

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
    if ((this.unavailableUntil.get(provider.modelId) ?? 0) > this.now())
      return { status: "unavailable" };
    const result = await countProviderPromptTokens(request, provider, log, fetchImpl);
    if (
      (result.status === "unavailable" || result.status === "invalid") &&
      !request.cancellationSignal?.aborted
    )
      this.unavailableUntil.set(provider.modelId, this.now() + 60_000);
    else this.unavailableUntil.delete(provider.modelId);
    return result;
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
    this.remainingBudget(request, budgetMs, start);
    admitGatewayPrompt(
      projected,
      this.options.capability,
      this.log,
      this.options.correlationId,
      this.retainedMeasurement(projected, measured),
    );
    return this.remainingBudget(request, budgetMs, start);
  }

  private remainingBudget(request: GatewayCallRequest, budgetMs: number, start: number): number {
    if (request.cancellationSignal?.aborted)
      throw new CancelledError("request cancelled during prompt admission");
    const remaining = budgetMs - Math.max(0, this.options.now() - start);
    if (remaining <= 0) throw new TimeoutError("request budget exhausted during prompt admission");
    return remaining;
  }

  private retainedMeasurement(
    request: GatewayCallRequest & GatewayPromptTokenInput,
    count: ProviderTokenCount,
  ): ProviderTokenCount {
    const profile = deriveContextProfileFromCapability(this.options.capability);
    // The remote payload omits responseFormat, so the retained floor must omit it too.
    const estimated = countGatewayPromptTokens(
      { messages: request.messages, tools: request.tools },
      profile.tokenAccounting,
    );
    const retained =
      this.previous === undefined
        ? 0
        : this.previous.measured + Math.max(0, estimated - this.previous.estimated);
    const measured = Math.max(retained, count.tokens ?? 0);
    if (measured === 0) return count;
    this.previous = { estimated, measured };
    return { ...count, tokens: measured };
  }
}
