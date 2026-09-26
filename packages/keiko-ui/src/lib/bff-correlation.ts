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

interface BffRequestShape {
  readonly isStateChanging: boolean;
  readonly hasBody: boolean;
}

function classifyBffRequest(init: RequestInit | undefined): BffRequestShape {
  const method = (init?.method ?? "GET").toUpperCase();
  return {
    isStateChanging: method !== "GET" && method !== "HEAD",
    hasBody: init?.body !== undefined && init.body !== null,
  };
}

// Every legal `HeadersInit` shape (a plain record, a `Headers` instance, or a tuple array) reduced
// to `[name, value]` pairs. A plain record keeps the caller's own key casing; the other two shapes
// iterate the way the platform defines them (lower-cased names for a `Headers` instance).
function headerEntries(headers: HeadersInit | undefined): readonly (readonly [string, string])[] {
  if (headers === undefined) return [];
  if (headers instanceof Headers || Array.isArray(headers)) return [...new Headers(headers)];
  return Object.entries(headers);
}

// A caller-supplied header always wins over a computed default, matched case-insensitively the way
// the wire treats header names: the default under the other casing is removed, never left beside it.
function overrideHeader(record: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const existing of Object.keys(record)) {
    if (existing.toLowerCase() === lower) delete record[existing];
  }
  record[name] = value;
}

// Builds the request headers as the union of both historical styles, as the plain record every
// fetch consumer in this codebase (and its tests) reads. `init.headers` wins last so a caller can
// still override any computed header (e.g. a non-JSON Accept, or their own correlation id) — merged
// through `headerEntries`/`overrideHeader` rather than object-spread, because `HeadersInit` has
// three legal shapes and only a plain record spreads correctly: spreading a `Headers` instance
// yields no own enumerable properties (every caller header vanishes), and spreading a tuple array
// yields numeric-indexed junk instead of header names (#3241 review).
export function buildBffHeaders(
  init: RequestInit | undefined,
  correlationId: string,
): Record<string, string> {
  const { isStateChanging, hasBody } = classifyBffRequest(init);
  const headers: Record<string, string> = {
    Accept: "application/json",
    [CORRELATION_HEADER]: correlationId,
  };
  if (isStateChanging || hasBody) headers["Content-Type"] = "application/json";
  if (isStateChanging) headers["X-Keiko-CSRF"] = "1";
  for (const [name, value] of headerEntries(init?.headers)) overrideHeader(headers, name, value);
  return headers;
}
