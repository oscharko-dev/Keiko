// SupportIncident candidates (#3533): the two triggers, the candidate policy, the defectFingerprint
// hash, deduplication, quotas, the incident-window pin, expiry, dismissal, and the body-free
// lifecycle evidence. The descriptor contract itself lives in keiko-contracts (support-incident.ts);
// the store I/O lives in ./support-incident-store.ts.
//
// Nothing here transfers data anywhere. A candidate is a small local record plus an Activity Log
// retention pin over a bounded time window around the incident; reporting, acknowledging, and
// dismissing stay explicit human actions.
//
// CANDIDATE POLICY (registered-failure trigger). An event is a candidate only when the generated
// registry declares its operation with the `failure` lifecycle and at least one failure class the
// registry reports as supported, and the event was emitted at level `error` (a `warn` failure is
// an expected refusal, not a defect). Eligibility is therefore derived from the registry alone —
// there is no UI- or caller-side list. This module's own operations are never candidates.
//
// DEDUPLICATION. At most one open registered-failure candidate exists per defectFingerprint: a
// recurrence of the same defect is evidenced as `support.incident.deduplicated` on the existing
// incident instead of pinning a second window. A process additionally suppresses re-evaluating a
// fingerprint for SUPPORT_INCIDENT_SUPPRESSION_MS so a failure storm costs no filesystem work.
// User reports are never merged: each explicit "Report a problem" is its own occurrence.
//
// QUOTAS AND EXPIRY. The store holds at most MAX_SUPPORT_INCIDENTS records (each at most
// MAX_SUPPORT_INCIDENT_RECORD_BYTES), of which registered-failure candidates may occupy at most
// MAX_REGISTERED_FAILURE_INCIDENTS so a failure flood can never block an explicit user report. A
// full store rejects the new candidate with body-free loss evidence; it never evicts a candidate the
// user has not seen. Every candidate expires SUPPORT_INCIDENT_TTL_MS after creation; its pin expires
// at the same instant, so an unreported incident releases its evidence predictably.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ACTIVITY_LOG_FAILURE_CLASS_COVERAGE,
  ACTIVITY_LOG_OPERATION_SURFACES,
  DEFECT_FINGERPRINT_ALGORITHM_VERSION,
  MAX_SUPPORT_INCIDENT_CHILD_CORRELATIONS,
  SUPPORT_INCIDENT_SCHEMA_VERSION,
  UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT,
  activityLogErrorKindOr,
  activityLogEvent,
  activityLogOperationSchema,
  defectFingerprintPreimage,
  defineActivityLogOperation,
  isActivityLogCorrelationId,
  normalizeKeikoFrameSignature,
  recordActivityLogLoss,
  supportIncidentBuild,
  type DefectFingerprintInput,
  type SupportIncidentCorrelation,
  type SupportIncidentPin,
  type SupportIncidentRecord,
  type SupportIncidentTrigger,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import type { ServerLogEnv } from "./log-level.js";
import {
  createFileServerLogSink,
  pinActivityLogWindow,
  reportServerLogFailure,
  serverLogProcessIdentity,
  type ActivityLogPinResult,
  type ServerLogEvent,
} from "./server-log.js";
import { activityLogTestWriterInstalled } from "./server-logger.js";
import { FRAME_SHAPE_PATTERN } from "./stack-frames.js";
import {
  ensureSupportIncidentDirectory,
  listSupportIncidentEntries,
  supportIncidentDirectory,
  removeSupportIncidentRecord,
  serializeSupportIncidentRecord,
  writeSupportIncidentRecord,
  type SupportIncidentStoreEntry,
} from "./support-incident-store.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** An unreported candidate (and its pin) expires this long after creation. */
export const SUPPORT_INCIDENT_TTL_MS = 14 * DAY_MS;
/** The pinned window reaches this far before the incident … */
export const SUPPORT_INCIDENT_WINDOW_BEFORE_MS = 15 * MINUTE_MS;
/** … and this far after it, so segments sealed after the incident are retained too. */
export const SUPPORT_INCIDENT_WINDOW_AFTER_MS = 5 * MINUTE_MS;
/** Records the store holds at most (count quota). */
export const MAX_SUPPORT_INCIDENTS = 32;
/** Of those, registered-failure candidates may occupy at most this many. */
export const MAX_REGISTERED_FAILURE_INCIDENTS = 24;
/** A process re-evaluates one defectFingerprint at most this often. */
export const SUPPORT_INCIDENT_SUPPRESSION_MS = MINUTE_MS;

