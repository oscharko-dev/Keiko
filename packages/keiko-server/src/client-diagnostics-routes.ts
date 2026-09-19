// `POST /api/diagnostics/client` (Wave 5 of epic #3233, ADR-0173).
//
// The browser-side sink (`packages/keiko-ui/src/lib/client-diagnostics.ts`) buffers an already
// bounded, already-redacted-by-convention diagnostic string, but that promise is a LIBRARY
// contract on the browser side — never a trust boundary the server may rely on. This route treats
// every field as hostile input and re-validates it independently:
//
//   * shape and length come from `isClientDiagnosticIngestRequest` (keiko-contracts, the leaf);
//   * `correlationId` is only ever trusted after `isValidCorrelationId` — the same server-side
//     policy every other correlation id on this server goes through (`correlation.ts`) — so a
//     browser cannot inject an arbitrary join key onto another request's timeline;
//   * the optional Git-change response identity is a closed, body-free contract and is projected
//     field-by-field; unknown browser fields can never enter the activity log;
//   * the hostile message text is reduced to a domain-separated SHA-256 digest before it reaches
//     the logger. Length bounds and generic redaction are useful defenses, but neither makes an
//     arbitrary client sentence an opaque identifier; the raw message never enters the event.
//
// Rate limiting reuses `createInlineCompletionRateLimiter` (the editor's existing token-bucket
// primitive — AGENTS.md §5 forbids a second one) as a single, process-wide bucket: a flapping tab
// or a hostile page must not be able to grow the activity log without bound. The response is 204
// whether a report was accepted or dropped by the limiter — the limit itself is never disclosed to
// the browser — and a dropped report is still counted, mirroring `server-log.ts`'s own
// `reportServerLogFailure` throttle-and-count-suppressed shape: the first drop after a quiet window
// is logged immediately, later drops in the same window are counted silently, and the count is
// flushed on the next window's first drop — or, at the latest, by
// `flushClientDiagnosticsIngestCounts` when the process shuts down (#3532).
//
// Every refused report (malformed JSON, a shape the contract rejects, an oversized or cancelled
// body) gets its own throttled `client.diagnostic.rejected` line, and every drop, rejection and
// browser-reported delivery loss is also counted in the process-wide loss ledger that the
// `activity-log.loss` summary persists. None of those paths ever carries the refused content.
//
// #3557: a third shape, a binding report, carries a restored window's binding outcome
// (`client.binding.resolved`/`client.binding.target-missing`) with closed values only.
//
// KEIKO-3557: this route accepts TWO closed report shapes on the same rate limit, size bound, and
// rejection/loss accounting above. A message report (the shape this header describes) reaches
// `client.diagnostic` — a FAILURE, always at warn. A stage report (`useWindowStageEvidence`,
// keiko-ui: a desktop window placeholder mounting and later unmounting) reaches
// `client.stage.started`/`client.stage.settled` instead — the ORDINARY case, at info, with no
// `errorKind`. Routing routine evidence through the failure-shaped operation is exactly the defect
// this pair fixes: a live log showed 416 of 449 `client.diagnostic` lines were stage evidence, all
// misclassified warn/unknown and burying the rare real failures a `keiko support analyze --clusters`
// pass needs to find.

import type { IncomingMessage } from "node:http";

import type {
  ClientBindingIngestRequest,
  ClientDiagnosticIngestRequest,
  ClientDiagnosticLossCounts,
  ClientSessionRepairIngestRequest,
  ClientStageId,
  ClientStageIngestRequest,
  ClientStageSettledIngestRequest,
  ClientStageStartedIngestRequest,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import {
  CLIENT_BINDING_FAILURE_OUTCOMES,
  CLIENT_SESSION_REPAIR_ROUTINE_OUTCOMES,
  isClientBindingIngestRequest,
  isClientDiagnosticIngestRequest,
  isClientSessionRepairIngestRequest,
  isClientStageIngestRequest,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import {
  activityLogEvent,
  defineActivityLogOperation,
  recordActivityLogLoss,
  type ActivityLogErrorKind,
  type ActivityLogFields,
  type ActivityLogLossReason,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";

import {
  RequestBodyCancelledError,
  RequestBodyTooLargeError,
  readBoundedRequestBody,
} from "./bounded-request-body.js";
import { correlationIdOrUnknown, isValidCorrelationId } from "./correlation.js";
import {
  createInlineCompletionRateLimiter,
  type InlineCompletionRateLimiter,
} from "./editor/inlineCompletionRateLimiter.js";
import { getServerLogger } from "./observability/index.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";

// A diagnostic report is a handful of short fields — generous relative to the wire guard's own
// 200-character message cap, never a channel for an attached body.
const MAX_CLIENT_DIAGNOSTIC_BODY_BYTES = 4_096;

// Process-wide, not per-connection (this endpoint identifies no session): 60 accepted reports per
// rolling minute is generous for genuine crash/error reporting and bounds a flooding or hostile
// page. `minIntervalMs: 0` disables the limiter's own burst/cooldown gate, so only the sliding
// window cap below applies.
//
// Two sliding windows (#3557): routine evidence (a stage, a binding that resolved, a session repair
// that recovered) spends its own budget, so a page load's dozen stage reports can never use up the
// budget a failure report needs.
const CLIENT_DIAGNOSTIC_RATE_LIMIT_KEYS = {
  failure: "client-diagnostics",
  routine: "client-diagnostics-routine",
} as const;

const CLIENT_DIAGNOSTIC_RATE_LIMITED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.diagnostic.rate-limited",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.noticeRateLimitedDrop",
  fields: {
    suppressedDrops: { type: "integer", dataClass: "count", required: false },
    // Which budget overflowed, so a dropped failure report is never hidden behind routine
    // evidence (#3557 review).
    budget: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["failure", "routine"],
    },
    trigger: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["window", "shutdown-flush"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "loss",
  analyzerProjection: "failure-cluster",
  failureClasses: ["client-diagnostic-rate-limit"],
  proofIds: ["client.diagnostic.rate-limited.line"],
  releaseImpact: "patch",
});

const CLIENT_DIAGNOSTIC_REJECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.diagnostic.rejected",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.noticeRejectedReport",
  fields: {
    rejection: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["invalid-json", "invalid-shape", "too-large", "cancelled"],
    },
    suppressedRejections: { type: "integer", dataClass: "count", required: false },
    trigger: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["window", "shutdown-flush"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "loss",
  analyzerProjection: "failure-cluster",
  failureClasses: ["client-diagnostic-rejection"],
  proofIds: ["client.diagnostic.rejected.line", "client.diagnostic.rejected.shutdown-flush"],
  releaseImpact: "minor",
});

const CLIENT_VOICE_DIALOGUE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "voice.dialogue.stage",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.logVoiceDialogueStage",
  fields: {
    voiceCaptureError: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "type-error",
        "range-error",
        "invalid-state",
        "not-supported",
        "security",
        "not-readable",
        "other",
      ],
    },
    voiceCaptureReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "vad-unavailable",
        "speech-observed",
        "renewal-unsupported",
        "replacement-create-failed",
        "replacement-start-failed",
        "previous-stop-failed",
        "replacement-stop-failed",
        "unknown-failure",
      ],
    },
    voiceDialogueStage: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "started",
        "turn-submitted",
        "answer-ready",
        "playback-settled",
        "playback-fallback",
        "capture-bound-reached",
        "capture-renewed",
        "interrupted",
        "stopped",
      ],
    },
    clientBufferEvicted: { type: "integer", dataClass: "count", required: false },
    clientPostsThrottled: { type: "integer", dataClass: "count", required: false },
    clientPostsFailed: { type: "integer", dataClass: "count", required: false },
    clientRejectionsSuppressed: { type: "integer", dataClass: "count", required: false },
    clientErrorsSuppressed: { type: "integer", dataClass: "count", required: false },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["client-diagnostic"],
  proofIds: ["voice.dialogue.stage.line"],
  releaseImpact: "patch",
});

