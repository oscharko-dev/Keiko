// Orchestrator: routes a request through the capability registry, then through the
// circuit breaker, bounded retry, and the provider adapter. Usage metadata
// (request id, latency, cost class) is owned by the gateway, not the provider, so
// the audit ledger (issue #10) has a reliable typed target on every response.

import { randomUUID } from "node:crypto";
import { UnknownModelError } from "@oscharko-dev/keiko-security/errors/gateway";
import { findConfiguredCapability } from "./model-selection.js";
import { createDefaultProviderRuntimeRegistry } from "./provider-runtime.js";
import { CircuitBreaker, executeWithRetry, systemClock } from "./resilience.js";
import type {
  Clock,
  CircuitBreakerStatus,
  CostClass,
  GatewayConfig,
  GatewayRequest,
  GatewayStreamChunk,
  ModelCapability,
  ModelProviderConfig,
  NormalizedResponse,
  ProviderAdapter,
  RuntimeDispatchProviderConfig,
} from "./types.js";
import type { ResolvedProviderRuntime } from "./provider-runtime.js";

export interface GatewayRuntimeRegistry {
  readonly resolve: (
    modelId: string,
    provider: ModelProviderConfig,
    deps: {
      readonly adapterOverride?: ProviderAdapter | undefined;
      readonly requestId: string;
      readonly costClass: CostClass;
      readonly now: () => number;
    },
  ) => {
    readonly provider: RuntimeDispatchProviderConfig;
    readonly adapter: ProviderAdapter;
  };
}

export interface GatewayDeps {
  readonly adapter?: ProviderAdapter | undefined;
  readonly clock?: Clock | undefined;
  readonly runtimeRegistry?: GatewayRuntimeRegistry | undefined;
}

interface RoutedCall {
  readonly provider: ModelProviderConfig;
  readonly capability: ModelCapability;
}

export class Gateway {
  private readonly clock: Clock;
  private readonly adapter: ProviderAdapter | undefined;
  private readonly runtimeRegistry: GatewayRuntimeRegistry;
  private readonly providers: ReadonlyMap<string, ModelProviderConfig>;
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly config: GatewayConfig,
    deps: GatewayDeps = {},
  ) {
    this.clock = deps.clock ?? systemClock;
    this.adapter = deps.adapter;
    this.runtimeRegistry = deps.runtimeRegistry ?? createDefaultProviderRuntimeRegistry();
    this.providers = new Map(config.providers.map((p) => [p.modelId, p]));
  }

  async chat(request: GatewayRequest): Promise<NormalizedResponse> {
    const route = this.route(request.modelId);
    const breaker = this.breakerFor(route.provider);
    const requestId = randomUUID();
    const start = this.clock.now();
    const runtime = this.runtimeFor(requestId, route);
    const result = await executeWithRetry(
      (attemptTimeoutMs) =>
        this.invoke(breaker, runtime.adapter, request, {
          ...runtime.provider,
          ...(attemptTimeoutMs === undefined ? {} : { timeoutMs: attemptTimeoutMs }),
        }),
      runtime.provider,
      this.clock,
      request.cancellationSignal,
    );
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
    const breaker = this.breakerFor(route.provider);
    breaker.assertAllowed();
    const requestId = randomUUID();
    const start = this.clock.now();
    const runtime = this.runtimeFor(requestId, route);
    try {
      for await (const chunk of this.streamFrom(runtime.adapter, request, runtime.provider)) {
        yield chunk.type === "done"
          ? { type: "done", response: this.enrich(chunk.response, requestId, start, route) }
          : chunk;
      }
      breaker.recordSuccess();
    } catch (error) {
      breaker.recordFailure();
      throw error;
    }
  }

  private async *streamFrom(
    adapter: ProviderAdapter,
    request: GatewayRequest,
    provider: ResolvedProviderRuntime["provider"],
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
    provider: ResolvedProviderRuntime["provider"],
  ): Promise<NormalizedResponse> {
    breaker.assertAllowed();
    try {
      const response = await adapter.call(request, provider);
      breaker.recordSuccess();
      return response;
    } catch (error) {
      breaker.recordFailure();
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

  // Resolve providerType -> productive runtime config + adapter through the
  // internal registry so Gateway orchestration stays provider-neutral.
  private runtimeFor(requestId: string, route: RoutedCall): ResolvedProviderRuntime {
    return this.runtimeRegistry.resolve(route.provider.modelId, route.provider, {
      adapterOverride: this.adapter,
      requestId,
      costClass: route.capability.costClass,
      now: this.clock.now,
    });
  }
}