// ─── Lifecycle operations ──────────────────────────────────────────────────────────────────────

const INCIDENT_ID_FIELD = {
  type: "string",
  dataClass: "opaque-id",
  required: true,
  maxLength: 32,
} as const;
const FINGERPRINT_FIELD = {
  type: "string",
  dataClass: "digest",
  required: true,
  maxLength: 64,
} as const;
const ALGORITHM_FIELD = { type: "integer", dataClass: "safe-version", required: true } as const;
const TRIGGER_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: true,
  values: ["registered-failure", "user-report"],
} as const;
const OPEN_COUNT_FIELD = { type: "integer", dataClass: "count", required: true } as const;

const SUPPORT_INCIDENT_CREATED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "support.incident.created",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/support-incident.createdEvidence",
  fields: {
    incidentId: INCIDENT_ID_FIELD,
    defectFingerprint: FINGERPRINT_FIELD,
    fingerprintAlgorithm: ALGORITHM_FIELD,
    descriptorSchemaVersion: { type: "integer", dataClass: "safe-version", required: true },
    trigger: TRIGGER_FIELD,
    frameCount: { type: "integer", dataClass: "count", required: true },
    pinStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["pinned", "quota-exceeded", "rejected"],
    },
    pinnedSegmentCount: { type: "integer", dataClass: "count", required: true },
    pinnedBytes: { type: "integer", dataClass: "count", required: true },
    windowSeconds: { type: "integer", dataClass: "count", required: true },
    expiresInSeconds: { type: "integer", dataClass: "count", required: true },
    openIncidentCount: OPEN_COUNT_FIELD,
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["support-incident"],
  proofIds: ["support.incident.created.emitted-line"],
  releaseImpact: "minor",
});

const SUPPORT_INCIDENT_DEDUPLICATED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "support.incident.deduplicated",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/support-incident.deduplicatedEvidence",
  fields: {
    incidentId: INCIDENT_ID_FIELD,
    defectFingerprint: FINGERPRINT_FIELD,
    fingerprintAlgorithm: ALGORITHM_FIELD,
    trigger: TRIGGER_FIELD,
    openIncidentCount: OPEN_COUNT_FIELD,
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["support-incident"],
  proofIds: ["support.incident.deduplicated.emitted-line"],
  releaseImpact: "minor",
});

const SUPPORT_INCIDENT_REJECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "support.incident.rejected",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/support-incident.rejectedEvidence",
  fields: {
    rejectionReason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["quota-exhausted", "store-unavailable", "record-too-large"],
    },
    defectFingerprint: { ...FINGERPRINT_FIELD, required: false },
    fingerprintAlgorithm: ALGORITHM_FIELD,
    trigger: TRIGGER_FIELD,
    openIncidentCount: OPEN_COUNT_FIELD,
  },
  causal: "correlation",
  lifecycle: "loss",
  analyzerProjection: "failure-cluster",
  failureClasses: ["support-incident"],
  proofIds: ["support.incident.rejected.emitted-line"],
  releaseImpact: "minor",
});

const SUPPORT_INCIDENT_DISMISSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "support.incident.dismissed",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/support-incident.dismissedEvidence",
  fields: {
    incidentId: INCIDENT_ID_FIELD,
    defectFingerprint: FINGERPRINT_FIELD,
    fingerprintAlgorithm: ALGORITHM_FIELD,
    trigger: TRIGGER_FIELD,
    incidentState: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["candidate", "acknowledged", "reported"],
    },
    openIncidentCount: OPEN_COUNT_FIELD,
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["support-incident"],
  proofIds: ["support.incident.dismissed.emitted-line"],
  releaseImpact: "minor",
});

