/**
 * Correlation-id + header-building primitives shared by the BFF fetch scaffold (`./http`) and the
 * desktop chat SSE client (`./api`).
 *
 * Kept as its own leaf module (no dependency on `./api`) so both call sites can share ONE
 * implementation without a module cycle: `./http` imports `ApiError` from `./api` (documented
 * one-way edge there), so `./api` importing header-building helpers FROM `./http` would close a
 * cycle. Neither of these primitives needs `ApiError`, so they live here instead and `./http`
 * re-exports `CORRELATION_HEADER`/`newClientCorrelationId` for its existing consumers.
 */

import { secureRandomId } from "./secure-random";

// RB-6 (GEN-OBS-CORRELATION-601): a per-request correlation id sent on X-Keiko-Correlation-Id so a
// failure is traceable UI -> server with a single id (the server honours a well-formed client id and
// echoes it back). Header-safe alphabet + length, matching the server's SAFE_CORRELATION_ID predicate.
export const CORRELATION_HEADER = "X-Keiko-Correlation-Id";

export function newClientCorrelationId(): string {
  return secureRandomId("ui");
}

// Builds the request headers as the union of both historical styles. `init.headers` win last so a
// caller can still override any computed header (e.g. a non-JSON Accept). A correlation id is added
// unless the caller already supplied one.
export function buildBffHeaders(init: RequestInit | undefined, correlationId: string): HeadersInit {
  const method = (init?.method ?? "GET").toUpperCase();
  const isStateChanging = method !== "GET" && method !== "HEAD";
  const hasBody = init?.body !== undefined && init.body !== null;
  return {
    Accept: "application/json",
    [CORRELATION_HEADER]: correlationId,
    ...(isStateChanging || hasBody ? { "Content-Type": "application/json" } : {}),
    ...(isStateChanging ? { "X-Keiko-CSRF": "1" } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
}
