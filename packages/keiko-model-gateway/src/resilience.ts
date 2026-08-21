// Resilience primitives: a real-time Clock, a bounded exponential-backoff retry
// loop, and a per-(model,endpoint) circuit breaker. All time-dependent behaviour
// flows through the injectable Clock so tests are deterministic and instant.

import {
  CancelledError,
  CircuitOpenError,
  GatewayError,
  RateLimitError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import {
  logErrorKind,
  logLevelEnabled,
  logTimer,
  nullModelGatewayLogSink,
  resolveLogSink,
  type ModelGatewayLogEvent,
  type ModelGatewayLogLevel,
  type ModelGatewayLogSink,
} from "./observability.js";
import type { CircuitBreakerConfig, CircuitBreakerStatus, CircuitState, Clock } from "./types.js";

const MAX_BACKOFF_MS = 30_000;

export const systemClock: Clock = {
  now: (): number => Date.now(),
  sleep: (ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted === true) {
      return Promise.reject(new DOMException("cancelled", "AbortError"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort(): void {
        clearTimeout(timeout);
        reject(new DOMException("cancelled", "AbortError"));
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};

export interface RetryConfig {
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly timeoutMs?: number | undefined;
}

// Equal jitter over the capped exponential ladder: half the delay is fixed, half
// is random, so concurrent callers hitting a recovering provider spread across
// [0.5·d, d] instead of retrying in lockstep (thundering herd) while never
// collapsing to a zero delay. Randomness is injected for deterministic tests.
function backoffDelayMs(attempt: number, base: number, random: () => number): number {
  const capped = Math.min(base * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return capped * (0.5 + 0.5 * random());
}

// A RateLimitError with an explicit retryAfterMs is honoured VERBATIM (the server
// told us when to come back — jitter would only delay recovery); otherwise the
// error's own `retryable` flag decides. Non-GatewayErrors are never retried.
function retryDelayMs(
  error: unknown,
  attempt: number,
  base: number,
  random: () => number,
): number | null {
  if (!(error instanceof GatewayError) || !error.retryable) {
    return null;
  }
  if (error instanceof RateLimitError && error.retryAfterMs !== null && error.retryAfterMs > 0) {
    return Math.min(error.retryAfterMs, MAX_BACKOFF_MS);
  }
  return backoffDelayMs(attempt, base, random);
}

// Resolves the next backoff sleep for a failed attempt, bounded by the remaining
// end-to-end budget — or null when the error is terminal, retries are exhausted,
// or no budget remains (the caller then rethrows the last error).
function boundedRetrySleepMs(
  lastError: Error,
  attempt: number,
  config: RetryConfig,
  clock: Clock,
  start: number,
  random: () => number,
): number | null {
  const delay =
    attempt <= config.maxRetries
      ? retryDelayMs(lastError, attempt, config.retryBaseDelayMs, random)
      : null;
  if (delay === null) {
    return null;
  }
  const remaining = remainingBudgetMs(start, config.timeoutMs, clock);
  if (remaining <= 0) {
    return null;
  }
  return Math.min(delay, remaining);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new CancelledError("request cancelled during retry");
  }
}

function remainingBudgetMs(start: number, timeoutMs: number | undefined, clock: Clock): number {
  if (timeoutMs === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, timeoutMs - (clock.now() - start));
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

async function sleepWithCancellation(
  clock: Clock,
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  assertNotAborted(signal);
  try {
    await clock.sleep(delayMs, signal);
  } catch (error) {
    if (signal?.aborted === true) {
      throw new CancelledError("request cancelled during retry backoff");
    }
    throw error;
  }
  assertNotAborted(signal);
}

// What the retry loop needs in order to LABEL its lines. Optional in full: an unwired caller
// keeps the exact behaviour it had before instrumentation, down to the allocation count.
export interface RetryLogContext {
  readonly sink?: ModelGatewayLogSink | undefined;
  readonly modelId?: string | undefined;
  readonly correlationId?: string | undefined;
}

function retryEvent(
  context: RetryLogContext,
  level: ModelGatewayLogLevel,
  op: string,
  durationMs: number,
  error: Error | undefined,
  extra: Readonly<Record<string, unknown>>,
): ModelGatewayLogEvent {
  return {
    level,
    category: "gateway",
    op,
    correlationId: context.correlationId,
    durationMs,
    errorKind: error === undefined ? undefined : logErrorKind(error),
    extra: { modelId: context.modelId, ...extra },
  };
}

// The budget ran out BEFORE an attempt was made. Preserves the original throw exactly (the last
// provider error when there is one, a CancelledError otherwise) and only adds the line that says
// which of the two happened — the difference between "the provider kept failing" and "the caller's
// deadline was already spent" is invisible from the thrown error alone.
function budgetExhaustedError(
  lastError: Error | undefined,
  sink: ModelGatewayLogSink,
  context: RetryLogContext,
  attempt: number,
  durationMs: number,
): Error {
  const error =
    lastError ?? new CancelledError("request timeout budget exhausted before provider call");
  sink.write(
    retryEvent(context, "warn", "gateway.retry.budget-exhausted", durationMs, error, {
      attempt,
      hadPriorFailure: lastError !== undefined,
    }),
  );
  return error;
}

export async function executeWithRetry<T>(
  operation: (attemptTimeoutMs?: number) => Promise<T>,
  config: RetryConfig,
  clock: Clock,
  signal?: AbortSignal,
  random: () => number = Math.random,
  logContext: RetryLogContext = {},
): Promise<T> {
  const sink = resolveLogSink(logContext.sink);
  const elapsed = logTimer();
  let lastError: Error | undefined;
  const start = clock.now();
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
    assertNotAborted(signal);
    const attemptBudget = remainingBudgetMs(start, config.timeoutMs, clock);
    if (attemptBudget <= 0) {
      throw budgetExhaustedError(lastError, sink, logContext, attempt, elapsed());
    }
    try {
      return await operation(
        Number.isFinite(attemptBudget) ? Math.max(1, Math.floor(attemptBudget)) : undefined,
      );
    } catch (error) {
      lastError = asError(error);
      const sleepMs = boundedRetrySleepMs(lastError, attempt, config, clock, start, random);
      if (sleepMs === null) {
        sink.write(
          retryEvent(logContext, "warn", "gateway.retry.exhausted", elapsed(), lastError, {
            attempt,
            maxRetries: config.maxRetries,
          }),
        );
        throw lastError;
      }
      sink.write(
        retryEvent(logContext, "warn", "gateway.retry.scheduled", elapsed(), lastError, {
          attempt,
          maxRetries: config.maxRetries,
          delayMs: sleepMs,
        }),
      );
      await sleepWithCancellation(clock, sleepMs, signal);
    }
  }
  throw lastError ?? new CancelledError("request timeout budget exhausted after retries");
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private probesRemaining = 0;
  // Tracks how many half-open probe slots are currently in-flight.
  private probesInFlight = 0;
  // Calls refused since the last state change. See `noteRejection` — this is both the rate limiter
  // and the number the transition lines report, so the volume survives the demotion.
  private rejectedSinceTransition = 0;

  constructor(
    private readonly modelId: string,
    private readonly config: CircuitBreakerConfig,
    private readonly clock: Clock,
    private readonly log: ModelGatewayLogSink = nullModelGatewayLogSink,
  ) {}

  // Every state transition and every fail-closed rejection is a line. A breaker that opens and
  // stays open is otherwise indistinguishable, from the outside, from a provider that has simply
  // gone quiet: the caller sees CircuitOpenError either way and no attempt ever reaches the wire.
  //
  // `correlationId` is the CALL that provoked the line, when there is one. A breaker is shared by
  // every caller of a model, so a refusal line without it says "some request was refused" — which,
  // with N requests in flight against one endpoint, does not tell an operator which of them is the
  // one that never came back. The state transitions reached from a completed call
  // (`open`/`closed`) are facts about the MODEL rather than about one request, and carry the id of
  // the call that tipped them purely as the attribution of the trigger.
  private emit(
    level: ModelGatewayLogLevel,
    op: string,
    extra: Readonly<Record<string, unknown>>,
    correlationId: string | undefined,
  ): void {
    this.log.write({
      level,
      category: "gateway",
      op,
      correlationId,
      extra: { modelId: this.modelId, ...extra },
    });
  }

  // A refused call is the highest-volume, lowest-information event this class produces: while the
  // breaker is open EVERY caller is refused, so a busy model under a provider outage turns one
  // fact — "the breaker for model X is open" — into thousands of identical `warn` lines, drowning
  // the transitions that actually carry news and pushing the lines before the outage out of the
  // retention window. That is worse than saying nothing: the log is loudest exactly when it is
  // least informative.
  //
  // So the FIRST refusal after each transition is reported at `warn` — an operator reading at the
  // default threshold still learns, once, that calls are being refused and why — and every
  // subsequent one is demoted to `debug` and counted. The count rides the next transition line
  // (`rejectedSinceTransition`), so nothing is lost: the volume is still reported, once, as a
  // number instead of as thousands of lines. The `logLevelEnabled` guard means a demoted refusal
  // costs a predicate call and an increment, not an allocation, when nobody is reading `debug`.
  private noteRejection(
    state: CircuitState,
    reason: string,
    correlationId: string | undefined,
  ): void {
    this.rejectedSinceTransition += 1;
    const first = this.rejectedSinceTransition === 1;
    if (!first && !logLevelEnabled(this.log, "debug")) return;
    this.emit(
      first ? "warn" : "debug",
      "gateway.circuit.rejected",
      {
        state,
        reason,
        probesInFlight: this.probesInFlight,
        rejectedSinceTransition: this.rejectedSinceTransition,
      },
      correlationId,
    );
  }

  // Returns the refusal count accumulated since the last transition and resets it, so every
  // transition line carries the volume of the window it is ending.
  private takeRejectedCount(): number {
    const rejected = this.rejectedSinceTransition;
    this.rejectedSinceTransition = 0;
    return rejected;
  }

  // Called before forwarding a request. Throws CircuitOpenError when the breaker is
  // open and the cooldown has not elapsed; otherwise lets the call through (entering
  // half-open as a side effect when cooldown has passed).
  // In half-open, at most config.halfOpenProbes concurrent probes are admitted; excess
  // callers receive CircuitOpenError until a probe slot is freed by recordSuccess/Failure.
  assertAllowed(correlationId?: string): void {
    if (this.state === "open") {
      this.enterHalfOpenOrReject(correlationId);
    }
    if (this.state === "half-open") {
      this.admitProbeOrReject(correlationId);
    }
  }

  private enterHalfOpenOrReject(correlationId: string | undefined): void {
    if (this.openedAt !== null && this.clock.now() - this.openedAt >= this.config.cooldownMs) {
      this.state = "half-open";
      this.probesRemaining = this.config.halfOpenProbes;
      this.probesInFlight = 0;
      this.emit(
        "info",
        "gateway.circuit.half-open",
        {
          probes: this.config.halfOpenProbes,
          rejectedWhileOpen: this.takeRejectedCount(),
        },
        correlationId,
      );
      return;
    }
    this.noteRejection("open", "cooldown", correlationId);
    throw new CircuitOpenError(`circuit open for model '${this.modelId}'`);
  }

  private admitProbeOrReject(correlationId: string | undefined): void {
    if (this.probesInFlight >= this.config.halfOpenProbes) {
      this.noteRejection("half-open", "probe-saturated", correlationId);
      throw new CircuitOpenError(`circuit half-open for model '${this.modelId}'`);
    }
    this.probesInFlight += 1;
  }

  recordSuccess(correlationId?: string): void {
    if (this.state === "half-open") {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      this.probesRemaining -= 1;
      if (this.probesRemaining <= 0) {
        this.close(correlationId);
      }
      return;
    }
    this.consecutiveFailures = 0;
  }

  recordFailure(correlationId?: string): void {
    if (this.state === "half-open") {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      this.open(correlationId);
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.open(correlationId);
    }
  }

  status(modelId: string): CircuitBreakerStatus {
    return {
      modelId,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
    };
  }

  // The transitions are the news, and they are rare — one per outage, not one per call. `opened`
  // stays `warn` because it is the moment the model stopped serving traffic; `half-open` and
  // `closed` are recoveries and stay `info`, where a recovery belongs. Each one carries the
  // refusals its window absorbed, which is the number the demoted per-call lines no longer report.
  private open(correlationId: string | undefined): void {
    const previousState = this.state;
    this.state = "open";
    this.openedAt = this.clock.now();
    this.probesRemaining = 0;
    this.probesInFlight = 0;
    this.emit(
      "warn",
      "gateway.circuit.opened",
      {
        previousState,
        consecutiveFailures: this.consecutiveFailures,
        cooldownMs: this.config.cooldownMs,
        rejectedSincePreviousTransition: this.takeRejectedCount(),
      },
      correlationId,
    );
  }

  private close(correlationId: string | undefined): void {
    const previousState = this.state;
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.probesRemaining = 0;
    this.probesInFlight = 0;
    this.emit(
      "info",
      "gateway.circuit.closed",
      {
        previousState,
        rejectedSincePreviousTransition: this.takeRejectedCount(),
      },
      correlationId,
    );
  }
}