const CLIENT_MARKDOWN_LAYOUT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.markdown.layout",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.logMarkdownLayout",
  fields: {
    messageId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    listNumbering: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["source-start"],
    },
    listStart: { type: "integer", dataClass: "count", required: false },
    listIndex: { type: "integer", dataClass: "count", required: false },
    depth: { type: "integer", dataClass: "count", required: false },
    clientBufferEvicted: { type: "integer", dataClass: "count", required: false },
    clientPostsThrottled: { type: "integer", dataClass: "count", required: false },
    clientPostsFailed: { type: "integer", dataClass: "count", required: false },
    clientRejectionsSuppressed: { type: "integer", dataClass: "count", required: false },
    clientErrorsSuppressed: { type: "integer", dataClass: "count", required: false },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["client-diagnostic"],
  proofIds: ["client.markdown.layout.line"],
  releaseImpact: "patch",
});

const CLIENT_DIAGNOSTIC_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.diagnostic",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.logClientDiagnostic",
  fields: {
    errorClass: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
    moduleLoadFailure: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["git-sync", "git-history"],
    },
    clientNoteDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    readyState: { type: "integer", dataClass: "count", required: false },
    clientKind: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "boundary",
        "unhandled-rejection",
        "window-error",
        "sse-error",
        "voice-dialogue",
        "voice-playback",
        "markdown-layout",
        "other",
      ],
    },
    voiceCaptureError: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "type-error",
        "range-error",
        "invalid-state",
        "not-supported",
        "security",
        "not-readable",
        "other",
      ],
    },
    voiceCaptureReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "vad-unavailable",
        "speech-observed",
        "renewal-unsupported",
        "replacement-create-failed",
        "replacement-start-failed",
        "previous-stop-failed",
        "replacement-stop-failed",
        "unknown-failure",
      ],
    },
    voiceDialogueStage: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "started",
        "preparation-failed",
        "turn-submitted",
        "queue-unavailable",
        "answer-ready",
        "delivery-failed",
        "delivery-cancelled",
        "delivery-rejected",
        "capture-renewal-failed",
        "playback-settled",
        "playback-fallback",
        "capture-bound-reached",
        "capture-renewed",
        "interrupted",
        "stopped",
      ],
    },
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["review", "approve", "apply"],
    },
    disposition: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["accepted", "discarded"],
    },
    relationshipId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    snapshotDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    proposalId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["preview", "approved", "observed", "blocked"],
    },
    repositoryId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 256 },
    workspaceId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 256 },
    clientBufferEvicted: { type: "integer", dataClass: "count", required: false },
    clientPostsThrottled: { type: "integer", dataClass: "count", required: false },
    clientPostsFailed: { type: "integer", dataClass: "count", required: false },
    clientRejectionsSuppressed: { type: "integer", dataClass: "count", required: false },
    clientErrorsSuppressed: { type: "integer", dataClass: "count", required: false },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["client-diagnostic"],
  proofIds: ["client.diagnostic.line"],
  releaseImpact: "patch",
});

// Kebab-case persisted vocabulary for the `stage` field below. The registration generator's closed
// value pattern refuses the space-separated wire ids (`ClientStageId`, e.g. "chat window chunk")
// outright, and every other closed-enum field this module persists is already kebab-case
// (`clientKind`, `action`, `disposition`, `outcome`). The `satisfies` clause keeps this map
// exhaustive: a new `ClientStageId` the contracts leaf adds without a matching entry here fails
// typecheck, not a gate.
const CLIENT_STAGE_ACTIVITY_LOG_IDS = [
  "window-chunk",
  "chat-window-chunk",
  "editor-widget-chunk",
  "files-widget-chunk",
  "chat-bind",
] as const;

const CLIENT_STAGE_ACTIVITY_LOG_ID_BY_WIRE_ID = {
  "window chunk": "window-chunk",
  "chat window chunk": "chat-window-chunk",
  "editor widget chunk": "editor-widget-chunk",
  "files widget chunk": "files-widget-chunk",
  "chat bind": "chat-bind",
} as const satisfies Record<ClientStageId, (typeof CLIENT_STAGE_ACTIVITY_LOG_IDS)[number]>;

// KEIKO-3557: routine desktop-window stage evidence (`useWindowStageEvidence`, keiko-ui) rides its
// own lifecycle operations instead of the failure-shaped `CLIENT_DIAGNOSTIC_OPERATION` above — a
// stage that starts and settles is the ordinary case, not a warning. Modelled on the non-failure
// `coding-app-session.channel.opened`/`.closed` pair (codingAppSessionRoutes.ts): `start`/`end`
// lifecycle, `timeline` projection, no `errorKind`, at level info.
const CLIENT_STAGE_FIELDS = {
  stage: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: CLIENT_STAGE_ACTIVITY_LOG_IDS,
  },
  ordinal: { type: "integer", dataClass: "count", required: true },
} as const;

