import { DECLARED_MODEL_MODES } from "@oscharko-dev/keiko-contracts/runtime/gateway";
import { providerErrorDetail } from "@oscharko-dev/keiko-model-gateway";

import { isValidCorrelationId } from "./correlation.js";

import {
  contentFreeErrorClass,
  machineToken,
  safeProperty,
} from "./observability/error-classification.js";
import { closeReasonVocabulary, redactLogFields } from "./observability/log-redaction.js";
import { redactRoutePath } from "./observability/route-template.js";
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
// This module turns those failures into a structured, correlation-keyed operator record. It never
// surfaces raw content to the browser; the response body stays opaque and the record is emitted only
// to the server's own diagnostic channel. `defaultServerDiagnosticSink` — the one production sink,
// and the only code that writes a record to stderr and the activity log — is the redaction-safe
// choke point: it sanitizes the record's correlation ids itself, so a caller that invokes
// `.record()` directly is protected exactly like one that goes through `emitServerDiagnostic`.

import { randomUUID } from "node:crypto";

export interface ServerDiagnosticRecord {
  readonly correlationId: string;
  // The correlation id of the request/run that SPAWNED this one, set only when this record
  // belongs to a background job/HarnessEvent run whose own `correlationId` was minted fresh at
  // that job's start (ADR-0173 D5 / g12) — a request-scoped record already has continuity through
  // `correlationId` alone and never sets this. Shape-guarded, not merely redacted, the same way
  // `server-log.ts`'s `applyEnvelopeFields` guards its own `parentCorrelationId` envelope field:
  // `diagnosticActivityLogFields` only projects this into `extra` when it satisfies
  // `isValidCorrelationId`; a value that does not fit the shape is dropped outright rather than
  // written under a marker — an unshaped value here is evidence of a producer bug, never content
  // worth preserving a trace of. `defaultServerDiagnosticSink.record()` ALSO sanitizes this field
  // (and `correlationId`, for symmetry) on the record itself before writing — see
  // `sanitizeDiagnosticRecord` — because `diagnosticActivityLogFields`'s guard only protects the
  // activity-log projection; without the writer-side check, the sink's `JSON.stringify(record)`
  // would still serialize an invalid value straight to stderr. `emitServerDiagnostic` applies the
  // same sanitizer before handing a record to a caller-supplied sink.
  readonly parentCorrelationId?: string | undefined;
  readonly timestamp: string;
  // A coarse operation label, e.g. `GET /api/projects` or `chat.stream`.
  readonly operation: string;
  // Where the failure was observed, e.g. `server.top-level-catch` or `chat.stream`.
  readonly source: string;
  // The content-free error class (never the raw message), e.g. `Error`, `TransportError`.
  readonly errorClass: string;
  // A code-declared, allowlisted summary. Foreign error/provider/customer text is never read.
  // Typed as the closed `ServerDiagnosticSummary` union (Issue #3245) rather than `string`, so a
  // producer that assigns free text no longer compiles — `allowlistedSummary`'s runtime check
  // below remains as defence in depth for a record built without going through the type checker
  // (e.g. `JSON.parse`d input, or a caller that casts around the type).
  readonly message: ServerDiagnosticSummary;
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
  // The provider HTTP status a `ProviderError`/`RateLimitError` carried (ADR-0173 D5 g26), derived
  // through the SAME `providerErrorDetail` helper `resilience.ts`'s retry lines already use — one
  // implementation of "what HTTP status did the provider report", not a second one bolted on here.
  // Removes the reconstruction ambiguity a bare `GATEWAY_PROVIDER_ERROR`/`GATEWAY_RATE_LIMIT`
  // `errorClass` leaves behind (which of 429/500/502/503/529 actually happened).
  readonly httpStatus?: number | undefined;
  // The provider-supplied retry delay a `RateLimitError` carried (ADR-0173 D5 g26), same
  // `providerErrorDetail` derivation. A count only — never content.
  readonly retryAfterMs?: number | undefined;
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
  // How many corrupt-lock quarantine files (update-session-lock.ts's `.corrupt.<iso-stamp>`
  // forensic evidence) a prune sweep could not remove -- a directory/stat/unlink failure that used
  // to be swallowed outright (#2906 round 3). The successful removal count for the SAME sweep
  // reuses `occurrenceCount`, matching `emitEvidenceRetentionDiagnostic`'s existing convention for
  // "how many things this retention pass removed"; this field is present only when at least one
  // entry could not be removed, so support can tell "nothing left to prune" apart from "pruning is
  // failing repeatedly" (the latter can otherwise accumulate indefinitely with no operator signal).
  readonly quarantinePruneFailedCount?: number | undefined;
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
//
// This sink is the sanitizing choke point for the two ids a hostile or buggy producer can shape:
// `sanitizeDiagnosticRecord` runs HERE, on the writer, so a record handed straight to `.record()`
// — as grounded-entailment-stage, codingRuntimeEventHub and sessionChannel do — is protected
// exactly like one routed through `emitServerDiagnostic`.
export const defaultServerDiagnosticSink: ServerDiagnosticSink = {
  record(record: ServerDiagnosticRecord): void {
    // Two guarantees, applied in order. First the record's correlation ids are sanitized
    // (`sanitizeDiagnosticRecord`: a CRLF-bearing or otherwise out-of-shape id never reaches
    // either track — this sink is the choke point for the three direct `.record()` callers as
    // much as for `emitServerDiagnostic`). Then the stderr line carries the SAME redaction
    // guarantee as the activity-log file line: `diagnosticActivityLogFields` projects the record
    // onto allowlisted, bounded FIELD NAMES (ADR-0173 D11 g29), but a field name allowlist alone
    // does not check what a caller put IN a field's value — that is `redactLogFields`'s job, and
    // the file sink already runs every `extra` field through it (`formatServerLogLine`). Running
    // the same projected fields through `redactLogFields` here, not just through the name
    // projection, is what actually makes the two channels share one contract instead of only
    // sharing the field list.
    const sanitized = sanitizeDiagnosticRecord(record);
    const safeLine = {
      correlationId: sanitized.correlationId,
      timestamp: sanitized.timestamp,
      operation: sanitized.operation,
      errorClass: sanitized.errorClass,
      ...redactLogFields(diagnosticActivityLogFields(sanitized)),
    };
    // eslint-disable-next-line no-console
    console.error(`[keiko-server:diagnostic] ${JSON.stringify(safeLine)}`);
    appendDiagnosticToActivityLog(sanitized);
  },
};

// `code` is a producer-declared machine token: coded-error codes, `GatewayError.code`, or a
// colon-joined `key=value` detail string (#3245 moved per-invocation counts and closed labels here
// when `message` became a closed vocabulary). Bounded at the writer, not only at each producer: no
// whitespace, a fixed alphabet, at most 256 characters — a value outside the shape is dropped, never
// written under a marker, because an out-of-shape code is evidence of a producer bug, not content
// worth preserving.
const DIAGNOSTIC_CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:=/-]{0,255}$/u;