const SUPPORT_INCIDENT_EXPIRED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "support.incident.expired",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/support-incident.expiredEvidence",
  fields: {
    incidentId: INCIDENT_ID_FIELD,
    expiryReason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["expired", "invalid-record"],
    },
    removalStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["removed", "failed"],
    },
    defectFingerprint: { ...FINGERPRINT_FIELD, required: false },
    openIncidentCount: OPEN_COUNT_FIELD,
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["support-incident"],
  proofIds: ["support.incident.expired.emitted-line"],
  releaseImpact: "minor",
});

/** This module's own operations: never incident candidates themselves. */
export const SUPPORT_INCIDENT_OPERATIONS: ReadonlySet<string> = new Set([
  SUPPORT_INCIDENT_CREATED_OPERATION.op,
  SUPPORT_INCIDENT_DEDUPLICATED_OPERATION.op,
  SUPPORT_INCIDENT_REJECTED_OPERATION.op,
  SUPPORT_INCIDENT_DISMISSED_OPERATION.op,
  SUPPORT_INCIDENT_EXPIRED_OPERATION.op,
]);

// Lifecycle evidence is mandatory: it passes every level threshold, like the process slot's sink.
function writeEvidence(stateDir: string, event: ServerLogEvent): void {
  createFileServerLogSink(stateDir, { level: "debug" }).write(event);
}

function createdEvidence(
  stateDir: string,
  record: SupportIncidentRecord,
  correlationId: string,
  openIncidentCount: number,
): void {
  writeEvidence(
    stateDir,
    activityLogEvent(
      SUPPORT_INCIDENT_CREATED_OPERATION,
      { correlationId },
      {
        incidentId: record.incidentId,
        defectFingerprint: record.fingerprint.defectFingerprint,
        fingerprintAlgorithm: record.fingerprint.algorithm,
        descriptorSchemaVersion: record.schemaVersion,
        trigger: record.trigger,
        frameCount: record.fingerprint.frameCount,
        pinStatus: record.pin.status,
        pinnedSegmentCount: record.pin.pinnedSegmentCount,
        pinnedBytes: record.pin.pinnedBytes,
        windowSeconds: Math.ceil((record.window.toMs - record.window.fromMs) / 1000),
        expiresInSeconds: Math.ceil((record.expiresAtMs - record.createdAtMs) / 1000),
        openIncidentCount,
        completeness: record.pin.status === "pinned" ? "complete" : "partial",
      },
    ),
  );
}

function deduplicatedEvidence(
  stateDir: string,
  record: SupportIncidentRecord,
  correlationId: string,
  openIncidentCount: number,
): void {
  writeEvidence(
    stateDir,
    activityLogEvent(
      SUPPORT_INCIDENT_DEDUPLICATED_OPERATION,
      { correlationId },
      {
        incidentId: record.incidentId,
        defectFingerprint: record.fingerprint.defectFingerprint,
        fingerprintAlgorithm: record.fingerprint.algorithm,
        trigger: record.trigger,
        openIncidentCount,
      },
    ),
  );
}

export type SupportIncidentRejection = "quota-exhausted" | "store-unavailable" | "record-too-large";

interface RejectionFacts {
  readonly reason: SupportIncidentRejection;
  readonly trigger: SupportIncidentTrigger;
  readonly defectFingerprint: string | undefined;
  readonly correlationId: string;
  readonly openIncidentCount: number;
}

function rejectedEvidence(stateDir: string, facts: RejectionFacts): void {
  writeEvidence(
    stateDir,
    activityLogEvent(
      SUPPORT_INCIDENT_REJECTED_OPERATION,
      {
        level: "warn",
        correlationId: facts.correlationId,
        errorKind: rejectionErrorKind(facts.reason),
      },
      {
        rejectionReason: facts.reason,
        ...(facts.defectFingerprint === undefined
          ? {}
          : { defectFingerprint: facts.defectFingerprint }),
        fingerprintAlgorithm: DEFECT_FINGERPRINT_ALGORITHM_VERSION,
        trigger: facts.trigger,
        openIncidentCount: facts.openIncidentCount,
        completeness: "partial",
        loss: "event-dropped",
      },
    ),
  );
}