const CLIENT_STAGE_STARTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.stage.started",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.logClientStageStarted",
  fields: CLIENT_STAGE_FIELDS,
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["client-stage"],
  proofIds: ["client.stage.started.line"],
  releaseImpact: "patch",
});

const CLIENT_STAGE_SETTLED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.stage.settled",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.logClientStageSettled",
  fields: CLIENT_STAGE_FIELDS,
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["client-stage"],
  proofIds: ["client.stage.settled.line"],
  releaseImpact: "patch",
});

// #3557 review: a restored window's binding outcome, with the closed shape of its persisted
// reference. `resolved` is the ordinary case at info; `target-missing` is the failure at warn,
// so a reference lost at persistence (`redacted`) and a target that is really gone (`uuid`) are
// told apart in the log instead of collapsing into one message digest with an unknown error kind.
// Literal here, as the registry generator requires; the assignment in `clientBindingFields` fails
// typecheck if the contracts leaf ever adds a surface or shape these do not list.
const CLIENT_BINDING_ACTIVITY_LOG_SURFACES = ["chat-window"] as const;
const CLIENT_BINDING_ACTIVITY_LOG_REFERENCE_SHAPES = [
  "uuid",
  "opaque",
  "redacted",
  "fingerprint",
  "user-selected",
] as const;

const CLIENT_BINDING_FIELDS = {
  surface: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: CLIENT_BINDING_ACTIVITY_LOG_SURFACES,
  },
  referenceShape: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: CLIENT_BINDING_ACTIVITY_LOG_REFERENCE_SHAPES,
  },
  // The chat id trips the card-number heuristic: a raw UUID, or one found again after persistence
  // redacted it (through its fingerprint, or chosen by the person).
  heuristicFlagged: { type: "boolean", dataClass: "closed-enum", required: true },
  // The digest of the window's own persisted id, computed here from the validated reference: two
  // windows restored from one list answer stay apart, and a later failure of the same window
  // carries the same digest (#3557 review).
  bindingDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
  // How many list loads decided the outcome, when more than the line names; the line is then
  // `partial` with `loss: event-location-unknown`, never silently complete.
  decidingLoadCount: { type: "integer", dataClass: "count", required: false },
  // The other list loads a legacy binding's verdict depended on, beyond the line's correlation id.
  relatedCorrelationIds: {
    type: "string-array",
    dataClass: "opaque-id",
    required: false,
    maxLength: 128,
    maxItems: 63,
  },
} as const;

const CLIENT_BINDING_RESOLVED_FIELDS = {
  ...CLIENT_BINDING_FIELDS,
  // A binding found again after redaction (through its fingerprint, or chosen by the person): the
  // fingerprint of the chat it bound to, the one the window persists, so two choices from one list
  // answer stay apart (#3557 review).
  targetFingerprint: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
} as const;

const CLIENT_BINDING_RESOLVED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.binding.resolved",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.logClientBindingResolved",
  fields: CLIENT_BINDING_RESOLVED_FIELDS,
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["client-binding"],
  proofIds: ["client.binding.resolved.line"],
  releaseImpact: "patch",
});

const CLIENT_BINDING_TARGET_MISSING_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.binding.target-missing",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.logClientBindingTargetMissing",
  fields: CLIENT_BINDING_FIELDS,
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["client-binding"],
  proofIds: ["client.binding.target-missing.line"],
  releaseImpact: "patch",
});

// #3557 review: a window whose chat id persistence redacted without a fingerprint listed the chats
// it may have shown, for the person to choose from. The line names the list loads that answered, how
// many chats were offered and how many of those read alike and show a fingerprint reference, zero
// included, so the recovery state the person saw is reconstructable.
const CLIENT_BINDING_CANDIDATES_OFFERED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.binding.candidates-offered",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.logClientBindingCandidatesOffered",
  fields: {
    ...CLIENT_BINDING_FIELDS,
    candidateCount: { type: "integer", dataClass: "count", required: true },
    disambiguatedCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["client-binding"],
  proofIds: ["client.binding.candidates-offered.line"],
  releaseImpact: "patch",
});

const CLIENT_BINDING_CHOICE_FIELDS = {
  ...CLIENT_BINDING_FIELDS,
  // The chat the person decided about, by the fingerprint the window persists, never its id.
  targetFingerprint: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
} as const;

// #3557 review: the chat a person chose for such a window stays a choice until they keep it; they
// can withdraw it and choose again. Each decision is a state on the binding's timeline and names the
// chat it concerns, so which conversation the window ended with is reconstructable.
const CLIENT_BINDING_CHOICE_KEPT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.binding.choice-kept",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.logClientBindingChoiceKept",
  fields: CLIENT_BINDING_CHOICE_FIELDS,
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["client-binding"],
  proofIds: ["client.binding.choice-kept.line"],
  releaseImpact: "patch",
});

const CLIENT_BINDING_CHOICE_WITHDRAWN_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.binding.choice-withdrawn",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.logClientBindingChoiceWithdrawn",
  fields: CLIENT_BINDING_CHOICE_FIELDS,
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["client-binding"],
  proofIds: ["client.binding.choice-withdrawn.line"],
  releaseImpact: "patch",
});

// #3557 review: a read a restarted BFF denied is repaired and replayed once (keiko-ui http.ts). The
// line sits on the denied request's timeline (the replay reuses its id) and names the repair request,
// so the self-heal, or the reason it did not happen, is reconstructable from the log alone.
const CLIENT_SESSION_REPAIR_ACTIVITY_LOG_FAILURES = [
  "replay-failed",
  "replay-skipped",
  "repair-failed",
] as const;
const CLIENT_SESSION_REPAIR_ACTIVITY_LOG_RECOVERIES = ["replayed", "stream-repaired"] as const;
const CLIENT_SESSION_REPAIR_ACTIVITY_LOG_STREAMS = ["run-events", "shared-event-source"] as const;

const CLIENT_SESSION_REPAIR_RECOVERED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.session-repair.recovered",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.logClientSessionRepairRecovered",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: CLIENT_SESSION_REPAIR_ACTIVITY_LOG_RECOVERIES,
    },
    // The stream whose failure streak asked for the repair; a stream has no readable request id.
    stream: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: CLIENT_SESSION_REPAIR_ACTIVITY_LOG_STREAMS,
    },
    repairCorrelationId: {
      type: "string",
      dataClass: "opaque-id",
      required: true,
      maxLength: 128,
    },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["client-session-repair"],
  proofIds: ["client.session-repair.recovered.line"],
  releaseImpact: "patch",
});

