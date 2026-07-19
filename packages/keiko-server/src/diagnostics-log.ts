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
  // The content-free error class (never the raw message), e.g. `Error`, `TransportError`.
  readonly errorClass: string;
  // The REDACTED error message. Known secrets are already scrubbed by the caller's redactor.
  readonly message: string;
  // A stable machine-readable code when the error carries one (coded errors, GatewayError.code).
  readonly code?: string | undefined;
  // Usage a streaming gateway call had accumulated before failing mid-stream
  // (GatewayError.partialUsage). Counts only — never content — so interrupted
  // turns stay visible to cost accounting instead of vanishing with the error.
  readonly partialUsage?:
    { readonly promptTokens: number; readonly completionTokens: number } | undefined;
  // The upstream model-gateway request id when the failure originated from a gateway call — this is
  // what links a UI/server correlation id to the gateway's own record (GEN-OBS-CORRELATION-503).
  readonly gatewayRequestId?: string | undefined;
  // Bounded numeric occurrence for rate-limited diagnostics; never parsed from content.
  readonly occurrenceCount?: number | undefined;
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
// message redactor (known secrets scrubbed); it is applied to the human message. The remaining fields
// are NOT trusted to be content-free by themselves: the class comes from `contentFreeErrorClass`
// (closed built-in allowlist, else the code-declared class name), and `code`/`requestId` are
// forwarded only as bounded machine tokens the redactor leaves unchanged — anything else is dropped
// rather than smuggled into an otherwise-redacted record.
export function describeError(
  error: unknown,
  redact: (message: string) => string,
): {
  readonly errorClass: string;
  readonly message: string;
  readonly code?: string | undefined;
  readonly gatewayRequestId?: string | undefined;
  readonly partialUsage?:
    { readonly promptTokens: number; readonly completionTokens: number } | undefined;
} {
  if (error instanceof Error) {
    const withExtras = error as Error & {
      code?: unknown;
      requestId?: unknown;
      partialUsage?: unknown;
    };
    return {
      errorClass: contentFreeErrorClass(error),
      message: redact(error.message),
      code: machineToken(withExtras.code, redact),
      gatewayRequestId: machineToken(withExtras.requestId, redact),
      partialUsage: partialUsageCounts(withExtras.partialUsage),
    };
  }
  return { errorClass: typeof error, message: redact(String(error)) };
}

// `Error.name` and the instance's `constructor` are plain mutable own properties: a hostile thrown
// value — or a buggy merge of request data onto an error — can load them with request-derived text.
// A name passes only when it is one of these well-known built-ins, which legitimately ride on
// generic `Error`/`DOMException` instances (e.g. an abort reason named "AbortError") where the
// declared class name would erase the useful distinction.
const BUILT_IN_ERROR_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
]);

// Class names come from code (class declarations), never from request data, so a bounded,
// identifier-shaped constructor name is safe to surface. Machine tokens (`code`, `requestId`)
// reuse the correlation-id alphabet: no whitespace, no prose, bounded length.
const DECLARED_ERROR_CLASS_SHAPE = /^[A-Z][A-Za-z0-9]{0,63}$/;
const MACHINE_TOKEN_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

// Resolves the content-free class of an unknown thrown value: a built-in error name, else the
// class name declared in code, else the generic "Error" (or `typeof` for non-Error throws).
// Shared by every diagnostics producer that labels an error, so the mutable-`name` hardening
// lives in exactly one place.
export function contentFreeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  if (BUILT_IN_ERROR_NAMES.has(error.name)) return error.name;
  return declaredErrorClassName(error) ?? "Error";
}

// Reads the constructor name off the PROTOTYPE (not the instance) so an own-property
// `constructor` planted by hostile data cannot shadow the code-declared class.
function declaredErrorClassName(error: Error): string | undefined {
  const proto = Reflect.getPrototypeOf(error) as { constructor?: unknown } | null;
  const ctor = proto?.constructor;
  if (typeof ctor !== "function" || !DECLARED_ERROR_CLASS_SHAPE.test(ctor.name)) {
    return undefined;
  }
  return ctor.name;
}

// Forwards a `code`/`requestId` style value only when it is a bounded machine token that the
// caller's redactor leaves unchanged; a known secret or any prose-shaped value is dropped, never
// rewritten, so the field stays machine-parseable or absent.
function machineToken(value: unknown, redact: (message: string) => string): string | undefined {
  if (typeof value !== "string" || !MACHINE_TOKEN_SHAPE.test(value)) return undefined;
  return redact(value) === value ? value : undefined;
}

// Accepts only the numeric counts (GatewayError.partialUsage shape) — anything
// else is dropped so a hostile/foreign `partialUsage` value can never smuggle
// content into a diagnostic record.
function partialUsageCounts(
  value: unknown,
): { readonly promptTokens: number; readonly completionTokens: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { promptTokens?: unknown; completionTokens?: unknown };
  if (
    typeof record.promptTokens !== "number" ||
    !Number.isFinite(record.promptTokens) ||
    typeof record.completionTokens !== "number" ||
    !Number.isFinite(record.completionTokens)
  ) {
    return undefined;
  }
  return { promptTokens: record.promptTokens, completionTokens: record.completionTokens };
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
    ...(described.partialUsage === undefined ? {} : { partialUsage: described.partialUsage }),
  };
}
