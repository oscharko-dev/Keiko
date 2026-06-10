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
// `Retry-After` (whole seconds) is honoured when present and numeric, capped at `maxDelayMs`.

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

// Parses a numeric `Retry-After` (whole seconds) into capped milliseconds. Returns undefined for a
// missing/non-numeric/negative value so the caller falls back to the computed exponential delay.
const retryAfterMs = (
  headers: Readonly<Record<string, string>> | undefined,
  policy: FigmaRetryPolicy,
): number | undefined => {
  const raw = headers?.["retry-after"];
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, policy.maxDelayMs);
};

/**
 * Run `operation` (a single attempt), retrying ONLY on HTTP 429 with deterministic exponential
 * backoff up to `policy.maxRetries`. Honours a numeric `Retry-After` over the computed delay.
 * Throws FIGMA_RATE_LIMITED once the bounded retries are exhausted; never retries a non-429.
 */
export const fetchWithBackoff = async <R extends FigmaBackoffResponse>(
  operation: () => Promise<R>,
  policy: FigmaRetryPolicy,
  sleep: FigmaRetrySleep,
): Promise<R> => {
  for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
    const response = await operation();
    if (response.status !== FIGMA_RATE_LIMIT_STATUS) return response;
    if (attempt === policy.maxRetries) break;
    const delay = retryAfterMs(response.headers, policy) ?? computeBackoffMs(attempt, policy);
    await sleep(delay);
  }
  throw new FigmaConnectorError("FIGMA_RATE_LIMITED");
};