// #3557 review: a stream's repair request was acknowledged. The endpoint acknowledges whether or
// not it issued a cookie, so this is a state, not the recovery: the stream reports
// `stream-repaired` once it opens again, and a streak that keeps failing after this line shows a
// repair that did not restore it.
const CLIENT_SESSION_REPAIR_ACKNOWLEDGED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.session-repair.acknowledged",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.logClientSessionRepairAcknowledged",
  fields: {
    stream: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: CLIENT_SESSION_REPAIR_ACTIVITY_LOG_STREAMS,
    },
    repairCorrelationId: {
      type: "string",
      dataClass: "opaque-id",
      required: true,
      maxLength: 128,
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["client-session-repair"],
  proofIds: ["client.session-repair.acknowledged.line"],
  releaseImpact: "patch",
});

const CLIENT_SESSION_REPAIR_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.session-repair.failed",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.logClientSessionRepairFailed",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: CLIENT_SESSION_REPAIR_ACTIVITY_LOG_FAILURES,
    },
    stream: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: CLIENT_SESSION_REPAIR_ACTIVITY_LOG_STREAMS,
    },
    repairCorrelationId: {
      type: "string",
      dataClass: "opaque-id",
      required: true,
      maxLength: 128,
    },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["client-session-repair"],
  proofIds: ["client.session-repair.failed.line"],
  releaseImpact: "patch",
});

// One declaration for production and the test reset below — duplicating these three literals let
// them drift, so the test reset silently exercised a limiter with different bounds than production.
const CLIENT_DIAGNOSTIC_RATE_LIMIT_CONFIG = {
  minIntervalMs: 0,
  maxPerWindow: 60,
  windowMs: 60_000,
} as const;

let rateLimiter: InlineCompletionRateLimiter = createInlineCompletionRateLimiter(
  CLIENT_DIAGNOSTIC_RATE_LIMIT_CONFIG,
);

const DROP_NOTICE_WINDOW_MS = 60_000;

type ClientDiagnosticRejection = ActivityLogFields<
  typeof CLIENT_DIAGNOSTIC_REJECTED_OPERATION
>["rejection"];

// One throttle for rate-limited drops and one per refusal reason: the first of each after a quiet
// window is logged immediately, later ones in the same window are counted, and the count rides on
// the next window's first line of the same kind or on the shutdown flush.
interface NoticeThrottle {
  lastAt: number | null;
  suppressed: number;
}

function quietThrottle(): NoticeThrottle {
  return { lastAt: null, suppressed: 0 };
}

const CLIENT_DIAGNOSTIC_REJECTIONS: readonly ClientDiagnosticRejection[] = [
  "invalid-json",
  "invalid-shape",
  "too-large",
  "cancelled",
];

function quietRejectionThrottles(): Map<ClientDiagnosticRejection, NoticeThrottle> {
  return new Map(CLIENT_DIAGNOSTIC_REJECTIONS.map((rejection) => [rejection, quietThrottle()]));
}

type ClientReportBudget = "failure" | "routine";

// One notice throttle per budget: routine overflow never suppresses the notice of a dropped
// failure report, which then keeps its own correlation id and budget class.
let dropNotices: Record<ClientReportBudget, NoticeThrottle> = {
  failure: quietThrottle(),
  routine: quietThrottle(),
};
let rejectionNotices = quietRejectionThrottles();

/** Test-only: puts the shared rate limiter and notice counters back to a clean start. */
export function resetClientDiagnosticsIngestStateForTests(): void {
  rateLimiter = createInlineCompletionRateLimiter(CLIENT_DIAGNOSTIC_RATE_LIMIT_CONFIG);
  dropNotices = { failure: quietThrottle(), routine: quietThrottle() };
  rejectionNotices = quietRejectionThrottles();
}

function rejectionThrottle(rejection: ClientDiagnosticRejection): NoticeThrottle {
  let throttle = rejectionNotices.get(rejection);
  if (throttle === undefined) {
    throttle = quietThrottle();
    rejectionNotices.set(rejection, throttle);
  }
  return throttle;
}

// True when this occurrence falls inside the open window: it is counted instead of logged.
function suppressedByThrottle(throttle: NoticeThrottle, now: number): boolean {
  if (throttle.lastAt !== null) {
    const elapsed = now - throttle.lastAt;
    if (elapsed >= 0 && elapsed < DROP_NOTICE_WINDOW_MS) {
      throttle.suppressed += 1;
      return true;
    }
  }
  return false;
}

// Opens a new window and hands back the count the previous window suppressed.
function openThrottleWindow(throttle: NoticeThrottle, now: number | null): number {
  const suppressed = throttle.suppressed;
  throttle.lastAt = now;
  throttle.suppressed = 0;
  return suppressed;
}

function writeRateLimitedNotice(
  correlationId: string | undefined,
  budget: ClientReportBudget,
  suppressed: number,
  trigger: "window" | "shutdown-flush",
): void {
  getServerLogger().warn(
    activityLogEvent(
      CLIENT_DIAGNOSTIC_RATE_LIMITED_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId), errorKind: "rate-limited" },
      {
        ...(suppressed > 0 ? { suppressedDrops: suppressed } : {}),
        budget,
        trigger,
        completeness: "complete",
        loss: "event-dropped",
      },
    ),
  );
}

// Reports a rate-limited drop exactly once per window, carrying how many further drops that same
// window suppressed — never the report content, which was never admitted past the limiter.
function noticeRateLimitedDrop(
  budget: ClientReportBudget,
  now: number,
  correlationId: string | undefined,
): void {
  recordActivityLogLoss("client-rate-suppressed");
  const throttle = dropNotices[budget];
  if (suppressedByThrottle(throttle, now)) return;
  writeRateLimitedNotice(correlationId, budget, openThrottleWindow(throttle, now), "window");
}

function writeRejectedNotice(
  correlationId: string | undefined,
  rejection: ClientDiagnosticRejection,
  suppressed: number,
  trigger: "window" | "shutdown-flush",
): void {
  getServerLogger().warn(
    activityLogEvent(
      CLIENT_DIAGNOSTIC_REJECTED_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId), errorKind: "invalid-request" },
      {
        rejection,
        ...(suppressed > 0 ? { suppressedRejections: suppressed } : {}),
        trigger,
        completeness: "complete",
        loss: "event-dropped",
      },
    ),
  );
}

