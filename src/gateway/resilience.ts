// Resilience primitives: a real-time Clock, a bounded exponential-backoff retry
// loop, and a per-(model,endpoint) circuit breaker. All time-dependent behaviour
// flows through the injectable Clock so tests are deterministic and instant.

import { CircuitOpenError, GatewayError, RateLimitError } from "./errors.js";
import type { CircuitBreakerConfig, CircuitBreakerStatus, CircuitState, Clock } from "./types.js";

const MAX_BACKOFF_MS = 30_000;

export const systemClock: Clock = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface RetryConfig {
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
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
    return error.retryAfterMs;
  }
  return backoffDelayMs(attempt, base);
}

export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig,
  clock: Clock,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const delay =
        attempt <= config.maxRetries ? retryDelayMs(error, attempt, config.retryBaseDelayMs) : null;
      if (delay === null) {
        throw error;
      }
      await clock.sleep(delay);
    }
  }
  throw lastError;
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
