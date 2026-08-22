import { DECLARED_MODEL_MODES } from "@oscharko-dev/keiko-contracts";

import {
  contentFreeErrorClass,
  machineToken,
  safeProperty,
} from "./observability/error-classification.js";
import { closeReasonVocabulary } from "./observability/log-redaction.js";
import { createFileServerLogSink } from "./observability/server-log.js";
import { causeChain, keikoStackFrames } from "./observability/stack-frames.js";

// The error-classification primitives below (`contentFreeErrorClass`, `safeProperty`,
// `machineToken`, and the shapes/sets they use) used to live in this file. They moved to
// `./observability/error-classification.js` (ADR-0173 D11) so `server-log.ts`'s `errorKindOf`
// could delegate to the same hardened reflection helpers instead of maintaining a second,
// less-hardened regex-based reader — `server-log.ts` cannot import THIS file (it already imports
// `server-log.ts` for `createFileServerLogSink`, so the reverse edge would cycle), but both can
// import a leaf that imports neither. Re-exported here so every import site that already reads
// `contentFreeErrorClass` (and friends) from `./diagnostics-log.js` keeps working unchanged.
export {
  contentFreeErrorClass,
  declaredErrorClassName,
  DECLARED_ERROR_CLASS_SHAPE,
  machineToken,
  MACHINE_TOKEN_SHAPE,
  safeProperty,
  SPECIFIC_BUILT_IN_ERROR_NAMES,
} from "./observability/error-classification.js";
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
  // Serialized byte count of the SSE frame that was rejected when a stream was destroyed for
  // backpressure (SseBackpressureKill). A count only — never body bytes — so it cannot leak
  // model tokens if logged.
  readonly frameBytes?: number | undefined;
  // How many models survived the discovery cap when a gateway-setup discovery was truncated
  // (GATEWAY_DISCOVERY_TRUNCATED). Kept separate from `occurrenceCount`, which counts how often a
  // rate-limited diagnostic fired — an aggregator summing that field must not pick up a model
  // count. A bounded count only; never a model id or an endpoint.
  readonly retainedModelCount?: number | undefined;
  // How many discovered models setup refused to configure because the gateway declared a mode
  // Keiko has no lane for (GATEWAY_DISCOVERY_UNUSABLE_MODELS), and how many declared embedding
  // models failed their setup probe. Bounded counts plus the reason CODES only — never a model
  // id or an endpoint; the ids belong in the setup response the operator reads.
  readonly unsupportedModelCount?: number | undefined;
  // Reason codes come from a CLOSED vocabulary (the declared modes Keiko knows, plus fixed
  // markers). A gateway-supplied mode string is never echoed: an unrecognised one collapses to
  // "unrecognised-mode" at classification time, so no foreign text reaches this record.
  readonly unsupportedReasons?: readonly string[] | undefined;
  // Embedding models that failed their setup probe: `unverified` were kept (their role was
  // explicitly asserted), `dropped` were removed (Keiko had only inferred the role).
  readonly unverifiedEmbeddingModelCount?: number | undefined;
  readonly droppedEmbeddingModelCount?: number | undefined;
  // How many candidate memories the conversation-retrieval semantic reranker skipped for a stored
  // embedding whose identity did not match the query's, and how many candidates were in play when
  // it did. Bounded counts only; never a memory id, model id, or embedding vector.
  readonly semanticSkippedCount?: number | undefined;
  readonly semanticCandidateCount?: number | undefined;
  // Keiko-code stack frames the error passed through, nearest-to-throw-site first, reduced by
  // `keikoStackFrames` (ADR-0173 D3) to their dist/src-anchored form — never an absolute path, never
  // a `node_modules`/`node:internal` frame. Capped at 8; absent when the error carried no `.stack`
  // this reducer could anchor.
  readonly frames?: readonly string[] | undefined;
  // The content-free CLASS of each link in the error's `.cause` chain (never the raw cause itself),
  // reduced by `causeChain`. Capped at 5; absent when the error carried no `.cause`.
  readonly causeChain?: readonly string[] | undefined;
}

