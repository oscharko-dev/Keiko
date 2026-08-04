// Server-side operator diagnostics sink (RB-6 / GEN-OBS-DIAGNOSTICS-901/602/603, STATUS-403).
//
// Before this module the top-level route-error catch, the buffered-send rethrow, and the streamed
// mid-stream failure all discarded the underlying cause: an unexpected throw became an opaque 500 (or
// a relabelled `GATEWAY_ERROR` SSE frame) with the error object dropped and nothing logged anywhere.
// This sink is the single, redaction-safe choke point that turns those failures into a structured,
// correlation-keyed operator record. It never surfaces raw content to the browser; the response body
// stays opaque and the record is emitted only to the server's own diagnostic channel.

import { randomUUID } from "node:crypto";

export interface ServerDiagnosticRecord {
  readonly correlationId: string;
  readonly timestamp: string;
  // A coarse operation label, e.g. `GET /api/projects` or `chat.stream`.
  readonly operation: string;
  // Where the failure was observed, e.g. `server.top-level-catch` or `chat.stream`.
  readonly source: string;
  // The content-free error class (never the raw message), e.g. `Error`, `TransportError`.
  readonly errorClass: string;
  // A code-declared, allowlisted summary. Foreign error/provider/customer text is never read.
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

export const DEFAULT_SERVER_DIAGNOSTIC_SUMMARY = "server-operation-failed";

// Compatibility summaries are accepted only by exact match. Existing producers may still supply
// the historical `redact` callback, but it receives only DEFAULT_SERVER_DIAGNOSTIC_SUMMARY; it is
// never handed foreign error text. A callback that returns request/provider content therefore
// degrades to the default rather than extending the diagnostic trust boundary.
const SERVER_DIAGNOSTIC_SUMMARIES = [
  DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
  "Provider verification failed without exposing upstream response details.",
  "Workspace index key resolution or initialization failed.",
  "Encrypted workspace index snapshot was rejected.",
  "Encrypted workspace index snapshot write was rejected.",
  "Stale workspace index generation was rejected after key rotation.",
  "Debug activation resolver failed.",
  "Persisting debug instrumentation state failed.",
  "DAP production background operation failed.",
  "DAP live-evidence projection failed.",
  "Changeset preview derivation failed.",
  "Patch preview derivation failed.",
  "The selected changeset could not be projected.",
  "The selected changeset projection failed.",
  "The selected changeset no longer passes patch validation.",
  "The changeset could not be applied atomically.",
  "The bounded status read was unavailable.",
  "The bounded diff read was unavailable.",
  "The bounded blame read was unavailable.",
  "The server-resolved editor operation failed.",
  "Local knowledge vector-index search failed.",
  "The editor inline-completion model tier failed.",
  "Editor test generation failed.",
  "A gateway readiness probe could not be completed.",
  "The coding sidecar gateway stream failed mid-response.",
  "Audit or evidence persistence failed.",
  "Debug production service composition failed.",
  "Managed task-workspace boundary materialization failed.",
] as const;

export type ServerDiagnosticSummary = (typeof SERVER_DIAGNOSTIC_SUMMARIES)[number];

const SERVER_DIAGNOSTIC_SUMMARY_SET: ReadonlySet<string> = new Set(SERVER_DIAGNOSTIC_SUMMARIES);

// Extracts only the diagnosable, body-free shape of an unknown thrown value. In particular this
// function never reads `.message` or stringifies the value. Machine fields are read independently
// through fail-closed property access, then admitted only by their bounded shapes.
export function describeError(error: unknown): {
  readonly errorClass: string;
  readonly code?: string | undefined;
  readonly gatewayRequestId?: string | undefined;
  readonly partialUsage?:
    { readonly promptTokens: number; readonly completionTokens: number } | undefined;
} {
  return {
    errorClass: contentFreeErrorClass(error),
    code: machineToken(safeProperty(error, "code")),
    gatewayRequestId: machineToken(safeProperty(error, "requestId")),
    partialUsage: partialUsageCounts(safeProperty(error, "partialUsage")),
  };
}

// `Error.name` and the instance's `constructor` are plain mutable own properties: a hostile thrown
// value — or a buggy merge of request data onto an error — can load them with request-derived text.
// A name passes only when it is one of these SPECIFIC well-known built-ins, which legitimately ride
// on generic `Error`/`DOMException` instances (e.g. an abort reason named "AbortError") where the
// declared class name would erase the useful distinction. The generic "Error" is deliberately NOT
// in the set: for it, the code-declared class name is the more specific, equally safe label.
const SPECIFIC_BUILT_IN_ERROR_NAMES: ReadonlySet<string> = new Set([
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
const OPERATION_LABEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*(?: [A-Za-z0-9/][A-Za-z0-9._:/-]*)?$/;
const SOURCE_LABEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_DIAGNOSTIC_LABEL_LENGTH = 160;

// Resolves the content-free class of an unknown thrown value: a specific built-in error name, else
// the class name declared in code (recovering subclasses that never assign `this.name`), else the
// generic "Error" (or `typeof` for non-Error throws). Shared by every diagnostics producer that
// labels an error, so the mutable-`name` hardening lives in exactly one place.
export function contentFreeErrorClass(error: unknown): string {
  try {
    if (!(error instanceof Error)) return typeof error;
    const name = safeProperty(error, "name");
    if (typeof name === "string" && SPECIFIC_BUILT_IN_ERROR_NAMES.has(name)) return name;
    return declaredErrorClassName(error) ?? "Error";
  } catch {
    // Reflection over a hostile value (a proxy trap or throwing accessor) must never turn the
    // diagnostic path into a second failure; degrade to the generic class instead.
    return "Error";
  }
}

// Reads the constructor name off the PROTOTYPE (not the instance) so an own-property
// `constructor` planted by hostile data cannot shadow the code-declared class.
function declaredErrorClassName(error: Error): string | undefined {
  const proto = Reflect.getPrototypeOf(error);
  const ctor = safeProperty(proto, "constructor");
  const name = safeProperty(ctor, "name");
  if (typeof ctor !== "function" || typeof name !== "string") return undefined;
  if (!DECLARED_ERROR_CLASS_SHAPE.test(name)) {
    return undefined;
  }
  return name;
}

// Reflective reads from a thrown value are hostile-input reads: accessors and proxy traps may throw.
// Every optional machine field therefore goes through this helper and degrades to absence.
function safeProperty(value: unknown, property: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return undefined;
  }
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

// Forwards a `code`/`requestId` style value only when it is a bounded machine token: the charset
// and length bound exclude prose, whitespace, and oversized payloads. Values are dropped, never
// rewritten, so the field stays machine-parseable or absent. The message redactor is deliberately
// NOT consulted here — producers that redact by constant message would otherwise lose every token.
function machineToken(value: unknown): string | undefined {
  return typeof value === "string" && MACHINE_TOKEN_SHAPE.test(value) ? value : undefined;
}

// Accepts only the numeric counts (GatewayError.partialUsage shape) — anything
// else is dropped so a hostile/foreign `partialUsage` value can never smuggle
// content into a diagnostic record.
function partialUsageCounts(
  value: unknown,
): { readonly promptTokens: number; readonly completionTokens: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const promptTokens = safeProperty(value, "promptTokens");
  const completionTokens = safeProperty(value, "completionTokens");
  if (
    typeof promptTokens !== "number" ||
    !Number.isFinite(promptTokens) ||
    typeof completionTokens !== "number" ||
    !Number.isFinite(completionTokens)
  ) {
    return undefined;
  }
  return { promptTokens, completionTokens };
}

function allowlistedSummary(value: unknown): ServerDiagnosticSummary | undefined {
  return typeof value === "string" && SERVER_DIAGNOSTIC_SUMMARY_SET.has(value)
    ? (value as ServerDiagnosticSummary)
    : undefined;
}

function compatibilitySummary(
  redact: (message: string) => string,
): ServerDiagnosticSummary | undefined {
  try {
    return allowlistedSummary(redact(DEFAULT_SERVER_DIAGNOSTIC_SUMMARY));
  } catch {
    return undefined;
  }
}

function diagnosticLabel(
  value: unknown,
  shape: RegExp,
  fallback: "server.operation" | "server.diagnostic",
): string {
  return typeof value === "string" &&
    value.length <= MAX_DIAGNOSTIC_LABEL_LENGTH &&
    shape.test(value)
    ? value
    : fallback;
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

export function emitEvidenceRetentionDiagnostic(
  sink: ServerDiagnosticSink | undefined,
  source: string,
  occurrenceCount: number,
): void {
  emitServerDiagnostic(sink, {
    correlationId: randomUUID(),
    timestamp: new Date().toISOString(),
    operation: "evidence.retention",
    source: diagnosticLabel(source, SOURCE_LABEL_SHAPE, "server.diagnostic"),
    errorClass: "EvidenceRetention",
    message: "Evidence retention deleted expired manifests.",
    occurrenceCount,
  });
}

export function evidenceRetentionDiagnosticObserver(
  sink: ServerDiagnosticSink | undefined,
  source: string,
): (occurrenceCount: number) => void {
  return emitEvidenceRetentionDiagnostic.bind(undefined, sink, source);
}

// Convenience: build a record from an unknown error with a current timestamp. Kept separate from
// emit so callers can enrich the record (e.g. add a gatewayRequestId) before emitting.
export function serverDiagnosticFromError(input: {
  readonly correlationId: string;
  readonly operation: string;
  readonly source: string;
  readonly error: unknown;
  readonly summary?: ServerDiagnosticSummary | undefined;
  // Compatibility-only: invoked with the fixed default summary, never with foreign error text.
  readonly redact: (message: string) => string;
  readonly now?: () => number;
}): ServerDiagnosticRecord {
  const described = describeError(input.error);
  const millis = (input.now ?? Date.now)();
  const message =
    allowlistedSummary(input.summary) ??
    compatibilitySummary(input.redact) ??
    DEFAULT_SERVER_DIAGNOSTIC_SUMMARY;
  return {
    correlationId: input.correlationId,
    timestamp: new Date(millis).toISOString(),
    operation: diagnosticLabel(input.operation, OPERATION_LABEL_SHAPE, "server.operation"),
    source: diagnosticLabel(input.source, SOURCE_LABEL_SHAPE, "server.diagnostic"),
    errorClass: described.errorClass,
    message,
    ...(described.code === undefined ? {} : { code: described.code }),
    ...(described.gatewayRequestId === undefined
      ? {}
      : { gatewayRequestId: described.gatewayRequestId }),
    ...(described.partialUsage === undefined ? {} : { partialUsage: described.partialUsage }),
  };
}
