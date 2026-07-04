// Server-side operator diagnostics sink (RB-6 / GEN-OBS-DIAGNOSTICS-901/602/603, STATUS-403).
//
// Before this module the top-level route-error catch, the buffered-send rethrow, and the streamed
// mid-stream failure all discarded the underlying cause: an unexpected throw became an opaque 500 (or
// a relabelled `GATEWAY_ERROR` SSE frame) with the error object dropped and nothing logged anywhere.
// This sink is the single, redaction-safe choke point that turns those failures into a structured,
// correlation-keyed operator record. It never surfaces raw content to the browser; the response body
// stays opaque and the record is emitted only to the server's own diagnostic channel.

export interface ServerDiagnosticRecord {
  readonly correlationId: string;
  readonly timestamp: string;
  // A coarse operation label, e.g. `GET /api/projects` or `chat.stream`.
  readonly operation: string;
  // Where the failure was observed, e.g. `server.top-level-catch` or `chat.stream`.
  readonly source: string;
  // The error constructor name (never the raw message), e.g. `Error`, `GatewayTransportError`.
  readonly errorClass: string;
  // The REDACTED error message. Known secrets are already scrubbed by the caller's redactor.
  readonly message: string;
  // A stable machine-readable code when the error carries one (coded errors, GatewayError.code).
  readonly code?: string | undefined;
  // The upstream model-gateway request id when the failure originated from a gateway call — this is
  // what links a UI/server correlation id to the gateway's own record (GEN-OBS-CORRELATION-503).
  readonly gatewayRequestId?: string | undefined;
}

export interface ServerDiagnosticSink {
  readonly record: (record: ServerDiagnosticRecord) => void;
}

// The default sink writes one structured JSON line to stderr. It is intentionally the only place in
// the server request path that logs, so operators get a diagnosable trail without the browser ever
// seeing raw content. Tests inject a capturing sink instead (via UiHandlerDeps.diagnostics).
export const defaultServerDiagnosticSink: ServerDiagnosticSink = {
  record(record: ServerDiagnosticRecord): void {
    // eslint-disable-next-line no-console
    console.error(`[keiko-server:diagnostic] ${JSON.stringify(record)}`);
  },
};

// Extracts the diagnosable, redaction-safe shape of an unknown thrown value. `redact` is the caller's
// message redactor (known secrets scrubbed); it is applied to the human message only. The class name
// and any machine code are inherently safe (no user content) and pass through unredacted.
export function describeError(
  error: unknown,
  redact: (message: string) => string,
): {
  readonly errorClass: string;
  readonly message: string;
  readonly code?: string | undefined;
  readonly gatewayRequestId?: string | undefined;
} {
  if (error instanceof Error) {
    const withExtras = error as Error & { code?: unknown; requestId?: unknown };
    return {
      errorClass: error.name || error.constructor.name || "Error",
      message: redact(error.message),
      code: typeof withExtras.code === "string" ? withExtras.code : undefined,
      gatewayRequestId: typeof withExtras.requestId === "string" ? withExtras.requestId : undefined,
    };
  }
  return { errorClass: typeof error, message: redact(String(error)) };
}

// Emits a diagnostic record through the provided sink (falling back to the default stderr sink).
// Never throws — a diagnostic sink failure must not compound the original request failure.
export function emitServerDiagnostic(
  sink: ServerDiagnosticSink | undefined,
  record: ServerDiagnosticRecord,
): void {
  try {
    (sink ?? defaultServerDiagnosticSink).record(record);
  } catch {
    // A logging failure is never allowed to escalate into a second, unhandled failure.
  }
}

// Convenience: build a record from an unknown error with a current timestamp. Kept separate from
// emit so callers can enrich the record (e.g. add a gatewayRequestId) before emitting.
export function serverDiagnosticFromError(input: {
  readonly correlationId: string;
  readonly operation: string;
  readonly source: string;
  readonly error: unknown;
  readonly redact: (message: string) => string;
  readonly now?: () => number;
}): ServerDiagnosticRecord {
  const described = describeError(input.error, input.redact);
  const millis = (input.now ?? Date.now)();
  return {
    correlationId: input.correlationId,
    timestamp: new Date(millis).toISOString(),
    operation: input.operation,
    source: input.source,
    errorClass: described.errorClass,
    message: described.message,
    ...(described.code === undefined ? {} : { code: described.code }),
    ...(described.gatewayRequestId === undefined
      ? {}
      : { gatewayRequestId: described.gatewayRequestId }),
  };
}
