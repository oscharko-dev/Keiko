// Shared GatewayError → operator-diagnostic wiring (ADR-0173 D5 g25/g27).
//
// Before this module, `chat-stream-handlers.ts`'s `errorEvent()` was the ONLY place a GatewayError
// reaching the desktop chat surface got routed to the redacted operator diagnostic sink before the
// response left — the buffered `/api/desktop/chat` path (`chat-handlers.ts`) and grounded Q&A
// (`grounded-qa.ts`) mapped the SAME error class straight to an HTTP body with no diagnostic call
// at all, so a mid-request gateway failure was traceable only when it happened to arrive over SSE.
// This file extracts that one block so every caller emits the identical record shape.
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";
import type { Redactor } from "./deps.js";

// A structural subset of `UiHandlerDeps` — the two fields this helper actually reads — so callers
// never need to import the full `UiHandlerDeps` type just to satisfy this one function.
export interface GatewayErrorDiagnosticDeps {
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly redactor: Redactor;
}

// `correlationId` falls back to `UNKNOWN_CORRELATION_ID` rather than being omitted:
// `ServerDiagnosticRecord` requires one (a diagnostic nobody can join to a request is far less
// useful than one honestly marked unjoinable), matching the fallback `chat-stream-handlers.ts`'s
// `errorEvent()` already used before this extraction — every caller inherits the same behaviour,
// not a stricter or looser one. The fixed sentinel (rather than the bare literal `"unknown"`) is
// deliberate: it is shape-valid, so it survives `emitServerDiagnostic`'s sanitizer unchanged instead
// of being rewritten to the sanitizer's own "hostile value" marker.
export function emitGatewayErrorDiagnostic(
  deps: GatewayErrorDiagnosticDeps,
  error: unknown,
  correlationId: string | undefined,
  operation: string,
  source: string,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
      operation,
      source,
      error,
      redact: (message) => String(deps.redactor(message)),
    }),
  );
}
