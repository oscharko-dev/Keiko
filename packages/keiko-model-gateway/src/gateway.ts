// Orchestrator: routes a request through the capability registry, then through the
// circuit breaker, bounded retry, and the provider adapter. Usage metadata
// (request id, latency, cost class) is owned by the gateway, not the provider, so
// the audit ledger (issue #10) has a reliable typed target on every response.

import { randomUUID } from "node:crypto";
import {
  CancelledError,
  ConfigInvalidError,
  GatewayError,
  UnknownModelError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { findConfiguredCapability } from "./model-selection.js";
import {
  logEndpointHost,
  logErrorKind,
  logLevelEnabled,
  logTimer,
  resolveLogSink,
  type ModelGatewayLogContext,
  type ModelGatewayLogEvent,
  type ModelGatewayLogLevel,
  type ModelGatewayLogSink,
} from "./observability.js";
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
  UsageMetadata,
} from "./types.js";

/** Shared, durable admission owned by the host; invoked before EVERY provider attempt. */
export interface GatewaySpendBudget {
  reserve(
    capability: ModelCapability,
    request: GatewayCallRequest,
    correlationId: string,
  ): GatewaySpendReservation;
}

export interface GatewaySpendReservation {
  /** Missing usage retains the full upper reservation, including cancellation or process loss. */
  settle(usage: UsageMetadata | undefined): void;
}

export interface GatewayDeps {
  readonly spendBudget?: GatewaySpendBudget | undefined;
  readonly adapter?: ProviderAdapter | undefined;
  readonly clock?: Clock | undefined;
  // Randomness source for the retry backoff's equal jitter. Injectable so tests
  // that pin exact sleep/budget arithmetic stay deterministic (same philosophy
  // as the injectable Clock). Defaults to Math.random.
  readonly random?: (() => number) | undefined;
  // Activity-log sink (ADR-0019: declared as a local port in `observability.ts`, never imported
  // from the server). Unset means no-op — the Gateway behaves exactly as it did before.
  readonly log?: ModelGatewayLogSink | undefined;
  // Fetch seam (ADR-0173 §7.3): threaded into every `OpenAiAdapter` this Gateway constructs, so a
  // caller can replace the transport for deterministic replay (`createScriptedGatewayFetch`)
  // without touching the real network. Unset means the adapter falls back to `globalThis.fetch`,
  // exactly as it did before this field existed.
  readonly fetchImpl?: typeof fetch | undefined;
}

// A gateway call plus the caller's log context.
//
// `GatewayRequest` is a wire contract owned by `keiko-contracts` and a correlation id is not wire
// data — it is a local diagnostic handle — so the field is added HERE, as an optional extension of
// the contract type. Every existing caller keeps compiling and keeps passing a plain
// `GatewayRequest`: the extra property is optional, so the contract type is still assignable to
// this one.
export interface GatewayCallRequest extends GatewayRequest {
  readonly logContext?: ModelGatewayLogContext | undefined;
}

// The two ids a single gateway call carries.
//
// `requestId` is minted here per call and is what `usage.requestId` and a thrown GatewayError
// report. `correlationId` is what the LINES are tagged with, and the caller's id wins when it
// supplied one: an operator diagnosing a frozen indexing run greps for the id of the RUN, and a
// gateway line tagged with an id that exists nowhere outside this process would not be found by
// that grep. The two are never lost — `callIdFields` puts the request id on the line whenever it
// differs from the correlation id, so the join between the two id spaces is on record.
interface CallIds {
  readonly requestId: string;
  readonly correlationId: string;
}

function callIds(requestId: string, request: GatewayCallRequest): CallIds {
  return { requestId, correlationId: request.logContext?.correlationId ?? requestId };
}

function callIdFields(ids: CallIds): Readonly<Record<string, unknown>> {
  return ids.correlationId === ids.requestId ? {} : { requestId: ids.requestId };
}