function boundedDiagnosticCode(code: string | undefined): string | undefined {
  return code !== undefined && DIAGNOSTIC_CODE_SHAPE.test(code) ? code : undefined;
}

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
  addBoundedField(fields, "code", boundedDiagnosticCode(record.code));
  if (
    record.parentCorrelationId !== undefined &&
    isValidCorrelationId(record.parentCorrelationId)
  ) {
    addBoundedField(fields, "parentCorrelationId", record.parentCorrelationId);
  }
  addBoundedField(fields, "gatewayRequestId", record.gatewayRequestId);
  addBoundedField(fields, "httpStatus", record.httpStatus);
  addBoundedField(fields, "retryAfterMs", record.retryAfterMs);
  addBoundedField(fields, "occurrenceCount", record.occurrenceCount);
  addBoundedField(fields, "frameBytes", record.frameBytes);
  addBoundedField(fields, "retainedModelCount", record.retainedModelCount);
  addBoundedField(fields, "unsupportedModelCount", record.unsupportedModelCount);
  addBoundedField(fields, "unverifiedEmbeddingModelCount", record.unverifiedEmbeddingModelCount);
  addBoundedField(fields, "droppedEmbeddingModelCount", record.droppedEmbeddingModelCount);
  addBoundedField(fields, "semanticSkippedCount", record.semanticSkippedCount);
  addBoundedField(fields, "semanticCandidateCount", record.semanticCandidateCount);
  addBoundedField(fields, "quarantinePruneFailedCount", record.quarantinePruneFailedCount);
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
// e.g. `emitEvidenceRetentionDiagnostic` below) ever assigns MUST be a member of this list.
// `ServerDiagnosticRecord.message` is typed `ServerDiagnosticSummary` (Issue #3245), so a producer
// assigning a string that is not a member of this array fails `npm run typecheck` outright — the
// vocabulary is now closed at compile time, not merely by convention. `allowlistedSummary` (and
// `diagnosticActivityLogFields`'s use of it below) remains as runtime defence in depth for a
// record that reaches this module without having gone through the type checker (e.g. a value
// reconstructed from persisted/JSON-parsed data, or a caller that casts around the type): since
// ADR-0173 D11 g29 the activity log projects `message` (as `diagnosticSummary`) through
// `allowlistedSummary`, so a record whose `message` fails the runtime check does not leak — it
// silently loses its summary on the log line instead of ever being echoed as-is.
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
  "Harness run reached a terminal completed state.",
  "Harness run reached a terminal failed state.",
  "Harness run reached a terminal cancelled state.",
  "Bug-investigation workflow reached a terminal completed state.",
  "Bug-investigation workflow reached a terminal failed state.",
  "Unit-test workflow reached a terminal completed state.",
  "Unit-test workflow reached a terminal failed state.",
  // Issue #3245: `message` narrowed from `string` to this closed union surfaced every producer
  // that had been assigning free/bounded-but-uncatalogued text. Each entry below is the literal
  // a real producer already assigned (or, where the producer used to embed per-invocation
  // dynamic data via a template literal, the fixed condition label that replaced it — the
  // dynamic detail moved to the record's existing `code` field, which already exists for exactly
  // this "stable machine-readable code" purpose, or was dropped outright where it was unbounded
  // free text, e.g. figmaSnapshotRoutes.ts's former `err.message` echo).
  "chat-memory-auto-maintenance-failed",
  "chat-memory-post-commit-side-effect-failed",
  "sse-backpressure",
  "sse-subscriber-write-failed",
  "sse-listener-failed",
  "runtime-event-invalid",
  "runtime-exit-code",
  "runtime-stderr-counts",
  "runtime-stream-drain-failed",
  "runtime-approval-revocation-failed",
  "runtime-handshake-failed",
  "runtime-lifecycle-failed",
  "runtime-start-failed",
  "runtime-turn-failed",
  "safe-activity-dropped-validation-rejected",
  "safe-activity-dropped-redactor-collapsed",
  "safe-activity-dropped-projection-rejected",
  "safe-activity-dropped-capacity-rejected",
  "safe-activity-dropped-subscriber-rejected",
  "safe-activity-purged-stop",
  "safe-activity-purged-takeover",
  "safe-activity-purged-shutdown",
  "safe-activity-purged-workspace-switch",
  // #2906 round 3: replaces the former "safe-activity-purged-expiry" -- that code was only ever
  // used by codingSafeActivityProjection.ts's KEIKO-0878 invariant-violation branch (real TTL
  // expiry purges silently via expireCurrent(), with no diagnostic at all), so the label
  // misreported every invariant/projection failure it fired for as an expiry.
  "safe-activity-purged-invariant-violation",
  "workspace-discovery-failed",
  "edit-transport-failed",
  "prepare-bridge-close",
  "prepare-run-root-remove",
  "tool-facade-failed",
  "sidecar-gateway-evidence-aggregation-failed",
  "coding-sidecar-gateway-profile-unavailable",
  "coding-sidecar-gateway-tool-contract-rejected",
  "coding-sidecar-gateway-tool-adoption-gap",
  "Local credential migration failed; plaintext config remains in place.",
  "Editor local-history capture failed.",
  "Verification execution failed unexpectedly.",
  "A verification event subscriber failed.",
  "Gateway tool-calling verification could not be persisted.",
  "Model discovery exceeded the discovery cap; setup continued with the retained models.",
  // KEIKO-0884 (#3333): loopback was the only egress class Gateway Setup accepted with no
  // configuration signal, no log line, and no opt-in trail. Not a failure — a deliberate, silent
  // acceptance made operator-visible.
  "Gateway Setup accepted a loopback candidate target.",
  "Stored gateway egress configuration was invalid; setup omitted it from the rewritten file.",
  "Setup skipped models the gateway declared as unsupported modes or that failed the embedding probe.",
  "gateway-setup-audit-validation-failed",
  "entailment-claim-judging-incomplete",
  "entailment stage failed; degraded to WARN",
  "model-incompatible",
  "capability-unenriched",
  "model-port-unavailable",
  "grounded-memory-enrichment-failed",
  "advisory-phase-summary",
  "salience-extraction-diagnostic",
  "salience-capture-dropped-queue-full",
  "salience-capture-summary",
  "figma-internal-error",
  "Network isolation probe failed; verification enforcement defaults to fail-closed.",
  "SSE stream destroyed because the client stopped draining.",
  "grounded-preview-citations-row-dropped",
  "release-impact-bundled-catalog-corrupted",
  "memory-consolidation-scheduled-job-failed",
  "functional-workspace-read-not-found",
  "functional-workspace-read-permission-denied",
  "atlassian-credential-rejection-activity-log-failed",
  // #2906 round 3: update-session-lock.ts's corrupt-lock quarantine prune used to swallow
  // directory/stat/unlink failures outright. "-pruned" reports a clean sweep (occurrenceCount is
  // the removed count); "-prune-degraded" reports one where at least one entry could not be
  // removed (occurrenceCount stays the removed count, quarantinePruneFailedCount carries the rest).
  "update-session-quarantine-pruned",
  "update-session-quarantine-prune-degraded",
  // #2906 round 3 (P1): debugSessionRegistry.ts's terminal-evidence reconciliation gives up after
  // a bounded number of appendEvidence() failures rather than retrying forever -- see
  // dapProductionService.ts's reportEvidenceAbandoned.
  "dap-session-terminal-evidence-abandoned",
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
  readonly httpStatus?: number | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly partialUsage?:
    { readonly promptTokens: number; readonly completionTokens: number } | undefined;
  readonly frames?: readonly string[] | undefined;
  readonly causeChain?: readonly string[] | undefined;
} {
  // `providerErrorDetail` (keiko-model-gateway/resilience.ts) is the SAME instanceof-based
  // derivation `gateway.retry.*` lines already use — reused, not re-implemented, so a diagnostic
  // record and its sibling retry line never disagree about what a `ProviderError`/`RateLimitError`
  // carried (ADR-0173 D5 g26).
  const detail = providerErrorDetail(error);
  return {
    errorClass: contentFreeErrorClass(error),
    code: machineToken(safeProperty(error, "code")),
    gatewayRequestId: machineToken(safeProperty(error, "requestId")),
    httpStatus: detail.httpStatus,
    retryAfterMs: detail.retryAfterMs,
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

// An operation label shaped like `"GET /api/foo/bar"` (a method word, a space, then a path
// starting with `/`) carries a live request path in its trailing word, and a path segment can be
// a customer-chosen identifier — a project name, a repository, a capsule id — exactly the raw
// content this record's own contract (counts, hashes, closed-vocabulary labels; never customer
// content) forbids. `redactRoutePath` (route-template.ts) is the reducer the HTTP request line
// itself already uses for the same purpose; calling it here reuses that one reduction instead of
// writing a second one, so there is exactly one place that decides what a route "looks like" once
// redacted. `SOURCE_LABEL_SHAPE` never admits a `/`, so this only ever runs for `fallback ===
// "server.operation"`. A label with no path component (e.g. `"chat.stream"`) is returned as-is.
function pathReducedOperationLabel(value: string): string | undefined {
  const spaceIndex = value.indexOf(" ");
  const prefix = spaceIndex === -1 ? "" : value.slice(0, spaceIndex + 1);
  const path = spaceIndex === -1 ? value : value.slice(spaceIndex + 1);
  if (!path.startsWith("/")) return value;
  const template = redactRoutePath(path, MAX_DIAGNOSTIC_LABEL_LENGTH - prefix.length);
  return template === undefined ? undefined : `${prefix}${template}`;
}

function diagnosticLabel(
  value: unknown,
  shape: RegExp,
  fallback: "server.operation" | "server.diagnostic",
): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_DIAGNOSTIC_LABEL_LENGTH ||
    !shape.test(value)
  ) {
    return fallback;
  }
  if (fallback !== "server.operation") return value;
  // A path this server does not serve (an unknown route) or one wearing traversal segments
  // (`redactRoutePath` fails closed on both) is not partially echoed — the whole label degrades
  // to the fallback, same fail-closed direction `redactRoutePath` itself documents.
  return pathReducedOperationLabel(value) ?? fallback;
}