export interface ServerDiagnosticSink {
  readonly record: (record: ServerDiagnosticRecord) => void;
}

// The default sink writes one structured JSON line to stderr AND — when the server is running
// under the CLI (KEIKO_STATE_DIR is set) — appends the same record to `<stateDir>/logs/server.log`.
// The two-track design is deliberate: unit tests that capture the sink via UiHandlerDeps.diagnostics
// keep observing stderr, while the shipped server writes a file the operator can read directly.
export const defaultServerDiagnosticSink: ServerDiagnosticSink = {
  record(record: ServerDiagnosticRecord): void {
    // The stderr line must carry the SAME redaction guarantee as the activity-log file line: the
    // raw caller-supplied `record` is never serialised directly. `diagnosticActivityLogFields`
    // already projects it onto allowlisted, bounded fields for the file sink (ADR-0173 D11 g29);
    // reused here rather than a second ad-hoc redaction so both channels share one contract.
    const safeLine = {
      correlationId: record.correlationId,
      timestamp: record.timestamp,
      operation: record.operation,
      errorClass: record.errorClass,
      ...diagnosticActivityLogFields(record),
    };
    // eslint-disable-next-line no-console
    console.error(`[keiko-server:diagnostic] ${JSON.stringify(safeLine)}`);
    appendDiagnosticToActivityLog(record);
  },
};

// Omits an absent value rather than writing it as `null`; see the projection contract below.
function addBoundedField(
  fields: Record<string, unknown>,
  name: string,
  value: string | number | undefined,
): void {
  if (value !== undefined) fields[name] = value;
}

// The closed vocabulary `unsupportedReasons` is allowed to carry: every declared mode Keiko
// recognises (the same set `boundedUnsupportedReason` in keiko-contracts already narrows a gateway
// declaration onto), plus the two fixed markers a producer falls back to when a declaration is
// unrecognised or names a non-chat capability. `boundedUnsupportedReason` already closes this
// vocabulary AT THE PRODUCER (gateway-setup.ts) — this is the SAME closure applied again,
// structurally, at the point that actually writes the value to disk: a future producer of this
// field that never calls `boundedUnsupportedReason`, or a bug that stops calling it, must not be
// able to put unbounded third-party text onto this record's activity-log line. The generic value
// guards in `log-redaction.ts` cannot backstop this on their own — a short, space-free vendor string
// like `"vendor-private-mode"` is indistinguishable from a legitimate reason code by shape alone.
export const UNSUPPORTED_REASON_VOCABULARY: ReadonlySet<string> = new Set([
  ...DECLARED_MODEL_MODES,
  "unrecognised-mode",
  "not-chat-capable",
]);
const UNSUPPORTED_REASON_FALLBACK = "unrecognised-mode";

