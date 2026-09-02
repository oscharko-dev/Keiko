"use client";

// Where THIS application delivers client diagnostics (0.3.0 release audit, #2802; second
// transport added Wave 5 of epic #3233 / ADR-0173, g6).
//
// `client-diagnostics.ts` owns the contract — what a diagnostic is, and that it is already redacted.
// It deliberately owns no transport, so that the one place a browser console is written to is a
// module whose whole purpose is choosing the transport, rather than a line buried in the library
// every call site imports.
//
// Importing this module installs the transport as a side effect, at module scope rather than in an
// effect, so diagnostics raised during hydration or an early boot crash are delivered too. Whatever
// the sink buffered before this point is flushed by `setClientDiagnosticWriter`.
//
// FAN-OUT, NOT A REPLACEMENT: the console remains the first transport (a developer watching devtools
// still sees every diagnostic even when the network call below is slow, throttled, or fails) and a
// best-effort POST to `POST /api/diagnostics/client` (packages/keiko-server/src/
// client-diagnostics-routes.ts) is added alongside it, so the same already-redacted, already-bounded
// string also reaches the server's activity log — the machine-reconstruction surface the rest of
// epic #3233 builds. The wire contract (`packages/keiko-contracts/src/diagnostics.ts`) treats the
// browser as untrusted input regardless of what this module sends; nothing here is a second place
// that does redaction, it only forwards the SAME string `reportClientDiagnostic` callers already
// bounded and redacted by convention.
//
// `correlationId` (Wave 5, wired in a follow-up to this wave): `client-error-summary.ts`'s
// `correlationIdOf(error)` recovers the originating request's id from any caught `ApiError` (the
// class `bffFetchJson`, http.ts, stamps a `.correlationId` on for every non-2xx and every contract
// validation failure — api.ts ~line 195, http.ts ~lines 126-129/148-149). Every `reportClientDiagnostic`
// call site that catches such an error passes it through `meta.correlationId`, and
// `clientDiagnosticPostBody` below puts it on the wire once it re-validates the shape client-side
// (defense in depth — the server, `client-diagnostics-routes.ts`, re-validates it again
// independently before trusting it for anything). It stays genuinely absent for the four SSE
// `onerror` call sites (sharedEventSource.ts, useSSE.ts, coding-workbench-event-retention.ts,
// useRelationshipActivityStream.ts): the native `EventSource` API exposes no response headers to
// page script, so there is no id to recover at that call site, ever — not a gap, a hard platform
// limit.

