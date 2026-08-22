// Wire contract for `POST /api/diagnostics/client` (Wave 5 of epic #3233, ADR-0173).
//
// The browser is untrusted input, so this shape — and its guard — live in the leaf contracts
// layer like every other request shape the server accepts from a client it does not control
// (ADR-0019). `correlationId` is the fatal-flaw fix all three design-panel judges independently
// flagged as missing: it is what lets an agent deterministically join a browser crash report to
// the specific failed server request it is reporting on, instead of fuzzy timestamp matching. It
// is DESIGNED to be populated from the same correlation id already threaded into every
// `ApiError`/SSE event (`packages/keiko-ui/src/lib/http.ts`), and is re-validated server-side with
// `isValidCorrelationId` before it is trusted — this guard only admits its general SHAPE (a short,
// bounded string), never the full correlation-id policy, which is server plumbing
// (`packages/keiko-server/src/correlation.ts`), not a wire concern.
//
// `install-client-diagnostics.ts` is the only place a `ClientDiagnosticIngestRequest` is built.
// `reportClientDiagnostic` (client-diagnostics.ts) takes an optional structured second argument,
// `{ correlationId?: string }`, and every call site that catches an `ApiError` (which
// `bffFetchJson`, keiko-ui's http.ts, stamps a `.correlationId` on for every non-2xx and every
// contract-validation failure) passes it through via `correlationIdOf(error)`
// (client-error-summary.ts). `install-client-diagnostics.ts` re-validates the shape client-side
// before putting it on the wire. It stays genuinely absent for the four SSE `onerror` call sites
// (sharedEventSource.ts, useSSE.ts, coding-workbench-event-retention.ts,
// useRelationshipActivityStream.ts): the native `EventSource` API exposes no response headers to
// page script, so there is no id to recover there — a hard platform limit, not a wiring gap.
//
// This guard is a promise about SHAPE only, never about the CONTENT of `message`. The browser-side
// sink's own doc comment promises an already-redacted string, but that promise is a library
// contract on the browser side — never a trust boundary the server may rely on. The server treats
// `message` as hostile regardless, and writes it under `extra.clientNote`, never `extra.message`
// (`"message"` is on `log-redaction.ts`'s `DENIED_FIELD_NAMES` and would collapse to
// `[redacted:key]` even though the value is already length-bounded here); the existing log-value
// guards (length/secret/personal/prose/path) do the actual content safety work on `clientNote`.

// EventSource.readyState at the moment the browser observed the failure: CONNECTING (0), OPEN (1)
// or CLOSED (2). A closed vocabulary, not a raw number, so a future EventSource-shaped value can
// never smuggle an out-of-range number onto the wire.
export const CLIENT_DIAGNOSTIC_READY_STATES = [0, 1, 2] as const;
export type ClientDiagnosticReadyState = (typeof CLIENT_DIAGNOSTIC_READY_STATES)[number];

// What raised the diagnostic: a caught render-boundary error, an unhandled promise rejection, an
// SSE transport failure, or anything else a call site does not further classify.
export const CLIENT_DIAGNOSTIC_KINDS = [
  "boundary",
  "unhandled-rejection",
  "sse-error",
  "other",
] as const;
export type ClientDiagnosticKind = (typeof CLIENT_DIAGNOSTIC_KINDS)[number];

// The browser-side sink already bounds a diagnostic message to this length (client-diagnostics.ts,
// `reportClientDiagnostic`); the server enforces the SAME bound independently rather than trusting
// the browser's own promise, per this module's header.
export const CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH = 200;

const CORRELATION_ID_MAX_LENGTH = 128;
const ISO_INSTANT_MAX_LENGTH = 40;

// Deliberately less strict than `correlation.ts`'s SAFE_CORRELATION_ID: this file only asserts the
// wire SHAPE (a short, non-empty string) so the leaf never has to import server plumbing. The
// server re-validates with `isValidCorrelationId` before trusting the value for anything.
const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

export interface ClientDiagnosticIngestRequest {
  readonly message: string;
  readonly clientTs: string;
  readonly readyState?: ClientDiagnosticReadyState | undefined;
  readonly correlationId?: string | undefined;
  readonly kind?: ClientDiagnosticKind | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

// UTC component getters in the same order the capture groups appear in `ISO_INSTANT_PATTERN`
// (year, month, day, hour, minute, second) — `getUTCMonth()` is 0-based, so it is adjusted to match
// the 1-based literal the input wrote.
const ISO_INSTANT_UTC_GETTERS: readonly ((date: Date) => number)[] = [
  (date): number => date.getUTCFullYear(),
  (date): number => date.getUTCMonth() + 1,
  (date): number => date.getUTCDate(),
  (date): number => date.getUTCHours(),
  (date): number => date.getUTCMinutes(),
  (date): number => date.getUTCSeconds(),
];

// `Date.parse` silently normalizes a calendar-invalid instant instead of rejecting it (e.g.
// `2026-02-30T10:00:00.000Z` becomes `2026-03-02T10:00:00.000Z`), so a regex-shape match plus a
// non-NaN parse is not enough on its own: reparse the accepted ms value and require every UTC
// component the input literally said to still be there. All six capture groups in
// `ISO_INSTANT_PATTERN` are mandatory (only the milliseconds fraction is optional, and it is
// non-capturing), so `match[1..6]` is always populated once `match` itself is non-null.
function isCalendarValidInstant(match: RegExpExecArray, parsedMs: number): boolean {
  const components = match.slice(1, 7);
  const parsed = new Date(parsedMs);
  return ISO_INSTANT_UTC_GETTERS.every(
    (getUtcComponent, index) => getUtcComponent(parsed) === Number(components[index]),
  );
}

function isIsoInstant(value: unknown): value is string {
  if (!isBoundedString(value, ISO_INSTANT_MAX_LENGTH)) return false;
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (match === null) return false;
  const parsedMs = Date.parse(value);
  return !Number.isNaN(parsedMs) && isCalendarValidInstant(match, parsedMs);
}

const CLIENT_DIAGNOSTIC_READY_STATE_SET: ReadonlySet<number> = new Set(
  CLIENT_DIAGNOSTIC_READY_STATES,
);

function isClientDiagnosticReadyState(value: unknown): value is ClientDiagnosticReadyState {
  return typeof value === "number" && CLIENT_DIAGNOSTIC_READY_STATE_SET.has(value);
}

const CLIENT_DIAGNOSTIC_KIND_SET: ReadonlySet<string> = new Set(CLIENT_DIAGNOSTIC_KINDS);

export function isClientDiagnosticKind(value: unknown): value is ClientDiagnosticKind {
  return typeof value === "string" && CLIENT_DIAGNOSTIC_KIND_SET.has(value);
}

function isCorrelationIdShape(value: unknown): value is string {
  return isBoundedString(value, CORRELATION_ID_MAX_LENGTH);
}

// A value present under an optional key must still conform to `guard`; absent is always accepted.
function isOptional(value: unknown, guard: (candidate: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}

export function isClientDiagnosticIngestRequest(
  value: unknown,
): value is ClientDiagnosticIngestRequest {
  if (!isRecord(value)) return false;
  const { message, clientTs, readyState, correlationId, kind } = value;
  if (!isBoundedString(message, CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH)) return false;
  if (!isIsoInstant(clientTs)) return false;
  if (!isOptional(readyState, isClientDiagnosticReadyState)) return false;
  if (!isOptional(correlationId, isCorrelationIdShape)) return false;
  if (!isOptional(kind, isClientDiagnosticKind)) return false;
  return true;
}