function rejectionErrorKind(
  reason: SupportIncidentRejection,
): "rate-limited" | "unavailable" | "validation-failed" {
  if (reason === "quota-exhausted") return "rate-limited";
  return reason === "store-unavailable" ? "unavailable" : "validation-failed";
}

function dismissedEvidence(
  stateDir: string,
  record: SupportIncidentRecord,
  correlationId: string,
  openIncidentCount: number,
): void {
  writeEvidence(
    stateDir,
    activityLogEvent(
      SUPPORT_INCIDENT_DISMISSED_OPERATION,
      { correlationId },
      {
        incidentId: record.incidentId,
        defectFingerprint: record.fingerprint.defectFingerprint,
        fingerprintAlgorithm: record.fingerprint.algorithm,
        trigger: record.trigger,
        incidentState: record.state,
        openIncidentCount,
      },
    ),
  );
}

interface ExpiryFacts {
  readonly entry: SupportIncidentStoreEntry;
  readonly removed: boolean;
  readonly correlationId: string;
  readonly openIncidentCount: number;
}

function expiredEvidence(stateDir: string, facts: ExpiryFacts): void {
  const record = facts.entry.record;
  writeEvidence(
    stateDir,
    activityLogEvent(
      SUPPORT_INCIDENT_EXPIRED_OPERATION,
      { correlationId: facts.correlationId },
      {
        incidentId: facts.entry.incidentId,
        expiryReason: record === undefined ? "invalid-record" : "expired",
        removalStatus: facts.removed ? "removed" : "failed",
        ...(record === undefined
          ? {}
          : { defectFingerprint: record.fingerprint.defectFingerprint }),
        openIncidentCount: facts.openIncidentCount,
        ...(facts.removed ? {} : { completeness: "partial" as const }),
      },
    ),
  );
}

// ─── Fingerprint and candidate policy ──────────────────────────────────────────────────────────

/** The deterministic, versioned defectFingerprint: SHA-256 over the canonical contract preimage. */
export function computeDefectFingerprint(input: DefectFingerprintInput): string {
  return createHash("sha256").update(defectFingerprintPreimage(input), "utf8").digest("hex");
}

let supportedFailureClasses: ReadonlySet<string> | undefined;

function supportedFailureClassSet(): ReadonlySet<string> {
  supportedFailureClasses ??= new Set(
    ACTIVITY_LOG_FAILURE_CLASS_COVERAGE.classes.map((entry) => entry.failureClass),
  );
  return supportedFailureClasses;
}

/**
 * True when the registry declares `op` as a failure operation of at least one supported failure
 * class — the only source of report eligibility (no caller-side list).
 */
export function supportIncidentEligibleOperation(op: string): boolean {
  if (SUPPORT_INCIDENT_OPERATIONS.has(op)) return false;
  const registration = activityLogOperationSchema(op);
  if (registration?.lifecycle !== "failure") return false;
  const supported = supportedFailureClassSet();
  return registration.failureClasses.some((failureClass) => supported.has(failureClass));
}

/** The body-free facts of one failure event that enter a candidate. */
export interface SupportIncidentFailureEvidence {
  readonly op: string;
  readonly errorKind?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly parentCorrelationId?: string | undefined;
  readonly frames?: readonly unknown[] | undefined;
}

function keikoFrames(frames: readonly unknown[] | undefined): readonly string[] {
  if (frames === undefined) return [];
  return frames.filter(
    (frame): frame is string => typeof frame === "string" && FRAME_SHAPE_PATTERN.test(frame),
  );
}

function failureFingerprintInput(evidence: SupportIncidentFailureEvidence): DefectFingerprintInput {
  return {
    surface: ACTIVITY_LOG_OPERATION_SURFACES[evidence.op] ?? "unattributed",
    op: evidence.op,
    errorKind: activityLogErrorKindOr(evidence.errorKind, "unknown"),
    frames: keikoFrames(evidence.frames),
  };
}