// Reports a refused report once per window with the closed refusal reason; the refused bytes were
// never parsed into an event and never reach the log.
function noticeRejectedReport(
  rejection: ClientDiagnosticRejection,
  correlationId: string | undefined,
): void {
  recordActivityLogLoss("client-rejected");
  const now = Date.now();
  const throttle = rejectionThrottle(rejection);
  if (suppressedByThrottle(throttle, now)) return;
  writeRejectedNotice(correlationId, rejection, openThrottleWindow(throttle, now), "window");
}

/**
 * Writes the counts the open throttle windows are still holding. Called once on the shutdown path
 * before the process-exit evidence, so a storm that ended in a quiet window is never lost with the
 * process: the trailing counts reach the log instead of waiting for a next window that never comes.
 */
export function flushClientDiagnosticsIngestCounts(): void {
  for (const budget of ["failure", "routine"] as const) {
    const drops = openThrottleWindow(dropNotices[budget], null);
    if (drops > 0) writeRateLimitedNotice(undefined, budget, drops, "shutdown-flush");
  }
  for (const [rejection, throttle] of rejectionNotices) {
    const suppressed = openThrottleWindow(throttle, null);
    if (suppressed > 0) writeRejectedNotice(undefined, rejection, suppressed, "shutdown-flush");
  }
}

export function clientDiagnosticNoteDigest(message: string): string {
  return sha256Hex(`keiko-client-diagnostic-note-v1\0${message}`);
}

type ClientDiagnosticKind = NonNullable<ClientDiagnosticIngestRequest["kind"]>;

const CLIENT_DIAGNOSTIC_ERROR_KINDS = {
  boundary: "internal",
  "unhandled-rejection": "internal",
  "window-error": "internal",
  "sse-error": "unavailable",
  "voice-dialogue": "internal",
  "voice-playback": "unavailable",
  "markdown-layout": "unknown",
  other: "unknown",
} as const satisfies Record<ClientDiagnosticKind, ActivityLogErrorKind>;

// The browser's own delivery loss, as closed counts: each is added to the process loss ledger and
// projected onto the `client.diagnostic` line under its own count field.
const CLIENT_LOSS_PROJECTION = [
  ["bufferEvicted", "client-buffer-evicted", "clientBufferEvicted"],
  ["postsThrottled", "client-post-throttled", "clientPostsThrottled"],
  ["postsFailed", "client-post-failed", "clientPostsFailed"],
  ["rejectionsSuppressed", "client-rejection-suppressed", "clientRejectionsSuppressed"],
  ["errorsSuppressed", "client-error-suppressed", "clientErrorsSuppressed"],
] as const satisfies readonly (readonly [
  keyof ClientDiagnosticLossCounts,
  ActivityLogLossReason,
  string,
])[];

function projectClientLoss(
  loss: ClientDiagnosticLossCounts | undefined,
  extra: Record<string, unknown>,
): void {
  if (loss === undefined) return;
  for (const [key, reason, field] of CLIENT_LOSS_PROJECTION) {
    const count = loss[key];
    if (count === undefined || count === 0) continue;
    recordActivityLogLoss(reason, count);
    extra[field] = count;
  }
}

function clientDiagnosticErrorKind(
  kind: ClientDiagnosticIngestRequest["kind"],
): "internal" | "unavailable" | "unknown" {
  return kind === undefined ? "unknown" : CLIENT_DIAGNOSTIC_ERROR_KINDS[kind];
}

const VOICE_FAILURE_STAGES = new Set([
  "preparation-failed",
  "queue-unavailable",
  "delivery-failed",
  "delivery-cancelled",
  "delivery-rejected",
  "capture-renewal-failed",
]);

function clientDiagnosticCorrelation(
  request: ClientDiagnosticIngestRequest,
  correlationId: string,
): {
  readonly correlationId: string;
  readonly parentCorrelationId?: string;
} {
  const parent = request.parentCorrelationId;
  return {
    correlationId,
    ...(parent !== undefined && isValidCorrelationId(parent) && parent !== correlationId
      ? { parentCorrelationId: parent }
      : {}),
  };
}

function logVoiceDialogueStage(
  request: ClientDiagnosticIngestRequest,
  correlationId: string,
): boolean {
  const stage = request.voiceDialogueStage;
  if (stage === undefined || VOICE_FAILURE_STAGES.has(stage)) return false;
  const extra: Record<string, unknown> = {
    voiceDialogueStage: stage,
    ...(request.voiceCaptureError === undefined
      ? {}
      : { voiceCaptureError: request.voiceCaptureError }),
    ...(request.voiceCaptureReason === undefined
      ? {}
      : { voiceCaptureReason: request.voiceCaptureReason }),
    completeness: "complete",
    loss: "none",
  };
  projectClientLoss(request.loss, extra);
  getServerLogger().info(
    activityLogEvent(
      CLIENT_VOICE_DIALOGUE_OPERATION,
      clientDiagnosticCorrelation(request, correlationId),
      extra as ActivityLogFields<typeof CLIENT_VOICE_DIALOGUE_OPERATION>,
    ),
  );
  return true;
}

function logMarkdownLayout(request: ClientDiagnosticIngestRequest, correlationId: string): boolean {
  if (request.kind !== "markdown-layout") return false;
  const extra: Record<string, unknown> = {
    listNumbering: "source-start",
    ...(request.markdownLayout === undefined
      ? {}
      : {
          ...(request.markdownLayout.messageId === undefined
            ? {}
            : { messageId: request.markdownLayout.messageId }),
          listStart: request.markdownLayout.listStart,
          listIndex: request.markdownLayout.listIndex,
          depth: request.markdownLayout.depth,
        }),
    completeness: "complete",
    loss: "none",
  };
  projectClientLoss(request.loss, extra);
  getServerLogger().info(
    activityLogEvent(
      CLIENT_MARKDOWN_LAYOUT_OPERATION,
      clientDiagnosticCorrelation(request, correlationId),
      extra as ActivityLogFields<typeof CLIENT_MARKDOWN_LAYOUT_OPERATION>,
    ),
  );
  return true;
}

// Projects the validated request onto the activity log. `message` is admitted only as a digest;
// `readyState`/`kind` ride along as bounded, closed-shape fields.
// The class the page classified wins (a refused connection is `unavailable`, #3557); otherwise the
// server derives one from the report's closed context.
function requestDiagnosticErrorKind(request: ClientDiagnosticIngestRequest): ActivityLogErrorKind {
  if (request.errorKind !== undefined) return request.errorKind;
  if (request.moduleLoadFailure !== undefined) {
    const errorClass = request.errorEvidence?.errorClass;
    return errorClass === "ChunkLoadError" || errorClass === "NetworkError"
      ? "unavailable"
      : "internal";
  }
  if (request.voiceDialogueStage === "delivery-cancelled") return "cancelled";
  if (request.voiceDialogueStage === "delivery-rejected") return "unavailable";
  return clientDiagnosticErrorKind(request.kind);
}