// A fixed, content-free stand-in for a `correlationId` that fails `isValidCorrelationId`.
// `correlationId` is required by `ServerDiagnosticRecord`, so — unlike the optional
// `parentCorrelationId`, which can simply be omitted — an out-of-shape value cannot be dropped
// outright without leaving the field empty. Substituting this marker keeps the record's own shape
// intact while guaranteeing the value that reaches a sink is never the hostile original.
const INVALID_CORRELATION_ID_MARKER = "invalid-correlation-id";

function sanitizedCorrelationId(value: string): string {
  return isValidCorrelationId(value) ? value : INVALID_CORRELATION_ID_MARKER;
}

function sanitizedParentCorrelationId(value: string | undefined): string | undefined {
  return value !== undefined && isValidCorrelationId(value) ? value : undefined;
}

// `diagnosticActivityLogFields` already shape-guards `parentCorrelationId` when projecting a record
// into the activity-log `extra` object — but that guard runs too late to help the stderr track,
// which serializes the record via `JSON.stringify`. A `parentCorrelationId` (or, for symmetry, a
// `correlationId`) that fails `isValidCorrelationId` — e.g. one carrying an embedded CRLF — would
// otherwise reach that stderr line untouched, regardless of what the activity-log projection does
// with its own copy. The sanitizer is applied by `defaultServerDiagnosticSink.record()` itself, the
// one place that writes, so it covers every caller of the default sink whether or not it went
// through `emitServerDiagnostic` — three production sites call `.record()` directly.
// `emitServerDiagnostic` applies it as well so a caller-supplied sink never observes the hostile
// original; the operation is idempotent. `diagnosticActivityLogFields`'s own guard remains in place
// as defence in depth.
function sanitizeDiagnosticRecord(record: ServerDiagnosticRecord): ServerDiagnosticRecord {
  return {
    ...record,
    correlationId: sanitizedCorrelationId(record.correlationId),
    parentCorrelationId: sanitizedParentCorrelationId(record.parentCorrelationId),
  };
}

