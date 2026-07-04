// Orchestrator: routes a request through the capability registry, then through the
// circuit breaker, bounded retry, and the provider adapter. Usage metadata
// (request id, latency, cost class) is owned by the gateway, not the provider, so
// the audit ledger (issue #10) has a reliable typed target on every response.

import { randomUUID } from "node:crypto";
import {
  CancelledError,
  GatewayError,
  UnknownModelError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { findConfiguredCapability } from "./model-selection.js";
import { OpenAiAdapter } from "./openai-adapter.js";
import { CircuitBreaker, executeWithRetry, systemClock } from "./resilience.js";
import { assertValidGatewaySamplingParameters } from "./types.js";
import type {
  Clock,
  CircuitBreakerStatus,
  GatewayConfig,
  GatewayRequest,
  GatewayStreamChunk,
  ModelCapability,
  ModelProviderConfig,
  NormalizedResponse,
  ProviderAdapter,
} from "./types.js";

export interface GatewayDeps {
  readonly adapter?: ProviderAdapter | undefined;
  readonly clock?: Clock | undefined;
}

// RB-6 (GEN-OBS-CORRELATION-503): tag a thrown GatewayError with the gateway's per-call request id
// so a failed model call is traceable to the gateway record (mirrors the id already carried by a
// successful call's `usage.requestId`). Only the first (innermost) tag wins so a retry does not
// overwrite the id of the attempt that actually failed. No-op for non-GatewayError throws.
function attachGatewayRequestId(error: unknown, requestId: string): void {
  if (error instanceof GatewayError && error.requestId === undefined) {
    error.requestId = requestId;
  }
}

interface RoutedCall {
  readonly provider: ModelProviderConfig;
  readonly capability: ModelCapability;
}

export class Gateway {
  private readonly clock: Clock;
  private readonly adapter: ProviderAdapter | undefined;
  private readonly providers: ReadonlyMap<string, ModelProviderConfig>;
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly config: GatewayConfig,
    deps: GatewayDeps = {},
  ) {
    this.clock = deps.clock ?? systemClock;
    this.adapter = deps.adapter;
    this.providers = new Map(config.providers.map((p) => [p.modelId, p]));
  }

  async chat(request: GatewayRequest): Promise<NormalizedResponse> {
    const route = this.route(request.modelId);
    assertValidGatewaySamplingParameters(request);
    const breaker = this.breakerFor(route.provider);
    const requestId = randomUUID();
    const start = this.clock.now();
    const adapter = this.adapterFor(requestId, route.capability);
    let result;
    try {
      result = await executeWithRetry(
        (attemptTimeoutMs) =>
          this.invoke(breaker, adapter, request, {
            ...route.provider,
            ...(attemptTimeoutMs === undefined ? {} : { timeoutMs: attemptTimeoutMs }),
          }),
        route.provider,
        this.clock,
        request.cancellationSignal,
      );
    } catch (error) {
      // RB-6: stamp the gateway request id onto the thrown error so a FAILED buffered call is
      // traceable to the gateway record (previously requestId was attached only on success/usage).
      attachGatewayRequestId(error, requestId);
      throw error;
    }
    return {
      ...result,
      usage: {
        ...result.usage,
        requestId,
        latencyMs: Math.max(1, this.clock.now() - start),
        costClass: route.capability.costClass,
      },
    };
  }

  // Streaming counterpart of chat(). Routes identically and guards with the circuit
  // breaker, but is NOT wrapped in executeWithRetry: a mid-stream retry would replay
  // already-emitted tokens. An adapter without a streaming variant falls back to a
  // single delta+done synthesised from its buffered call().
  async *chatStream(request: GatewayRequest): AsyncGenerator<GatewayStreamChunk> {
    const route = this.route(request.modelId);
    assertValidGatewaySamplingParameters(request);
    const breaker = this.breakerFor(route.provider);
    breaker.assertAllowed();
    const requestId = randomUUID();
    const start = this.clock.now();
    const adapter = this.adapterFor(requestId, route.capability);
    try {
      for await (const chunk of this.streamFrom(adapter, request, route.provider)) {
        yield chunk.type === "done"
          ? { type: "done", response: this.enrich(chunk.response, requestId, start, route) }
          : chunk;
      }
      breaker.recordSuccess();
    } catch (error) {
      // A client-initiated cancel is not a provider fault — skip the breaker.
      if (!(error instanceof CancelledError)) {
        breaker.recordFailure();
      }
      // RB-6: stamp the gateway request id onto the thrown error (mid-stream failure traceability).
      attachGatewayRequestId(error, requestId);
      throw error;
    }
  }

  private async *streamFrom(
    adapter: ProviderAdapter,
    request: GatewayRequest,
    provider: ModelProviderConfig,
  ): AsyncGenerator<GatewayStreamChunk> {
    if (adapter.callStream !== undefined) {
      yield* adapter.callStream(request, provider);
      return;
    }
    const response = await adapter.call(request, provider);
    yield { type: "delta", token: response.content };
    yield { type: "done", response };
  }

  private enrich(
    response: NormalizedResponse,
    requestId: string,
    start: number,
    route: RoutedCall,
  ): NormalizedResponse {
    return {
      ...response,
      usage: {
        ...response.usage,
        requestId,
        latencyMs: Math.max(1, this.clock.now() - start),
        costClass: route.capability.costClass,
      },
    };
  }

  circuitStatus(modelId: string): CircuitBreakerStatus {
    const breaker = this.breakers.get(modelId);
    return (
      breaker?.status(modelId) ?? {
        modelId,
        state: "closed",
        consecutiveFailures: 0,
        openedAt: null,
      }
    );
  }

  private async invoke(
    breaker: CircuitBreaker,
    adapter: ProviderAdapter,
    request: GatewayRequest,
    provider: ModelProviderConfig,
  ): Promise<NormalizedResponse> {
    breaker.assertAllowed();
    try {
      const response = await adapter.call(request, provider);
      breaker.recordSuccess();
      return response;
    } catch (error) {
      // A client-initiated cancel is not a provider fault — skip the breaker.
      if (!(error instanceof CancelledError)) {
        breaker.recordFailure();
      }
      throw error;
    }
  }

  private route(modelId: string): RoutedCall {
    const provider = this.providers.get(modelId);
    if (provider === undefined) {
      throw new UnknownModelError(`no provider configured for model '${modelId}'`);
    }
    const capability = findConfiguredCapability(this.config, modelId);
    if (capability === undefined) {
      throw new UnknownModelError(`model '${modelId}' has no capability metadata`);
    }
    if (capability.kind !== "chat") {
      throw new UnknownModelError(
        `model '${modelId}' has kind '${capability.kind}'; the chat path requires a chat model`,
      );
    }
    return { provider, capability };
  }

  private breakerFor(provider: ModelProviderConfig): CircuitBreaker {
    const existing = this.breakers.get(provider.modelId);
    if (existing !== undefined) {
      return existing;
    }
    const breaker = new CircuitBreaker(provider.modelId, this.config.circuitBreaker, this.clock);
    this.breakers.set(provider.modelId, breaker);
    return breaker;
  }

  private adapterFor(requestId: string, capability: ModelCapability): ProviderAdapter {
    return (
      this.adapter ??
      new OpenAiAdapter({
        requestId,
        costClass: capability.costClass,
        now: this.clock.now,
      })
    );
  }
}