function failureCorrelation(evidence: SupportIncidentFailureEvidence): SupportIncidentCorrelation {
  const own = isActivityLogCorrelationId(evidence.correlationId)
    ? evidence.correlationId
    : undefined;
  const parent = isActivityLogCorrelationId(evidence.parentCorrelationId)
    ? evidence.parentCorrelationId
    : undefined;
  const root = parent ?? own;
  const children = parent !== undefined && own !== undefined && own !== parent ? [own] : [];
  return {
    ...(root === undefined ? {} : { rootCorrelationId: root }),
    childCorrelationIds: children.slice(0, MAX_SUPPORT_INCIDENT_CHILD_CORRELATIONS),
  };
}

// ─── Candidate creation ────────────────────────────────────────────────────────────────────────

export type SupportIncidentCreation =
  | { readonly status: "created"; readonly record: SupportIncidentRecord }
  | { readonly status: "deduplicated"; readonly record: SupportIncidentRecord }
  | { readonly status: "rejected"; readonly reason: SupportIncidentRejection };

export interface SupportIncidentOptions {
  readonly env?: ServerLogEnv | undefined;
  readonly nowMs?: number | undefined;
  // The correlation of the user action (Report a problem); a fresh one is minted when absent.
  readonly correlationId?: string | undefined;
}

interface CandidateDraft {
  readonly trigger: SupportIncidentTrigger;
  readonly input: DefectFingerprintInput;
  readonly correlation: SupportIncidentCorrelation;
  readonly evidenceCorrelationId: string;
}

interface CandidateContext {
  readonly stateDir: string;
  readonly nowMs: number;
  readonly env: ServerLogEnv;
  readonly defectFingerprint: string;
}

function incidentWindow(nowMs: number): SupportIncidentRecord["window"] {
  return {
    fromMs: Math.max(0, nowMs - SUPPORT_INCIDENT_WINDOW_BEFORE_MS),
    incidentAtMs: nowMs,
    toMs: nowMs + SUPPORT_INCIDENT_WINDOW_AFTER_MS,
  };
}

function pinFromResult(result: ActivityLogPinResult): SupportIncidentPin {
  if (result.status === "rejected") {
    return { status: "rejected", pinnedSegmentCount: 0, pinnedBytes: 0 };
  }
  return {
    status: result.quotaStatus === "within-quota" ? "pinned" : "quota-exceeded",
    pinId: result.pinId,
    pinnedSegmentCount: result.pinnedSegmentCount,
    pinnedBytes: result.pinnedBytes,
  };
}

function buildRecord(
  draft: CandidateDraft,
  context: CandidateContext,
  pin: SupportIncidentPin,
): SupportIncidentRecord {
  const identity = serverLogProcessIdentity();
  return {
    schemaVersion: SUPPORT_INCIDENT_SCHEMA_VERSION,
    incidentId: randomBytes(16).toString("hex"),
    trigger: draft.trigger,
    state: "candidate",
    fingerprint: {
      algorithm: DEFECT_FINGERPRINT_ALGORITHM_VERSION,
      defectFingerprint: context.defectFingerprint,
      surface: draft.input.surface,
      op: draft.input.op,
      errorKind: draft.input.errorKind,
      frameCount: normalizeKeikoFrameSignature(draft.input.frames).length,
    },
    correlation: draft.correlation,
    build: supportIncidentBuild(identity.productVersion, identity.platformClass),
    window: incidentWindow(context.nowMs),
    pin,
    createdAtMs: context.nowMs,
    expiresAtMs: context.nowMs + SUPPORT_INCIDENT_TTL_MS,
  };
}

function quotaAllows(
  entries: readonly SupportIncidentStoreEntry[],
  trigger: SupportIncidentTrigger,
): boolean {
  if (entries.length >= MAX_SUPPORT_INCIDENTS) return false;
  if (trigger === "user-report") return true;
  const automatic = entries.filter((entry) => entry.record?.trigger !== "user-report").length;
  return automatic < MAX_REGISTERED_FAILURE_INCIDENTS;
}

