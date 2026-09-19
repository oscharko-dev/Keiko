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
  ClientStageId,
  ClientStageIngestRequest,
  ClientStageSettledIngestRequest,
  ClientStageStartedIngestRequest,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import {
  isClientBindingIngestRequest,
  isClientDiagnosticIngestRequest,
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
const CLIENT_DIAGNOSTIC_RATE_LIMIT_KEY = "client-diagnostics";

const CLIENT_DIAGNOSTIC_RATE_LIMITED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.diagnostic.rate-limited",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.noticeRateLimitedDrop",
  fields: {
    suppressedDrops: { type: "integer", dataClass: "count", required: false },
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

const CLIENT_DIAGNOSTIC_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.diagnostic",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.logClientDiagnostic",
  fields: {
    clientNoteDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    readyState: { type: "integer", dataClass: "count", required: false },
    clientKind: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["boundary", "unhandled-rejection", "window-error", "sse-error", "other"],
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
const CLIENT_BINDING_ACTIVITY_LOG_REFERENCE_SHAPES = ["uuid", "opaque", "redacted"] as const;

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
  heuristicExempt: { type: "boolean", dataClass: "closed-enum", required: true },
} as const;

const CLIENT_BINDING_RESOLVED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.binding.resolved",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-routes.logClientBindingResolved",
  fields: CLIENT_BINDING_FIELDS,
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

let dropNotice = quietThrottle();
let rejectionNotices = quietRejectionThrottles();

/** Test-only: puts the shared rate limiter and notice counters back to a clean start. */
export function resetClientDiagnosticsIngestStateForTests(): void {
  rateLimiter = createInlineCompletionRateLimiter(CLIENT_DIAGNOSTIC_RATE_LIMIT_CONFIG);
  dropNotice = quietThrottle();
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
  suppressed: number,
  trigger: "window" | "shutdown-flush",
): void {
  getServerLogger().warn(
    activityLogEvent(
      CLIENT_DIAGNOSTIC_RATE_LIMITED_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId), errorKind: "rate-limited" },
      {
        ...(suppressed > 0 ? { suppressedDrops: suppressed } : {}),
        trigger,
        completeness: "complete",
        loss: "event-dropped",
      },
    ),
  );
}

// Reports a rate-limited drop exactly once per window, carrying how many further drops that same
// window suppressed — never the report content, which was never admitted past the limiter.
function noticeRateLimitedDrop(now: number, correlationId: string | undefined): void {
  recordActivityLogLoss("client-rate-suppressed");
  if (suppressedByThrottle(dropNotice, now)) return;
  writeRateLimitedNotice(correlationId, openThrottleWindow(dropNotice, now), "window");
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
  const drops = openThrottleWindow(dropNotice, null);
  if (drops > 0) writeRateLimitedNotice(undefined, drops, "shutdown-flush");
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

// Projects the validated request onto the activity log. `message` is admitted only as a digest;
// `readyState`/`kind` ride along as bounded, closed-shape fields.
function logClientDiagnostic(
  request: ClientDiagnosticIngestRequest,
  ingestCorrelationId: string | undefined,
): void {
  const extra: Record<string, unknown> = {
    clientNoteDigest: clientDiagnosticNoteDigest(request.message),
  };
  if (request.readyState !== undefined) extra.readyState = request.readyState;
  if (request.kind !== undefined) extra.clientKind = request.kind;
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
  const correlationId =
    request.correlationId !== undefined && isValidCorrelationId(request.correlationId)
      ? request.correlationId
      : correlationIdOrUnknown(ingestCorrelationId);
  extra.completeness = "complete";
  extra.loss = "none";
  getServerLogger().warn(
    activityLogEvent(
      CLIENT_DIAGNOSTIC_OPERATION,
      { correlationId, errorKind: clientDiagnosticErrorKind(request.kind) },
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

// Projects a validated stage report onto its own lifecycle operation — never the failure-shaped
// `client.diagnostic` above. Root cause of KEIKO-3557: 416 of 449 `client.diagnostic` lines in a
// live log were exactly this routine evidence, all persisted as warn/unknown and burying the rare
// real failures. Unlike `client.diagnostic`, no client-supplied correlation id: a stage mount is not
// itself a server request, so only the ingest POST's own correlation id ever applies.
function logClientStage(
  request: ClientStageIngestRequest,
  ingestCorrelationId: string | undefined,
): void {
  const correlationId = correlationIdOrUnknown(ingestCorrelationId);
  if (request.phase === "started") {
    logClientStageStarted(request, correlationId);
    return;
  }
  logClientStageSettled(request, correlationId);
}

type ClientBindingFields = ActivityLogFields<typeof CLIENT_BINDING_RESOLVED_OPERATION>;

function clientBindingFields(request: ClientBindingIngestRequest): ClientBindingFields {
  return {
    surface: request.surface,
    referenceShape: request.referenceShape,
    heuristicExempt: request.heuristicExempt,
    completeness: "complete",
    loss: "none",
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
      clientBindingFields(request),
    ),
  );
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
  const correlationId =
    request.correlationId !== undefined && isValidCorrelationId(request.correlationId)
      ? request.correlationId
      : correlationIdOrUnknown(ingestCorrelationId);
  if (request.outcome === "resolved") {
    logClientBindingResolved(request, correlationId);
    return;
  }
  logClientBindingTargetMissing(request, correlationId);
}

// The three closed report shapes this route accepts. They are mutually exclusive by construction:
// a stage or binding report carries no `message`, and each declares its own `kind` literal, which
// the message shape's closed `kind` vocabulary never contains.
type ClassifiedClientReport =
  | { readonly shape: "stage"; readonly report: ClientStageIngestRequest }
  | { readonly shape: "binding"; readonly report: ClientBindingIngestRequest }
  | { readonly shape: "message"; readonly report: ClientDiagnosticIngestRequest };

function classifyClientReport(value: unknown): ClassifiedClientReport | undefined {
  if (isClientStageIngestRequest(value)) return { shape: "stage", report: value };
  if (isClientBindingIngestRequest(value)) return { shape: "binding", report: value };
  if (isClientDiagnosticIngestRequest(value)) return { shape: "message", report: value };
  return undefined;
}

function logClientReport(
  classified: ClassifiedClientReport,
  ingestCorrelationId: string | undefined,
): void {
  if (classified.shape === "stage") {
    logClientStage(classified.report, ingestCorrelationId);
  } else if (classified.shape === "binding") {
    logClientBinding(classified.report, ingestCorrelationId);
  } else {
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
  // Every shape shares the same rate limit, size bound, and rejection/loss accounting below; only
  // the operation it reaches differs.
  const classified = classifyClientReport(outcome.value);
  if (classified === undefined) {
    noticeRejectedReport("invalid-shape", ctx.correlationId);
    return badRequest("Request body is not a valid diagnostic report.", ctx.correlationId);
  }
  const now = Date.now();
  if (!rateLimiter.tryAcquire(CLIENT_DIAGNOSTIC_RATE_LIMIT_KEY, now)) {
    noticeRateLimitedDrop(now, ctx.correlationId);
    return { status: 204, body: null };
  }
  logClientReport(classified, ctx.correlationId);
  return { status: 204, body: null };
}