function projectClientFailure(
  request: ClientDiagnosticIngestRequest,
  extra: Record<string, unknown>,
): void {
  if (request.moduleLoadFailure !== undefined) extra.moduleLoadFailure = request.moduleLoadFailure;
  if (request.errorEvidence !== undefined) {
    extra.errorClass = request.errorEvidence.errorClass;
    extra.frames = request.errorEvidence.frames;
    extra.causeChain = request.errorEvidence.causeChain;
  }
  if (request.voiceCaptureError !== undefined) extra.voiceCaptureError = request.voiceCaptureError;
  if (request.voiceCaptureReason !== undefined)
    extra.voiceCaptureReason = request.voiceCaptureReason;
}

function logClientDiagnostic(
  request: ClientDiagnosticIngestRequest,
  ingestCorrelationId: string | undefined,
): void {
  const correlationId =
    request.correlationId !== undefined && isValidCorrelationId(request.correlationId)
      ? request.correlationId
      : correlationIdOrUnknown(ingestCorrelationId);
  if (logVoiceDialogueStage(request, correlationId) || logMarkdownLayout(request, correlationId))
    return;
  const extra: Record<string, unknown> = {
    clientNoteDigest: clientDiagnosticNoteDigest(request.message),
  };
  projectClientFailure(request, extra);
  if (request.readyState !== undefined) extra.readyState = request.readyState;
  if (request.kind !== undefined) extra.clientKind = request.kind;
  if (request.voiceDialogueStage !== undefined) {
    extra.voiceDialogueStage = request.voiceDialogueStage;
  }
  if (request.gitChangeDescription !== undefined) {
    extra.action = request.gitChangeDescription.action;
    extra.disposition = request.gitChangeDescription.disposition;
    extra.relationshipId = request.gitChangeDescription.relationshipId;
    extra.snapshotDigest = request.gitChangeDescription.snapshotDigest;
    extra.proposalId = request.gitChangeDescription.proposalId;
    extra.outcome = request.gitChangeDescription.outcome;
  }
  if (request.workspaceTrustBinding !== undefined) {
    extra.repositoryId = request.workspaceTrustBinding.repositoryId;
    extra.workspaceId = request.workspaceTrustBinding.workspaceId;
  }
  projectClientLoss(request.loss, extra);
  extra.completeness = "complete";
  extra.loss = "none";
  getServerLogger().warn(
    activityLogEvent(
      CLIENT_DIAGNOSTIC_OPERATION,
      {
        ...clientDiagnosticCorrelation(request, correlationId),
        errorKind: requestDiagnosticErrorKind(request),
      },
      extra as ActivityLogFields<typeof CLIENT_DIAGNOSTIC_OPERATION>,
    ),
  );
}

function logClientStageStarted(
  request: ClientStageStartedIngestRequest,
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CLIENT_STAGE_STARTED_OPERATION,
      { correlationId },
      {
        stage: CLIENT_STAGE_ACTIVITY_LOG_ID_BY_WIRE_ID[request.stage],
        ordinal: request.ordinal,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

function logClientStageSettled(
  request: ClientStageSettledIngestRequest,
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CLIENT_STAGE_SETTLED_OPERATION,
      { correlationId, durationMs: request.durationMs },
      {
        stage: CLIENT_STAGE_ACTIVITY_LOG_ID_BY_WIRE_ID[request.stage],
        ordinal: request.ordinal,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

// A client-supplied id when it is a safe correlation id, else the ingest POST's own.
function reportCorrelationId(
  clientCorrelationId: string | undefined,
  ingestCorrelationId: string | undefined,
): string {
  return clientCorrelationId !== undefined && isValidCorrelationId(clientCorrelationId)
    ? clientCorrelationId
    : correlationIdOrUnknown(ingestCorrelationId);
}

// Projects a validated stage report onto its own lifecycle operation — never the failure-shaped
// `client.diagnostic` above. Root cause of KEIKO-3557: 416 of 449 `client.diagnostic` lines in a
// live log were exactly this routine evidence, all persisted as warn/unknown and burying the rare
// real failures. Both phases of one mounted stage carry the same client-minted correlation id, so the
// pair joins in the log even when another tab reuses the stage and ordinal (#3557 review).
function logClientStage(
  request: ClientStageIngestRequest,
  ingestCorrelationId: string | undefined,
): void {
  const correlationId = reportCorrelationId(request.correlationId, ingestCorrelationId);
  if (request.phase === "started") {
    logClientStageStarted(request, correlationId);
    return;
  }
  logClientStageSettled(request, correlationId);
}

type ClientBindingFields = ActivityLogFields<typeof CLIENT_BINDING_TARGET_MISSING_OPERATION>;

// The deciding list loads the line can name: the primary id when it is a safe correlation id, and
// each distinct safe related id besides it. An id the server refuses, or one named twice, never
// counts as named; a malformed one is dropped rather than refusing the line (#3557 review).
function namedDecidingLoads(request: ClientBindingIngestRequest): {
  readonly primary: string | undefined;
  readonly related: readonly string[];
} {
  const { correlationId } = request;
  const primary =
    correlationId !== undefined && isValidCorrelationId(correlationId) ? correlationId : undefined;
  const related = [...new Set(request.relatedCorrelationIds ?? [])].filter(
    (id) => id !== primary && isValidCorrelationId(id),
  );
  return { primary, related };
}

// How many loads decided the outcome: the reported total, or else every distinct id the report
// declared, valid or not.
function decidingLoadTotal(request: ClientBindingIngestRequest): number {
  if (request.decidingLoadCount !== undefined) return request.decidingLoadCount;
  return new Set([
    ...(request.correlationId === undefined ? [] : [request.correlationId]),
    ...(request.relatedCorrelationIds ?? []),
  ]).size;
}

export function clientBindingDigest(windowRef: string): string {
  return sha256Hex(`keiko-client-binding-v1\0${windowRef}`);
}

// Every deciding list load is named when the line can hold it (up to 64). When more loads decided
// the outcome than the line names, the missing ones are classified loss, not a quiet count: the
// line is `partial` with `loss: event-location-unknown`, and the total is kept (#3557 review).
function clientBindingFields(request: ClientBindingIngestRequest): ClientBindingFields {
  const { primary, related } = namedDecidingLoads(request);
  const named = (primary === undefined ? 0 : 1) + related.length;
  const deciding = decidingLoadTotal(request);
  const unnamed = deciding > named;
  return {
    surface: request.surface,
    referenceShape: request.referenceShape,
    heuristicFlagged: request.heuristicFlagged,
    bindingDigest: clientBindingDigest(request.windowRef),
    ...(related.length === 0 ? {} : { relatedCorrelationIds: related }),
    ...(unnamed ? { decidingLoadCount: deciding } : {}),
    completeness: unnamed ? "partial" : "complete",
    loss: unnamed ? "event-location-unknown" : "none",
  };
}

function logClientBindingResolved(
  request: ClientBindingIngestRequest,
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CLIENT_BINDING_RESOLVED_OPERATION,
      { correlationId },
      {
        ...clientBindingFields(request),
        ...(request.targetFingerprint === undefined
          ? {}
          : { targetFingerprint: request.targetFingerprint }),
      },
    ),
  );
}

// The ingest contract holds these fields to their outcome; the guards below only let the compiler
// see what it already proved.
type ClientBindingOffer = ClientBindingIngestRequest & {
  readonly candidateCount: number;
  readonly disambiguatedCount: number;
};

type ClientBindingChoiceDecision = ClientBindingIngestRequest & {
  readonly outcome: "choice-kept" | "choice-withdrawn";
  readonly targetFingerprint: string;
};

function isClientBindingOffer(request: ClientBindingIngestRequest): request is ClientBindingOffer {
  return (
    request.outcome === "candidates-offered" &&
    request.candidateCount !== undefined &&
    request.disambiguatedCount !== undefined
  );
}

function isClientBindingChoiceDecision(
  request: ClientBindingIngestRequest,
): request is ClientBindingChoiceDecision {
  return (
    (request.outcome === "choice-kept" || request.outcome === "choice-withdrawn") &&
    request.targetFingerprint !== undefined
  );
}

function logClientBindingCandidatesOffered(
  request: ClientBindingOffer,
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CLIENT_BINDING_CANDIDATES_OFFERED_OPERATION,
      { correlationId },
      {
        ...clientBindingFields(request),
        candidateCount: request.candidateCount,
        disambiguatedCount: request.disambiguatedCount,
      },
    ),
  );
}