function reject(
  context: CandidateContext,
  draft: CandidateDraft,
  reason: SupportIncidentRejection,
  openIncidentCount: number,
): SupportIncidentCreation {
  rejectedEvidence(context.stateDir, {
    reason,
    trigger: draft.trigger,
    defectFingerprint: context.defectFingerprint,
    correlationId: draft.evidenceCorrelationId,
    openIncidentCount,
  });
  return { status: "rejected", reason };
}

const REJECTED_PIN: SupportIncidentPin = {
  status: "rejected",
  pinnedSegmentCount: 0,
  pinnedBytes: 0,
};

// Seals the active segment and pins the bounded window across every process instance, including
// segments sealed later inside it. A failed pin never blocks the candidate: it is recorded as
// `rejected` in the record and in `support.incident.created`, so sufficiency can say so.
function pinIncidentWindow(draft: CandidateDraft, context: CandidateContext): SupportIncidentPin {
  const window = incidentWindow(context.nowMs);
  try {
    return pinFromResult(
      pinActivityLogWindow(
        context.stateDir,
        {
          scope: { kind: "window", fromMs: window.fromMs, toMs: window.toMs },
          expiresAtMs: context.nowMs + SUPPORT_INCIDENT_TTL_MS,
          reason: "incident",
          correlationId: draft.evidenceCorrelationId,
        },
        context.env,
      ),
    );
  } catch (error) {
    reportServerLogFailure(error, {
      op: SUPPORT_INCIDENT_CREATED_OPERATION.op,
      correlationId: draft.evidenceCorrelationId,
    });
    return REJECTED_PIN;
  }
}

function publishCandidate(
  draft: CandidateDraft,
  context: CandidateContext,
  entries: readonly SupportIncidentStoreEntry[],
): SupportIncidentCreation {
  const record = buildRecord(draft, context, pinIncidentWindow(draft, context));
  const payload = serializeSupportIncidentRecord(record);
  if (payload === undefined) return reject(context, draft, "record-too-large", entries.length);
  try {
    writeSupportIncidentRecord(
      supportIncidentDirectory(context.stateDir),
      payload,
      record.incidentId,
    );
  } catch (error) {
    reportServerLogFailure(error, {
      op: SUPPORT_INCIDENT_REJECTED_OPERATION.op,
      correlationId: draft.evidenceCorrelationId,
    });
    // The pin (if any) still expires with the candidate's TTL; nothing is left unbounded.
    return reject(context, draft, "store-unavailable", entries.length);
  }
  createdEvidence(context.stateDir, record, draft.evidenceCorrelationId, entries.length + 1);
  return { status: "created", record };
}

function openDuplicate(
  entries: readonly SupportIncidentStoreEntry[],
  draft: CandidateDraft,
  defectFingerprint: string,
): SupportIncidentRecord | undefined {
  if (draft.trigger !== "registered-failure") return undefined;
  return entries.find(
    (entry) =>
      entry.record?.trigger === "registered-failure" &&
      entry.record.fingerprint.defectFingerprint === defectFingerprint,
  )?.record;
}

function createCandidate(
  stateDir: string,
  draft: CandidateDraft,
  options: SupportIncidentOptions,
): SupportIncidentCreation {
  const context: CandidateContext = {
    stateDir,
    nowMs: options.nowMs ?? Date.now(),
    env: options.env ?? process.env,
    defectFingerprint: computeDefectFingerprint(draft.input),
  };
  let entries: readonly SupportIncidentStoreEntry[];
  try {
    ensureSupportIncidentDirectory(stateDir);
    entries = sweepExpiredEntries(stateDir, context.nowMs, draft.evidenceCorrelationId);
  } catch (error) {
    reportServerLogFailure(error, {
      op: SUPPORT_INCIDENT_REJECTED_OPERATION.op,
      correlationId: draft.evidenceCorrelationId,
    });
    return reject(context, draft, "store-unavailable", 0);
  }
  const duplicate = openDuplicate(entries, draft, context.defectFingerprint);
  if (duplicate !== undefined) {
    deduplicatedEvidence(stateDir, duplicate, draft.evidenceCorrelationId, entries.length);
    return { status: "deduplicated", record: duplicate };
  }
  if (!quotaAllows(entries, draft.trigger)) {
    return reject(context, draft, "quota-exhausted", entries.length);
  }
  return publishCandidate(draft, context, entries);
}

