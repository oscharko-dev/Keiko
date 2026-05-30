// Resilience primitives: a real-time Clock, a bounded exponential-backoff retry
// loop, and a per-(model,endpoint) circuit breaker. All time-dependent behaviour
// flows through the injectable Clock so tests are deterministic and instant.

import { CancelledError, CircuitOpenError, GatewayError, RateLimitError } from "./errors.js";
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

function backoffDelayMs(attempt: number, base: number): number {
  return Math.min(base * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

// A RateLimitError with an explicit retryAfterMs is honoured; otherwise the error's
// own `retryable` flag decides. Non-GatewayErrors are never retried.
function retryDelayMs(error: unknown, attempt: number, base: number): number | null {
  if (!(error instanceof GatewayError) || !error.retryable) {
    return null;
  }
  if (error instanceof RateLimitError && error.retryAfterMs !== null && error.retryAfterMs > 0) {
    return Math.min(error.retryAfterMs, MAX_BACKOFF_MS);
  }
  return backoffDelayMs(attempt, base);
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

export async function executeWithRetry<T>(
  operation: (attemptTimeoutMs?: number) => Promise<T>,
  config: RetryConfig,
  clock: Clock,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: Error | undefined;
  const start = clock.now();
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
    assertNotAborted(signal);
    const attemptBudget = remainingBudgetMs(start, config.timeoutMs, clock);
    if (attemptBudget <= 0) {
      if (lastError) {
        throw lastError;
      }
      throw new CancelledError("request timeout budget exhausted before provider call");
    }
    try {
      return await operation(
        Number.isFinite(attemptBudget) ? Math.max(1, Math.floor(attemptBudget)) : undefined,
      );
    } catch (error) {
      lastError = asError(error);
      const delay =
        attempt <= config.maxRetries
          ? retryDelayMs(lastError, attempt, config.retryBaseDelayMs)
          : null;
      if (delay === null) {
        throw lastError;
      }
      const remaining = remainingBudgetMs(start, config.timeoutMs, clock);
      if (remaining <= 0) {
        throw lastError;
      }
      await sleepWithCancellation(clock, Math.min(delay, remaining), signal);
    }
  }
  throw lastError ?? new CancelledError("request timeout budget exhausted after retries");
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private probesRemaining = 0;

  constructor(
    private readonly modelId: string,
    private readonly config: CircuitBreakerConfig,
    private readonly clock: Clock,
  ) {}

  // Called before forwarding a request. Throws CircuitOpenError when the breaker is
  // open and the cooldown has not elapsed; otherwise lets the call through (entering
  // half-open as a side effect when cooldown has passed).
  assertAllowed(): void {
    if (this.state === "open") {
      if (this.openedAt !== null && this.clock.now() - this.openedAt >= this.config.cooldownMs) {
        this.state = "half-open";
        this.probesRemaining = this.config.halfOpenProbes;
        return;
      }
      throw new CircuitOpenError(`circuit open for model '${this.modelId}'`);
    }
  }

  recordSuccess(): void {
    if (this.state === "half-open") {
      this.probesRemaining -= 1;
      if (this.probesRemaining <= 0) {
        this.close();
      }
      return;
    }
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    if (this.state === "half-open") {
      this.open();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.open();
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

  private open(): void {
    this.state = "open";
    this.openedAt = this.clock.now();
    this.probesRemaining = 0;
  }

  private close(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.probesRemaining = 0;
  }
}
