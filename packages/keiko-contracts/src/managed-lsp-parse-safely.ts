// Shared throw-to-content-free-Result boundary for managed LSP and DAP contract parsers.
// Each caller keeps its domain validation; this internal adapter preserves returned Results and
// reduces thrown inspection failures to a closed error class without exposing private fields.
// ADR-0019: the only dependency is the import-free internal classifier; no I/O, clock or randomness.
// This wiring is intentionally not re-exported from index.ts or a new public package selector.
import { clientErrorClass } from "./error-classification.js";

type ParseSafelyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

function parserInspectionClass(error: unknown): string {
  try {
    return error instanceof Error ? clientErrorClass(error) : "unknown";
  } catch {
    return "unknown";
  }
}

export function parseSafely<T>(parser: () => ParseSafelyResult<T>): ParseSafelyResult<T> {
  try {
    return parser();
  } catch (error: unknown) {
    return {
      ok: false,
      errors: [`payload could not be inspected: ${parserInspectionClass(error)}`],
    };
  }
}