/**
 * Records a candidate for one registered failure event (the automatic trigger). Returns
 * `undefined` without any filesystem work when the operation is not eligible.
 */
export function recordRegisteredFailureIncident(
  stateDir: string,
  evidence: SupportIncidentFailureEvidence,
  options: SupportIncidentOptions = {},
): SupportIncidentCreation | undefined {
  if (!supportIncidentEligibleOperation(evidence.op)) return undefined;
  const correlation = failureCorrelation(evidence);
  return createCandidate(
    stateDir,
    {
      trigger: "registered-failure",
      input: failureFingerprintInput(evidence),
      correlation,
      evidenceCorrelationId:
        evidence.correlationId ?? correlation.rootCorrelationId ?? randomUUID(),
    },
    options,
  );
}

/**
 * Records a candidate for an explicit user "Report a problem" action. It needs no failure event:
 * its fingerprint uses the fixed unattributed inputs, and its sufficiency is computed later from
 * the pinned window, where a missing registered failure is a closed instrumentation-gap reason.
 */
export function recordUserReportedIncident(
  stateDir: string,
  options: SupportIncidentOptions = {},
): SupportIncidentCreation {
  const correlationId = isActivityLogCorrelationId(options.correlationId)
    ? options.correlationId
    : randomUUID();
  return createCandidate(
    stateDir,
    {
      trigger: "user-report",
      input: UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT,
      correlation: { rootCorrelationId: correlationId, childCorrelationIds: [] },
      evidenceCorrelationId: correlationId,
    },
    options,
  );
}

// ─── Reading, expiry, dismissal ────────────────────────────────────────────────────────────────

function expiredOrInvalid(entry: SupportIncidentStoreEntry, nowMs: number): boolean {
  return entry.record === undefined || entry.record.expiresAtMs <= nowMs;
}

function removeEntry(stateDir: string, incidentId: string): boolean {
  try {
    removeSupportIncidentRecord(stateDir, incidentId);
    return true;
  } catch (error) {
    reportServerLogFailure(error, { op: SUPPORT_INCIDENT_EXPIRED_OPERATION.op });
    return false;
  }
}

/**
 * Removes every expired or unreadable record (predictable expiry and torn-record recovery), emits
 * one `support.incident.expired` line per removal, and returns the records that remain open.
 */
function sweepExpiredEntries(
  stateDir: string,
  nowMs: number,
  correlationId: string,
): readonly SupportIncidentStoreEntry[] {
  const entries = listSupportIncidentEntries(stateDir);
  const open = entries.filter((entry) => !expiredOrInvalid(entry, nowMs));
  for (const entry of entries) {
    if (!expiredOrInvalid(entry, nowMs)) continue;
    const removed = removeEntry(stateDir, entry.incidentId);
    expiredEvidence(stateDir, { entry, removed, correlationId, openIncidentCount: open.length });
  }
  return open;
}

/** The open (unexpired, readable) incident records, oldest first. Expires stale records first. */
export function listSupportIncidents(
  stateDir: string,
  options: SupportIncidentOptions = {},
): readonly SupportIncidentRecord[] {
  const correlationId = options.correlationId ?? randomUUID();
  return sweepExpiredEntries(stateDir, options.nowMs ?? Date.now(), correlationId).flatMap(
    (entry) => (entry.record === undefined ? [] : [entry.record]),
  );
}

export type SupportIncidentDismissal = "dismissed" | "not-found" | "failed";

/** Explicit human dismissal: removes the record; its pin lapses at its (bounded) expiry. */
export function dismissSupportIncident(
  stateDir: string,
  incidentId: string,
  options: SupportIncidentOptions = {},
): SupportIncidentDismissal {
  const correlationId = options.correlationId ?? randomUUID();
  const open = sweepExpiredEntries(stateDir, options.nowMs ?? Date.now(), correlationId);
  const record = open.find((entry) => entry.incidentId === incidentId)?.record;
  if (record === undefined) return "not-found";
  try {
    removeSupportIncidentRecord(stateDir, incidentId);
  } catch (error) {
    reportServerLogFailure(error, { op: SUPPORT_INCIDENT_DISMISSED_OPERATION.op, correlationId });
    return "failed";
  }
  dismissedEvidence(stateDir, record, correlationId, open.length - 1);
  return "dismissed";
}

