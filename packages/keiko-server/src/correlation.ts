// Request-scoped correlation identifiers (RB-6 / GEN-OBS-CORRELATION-103/402/601).
//
// Every inbound HTTP request is stamped with a single correlation id that survives the whole
// request lifecycle: it is echoed back on the `X-Keiko-Correlation-Id` response header, folded into
// the `error.correlationId` field of any error body, threaded onto the `RouteContext`, and included
// in the SSE error frame and every server-side diagnostic record. A UI-supplied id (sent on the same
// header) is honoured when it is well formed, so a single id ties UI -> server -> gateway together;
// otherwise the server mints a fresh UUID. This is the shared plumbing the observability findings
// require and MUST NOT be reverted to a per-call anonymous id.

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

// Canonical header name (lower-case for `IncomingMessage.headers` lookups; the response header uses
// the same characters with conventional casing via CORRELATION_RESPONSE_HEADER).
export const CORRELATION_HEADER = "x-keiko-correlation-id";
export const CORRELATION_RESPONSE_HEADER = "X-Keiko-Correlation-Id";

// A UI-supplied correlation id is only trusted when it is short and drawn from an unambiguous,
// header-safe alphabet. Anything else (empty, oversized, CR/LF, arbitrary punctuation) is rejected
// so a client can neither inject response headers nor bloat the diagnostic log.
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function isValidCorrelationId(value: string): boolean {
  return SAFE_CORRELATION_ID.test(value);
}

export function newCorrelationId(): string {
  return randomUUID();
}

// A fixed, shape-valid stand-in for "no correlation id was known at this call site" — as opposed to
// a hostile or malformed one (see `diagnostics-log.ts`'s `INVALID_CORRELATION_ID_MARKER`, which
// covers that case). A `ServerDiagnosticRecord.correlationId` is required, so a caller with none in
// scope needs SOME value rather than an omission; several call sites used the bare literal
// `"unknown"` for this, but at 7 characters it always fails `isValidCorrelationId` itself and was
// silently rewritten to the sanitizer's own marker — making an honestly-absent id indistinguishable
// from a hostile one. This constant already satisfies the shape, so it survives the sanitizer and
// keeps its own distinct meaning.
export const UNKNOWN_CORRELATION_ID = "unknown-correlation-id";

// Service-layer fail-closed normalization for an optional correlation id. HTTP routes normally
// supply a value that `resolveCorrelationId` already validated, but internal callers and background
// entry points can invoke services directly. Never let an empty, oversized, or control-bearing value
// reach an adapter's termination evidence or a persisted event merely because it was non-nullish.
export function correlationIdOrUnknown(value: string | undefined): string {
  return value !== undefined && isValidCorrelationId(value) ? value : UNKNOWN_CORRELATION_ID;
}

// Resolves the correlation id for a request: reuse a well-formed client-supplied id (UI -> server
// continuity) or mint a fresh one. Never throws.
export function resolveCorrelationId(req: IncomingMessage): string {
  const header = req.headers[CORRELATION_HEADER];
  const candidate = Array.isArray(header) ? header[0] : header;
  if (typeof candidate === "string" && isValidCorrelationId(candidate)) {
    return candidate;
  }
  return newCorrelationId();
}