import type {
  ClientDiagnosticIngestRequest,
  ClientDiagnosticReadyState,
} from "@oscharko-dev/keiko-contracts";
import { CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { type ClientDiagnosticMeta, setClientDiagnosticWriter } from "./client-diagnostics";
import { bffFetchJson } from "./http";

function writeToBrowserConsole(message: string): void {
  // The single sanctioned console access in keiko-ui production code. Everything above this line is
  // why it is here — in the transport, not in the sink — rather than at each call site.
  // eslint-disable-next-line no-console
  if (typeof console !== "undefined" && typeof console.warn === "function") console.warn(message);
}

// Fixed, bounded, and content-free by construction: it never repeats the original diagnostic
// message or any error detail, so it cannot itself become a place that leaks something the sink
// already redacted. Written with `writeToBrowserConsole` directly (never `reportClientDiagnostic`)
// — going back through the sink would re-enter `fanOutClientDiagnostic` and, on a persistently
// failing transport, retry the same failing POST on every diagnostic: a reporting loop.
const DIAGNOSTIC_DELIVERY_FAILURE_NOTICE =
  "[keiko] diagnostic delivery to the server failed; the diagnostic above (if any) was not recorded server-side.";
// Same reasoning as the failure notice: a throttled drop must leave a trace in the console, or the
// busiest boot — the one most likely to hold a real stall — is the one whose evidence vanishes silently.
// Written once per throttled window, never per dropped diagnostic.
const DIAGNOSTIC_DELIVERY_THROTTLED_NOTICE =
  "[keiko] diagnostic delivery to the server is throttled; further diagnostics in this window stay console-only.";

// Mirrors the server's SAFE_CORRELATION_ID predicate (packages/keiko-server/src/correlation.ts).
// keiko-ui may only depend on the server through the shared contract types (AGENTS.md §4), never on
// a server module directly, so this file re-derives the same alphabet+length shape as its own,
// client-side copy rather than importing one — the same layering `diagnostics.ts` (keiko-contracts)
// documents for its own, deliberately looser, wire-shape guard.
const CLIENT_CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

// Drops silently (never throws) on a caller-supplied id that is not shape-valid: a malformed id is
// still a successful diagnostic report, just without a join key attached.
function validCorrelationId(correlationId: string | undefined): string | undefined {
  return correlationId !== undefined && CLIENT_CORRELATION_ID_PATTERN.test(correlationId)
    ? correlationId
    : undefined;
}

// The four SSE-consuming modules (sharedEventSource.ts, useSSE.ts,
// coding-workbench-event-retention.ts, useRelationshipActivityStream.ts) each format their
// `EventSource.onerror` diagnostic with this EXACT substring so this module can recover the
// structured `readyState`/`kind` wire fields from the plain string `reportClientDiagnostic` takes —
// without those four modules importing this one (which would pull its module-scope
// `setClientDiagnosticWriter` side effect into their own unit tests). The four call sites duplicate
// a four-line pure formatter rather than share this module for exactly that reason; this pattern is
// the other half of that contract and is pinned against all four by this file's own test.
const SSE_DIAGNOSTIC_MESSAGE_PATTERN =
  /kind=sse-error, readyState=([0-2]), reason=(?:connecting|closed|unknown)/;

function parsedSseReadyState(digit: string): ClientDiagnosticReadyState {
  if (digit === "0") return 0;
  if (digit === "2") return 2;
  return 1;
}

// Builds the wire body for one already-bounded diagnostic message. `clientTs` is stamped at send
// time (not at the original `reportClientDiagnostic` call), which is close enough for an operator
// diagnostic and avoids threading a timestamp through the sink's string-only contract.
// `exactOptionalPropertyTypes` is honoured because `ClientDiagnosticIngestRequest`'s optional fields
// are all typed `T | undefined` (keiko-contracts), so assigning `undefined` outright is legal — and
// `JSON.stringify` drops an `undefined`-valued key from the wire body regardless, so an absent
// correlation id never reaches the request at all.
function clientDiagnosticPostBody(
  message: string,
  correlationId: string | undefined,
): ClientDiagnosticIngestRequest {
  const bounded =
    message.length > CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH
      ? message.slice(0, CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH)
      : message;
  const clientTs = new Date().toISOString();
  const validId = validCorrelationId(correlationId);
  const sseMatch = SSE_DIAGNOSTIC_MESSAGE_PATTERN.exec(message);
  if (sseMatch === null) return { message: bounded, clientTs, correlationId: validId };
  const readyStateDigit = sseMatch[1];
  if (readyStateDigit === undefined) return { message: bounded, clientTs, correlationId: validId };
  return {
    message: bounded,
    clientTs,
    correlationId: validId,
    readyState: parsedSseReadyState(readyStateDigit),
    kind: "sse-error",
  };
}

// Process-wide (module-scope), not per-diagnostic: a flapping stream or a hostile page must not be
// able to grow the activity log without bound. The server independently rate-limits the same route
// (client-diagnostics-routes.ts); this is defense in depth on the sending side, so a burst never
// leaves the tab at all.
const CLIENT_DIAGNOSTIC_POST_LIMIT_PER_WINDOW = 20;
const CLIENT_DIAGNOSTIC_POST_WINDOW_MS = 60_000;

let postWindowStartedAtMs = 0;
let postCountInWindow = 0;
let postFailureCount = 0;
let postThrottledCount = 0;

function admittedByClientPostRateLimit(nowMs: number): boolean {
  if (nowMs - postWindowStartedAtMs >= CLIENT_DIAGNOSTIC_POST_WINDOW_MS) {
    postWindowStartedAtMs = nowMs;
    postCountInWindow = 0;
  }
  if (postCountInWindow >= CLIENT_DIAGNOSTIC_POST_LIMIT_PER_WINDOW) return false;
  postCountInWindow += 1;
  return true;
}

/** Test-only: number of best-effort diagnostic POSTs that failed (network error or non-2xx). */
export function clientDiagnosticPostFailureCount(): number {
  return postFailureCount;
}

/** Test-only: number of diagnostic POSTs dropped by the client-side rate limit. */
export function clientDiagnosticPostThrottledCount(): number {
  return postThrottledCount;
}

/** Test-only: put the POST transport's rate limiter and failure/drop counters back to a clean start. */
export function resetClientDiagnosticPostStateForTests(): void {
  postWindowStartedAtMs = 0;
  postCountInWindow = 0;
  postFailureCount = 0;
  postThrottledCount = 0;
}

// Best-effort POST to the server activity log. Never awaited by a call site and never lets a
// rejected fetch (or a non-2xx `ApiError` `bffFetchJson` throws) reach back into
// `reportClientDiagnostic`'s caller — the same best-effort discipline `writeToBrowserConsole`
// already has, just with a `.catch` standing in for that function's `typeof` guards. A failure is
// counted (for tests) AND surfaced to the console directly via the fixed, content-free
// `DIAGNOSTIC_DELIVERY_FAILURE_NOTICE` (AGENTS.md §7: "errors must surface with enough context to
// diagnose" — silently dropping a failed POST left a developer with no way to tell the server never
// received the diagnostic). This never calls back through `reportClientDiagnostic`, which would
// re-enter `fanOutClientDiagnostic` and risk a loop under a persistently failing transport.
function postClientDiagnosticToServer(message: string, meta?: ClientDiagnosticMeta): void {
  if (!admittedByClientPostRateLimit(Date.now())) {
    postThrottledCount += 1;
    if (postThrottledCount === 1) writeToBrowserConsole(DIAGNOSTIC_DELIVERY_THROTTLED_NOTICE);
    return;
  }
  try {
    const body = clientDiagnosticPostBody(message, meta?.correlationId);
    void bffFetchJson<undefined>("/api/diagnostics/client", {
      method: "POST",
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {
      postFailureCount += 1;
      writeToBrowserConsole(DIAGNOSTIC_DELIVERY_FAILURE_NOTICE);
    });
  } catch {
    postFailureCount += 1;
    writeToBrowserConsole(DIAGNOSTIC_DELIVERY_FAILURE_NOTICE);
  }
}

// The fan-out composite: every diagnostic reaches both transports. Console first, so a developer
// watching devtools sees it even when the POST below is throttled or fails. `meta` only ever
// affects the POST body — the console transport stays the plain, undecorated message it always was.
function fanOutClientDiagnostic(message: string, meta?: ClientDiagnosticMeta): void {
  writeToBrowserConsole(message);
  postClientDiagnosticToServer(message, meta);
}

setClientDiagnosticWriter(fanOutClientDiagnostic);

export { writeToBrowserConsole, fanOutClientDiagnostic };