// ─── The registered-failure trigger ────────────────────────────────────────────────────────────

/** A process evaluates at most this many new candidates per rolling minute (all fingerprints). */
export const MAX_SUPPORT_INCIDENT_EVALUATIONS_PER_MINUTE = 6;
const MAX_REMEMBERED_FINGERPRINTS = 128;

let triggerDepth = 0;
let triggerOverride: boolean | undefined;
const recentFingerprints = new Map<string, number>();
const recentEvaluations: number[] = [];

/** Test seam: force the automatic trigger on or off; `undefined` restores the default. */
export function setSupportIncidentTriggerForTests(enabled: boolean | undefined): void {
  triggerOverride = enabled;
  recentFingerprints.clear();
  recentEvaluations.length = 0;
}

function triggerEnabled(): boolean {
  return triggerOverride ?? !activityLogTestWriterInstalled();
}

// Bounds the synchronous cost a failure storm can add to the logging path: one fingerprint is
// re-evaluated at most once per SUPPORT_INCIDENT_SUPPRESSION_MS, and all fingerprints together at
// most MAX_SUPPORT_INCIDENT_EVALUATIONS_PER_MINUTE times. The failure lines themselves are always
// persisted, so a skipped evaluation loses no evidence; the pinned window of the first occurrence
// and the Activity Log's own retention still hold it.
function admitEvaluation(fingerprint: string, nowMs: number): boolean {
  const last = recentFingerprints.get(fingerprint);
  if (last !== undefined && nowMs - last < SUPPORT_INCIDENT_SUPPRESSION_MS) return false;
  while (recentEvaluations.length > 0 && nowMs - (recentEvaluations[0] ?? nowMs) >= MINUTE_MS) {
    recentEvaluations.shift();
  }
  if (recentEvaluations.length >= MAX_SUPPORT_INCIDENT_EVALUATIONS_PER_MINUTE) return false;
  recentEvaluations.push(nowMs);
  if (recentFingerprints.size >= MAX_REMEMBERED_FINGERPRINTS) recentFingerprints.clear();
  recentFingerprints.set(fingerprint, nowMs);
  return true;
}

function eventFrames(event: ServerLogEvent): readonly unknown[] | undefined {
  const frames = event.extra?.frames;
  return Array.isArray(frames) ? frames : undefined;
}

function triggerCandidate(stateDir: string, event: ServerLogEvent): void {
  if (!supportIncidentEligibleOperation(event.op)) return;
  const evidence: SupportIncidentFailureEvidence = {
    op: event.op,
    errorKind: event.errorKind,
    correlationId: event.correlationId,
    parentCorrelationId: event.parentCorrelationId,
    frames: eventFrames(event),
  };
  if (!admitEvaluation(computeDefectFingerprint(failureFingerprintInput(evidence)), Date.now())) {
    return;
  }
  recordRegisteredFailureIncident(stateDir, evidence);
}

/**
 * Called by the Activity Log file sink after it persisted `event`. Creates (or deduplicates) an
 * incident candidate for an eligible failure. Never throws and never re-enters itself: the
 * candidate's own lifecycle and pin lines are written from inside this call.
 */
export function observeSupportIncidentTrigger(stateDir: string, event: ServerLogEvent): void {
  if (triggerDepth > 0 || event.level !== "error" || !triggerEnabled()) return;
  triggerDepth += 1;
  try {
    triggerCandidate(stateDir, event);
  } catch (error) {
    // The failure line itself is already persisted; only the candidate is lost, and says so.
    recordActivityLogLoss("persistence-failed");
    reportServerLogFailure(error, {
      op: SUPPORT_INCIDENT_REJECTED_OPERATION.op,
      correlationId: event.correlationId,
      loss: "event-dropped",
    });
  } finally {
    triggerDepth -= 1;
  }
}
