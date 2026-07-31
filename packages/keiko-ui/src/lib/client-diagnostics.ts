// The one client-side diagnostic sink (0.3.0 release audit, #2802 — Qodo review on #2869).
//
// AGENTS.md §6 says real output belongs in "the intended logger/diagnostic sink, not `console.*`".
// The browser had no such sink, so every bounded failure path reached for `console.warn` directly and
// the policy was satisfied only by convention — eight call sites each re-deciding what "bounded" and
// "redacted" mean, with nothing to point a test or a future replacement at.
//
// This is that sink. It is deliberately thin: one function, one default implementation that writes to
// the console, and a seam to replace it. Concentrating the console access here means the `no-console`
// exception is one reviewable line instead of eight scattered ones, and a host that wants to ship
// these somewhere else (an operator panel, a support bundle, a telemetry endpoint the user opted
// into) changes one module rather than hunting call sites.
//
// REDACTION IS THE CALLER'S JOB AND THE TYPE ENFORCES IT. The sink takes a `string`, never an
// `unknown` or an `Error`: a raw error carries a stack with absolute paths and a message Keiko does
// not control, and the console is the surface users screenshot into bug reports. Callers that hold an
// error pass `clientErrorSummary(error)`, which yields its class and nothing else.

export type ClientDiagnosticWriter = (message: string) => void;

function defaultWriter(message: string): void {
  // The single sanctioned console access in keiko-ui production code. Everything above this line is
  // why it is here rather than at each call site.
  // eslint-disable-next-line no-console
  if (typeof console !== "undefined" && typeof console.warn === "function") console.warn(message);
}

let writer: ClientDiagnosticWriter = defaultWriter;

/**
 * Report a bounded, already-redacted operator diagnostic.
 *
 * `message` must contain only counts, statuses, closed identifiers and error classes — never a raw
 * error, a file path, a URL with a query string, or anything the user typed.
 */
export function reportClientDiagnostic(message: string): void {
  writer(message);
}

/** Replace the sink (tests, and any host that ships diagnostics somewhere other than the console). */
export function setClientDiagnosticWriter(next: ClientDiagnosticWriter): void {
  writer = next;
}

/** Restore the console-backed default. */
export function resetClientDiagnosticWriter(): void {
  writer = defaultWriter;
}
