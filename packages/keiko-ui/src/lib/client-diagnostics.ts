// The one client-side diagnostic sink (0.3.0 release audit, #2802 — Qodo review on #2869).
//
// AGENTS.md §6 says real output belongs in "the intended logger/diagnostic sink, not `console.*`".
// The browser had no such sink, so every bounded failure path reached for `console.warn` directly and
// the policy was satisfied only by convention — eight call sites each re-deciding what "bounded" and
// "redacted" mean, with nothing to point a test or a future replacement at.
//
// This is that sink, and it deliberately owns NO transport. The library decides what a diagnostic is
// and what it may contain; the application decides where diagnostics go. That split is why this
// module contains no `console` call: a browser console is one possible transport, not the contract.
// `packages/keiko-ui/src/lib/install-client-diagnostics.ts` is where this application chooses one.
//
// Until a transport is installed, records are held in a bounded buffer and handed to the first
// writer that arrives. Dropping them instead — the obvious "no-op by default" — would be a silent
// failure (AGENTS.md §7): every diagnostic raised during module init, hydration, or an early boot
// crash happens before any host code can run, which is exactly when they matter most.
//
// REDACTION IS THE CALLER'S JOB AND THE TYPE ENFORCES IT. The sink takes a `string`, never an
// `unknown` or an `Error`: a raw error carries a stack with absolute paths and a message Keiko does
// not control, and a diagnostic surface is what users screenshot into bug reports. Callers that hold
// an error pass `clientErrorSummary(error)`, which yields its class and nothing else.

export type ClientDiagnosticWriter = (message: string) => void;

// Bounded on purpose: a failing poll loop can raise a diagnostic every tick while the BFF restarts,
// and an unbounded pre-transport buffer would grow without limit in exactly that case. The oldest
// records are dropped first — a storm's later entries describe the same fault as its first.
const PENDING_LIMIT = 100;

const pending: string[] = [];

function bufferUntilTransportArrives(message: string): void {
  pending.push(message);
  if (pending.length > PENDING_LIMIT) pending.shift();
}

let writer: ClientDiagnosticWriter = bufferUntilTransportArrives;

/**
 * Report a bounded, already-redacted operator diagnostic.
 *
 * `message` must contain only counts, statuses, closed identifiers and error classes — never a raw
 * error, a file path, a URL with a query string, or anything the user typed.
 */
export function reportClientDiagnostic(message: string): void {
  writer(message);
}

/**
 * Install the transport diagnostics are delivered to.
 *
 * Anything buffered before this call is handed to the new writer first, in order, so installing a
 * transport late never loses what happened during boot.
 */
export function setClientDiagnosticWriter(next: ClientDiagnosticWriter): void {
  writer = next;
  if (pending.length === 0) return;
  const buffered = pending.splice(0, pending.length);
  for (const message of buffered) next(message);
}

/** Restore the buffering default and discard anything held. Tests use this; product code does not. */
export function resetClientDiagnosticWriter(): void {
  writer = bufferUntilTransportArrives;
  pending.length = 0;
}