function logClientBindingChoiceKept(
  request: ClientBindingChoiceDecision,
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CLIENT_BINDING_CHOICE_KEPT_OPERATION,
      { correlationId },
      { ...clientBindingFields(request), targetFingerprint: request.targetFingerprint },
    ),
  );
}

function logClientBindingChoiceWithdrawn(
  request: ClientBindingChoiceDecision,
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CLIENT_BINDING_CHOICE_WITHDRAWN_OPERATION,
      { correlationId },
      { ...clientBindingFields(request), targetFingerprint: request.targetFingerprint },
    ),
  );
}

function logClientBindingChoiceDecision(
  request: ClientBindingChoiceDecision,
  correlationId: string,
): void {
  if (request.outcome === "choice-kept") {
    logClientBindingChoiceKept(request, correlationId);
    return;
  }
  logClientBindingChoiceWithdrawn(request, correlationId);
}

function logClientBindingTargetMissing(
  request: ClientBindingIngestRequest,
  correlationId: string,
): void {
  getServerLogger().warn(
    activityLogEvent(
      CLIENT_BINDING_TARGET_MISSING_OPERATION,
      { correlationId, errorKind: "unavailable" },
      clientBindingFields(request),
    ),
  );
}

// The binding line carries the correlation id of the request whose answer decided it (the target
// list load), so `keiko support analyze --correlation-id` reads that load and the outcome as one
// timeline. Without a valid one, the ingest POST's own id applies.
function logClientBinding(
  request: ClientBindingIngestRequest,
  ingestCorrelationId: string | undefined,
): void {
  const correlationId = reportCorrelationId(request.correlationId, ingestCorrelationId);
  if (request.outcome === "resolved") {
    logClientBindingResolved(request, correlationId);
    return;
  }
  if (isClientBindingOffer(request)) {
    logClientBindingCandidatesOffered(request, correlationId);
    return;
  }
  if (isClientBindingChoiceDecision(request)) {
    logClientBindingChoiceDecision(request, correlationId);
    return;
  }
  logClientBindingTargetMissing(request, correlationId);
}

// Every repair report names its repair request (the ingest contract refuses one that does not), so
// the line always links the repair attempt it describes (#3557 review).
function sessionRepairCorrelation(request: ClientSessionRepairIngestRequest): {
  readonly repairCorrelationId: string;
  readonly stream?: NonNullable<ClientSessionRepairIngestRequest["stream"]>;
} {
  return {
    repairCorrelationId: request.repairCorrelationId,
    ...(request.stream === undefined ? {} : { stream: request.stream }),
  };
}

