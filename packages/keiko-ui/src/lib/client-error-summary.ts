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
