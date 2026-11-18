// Deterministic 429 backoff for the bounded Figma snapshot-build (Epic #750, Issue #759).
//
// Figma rate-limits the scoped `/v1/files/:key/nodes` fetch and the `/v1/images` render with HTTP
// 429. On a huge enterprise board these are expected, not exceptional, so the snapshot-build must
// retry them on a deterministic exponential schedule rather than failing or hammering the API.
//
// Scope discipline: ONLY a 429 is retried here. A 4xx (auth/scope/not-found) or 5xx is surfaced
// to the caller unchanged — those are not rate-limit conditions and must not be silently retried.
// There is NO webhook, NO polling, and NO timer beyond the injectable `sleep` seam: the whole
// schedule is driven by the caller's awaited promise chain, so a mocked sleep makes tests instant.
//
// The `sleep` seam is injectable so unit tests record the exact delay schedule without waiting.
// A valid `Retry-After` (whole seconds) is honored if it fits the delay budget.

import { FigmaConnectorError } from "./figmaConnectorErrors.js";

/** Injectable wait seam — the default is real `setTimeout`; tests pass a synchronous recorder. */
export type FigmaRetrySleep = (ms: number) => Promise<void>;

export interface FigmaRetryPolicy {
  /** Maximum extra attempts after the first; total attempts = maxRetries + 1. */
  readonly maxRetries: number;
  /** First backoff delay in ms; subsequent delays double until `maxDelayMs`. */
  readonly baseDelayMs: number;
  /** Hard ceiling for any single delay (computed or `Retry-After`) — prevents unbounded waits. */
  readonly maxDelayMs: number;
}

/**
 * Bounded, conservative default well inside Figma's documented limits. Patient enough (8 retries,
 * 45s ceiling) that the multi-fetch deep scoped-pagination build (#837) absorbs the cost-based 429
 * bursts a large board provokes instead of aborting, while staying finite so a genuinely down API
 * still fails fast-ish.
 */
export const DEFAULT_FIGMA_RETRY_POLICY: FigmaRetryPolicy = {
  maxRetries: 8,
  baseDelayMs: 500,
  maxDelayMs: 45_000,
};

/** The minimum a backoff-capable response must expose: a status and (lower-cased) headers. */
export interface FigmaBackoffResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The real-timer sleep used by the default ports. */
export const realFigmaRetrySleep: FigmaRetrySleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const FIGMA_RATE_LIMIT_STATUS = 429;

const computeBackoffMs = (attempt: number, policy: FigmaRetryPolicy): number => {
  const exponential = policy.baseDelayMs * 2 ** attempt;
  return Math.min(exponential, policy.maxDelayMs);
};

// Retry-After is either whole seconds or an HTTP date; anything else is ignored. A date in the
// past means "now", so it reads as a zero delay.
const retryAfterMs = (
  headers: Readonly<Record<string, string>> | undefined,
  now: () => number,
): number | undefined => {
  const raw = headers?.["retry-after"]?.trim();
  if (raw === undefined) return undefined;
  if (/^\d+$/u.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now());
};

/**
 * Run `operation` (a single attempt), retrying ONLY on HTTP 429 with deterministic exponential
 * backoff up to `policy.maxRetries`. Honours `Retry-After` (seconds or HTTP date) over the computed
 * delay, and reports it on the error.
 * Throws FIGMA_RATE_LIMITED once the bounded retries are exhausted; never retries a non-429.
 */
export const fetchWithBackoff = async <R extends FigmaBackoffResponse>(
  operation: () => Promise<R>,
  policy: FigmaRetryPolicy,
  sleep: FigmaRetrySleep,
  now: () => number = Date.now,
): Promise<R> => {
  let explicitDelay: number | undefined;
  for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
    const response = await operation(); // NOSONAR typescript:S9382 -- the current status determines whether another attempt is needed.
    if (response.status !== FIGMA_RATE_LIMIT_STATUS) return response;
    // Read the header before any exit so the error keeps what Figma asked for, even with no retry.
    explicitDelay = retryAfterMs(response.headers, now);
    if (attempt === policy.maxRetries) break;
    const delay = explicitDelay ?? computeBackoffMs(attempt, policy);
    // A shorter wait would send requests while the provider has instructed us to stop.
    if (delay > policy.maxDelayMs) break;
    await sleep(delay); // NOSONAR typescript:S9382 -- wait before another attempt to respect Retry-After.
  }
  throw new FigmaConnectorError("FIGMA_RATE_LIMITED", explicitDelay);
};
