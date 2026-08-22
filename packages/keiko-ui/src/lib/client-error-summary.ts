// Body-free client diagnostics (0.3.0 release audit, #2802 — Qodo review on #2869).
//
// Browser-side failure paths used to hand the raw `Error` to `console.warn`. A raw error carries a
// stack and a message, and neither is under Keiko's control: a message can quote a filesystem path,
// a URL with a query string, or text the user typed. AGENTS.md is explicit that diagnostics report
// counts, statuses and identifiers — never bodies — and that rule does not stop at the server
// boundary just because a browser console feels local. The console is also the one surface a user
// is most likely to screenshot into a bug report.
//
// So the object never travels. What travels is its CLASS, which is what actually tells an operator
// what kind of failure happened ("TypeError" vs "AbortError" vs a bespoke error type), plus whatever
// closed identifiers the call site already knows are safe. A caller that has a closed reason code
// should pass that code in its own static message rather than relying on this summary.

/**
 * The error's class name, and nothing else from the object.
 *
 * Deliberately not the message: `error.message` is attacker- and environment-influenced text.
 * Deliberately not the stack: it carries absolute paths.
 */
export function clientErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name.trim();
    return name.length > 0 ? name : "Error";
  }
  // A thrown non-Error still has a useful shape without quoting its content.
  return typeof error;
}

function hasStringCorrelationId(value: unknown): value is { correlationId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "correlationId" in value &&
    typeof (value as { correlationId?: unknown }).correlationId === "string"
  );
}

/**
 * The originating request's correlation id, when the caught error carries one — currently
 * `ApiError` (api.ts), which `bffFetchJson` (http.ts) stamps on every non-2xx and every contract
 * validation failure. Duck-typed rather than an `instanceof ApiError` check so any future error
 * class that exposes the same field (e.g. a widened `StreamingUnavailableError`) is picked up here
 * too, without this module importing api.ts.
 *
 * Undefined for a native thrown value, a boundary-caught render error with no id, or any failure
 * that never went through `bffFetchJson` — most notably `EventSource.onerror`: the native
 * EventSource API exposes no response headers to page script, so no producer downstream of one can
 * ever recover a correlation id from it.
 */
export function correlationIdOf(error: unknown): string | undefined {
  return hasStringCorrelationId(error) ? error.correlationId : undefined;
}