// A diagnostic record is a CALLER-SUPPLIED object, so handing it to the activity log whole
// (`extra: { record }`) made every field of it — including every field added to the type later —
// a log field by default, and made the log's value guards the only thing standing between a
// future producer and a leaked value. The record is PROJECTED onto the fields an operator reads
// instead: counts, codes, hashes and labels, each named here in code. Anything not on this list
// never reaches the file, whatever a producer puts on the record.
//
// `message` is never projected under ITS OWN name: `message` is on `log-redaction.ts`'s
// `DENIED_FIELD_NAMES`, so a field literally named `message` would collapse to `[redacted:key]`
// even though the value is already safe — a code-declared, allowlisted summary, never foreign
// error/provider/customer text (see the field's own doc comment above). It is instead projected
// under `diagnosticSummary` (ADR-0173 D11 g29), and re-validated against the SAME closed
// vocabulary a second time here — the same "closure applied again, structurally, at the point
// that actually writes the value" `unsupportedReasons` above already uses — so a future producer
// that sets `.message` without going through `serverDiagnosticFromError`'s allowlist check cannot
// put arbitrary text on this line either. `timestamp` is absent because the line already carries
// `ts`; `correlationId`, `operation` and `errorClass` ride on the envelope.
function diagnosticActivityLogFields(record: ServerDiagnosticRecord): Record<string, unknown> {
  const fields: Record<string, unknown> = { source: record.source };
  addBoundedField(fields, "code", record.code);
  addBoundedField(fields, "gatewayRequestId", record.gatewayRequestId);
  addBoundedField(fields, "occurrenceCount", record.occurrenceCount);
  addBoundedField(fields, "frameBytes", record.frameBytes);
  addBoundedField(fields, "retainedModelCount", record.retainedModelCount);
  addBoundedField(fields, "unsupportedModelCount", record.unsupportedModelCount);
  addBoundedField(fields, "unverifiedEmbeddingModelCount", record.unverifiedEmbeddingModelCount);
  addBoundedField(fields, "droppedEmbeddingModelCount", record.droppedEmbeddingModelCount);
  addBoundedField(fields, "semanticSkippedCount", record.semanticSkippedCount);
  addBoundedField(fields, "semanticCandidateCount", record.semanticCandidateCount);
  addBoundedField(fields, "diagnosticSummary", allowlistedSummary(record.message));
  if (record.unsupportedReasons !== undefined) {
    fields.unsupportedReasons = record.unsupportedReasons.map((reason) =>
      closeReasonVocabulary(UNSUPPORTED_REASON_VOCABULARY, reason, UNSUPPORTED_REASON_FALLBACK),
    );
  }
  if (record.partialUsage !== undefined) {
    fields.promptTokens = record.partialUsage.promptTokens;
    fields.completionTokens = record.partialUsage.completionTokens;
  }
  if (record.frames !== undefined) fields.frames = record.frames;
  if (record.causeChain !== undefined) fields.causeChain = record.causeChain;
  return fields;
}

// Lazy file-log writer. Resolved from KEIKO_STATE_DIR, so the CLI wiring (which sets that env for
// the child server) picks up the file sink without any explicit bootstrap call — a defense in
// depth alongside UiServerDeps.activityLog: diagnostics emitted by code paths that do not go
// through createUiServer (background workers, capsule preflights) still reach the same file. The
// resolution is cached against the state directory it was resolved FOR, so a changed
// KEIKO_STATE_DIR rebuilds instead of writing to the previous process's file.
interface ActivityLogTarget {
  readonly stateDir: string;
  readonly write: (record: ServerDiagnosticRecord) => void;
}

let activityLogTarget: ActivityLogTarget | null = null;

function buildActivityLogTarget(stateDir: string): ActivityLogTarget {
  if (stateDir === "") {
    return {
      stateDir,
      write: (): void => {
        // No state directory: writes stay stderr-only.
      },
    };
  }
  const sink = createFileServerLogSink(stateDir);
  return {
    stateDir,
    write: (record: ServerDiagnosticRecord): void => {
      // Every record that reaches this sink is a FAILURE record — it carries an errorClass and a
      // failure summary. Without an explicit level the line defaults to `info`, so
      // `KEIKO_LOG_LEVEL=warn` would drop exactly the evidence an operator raised the threshold to
      // isolate. `error` also matches what the server logger stamps on `category: "diagnostic"`
      // lines, so both diagnostic paths land on the file at the same level.
      sink.write({
        level: "error",
        category: "diagnostic",
        op: record.operation,
        correlationId: record.correlationId,
        errorKind: record.errorClass,
        extra: diagnosticActivityLogFields(record),
      });
    },
  };
}

function appendDiagnosticToActivityLog(record: ServerDiagnosticRecord): void {
  const stateDir = process.env.KEIKO_STATE_DIR ?? "";
  if (activityLogTarget?.stateDir !== stateDir) {
    activityLogTarget = buildActivityLogTarget(stateDir);
  }
  activityLogTarget.write(record);
}

export const DEFAULT_SERVER_DIAGNOSTIC_SUMMARY = "server-operation-failed";