function logClientSessionRepairRecovered(
  request: ClientSessionRepairIngestRequest & {
    readonly outcome: (typeof CLIENT_SESSION_REPAIR_ACTIVITY_LOG_RECOVERIES)[number];
  },
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CLIENT_SESSION_REPAIR_RECOVERED_OPERATION,
      { correlationId },
      {
        outcome: request.outcome,
        ...sessionRepairCorrelation(request),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

function logClientSessionRepairAcknowledged(
  request: ClientSessionRepairIngestRequest & {
    readonly stream: NonNullable<ClientSessionRepairIngestRequest["stream"]>;
  },
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CLIENT_SESSION_REPAIR_ACKNOWLEDGED_OPERATION,
      { correlationId },
      {
        ...sessionRepairCorrelation(request),
        stream: request.stream,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

// The class of the step that actually failed, as the browser classified it. A skipped replay
// leaves the original refusal in place, an authority denial; any other outcome without a class is
// unknown rather than guessed (#3557 review).
function sessionRepairErrorKind(request: ClientSessionRepairIngestRequest): ActivityLogErrorKind {
  if (request.errorKind !== undefined) return request.errorKind;
  return request.outcome === "replay-skipped" ? "authority-denied" : "unknown";
}

function logClientSessionRepairFailed(
  request: ClientSessionRepairIngestRequest & {
    readonly outcome: (typeof CLIENT_SESSION_REPAIR_ACTIVITY_LOG_FAILURES)[number];
  },
  correlationId: string,
): void {
  getServerLogger().warn(
    activityLogEvent(
      CLIENT_SESSION_REPAIR_FAILED_OPERATION,
      { correlationId, errorKind: sessionRepairErrorKind(request) },
      {
        outcome: request.outcome,
        ...sessionRepairCorrelation(request),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

// The line joins the denied request's own timeline (the replay reused its id), or a stream's
// failure streak.
function logClientSessionRepair(
  request: ClientSessionRepairIngestRequest,
  ingestCorrelationId: string | undefined,
): void {
  const correlationId = reportCorrelationId(request.correlationId, ingestCorrelationId);
  const { outcome, stream } = request;
  if (outcome === "replayed" || outcome === "stream-repaired") {
    logClientSessionRepairRecovered({ ...request, outcome }, correlationId);
    return;
  }
  if (outcome === "repair-acknowledged") {
    // The contract guard refuses an acknowledged repair that names no stream.
    if (stream !== undefined)
      logClientSessionRepairAcknowledged({ ...request, stream }, correlationId);
    return;
  }
  logClientSessionRepairFailed({ ...request, outcome }, correlationId);
}

// The closed report shapes this route accepts. They are mutually exclusive by construction: only
// the message shape carries `message`, and every other shape declares its own `kind` literal,
// which the message shape's closed `kind` vocabulary never contains.
type ClassifiedClientReport =
  | { readonly shape: "stage"; readonly report: ClientStageIngestRequest }
  | { readonly shape: "binding"; readonly report: ClientBindingIngestRequest }
  | { readonly shape: "session-repair"; readonly report: ClientSessionRepairIngestRequest }
  | { readonly shape: "message"; readonly report: ClientDiagnosticIngestRequest };

function classifyClientReport(value: unknown): ClassifiedClientReport | undefined {
  if (isClientStageIngestRequest(value)) return { shape: "stage", report: value };
  if (isClientBindingIngestRequest(value)) return { shape: "binding", report: value };
  if (isClientSessionRepairIngestRequest(value)) {
    // The repair id becomes a line field, so it meets the server's own correlation rule or the
    // report is refused like any other malformed one (#3557 review).
    return isValidCorrelationId(value.repairCorrelationId)
      ? { shape: "session-repair", report: value }
      : undefined;
  }
  if (isClientDiagnosticIngestRequest(value)) return { shape: "message", report: value };
  return undefined;
}

function reportBudget(classified: ClassifiedClientReport): ClientReportBudget {
  switch (classified.shape) {
    case "stage":
      return "routine";
    case "binding":
      return CLIENT_BINDING_FAILURE_OUTCOMES.has(classified.report.outcome) ? "failure" : "routine";
    case "session-repair":
      return CLIENT_SESSION_REPAIR_ROUTINE_OUTCOMES.has(classified.report.outcome)
        ? "routine"
        : "failure";
    case "message":
      return "failure";
  }
}

function logClientReport(
  classified: ClassifiedClientReport,
  ingestCorrelationId: string | undefined,
): void {
  switch (classified.shape) {
    case "stage":
      logClientStage(classified.report, ingestCorrelationId);
      return;
    case "binding":
      logClientBinding(classified.report, ingestCorrelationId);
      return;
    case "session-repair":
      logClientSessionRepair(classified.report, ingestCorrelationId);
      return;
    case "message":
      logClientDiagnostic(classified.report, ingestCorrelationId);
  }
}

// Discriminates a rejected read (already a fully-formed `RouteResult`) from a successfully parsed
// body, instead of duck-typing the parsed value's shape. Attacker-controlled JSON can legally
// contain a numeric `status` field and a `body` key (e.g. `{"status":200,"body":{...}}`), which
// would collide with a shape test and let the client's own parsed JSON be returned verbatim as this
// route's HTTP response — bypassing `isClientDiagnosticIngestRequest`, the rate limiter, and the
// logger entirely. A tagged union makes that collision structurally impossible: the tag is set by
// this module, never derived from the parsed value.
type BodyReadOutcome =
  | {
      readonly kind: "rejected";
      readonly result: RouteResult;
      readonly rejection: ClientDiagnosticRejection;
    }
  | { readonly kind: "parsed"; readonly value: unknown };

function badRequest(message: string, correlationId: string | undefined): RouteResult {
  return { status: 400, body: errorBody("BAD_REQUEST", message, correlationId) };
}

async function readClientDiagnosticBody(
  req: IncomingMessage,
  correlationId: string | undefined,
): Promise<BodyReadOutcome> {
  let raw: string;
  try {
    raw = await readBoundedRequestBody(
      req,
      MAX_CLIENT_DIAGNOSTIC_BODY_BYTES,
      undefined,
      correlationId,
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return {
        kind: "rejected",
        rejection: "too-large",
        result: {
          status: 413,
          body: errorBody(
            "PAYLOAD_TOO_LARGE",
            "Request body exceeds the size limit.",
            correlationId,
          ),
        },
      };
    }
    if (error instanceof RequestBodyCancelledError) {
      return {
        kind: "rejected",
        rejection: "cancelled",
        result: { status: 499, body: errorBody("REQUEST_CANCELLED", "Request was cancelled.") },
      };
    }
    throw error;
  }
  try {
    return { kind: "parsed", value: JSON.parse(raw) as unknown };
  } catch {
    return {
      kind: "rejected",
      rejection: "invalid-json",
      result: badRequest("Request body is not valid JSON.", correlationId),
    };
  }
}

export async function handleClientDiagnosticIngest(ctx: RouteContext): Promise<RouteResult> {
  const outcome = await readClientDiagnosticBody(ctx.req, ctx.correlationId);
  if (outcome.kind === "rejected") {
    noticeRejectedReport(outcome.rejection, ctx.correlationId);
    return outcome.result;
  }
  // Every shape shares the same size bound and rejection/loss accounting below; routine evidence
  // and failure reports each spend their own rate-limit budget.
  const classified = classifyClientReport(outcome.value);
  if (classified === undefined) {
    noticeRejectedReport("invalid-shape", ctx.correlationId);
    return badRequest("Request body is not a valid diagnostic report.", ctx.correlationId);
  }
  const now = Date.now();
  const budget = reportBudget(classified);
  if (!rateLimiter.tryAcquire(CLIENT_DIAGNOSTIC_RATE_LIMIT_KEYS[budget], now)) {
    noticeRateLimitedDrop(budget, now, ctx.correlationId);
    return { status: 204, body: null };
  }
  logClientReport(classified, ctx.correlationId);
  return { status: 204, body: null };
}