// Emits a diagnostic record through the provided sink (falling back to the default stderr sink).
// Never throws — a diagnostic sink failure must not compound the original request failure.
export function emitServerDiagnostic(
  sink: ServerDiagnosticSink | undefined,
  record: ServerDiagnosticRecord,
): void {
  try {
    (sink ?? defaultServerDiagnosticSink).record(sanitizeDiagnosticRecord(record));
  } catch {
    // A logging failure is never allowed to escalate into a second, unhandled failure.
  }
}

// `correlationId` defaults to a fresh mint ONLY so a caller that already has a request/run id in
// scope can pass it straight through (ADR-0173 D5 / g12) — the retention sweep itself has no
// triggering request, so `evidenceRetentionDiagnosticObserver` below is the real production path
// and mints exactly once per observer rather than once per call, so every deletion this ONE
// retention pass reports stays joinable under the same id.
export function emitEvidenceRetentionDiagnostic(
  sink: ServerDiagnosticSink | undefined,
  source: string,
  occurrenceCount: number,
  correlationId: string = randomUUID(),
): void {
  emitServerDiagnostic(sink, {
    correlationId,
    timestamp: new Date().toISOString(),
    operation: "evidence.retention",
    source: diagnosticLabel(source, SOURCE_LABEL_SHAPE, "server.diagnostic"),
    errorClass: "EvidenceRetention",
    message: "Evidence retention deleted manifests.",
    occurrenceCount,
  });
}