// Compatibility summaries are accepted only by exact match. Existing producers may still supply
// the historical `redact` callback, but it receives only DEFAULT_SERVER_DIAGNOSTIC_SUMMARY; it is
// never handed foreign error text. A callback that returns request/provider content therefore
// degrades to the default rather than extending the diagnostic trust boundary.
//
// Every literal `message` this module (or a caller building a `ServerDiagnosticRecord` by hand,
// e.g. `emitEvidenceRetentionDiagnostic` below) ever assigns MUST be a member of this list: since
// ADR-0173 D11 g29 the activity log projects `message` (as `diagnosticSummary`) through
// `allowlistedSummary`, so an entry missing here does not leak — it silently loses its summary on
// the log line instead. `message`'s own type stayed a plain `string` rather than
// `ServerDiagnosticSummary` (which would force every call site to satisfy this list at compile
// time) to keep the historical `redact`-callback compatibility path in `compatibilitySummary`
// working unchanged; this list is the runtime enforcement of the same closed vocabulary instead.
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
  "A detached capsule indexing run failed before reaching a terminal state.",
  "The coding sidecar gateway stream failed mid-response.",
  "Audit or evidence persistence failed.",
  "Debug production service composition failed.",
  "Managed task-workspace boundary materialization failed.",
  "Evidence retention deleted manifests.",
  "Semantic memory retrieval skipped incompatible embeddings.",
  "Semantic memory retrieval was disabled for this turn.",
] as const;

export type ServerDiagnosticSummary = (typeof SERVER_DIAGNOSTIC_SUMMARIES)[number];

const SERVER_DIAGNOSTIC_SUMMARY_SET: ReadonlySet<string> = new Set(SERVER_DIAGNOSTIC_SUMMARIES);

const OPERATION_LABEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*(?: [A-Za-z0-9/][A-Za-z0-9._:/-]*)?$/;
const SOURCE_LABEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_DIAGNOSTIC_LABEL_LENGTH = 160;

// `keikoStackFrames`/`causeChain` always return an array, empty when there is nothing to report
// (no stack, no cause). An empty array is still a VALUE, and writing `frames: []`/`causeChain: []`
// onto every diagnostic record — including the vast majority that carry no error object at all —
// would put a content-free but permanent field on every single line. Degrading empty to `undefined`
// keeps both fields doing what every other optional field on this record already does: present
// only when there is real evidence, `addBoundedField`'s omission contract downstream.
function nonEmpty(values: readonly string[]): readonly string[] | undefined {
  return values.length > 0 ? values : undefined;
}

// Extracts only the diagnosable, body-free shape of an unknown thrown value. In particular this
// function never reads `.message` or stringifies the value. Machine fields are read independently
// through fail-closed property access, then admitted only by their bounded shapes. `frames` and
// `causeChain` (ADR-0173 D3) reuse `stack-frames.ts`'s reducers rather than re-deriving them: a
// second stack reducer here would either duplicate that module's dist-anchoring and bounds, or,
// worse, drift from them.
export function describeError(error: unknown): {
  readonly errorClass: string;
  readonly code?: string | undefined;
  readonly gatewayRequestId?: string | undefined;
  readonly partialUsage?:
    { readonly promptTokens: number; readonly completionTokens: number } | undefined;
  readonly frames?: readonly string[] | undefined;
  readonly causeChain?: readonly string[] | undefined;
} {
  return {
    errorClass: contentFreeErrorClass(error),
    code: machineToken(safeProperty(error, "code")),
    gatewayRequestId: machineToken(safeProperty(error, "requestId")),
    partialUsage: partialUsageCounts(safeProperty(error, "partialUsage")),
    frames: nonEmpty(keikoStackFrames(error)),
    causeChain: nonEmpty(causeChain(error)),
  };
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
    message: "Evidence retention deleted manifests.",
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
    ...(described.frames === undefined ? {} : { frames: described.frames }),
    ...(described.causeChain === undefined ? {} : { causeChain: described.causeChain }),
  };
}