function gatewayEvent(
  level: ModelGatewayLogLevel,
  op: string,
  correlationId: string | undefined,
  extra: Readonly<Record<string, unknown>>,
  durationMs?: number,
  errorKind?: string,
): ModelGatewayLogEvent {
  return { level, category: "gateway", op, correlationId, durationMs, errorKind, extra };
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

function recordProviderFailure(
  breaker: CircuitBreaker,
  error: unknown,
  correlationId: string,
): void {
  if (!(error instanceof CancelledError) && !(error instanceof ConfigInvalidError)) {
    breaker.recordFailure(correlationId);
  }
}

interface RoutedCall {
  readonly provider: ModelProviderConfig;
  readonly capability: ModelCapability;
}

// Bare hostname only — never `scheme://host:port` (that's `logEndpointHost`, used on the per-call
// attempt line) and never the full `baseUrl`, which can carry a path or embedded credentials for a
// misconfigured provider entry (`https://user:token@host/deploy-path`). An unparseable URL yields
// undefined rather than echoing the raw string back, mirroring `logEndpointHost`'s own failure mode.
function providerEndpointHost(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

// The moment worth naming on a stream is the FIRST content the caller actually saw, not the first
// chunk of any kind — a synthesised buffered-fallback stream's lone "delta" already carries the
// whole answer, and a provider's own stream can open with a role-only or empty delta before real
// content arrives. Called on every chunk; returns undefined once a non-empty one has already fired
// so the caller's `??=` never re-times a later chunk.
function firstNonEmptyDeltaMs(
  chunk: GatewayStreamChunk,
  elapsed: () => number,
): number | undefined {
  return chunk.type === "delta" && chunk.token.length > 0 ? elapsed() : undefined;
}

// A minimal usage projection carried on the stream-completed line — never the full UsageMetadata,
// whose `requestId`/`latencyMs`/`costClass` are already on the envelope or on `extra` elsewhere.
interface StreamTerminalUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

// Streaming usage is accumulated by the adapter from an optional provider-supplied final chunk
// (OpenAI's `include_usage`); a provider that never sends one leaves both counts at their initial
// zero. Zero counts are therefore not a measurement, they are the absence of one — logging them
// would tell an operator "this call cost nothing", which is a stronger and false claim compared to
// simply not printing a field the provider never supplied.
function streamUsageIfSupplied(usage: UsageMetadata | undefined): StreamTerminalUsage | undefined {
  if (usage === undefined || (usage.promptTokens === 0 && usage.completionTokens === 0)) {
    return undefined;
  }
  return { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens };
}

export class Gateway {
  private readonly spendBudget: GatewaySpendBudget | undefined;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly adapter: ProviderAdapter | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly providers: ReadonlyMap<string, ModelProviderConfig>;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly log: ModelGatewayLogSink;

  constructor(
    private readonly config: GatewayConfig,
    deps: GatewayDeps = {},
  ) {
    this.spendBudget = deps.spendBudget;
    this.clock = deps.clock ?? systemClock;
    this.random = deps.random ?? Math.random;
    this.adapter = deps.adapter;
    this.fetchImpl = deps.fetchImpl;
    this.log = resolveLogSink(deps.log);
    this.providers = new Map(config.providers.map((p) => [p.modelId, p]));
    this.logConfigResolved();
  }

  private prepareRequest(
    request: GatewayCallRequest,
    capability: ModelCapability,
  ): GatewayCallRequest {
    assertValidGatewaySamplingParameters(request);
    if (this.spendBudget === undefined || request.maxOutputTokens !== undefined) return request;
    return { ...request, maxOutputTokens: capability.maxOutputTokens };
  }

  // ONE-TIME configuration snapshot, written once per Gateway construction (the process-wide
  // instance cache in keiko-server constructs exactly one Gateway per distinct GatewayConfig, so
  // this line does not repeat on every call). Answers "what did the gateway actually resolve to
  // run with" — the question an operator has no other way to answer once a provider's env-sourced
  // baseUrl or timeout has been merged and parsed. Per-provider fields only, and never `baseUrl`
  // or `apiKey`: `endpointHost` is the bare hostname a misconfigured entry cannot turn into a path
  // or embedded-credential leak.
  private logConfigResolved(): void {
    this.log.write(
      gatewayEvent("info", "gateway.config.resolved", undefined, {
        providers: this.config.providers.map((provider) => ({
          modelId: provider.modelId,
          endpointHost: providerEndpointHost(provider.baseUrl),
          timeoutMs: provider.timeoutMs,
          maxRetries: provider.maxRetries,
          retryBaseDelayMs: provider.retryBaseDelayMs,
        })),
      }),
    );
  }

  async chat(request: GatewayCallRequest): Promise<NormalizedResponse> {
    const route = this.route(request.modelId, request.logContext?.correlationId);
    request = this.prepareRequest(request, route.capability);
    const breaker = this.breakerFor(route.provider);
    const requestId = randomUUID();
    const ids = callIds(requestId, request);
    const start = this.clock.now();
    const elapsed = logTimer();
    const adapter = this.adapterFor(requestId, route.capability, ids.correlationId);
    this.logCallStarted(ids, route, false, request.reasoningEffort);
    let result;
    try {
      result = await executeWithRetry(
        (attemptTimeoutMs) =>
          this.invoke(breaker, adapter, request, route.capability, ids.correlationId, {
            ...route.provider,
            ...(attemptTimeoutMs === undefined ? {} : { timeoutMs: attemptTimeoutMs }),
          }),
        route.provider,
        this.clock,
        request.cancellationSignal,
        this.random,
        { sink: this.log, modelId: route.provider.modelId, correlationId: ids.correlationId },
      );
    } catch (error) {
      // RB-6: stamp the gateway request id onto the thrown error so a FAILED buffered call is
      // traceable to the gateway record (previously requestId was attached only on success/usage).
      attachGatewayRequestId(error, requestId);
      this.logCallFailed(ids, route, elapsed(), error);
      throw error;
    }
    this.logCallCompleted(ids, route, result, elapsed());
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
  async *chatStream(request: GatewayCallRequest): AsyncGenerator<GatewayStreamChunk> {
    const route = this.route(request.modelId, request.logContext?.correlationId);
    request = this.prepareRequest(request, route.capability);
    const breaker = this.breakerFor(route.provider);
    const ids = callIds(randomUUID(), request);
    breaker.assertAllowed(ids.correlationId);
    const start = this.clock.now();
    const elapsed = logTimer();
    const adapter = this.adapterFor(ids.requestId, route.capability, ids.correlationId);
    this.logCallStarted(ids, route, true, request.reasoningEffort);
    let reservation: GatewaySpendReservation | undefined;
    let chunkCount = 0;
    // The moment the caller saw its first actual content, timed off the same `elapsed()` as every
    // other stream outcome. `??=` locks it in on the first non-empty delta and leaves it alone.
    let firstTokenMs: number | undefined;
    let terminalUsage: UsageMetadata | undefined;
    // EVERY started stream needs exactly one outcome line. Set the moment an outcome is written,
    // so the `finally` can tell "the consumer walked away" from the two paths that already spoke.
    let settled = false;
    try {
      reservation = this.spendBudget?.reserve(route.capability, request, ids.correlationId);
      for await (const chunk of this.streamFrom(adapter, request, route.provider, ids)) {
        chunkCount += 1;
        firstTokenMs ??= firstNonEmptyDeltaMs(chunk, elapsed);
        if (chunk.type === "done") {
          terminalUsage = chunk.response.usage;
          yield {
            type: "done",
            response: this.enrich(chunk.response, ids.requestId, start, route),
          };
        } else {
          yield chunk;
        }
      }
      breaker.recordSuccess(ids.correlationId);
      settled = true;
    } catch (error) {
      settled = true;
      this.failStream(ids, route, breaker, chunkCount, elapsed(), error);
    } finally {
      reservation?.settle(terminalUsage);
      // A consumer that stops iterating (client disconnect, request abort, `break`) closes this
      // generator through `return()`: the loop is left without running either outcome branch, so
      // without this line the log keeps `gateway.stream.started` with nothing after it — the exact
      // shape of a wedged provider. Not a failure and not a fault, so it is an outcome of its own.
      if (!settled) {
        this.logStreamAbandoned(ids, route, chunkCount, elapsed());
      }
    }
    // Outside the try on purpose: a sink that throws here must not be caught above and reported as
    // a mid-stream provider failure — which would also trip the circuit breaker on a logging fault.
    this.logStreamCompleted(
      ids,
      route,
      chunkCount,
      elapsed(),
      firstTokenMs,
      streamUsageIfSupplied(terminalUsage),
    );
  }

  private failStream(
    ids: CallIds,
    route: RoutedCall,
    breaker: CircuitBreaker,
    chunkCount: number,
    durationMs: number,
    error: unknown,
  ): never {
    recordProviderFailure(breaker, error, ids.correlationId);
    attachGatewayRequestId(error, ids.requestId);
    this.logStreamFailed(ids, route, chunkCount, durationMs, error);
    throw error;
  }

  // THE ATTEMPT LINE for a model call — written BEFORE the adapter is invoked, not after it
  // returns. A provider that accepts the connection and then goes quiet produces no completion
  // and no failure, so without this the gateway is silent for exactly the window an operator is
  // trying to diagnose. `timeoutMs` and `maxRetries` are on it because the pair bounds how long
  // this silence can legitimately last: an attempt line whose deadline has already passed with no
  // outcome is a wedge, not a slow provider.
  private logCallStarted(
    ids: CallIds,
    route: RoutedCall,
    streaming: boolean,
    reasoningEffort: GatewayCallRequest["reasoningEffort"],
  ): void {
    if (!logLevelEnabled(this.log, "info")) return;
    this.log.write(
      gatewayEvent(
        "info",
        streaming ? "gateway.stream.started" : "gateway.chat.started",
        ids.correlationId,
        {
          ...callIdFields(ids),
          modelId: route.provider.modelId,
          endpoint: logEndpointHost(route.provider.baseUrl),
          costClass: route.capability.costClass,
          timeoutMs: route.provider.timeoutMs,
          maxRetries: route.provider.maxRetries,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          streaming,
        },
      ),
    );
  }

  private logCallFailed(ids: CallIds, route: RoutedCall, durationMs: number, error: unknown): void {
    this.log.write(
      gatewayEvent(
        "warn",
        "gateway.chat.failed",
        ids.correlationId,
        { ...callIdFields(ids), modelId: route.provider.modelId, streaming: false },
        durationMs,
        logErrorKind(error),
      ),
    );
  }

  private logStreamCompleted(
    ids: CallIds,
    route: RoutedCall,
    chunkCount: number,
    durationMs: number,
    firstTokenMs: number | undefined,
    usage: StreamTerminalUsage | undefined,
  ): void {
    this.log.write(
      gatewayEvent(
        "info",
        "gateway.stream.completed",
        ids.correlationId,
        {
          ...callIdFields(ids),
          modelId: route.provider.modelId,
          costClass: route.capability.costClass,
          chunkCount,
          ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
          ...usage,
        },
        durationMs,
      ),
    );
  }

  // The third stream outcome: the provider never finished because nobody was listening any more.
  // `info`, not `warn` — a user pressing stop is routine, and the line exists to close the
  // started/outcome pair an operator scans for, not to report a fault. `chunkCount` says how much
  // of the answer had already been paid for and thrown away.
  private logStreamAbandoned(
    ids: CallIds,
    route: RoutedCall,
    chunkCount: number,
    durationMs: number,
  ): void {
    this.log.write(
      gatewayEvent(
        "info",
        "gateway.stream.abandoned",
        ids.correlationId,
        {
          ...callIdFields(ids),
          modelId: route.provider.modelId,
          costClass: route.capability.costClass,
          streaming: true,
          chunkCount,
          reason: "consumer-stopped-iterating",
        },
        durationMs,
      ),
    );
  }

  private logStreamFailed(
    ids: CallIds,
    route: RoutedCall,
    chunkCount: number,
    durationMs: number,
    error: unknown,
  ): void {
    this.log.write(
      gatewayEvent(
        "warn",
        "gateway.stream.failed",
        ids.correlationId,
        {
          ...callIdFields(ids),
          modelId: route.provider.modelId,
          streaming: true,
          chunkCount,
          // A mid-stream failure has already handed tokens to the caller and cannot be retried
          // (chatStream is deliberately outside executeWithRetry); the count is how far it got.
          afterFirstChunk: chunkCount > 0,
        },
        durationMs,
        logErrorKind(error),
      ),
    );
  }

  // Buffered completions only: the streaming path has its own outcome lines with their own fields
  // (`gateway.stream.completed` / `.abandoned` / `.failed`). The `streaming: false` here is a
  // constant of THIS op rather than a parameter — a caller able to pass `true` would emit
  // `gateway.chat.completed` for a stream and break the op naming every reader filters on.
  private logCallCompleted(
    ids: CallIds,
    route: RoutedCall,
    result: NormalizedResponse,
    durationMs: number,
  ): void {
    this.log.write(
      gatewayEvent(
        "info",
        "gateway.chat.completed",
        ids.correlationId,
        {
          ...callIdFields(ids),
          modelId: route.provider.modelId,
          costClass: route.capability.costClass,
          finishReason: result.finishReason,
          toolCallCount: result.toolCalls.length,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          streaming: false,
        },
        durationMs,
      ),
    );
  }

  private async *streamFrom(
    adapter: ProviderAdapter,
    request: GatewayCallRequest,
    provider: ModelProviderConfig,
    ids: CallIds,
  ): AsyncGenerator<GatewayStreamChunk> {
    if (adapter.callStream !== undefined) {
      yield* adapter.callStream(request, provider);
      return;
    }
    // Degradation: this adapter has no streaming variant, so the caller gets ONE synthetic delta
    // after the full buffered latency instead of incremental tokens. Silently, that reads to an
    // operator as a provider that took seconds to emit its first token.
    this.log.write(
      gatewayEvent("warn", "gateway.stream.buffered-fallback", ids.correlationId, {
        ...callIdFields(ids),
        modelId: provider.modelId,
        reason: "adapter-has-no-stream",
      }),
    );
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
    request: GatewayCallRequest,
    capability: ModelCapability,
    correlationId: string,
    provider: ModelProviderConfig,
  ): Promise<NormalizedResponse> {
    breaker.assertAllowed(correlationId);
    const reservation = this.spendBudget?.reserve(capability, request, correlationId);
    let usage: UsageMetadata | undefined;
    try {
      const response = await adapter.call(request, provider);
      usage = response.usage;
      breaker.recordSuccess(correlationId);
      return response;
    } catch (error) {
      // A client-initiated cancel is not a provider fault — skip the breaker.
      recordProviderFailure(breaker, error, correlationId);
      throw error;
    } finally {
      reservation?.settle(usage);
    }
  }

  // Fail-closed routing. Each of the three refusals is a DIFFERENT operator problem — an unknown
  // model id, a configured provider with no capability metadata, and a correctly configured model
  // of the wrong kind — and all three surface to the caller as the same UnknownModelError, so the
  // reason label is the only thing that separates them after the fact.
  //
  // Routing happens BEFORE this call has a request id of its own, so the caller's correlation id
  // is the only thing that can attribute a refusal to the operation that provoked it — and a
  // refusal is exactly the "never started" case an operator has to separate from "started and
  // hung". Absent when the caller supplied none, as before.
  private logRouteRejected(
    modelId: string,
    correlationId: string | undefined,
    reason: string,
    kind?: string,
  ): void {
    this.log.write(
      gatewayEvent("warn", "gateway.route.rejected", correlationId, { modelId, reason, kind }),
    );
  }

  private route(modelId: string, correlationId?: string): RoutedCall {
    const provider = this.providers.get(modelId);
    if (provider === undefined) {
      this.logRouteRejected(modelId, correlationId, "no-provider-configured");
      throw new UnknownModelError(`no provider configured for model '${modelId}'`);
    }
    const capability = findConfiguredCapability(this.config, modelId);
    if (capability === undefined) {
      this.logRouteRejected(modelId, correlationId, "no-capability-metadata");
      throw new UnknownModelError(`model '${modelId}' has no capability metadata`);
    }
    if (capability.kind !== "chat") {
      this.logRouteRejected(modelId, correlationId, "wrong-model-kind", capability.kind);
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
    // Prefer the provider-level override (audit KEIKO-0167). Falls through to the top-level
    // GatewayConfig.circuitBreaker when the provider did not declare its own — every existing
    // config keeps its exact behaviour.
    const breakerConfig = provider.circuitBreaker ?? this.config.circuitBreaker;
    const breaker = new CircuitBreaker(provider.modelId, breakerConfig, this.clock, this.log);
    this.breakers.set(provider.modelId, breaker);
    return breaker;
  }

  private adapterFor(
    requestId: string,
    capability: ModelCapability,
    correlationId: string,
  ): ProviderAdapter {
    return (
      this.adapter ??
      new OpenAiAdapter({
        requestId,
        costClass: capability.costClass,
        now: this.clock.now,
        fetchImpl: this.fetchImpl,
        log: this.log,
        logContext: { correlationId },
      })
    );
  }
}