// Minted ONCE here, at the start of the enclosing retention-observer registration, rather than
// inside `emitEvidenceRetentionDiagnostic` on every `onRetentionDeleted` firing: a single retention
// pass over one evidence store can delete manifests from more than one bucket, and each deletion
// used to mint its own disconnected id — making it impossible for an operator to tell two
// deletions from the SAME sweep apart from two deletions from different sweeps.
export function evidenceRetentionDiagnosticObserver(
  sink: ServerDiagnosticSink | undefined,
  source: string,
): (occurrenceCount: number) => void {
  const correlationId = randomUUID();
  return (occurrenceCount: number): void => {
    emitEvidenceRetentionDiagnostic(sink, source, occurrenceCount, correlationId);
  };
}

// The optional half of `describeError`'s output, each field omitted (never written as
// `undefined`) rather than always present — split out of `serverDiagnosticFromError` purely to
// keep that function's cyclomatic complexity under the repository's limit as the field set grows;
// the omission contract itself is unchanged from before this split.
function describedErrorFields(
  described: ReturnType<typeof describeError>,
): Partial<
  Pick<
    ServerDiagnosticRecord,
    | "code"
    | "gatewayRequestId"
    | "httpStatus"
    | "retryAfterMs"
    | "partialUsage"
    | "frames"
    | "causeChain"
  >
> {
  return {
    ...(described.code === undefined ? {} : { code: described.code }),
    ...(described.gatewayRequestId === undefined
      ? {}
      : { gatewayRequestId: described.gatewayRequestId }),
    ...(described.httpStatus === undefined ? {} : { httpStatus: described.httpStatus }),
    ...(described.retryAfterMs === undefined ? {} : { retryAfterMs: described.retryAfterMs }),
    ...(described.partialUsage === undefined ? {} : { partialUsage: described.partialUsage }),
    ...(described.frames === undefined ? {} : { frames: described.frames }),
    ...(described.causeChain === undefined ? {} : { causeChain: described.causeChain }),
  };
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
    ...describedErrorFields(described),
  };
}
