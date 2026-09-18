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
// DEDUPLICATION. At most one open registered-failure candidate exists per defectFingerprint,
// enforced atomically across every process sharing stateDir by an exclusive-create claim file keyed
// by the fingerprint (#3533 review 4050606506): a recurrence of the same defect is evidenced as
// `support.incident.deduplicated` on the existing incident instead of pinning a second window. A
// process additionally suppresses re-evaluating a fingerprint for SUPPORT_INCIDENT_SUPPRESSION_MS
// so a failure storm costs no filesystem work. User reports are never merged: each explicit "Report
// a problem" is its own occurrence.
//
// QUOTAS AND EXPIRY. The store holds at most MAX_SUPPORT_INCIDENTS records (each at most
// MAX_SUPPORT_INCIDENT_RECORD_BYTES), of which registered-failure candidates may occupy at most
// MAX_REGISTERED_FAILURE_INCIDENTS so a failure flood can never block an explicit user report. Both
// bounds hold atomically across processes too: every candidate claims one of a bounded pool of
// exclusive-create quota-slot files before its record is written (automatics from slot 0 up,
// reserving the top slots for user reports, exactly as the count-based reserve always intended). A
// full store rejects the new candidate with body-free loss evidence; it never evicts a candidate the
// user has not seen. Every candidate expires SUPPORT_INCIDENT_TTL_MS after creation; its pin expires
// at the same instant, and its fingerprint and slot claims release with it, so an unreported incident
// releases its evidence and its claims predictably.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ACTIVITY_LOG_DIRECTORY_NAME,
  ACTIVITY_LOG_FAILURE_CLASS_COVERAGE,
  ACTIVITY_LOG_OPERATION_SURFACES,
  DEFECT_FINGERPRINT_ALGORITHM_VERSION,
  MAX_SUPPORT_INCIDENT_CHILD_CORRELATIONS,
  SUPPORT_INCIDENT_SCHEMA_VERSION,
  SUPPORT_INCIDENT_SLOT_COUNT,
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
  type SupportIncidentSegmentReference,
  type SupportIncidentTrigger,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  activityLogPinCovers,
  isActivityLogSegmentEntry,
  listActivityLogDirectory,
  type ActivityLogPinRecord,
} from "./activity-log-store.js";
import type { ServerLogEnv } from "./log-level.js";
import {
  createFileServerLogSink,
  pinActivityLogWindow,
  releaseActivityLogPin,
  reportServerLogFailure,
  serverLogProcessIdentity,
  type ActivityLogPinResult,
  type ServerLogEvent,
} from "./server-log.js";
import { activityLogTestWriterInstalled } from "./server-logger.js";
import { FRAME_SHAPE_PATTERN } from "./stack-frames.js";
import {
  claimSupportIncidentFingerprint,
  claimSupportIncidentSlot,
  ensureSupportIncidentDirectory,
  listSupportIncidentClaims,
  listSupportIncidentEntries,
  readSupportIncidentFingerprintClaim,
  readSupportIncidentRecord,
  releaseSupportIncidentFingerprintClaim,
  releaseSupportIncidentSlot,
  removeSupportIncidentClaimFile,
  removeSupportIncidentRecord,
  serializeSupportIncidentRecord,
  supportIncidentDirectory,
  writeSupportIncidentRecord,
  type SupportIncidentClaimEntry,
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
/** Records the store holds at most (count quota); also the quota-slot claim file grammar's bound. */
export const MAX_SUPPORT_INCIDENTS = SUPPORT_INCIDENT_SLOT_COUNT;
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
    // True when a sealed segment inside the window, visible just before the pin was published, was
    // already gone by the time the pin actually covered it (a maintenance pass raced the gap): the
    // window is then never reported as a clean "pinned" even though `pinStatus` says "pinned".
    evidenceLostBeforePin: { type: "boolean", dataClass: "closed-enum", required: true },
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
    pinRelease: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["released", "not-pinned", "rejected"],
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
        evidenceLostBeforePin: record.pin.evidenceLostBeforePin,
        windowSeconds: Math.ceil((record.window.toMs - record.window.fromMs) / 1000),
        expiresInSeconds: Math.ceil((record.expiresAtMs - record.createdAtMs) / 1000),
        openIncidentCount,
        completeness:
          record.pin.status === "pinned" && !record.pin.evidenceLostBeforePin
            ? "complete"
            : "partial",
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

export type SupportIncidentPinRelease = "released" | "not-pinned" | "rejected";

interface DismissalFacts {
  readonly correlationId: string;
  readonly openIncidentCount: number;
  readonly pinRelease: SupportIncidentPinRelease;
}

function dismissedEvidence(
  stateDir: string,
  record: SupportIncidentRecord,
  facts: DismissalFacts,
): void {
  writeEvidence(
    stateDir,
    activityLogEvent(
      SUPPORT_INCIDENT_DISMISSED_OPERATION,
      { correlationId: facts.correlationId },
      {
        incidentId: record.incidentId,
        defectFingerprint: record.fingerprint.defectFingerprint,
        fingerprintAlgorithm: record.fingerprint.algorithm,
        trigger: record.trigger,
        incidentState: record.state,
        pinRelease: facts.pinRelease,
        openIncidentCount: facts.openIncidentCount,
        ...(facts.pinRelease === "rejected" ? { completeness: "partial" as const } : {}),
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
  // Set only by the registered-failure trigger (observeSupportIncidentTrigger): the window pin it
  // already published synchronously, in the same turn as the triggering failure write, before any
  // later maintenance pass could run against an unprotected window. publishCandidate reuses it
  // instead of pinning again; any outcome other than "created" releases it (releasePrePinned).
  readonly prePinned?: SupportIncidentPin | undefined;
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
    return {
      status: "rejected",
      pinnedSegmentCount: 0,
      pinnedBytes: 0,
      evidenceLostBeforePin: false,
    };
  }
  return {
    status: result.quotaStatus === "within-quota" ? "pinned" : "quota-exceeded",
    pinId: result.pinId,
    pinnedSegmentCount: result.pinnedSegmentCount,
    pinnedBytes: result.pinnedBytes,
    evidenceLostBeforePin: false,
  };
}

// A synthetic pin record used only to reuse `activityLogPinCovers`'s coverage rule (the same rule
// retention and the pin API apply) for a window that may not have a real, or not yet a final, pin
// id. Only `scope` is ever read by that rule; the other fields are structural filler.
function windowCoverageRecord(
  window: SupportIncidentRecord["window"],
  pinId: string | undefined,
): ActivityLogPinRecord {
  return {
    schemaVersion: 1,
    pinId: pinId ?? "0".repeat(24),
    reason: "incident",
    createdAtMs: window.incidentAtMs,
    expiresAtMs: window.incidentAtMs + 1,
    scope: { kind: "window", fromMs: window.fromMs, toMs: window.toMs },
  };
}

// The sealed segments the Activity Log directory currently shows overlapping `window`. Sealed
// only: an active segment is never a retention target (`deletable` in activity-log-store.ts
// excludes it), so only a sealed name can meaningfully disappear between two snapshots.
function overlappingSealedSegmentNames(
  stateDir: string,
  window: SupportIncidentRecord["window"],
  correlationId: string,
): ReadonlySet<string> {
  const coverage = windowCoverageRecord(window, undefined);
  try {
    return new Set(
      listActivityLogDirectory(join(stateDir, ACTIVITY_LOG_DIRECTORY_NAME))
        .files.filter(isActivityLogSegmentEntry)
        .filter((entry) => entry.file.kind === "sealed" && activityLogPinCovers(coverage, entry))
        .map((entry) => entry.file.name),
    );
  } catch (error) {
    // Best-effort: an unreadable directory here only skips the evidenceLostBeforePin check below.
    // The pin request itself still runs its own, separately reported, directory read.
    reportServerLogFailure(error, { op: SUPPORT_INCIDENT_CREATED_OPERATION.op, correlationId });
    return new Set();
  }
}

function buildRecord(
  draft: CandidateDraft,
  context: CandidateContext,
  pin: SupportIncidentPin,
  incidentId: string,
  slotIndex: number,
): SupportIncidentRecord {
  const identity = serverLogProcessIdentity();
  return {
    schemaVersion: SUPPORT_INCIDENT_SCHEMA_VERSION,
    incidentId,
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
    slotIndex,
    createdAtMs: context.nowMs,
    expiresAtMs: context.nowMs + SUPPORT_INCIDENT_TTL_MS,
  };
}

// Automatics claim ascending from slot 0 (0..MAX_REGISTERED_FAILURE_INCIDENTS-1); user reports
// claim descending from the top (MAX_SUPPORT_INCIDENTS-1..0). Automatics never touch the top
// MAX_SUPPORT_INCIDENTS-MAX_REGISTERED_FAILURE_INCIDENTS slots, so those stay available to a user
// report even when automatics hold their full share -- reproducing quotaAllows's old count-based
// reserve atomically, one exclusive-create attempt at a time instead of one racy directory count.
function slotSearchOrder(trigger: SupportIncidentTrigger): readonly number[] {
  if (trigger === "user-report") {
    return Array.from(
      { length: MAX_SUPPORT_INCIDENTS },
      (_, index) => MAX_SUPPORT_INCIDENTS - 1 - index,
    );
  }
  return Array.from({ length: MAX_REGISTERED_FAILURE_INCIDENTS }, (_, index) => index);
}

/**
 * Atomically claims one quota slot for `incidentId`, or `undefined` when every slot this trigger
 * may use is already held -- the store (or, for a registered failure, its 24-slot share) is full.
 * Each attempt is one exclusive-create (#3533 review 4050606506): two processes racing the same
 * free slot can never both win it, unlike a count read from a directory listing.
 */
function claimQuotaSlot(
  stateDir: string,
  trigger: SupportIncidentTrigger,
  incidentId: string,
): number | undefined {
  for (const slotIndex of slotSearchOrder(trigger)) {
    if (claimSupportIncidentSlot(stateDir, slotIndex, incidentId)) return slotIndex;
  }
  return undefined;
}

// Releases a window pin a draft already published before dedup or quota was decided (the
// registered-failure trigger always pre-pins; see observeSupportIncidentTrigger). Nothing will
// reference it once the candidate is rejected or turns out to be a duplicate, so it must not sit
// and hold its segments for no reason until its own TTL. Never throws: `releaseWindowPin` mirrors
// `releaseActivityLogPin`'s own closed, evidenced-rejection contract.
function releasePrePinned(context: CandidateContext, draft: CandidateDraft): void {
  if (draft.prePinned === undefined) return;
  releaseWindowPin(context.stateDir, draft.prePinned.pinId, {
    correlationId: draft.evidenceCorrelationId,
    env: context.env,
  });
}

function reject(
  context: CandidateContext,
  draft: CandidateDraft,
  reason: SupportIncidentRejection,
  openIncidentCount: number,
): SupportIncidentCreation {
  releasePrePinned(context, draft);
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
  evidenceLostBeforePin: false,
};

/**
 * Publishes the Activity Log retention pin for the incident window and seals the caller's own
 * active segment as part of that request (#3530). Also detects the residual race a synchronous
 * caller cannot fully close on its own: a sealed segment inside the window, visible in the
 * directory just before this call, that is already gone by the time the pin actually covers it —
 * for example another process sharing `stateDir` running retention in the same narrow gap. That
 * loss is reported as `evidenceLostBeforePin` instead of a silent, clean `pinned`. A failed pin
 * never blocks the candidate: it is recorded as `rejected`, so sufficiency can say so.
 */
function pinIncidentWindow(
  stateDir: string,
  nowMs: number,
  correlationId: string,
  env: ServerLogEnv,
): SupportIncidentPin {
  const window = incidentWindow(nowMs);
  const before = overlappingSealedSegmentNames(stateDir, window, correlationId);
  try {
    const pin = pinFromResult(
      pinActivityLogWindow(
        stateDir,
        {
          scope: { kind: "window", fromMs: window.fromMs, toMs: window.toMs },
          expiresAtMs: nowMs + SUPPORT_INCIDENT_TTL_MS,
          reason: "incident",
          correlationId,
        },
        env,
      ),
    );
    if (pin.status === "rejected" || before.size === 0) return pin;
    const after = overlappingSealedSegmentNames(stateDir, window, correlationId);
    const evidenceLostBeforePin = [...before].some((name) => !after.has(name));
    return { ...pin, evidenceLostBeforePin };
  } catch (error) {
    reportServerLogFailure(error, { op: SUPPORT_INCIDENT_CREATED_OPERATION.op, correlationId });
    return REJECTED_PIN;
  }
}

function publishCandidate(
  draft: CandidateDraft,
  context: CandidateContext,
  entries: readonly SupportIncidentStoreEntry[],
  incidentId: string,
  slotIndex: number,
): SupportIncidentCreation {
  const pin =
    draft.prePinned ??
    pinIncidentWindow(context.stateDir, context.nowMs, draft.evidenceCorrelationId, context.env);
  const record = buildRecord(draft, context, pin, incidentId, slotIndex);
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

type DedupOutcome =
  | { readonly status: "claimed" }
  | { readonly status: "duplicate"; readonly record: SupportIncidentRecord }
  | { readonly status: "unavailable" };

/**
 * Atomically decides "is this fingerprint already open" (#3533 review 4050606506): exclusive-
 * create on the fingerprint's own claim file can succeed for only one caller, so two processes
 * racing the identical registered failure can never both believe they are first -- the exclusive
 * create on the incident record's own random-id file name alone never protected the fingerprint
 * itself, only the filename. The loser reads the winner's incidentId and deduplicates onto it. A
 * claim whose referenced record is missing (a crash before it was written, or a cleanup pass that
 * raced ahead of this read) is stale: it is removed and the attempt retried once before this
 * gives up as unavailable rather than risk a second, indistinguishable publish.
 */
function claimOrFindDuplicate(
  stateDir: string,
  defectFingerprint: string,
  incidentId: string,
  correlationId: string,
): DedupOutcome {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (claimSupportIncidentFingerprint(stateDir, defectFingerprint, incidentId)) {
        return { status: "claimed" };
      }
      const holderId = readSupportIncidentFingerprintClaim(stateDir, defectFingerprint);
      const holderRecord =
        holderId === undefined ? undefined : readSupportIncidentRecord(stateDir, holderId);
      if (holderRecord !== undefined) return { status: "duplicate", record: holderRecord };
      releaseSupportIncidentFingerprintClaim(stateDir, defectFingerprint);
    } catch (error) {
      reportServerLogFailure(error, { op: SUPPORT_INCIDENT_CREATED_OPERATION.op, correlationId });
      return { status: "unavailable" };
    }
  }
  return { status: "unavailable" };
}

type SweptEntries =
  | { readonly ok: true; readonly entries: readonly SupportIncidentStoreEntry[] }
  | { readonly ok: false; readonly result: SupportIncidentCreation };

function sweptEntriesOrReject(
  stateDir: string,
  context: CandidateContext,
  draft: CandidateDraft,
): SweptEntries {
  try {
    ensureSupportIncidentDirectory(stateDir);
    const entries = sweepExpiredEntries(stateDir, context.nowMs, draft.evidenceCorrelationId);
    return { ok: true, entries };
  } catch (error) {
    reportServerLogFailure(error, {
      op: SUPPORT_INCIDENT_REJECTED_OPERATION.op,
      correlationId: draft.evidenceCorrelationId,
    });
    return { ok: false, result: reject(context, draft, "store-unavailable", 0) };
  }
}

type DedupHandled =
  { readonly done: true; readonly result: SupportIncidentCreation } | { readonly done: false };

// Handles the two outcomes that end candidate creation before quota or publish is even reached;
// "claimed" (the common case) falls through and lets createCandidate proceed.
function handleDedup(
  stateDir: string,
  context: CandidateContext,
  draft: CandidateDraft,
  dedupFingerprint: string,
  incidentId: string,
  openIncidentCount: number,
): DedupHandled {
  const dedup = claimOrFindDuplicate(
    stateDir,
    dedupFingerprint,
    incidentId,
    draft.evidenceCorrelationId,
  );
  if (dedup.status === "unavailable") {
    return { done: true, result: reject(context, draft, "store-unavailable", openIncidentCount) };
  }
  if (dedup.status === "duplicate") {
    releasePrePinned(context, draft);
    deduplicatedEvidence(stateDir, dedup.record, draft.evidenceCorrelationId, openIncidentCount);
    return { done: true, result: { status: "deduplicated", record: dedup.record } };
  }
  return { done: false };
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
  const swept = sweptEntriesOrReject(stateDir, context, draft);
  if (!swept.ok) return swept.result;
  const entries = swept.entries;

  const incidentId = randomBytes(16).toString("hex");
  const dedupFingerprint =
    draft.trigger === "registered-failure" ? context.defectFingerprint : undefined;
  if (dedupFingerprint !== undefined) {
    const handled = handleDedup(
      stateDir,
      context,
      draft,
      dedupFingerprint,
      incidentId,
      entries.length,
    );
    if (handled.done) return handled.result;
  }

  const slotIndex = claimQuotaSlot(stateDir, draft.trigger, incidentId);
  if (slotIndex === undefined) {
    if (dedupFingerprint !== undefined) {
      releaseSupportIncidentFingerprintClaim(stateDir, dedupFingerprint);
    }
    return reject(context, draft, "quota-exhausted", entries.length);
  }

  const created = publishCandidate(draft, context, entries, incidentId, slotIndex);
  if (created.status !== "created") releaseClaims(stateDir, dedupFingerprint, slotIndex);
  return created;
}

function registeredFailureDraft(evidence: SupportIncidentFailureEvidence): CandidateDraft {
  const correlation = failureCorrelation(evidence);
  return {
    trigger: "registered-failure",
    input: failureFingerprintInput(evidence),
    correlation,
    // The failing operation's own correlation (validated), so the candidate's lines join it.
    evidenceCorrelationId:
      correlation.childCorrelationIds[0] ?? correlation.rootCorrelationId ?? randomUUID(),
  };
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
  return createCandidate(stateDir, registeredFailureDraft(evidence), options);
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

// Releases the quota-slot claim, and (for a registered failure) the fingerprint claim, that a
// record's own existence depends on. Shared by dismissal and by the expiry sweep below, and by
// createCandidate's own rollback when a claimed slot's record write ultimately fails.
function releaseClaims(
  stateDir: string,
  defectFingerprint: string | undefined,
  slotIndex: number,
): void {
  if (defectFingerprint !== undefined) {
    releaseSupportIncidentFingerprintClaim(stateDir, defectFingerprint);
  }
  releaseSupportIncidentSlot(stateDir, slotIndex);
}

function releaseRecordClaims(stateDir: string, record: SupportIncidentRecord): void {
  releaseClaims(
    stateDir,
    record.trigger === "registered-failure" ? record.fingerprint.defectFingerprint : undefined,
    record.slotIndex,
  );
}

function removeEntry(stateDir: string, entry: SupportIncidentStoreEntry): boolean {
  try {
    removeSupportIncidentRecord(stateDir, entry.incidentId);
  } catch (error) {
    reportServerLogFailure(error, { op: SUPPORT_INCIDENT_EXPIRED_OPERATION.op });
    return false;
  }
  if (entry.record !== undefined) releaseRecordClaims(stateDir, entry.record);
  return true;
}

// A claim whose referenced incidentId names no record right now is an orphan: a crash between
// claiming and writing that record, or a record already removed by the loop above in this same
// pass. Checks each claim against a FRESH read, never a pre-computed "open" set: entries/open is
// a snapshot taken earlier in this same sweep, and a claim (with its record) can legitimately be
// published by another process in the gap between that snapshot and this loop -- reusing the
// stale snapshot here would delete a brand-new, perfectly live claim out from under its owner,
// silently reopening the exact cross-process race this whole scheme exists to close. Best-effort
// per claim (#3533 review 4050606506) so one bad removal never blocks the rest.
function sweepOrphanedClaims(stateDir: string): void {
  let claims: readonly SupportIncidentClaimEntry[];
  try {
    claims = listSupportIncidentClaims(stateDir);
  } catch (error) {
    reportServerLogFailure(error, { op: SUPPORT_INCIDENT_EXPIRED_OPERATION.op });
    return;
  }
  for (const claim of claims) {
    if (
      claim.incidentId !== undefined &&
      readSupportIncidentRecord(stateDir, claim.incidentId) !== undefined
    ) {
      continue;
    }
    try {
      removeSupportIncidentClaimFile(stateDir, claim.fileName);
    } catch (error) {
      reportServerLogFailure(error, { op: SUPPORT_INCIDENT_EXPIRED_OPERATION.op });
    }
  }
}

/**
 * Removes every expired or unreadable record (predictable expiry and torn-record recovery), emits
 * one `support.incident.expired` line per removal, sweeps orphaned dedup/quota claims, and returns
 * the records that remain open.
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
    const removed = removeEntry(stateDir, entry);
    expiredEvidence(stateDir, { entry, removed, correlationId, openIncidentCount: open.length });
  }
  sweepOrphanedClaims(stateDir);
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

/**
 * One open incident record by id: `undefined` when the id is malformed, unknown, expired, or its
 * record is unreadable. Read-only — expiry removal happens in `listSupportIncidents`.
 */
export function readSupportIncident(
  stateDir: string,
  incidentId: string,
  options: Pick<SupportIncidentOptions, "nowMs"> = {},
): SupportIncidentRecord | undefined {
  const record = readSupportIncidentRecord(stateDir, incidentId);
  return record !== undefined && record.expiresAtMs > (options.nowMs ?? Date.now())
    ? record
    : undefined;
}

export interface SupportIncidentSegmentFile extends SupportIncidentSegmentReference {
  // Local read location for the CLI resolver only; never part of a descriptor or projection.
  readonly path: string;
}

/**
 * The Activity Log segments the incident window covers now, in logical-log order, selected by the
 * retention pin's own coverage rule (#3530) so the resolver and retention can never disagree. A
 * window pin also covers segments sealed after the incident, so this set can grow until the window
 * closes. Legacy daily files predate segments and are never selected.
 */
export function supportIncidentSegmentFiles(
  stateDir: string,
  record: SupportIncidentRecord,
): readonly SupportIncidentSegmentFile[] {
  const coverage = windowCoverageRecord(record.window, record.pin.pinId);
  return listActivityLogDirectory(join(stateDir, ACTIVITY_LOG_DIRECTORY_NAME))
    .files.filter(isActivityLogSegmentEntry)
    .filter((entry) => activityLogPinCovers(coverage, entry))
    .map((entry) => ({
      segmentId: entry.file.segmentId,
      state: entry.file.kind,
      sizeBytes: entry.sizeBytes,
      path: entry.path,
    }));
}

export type SupportIncidentDismissal = "dismissed" | "not-found" | "failed";

// Shared by dismissal (an existing record's own pin) and by a candidate outcome other than
// "created" that must release a pin it published pre-emptively (releasePrePinned above). Never
// throws: an absent pin id is `not-pinned`, and `releaseActivityLogPin` closes every other outcome
// into `released` or a rejection on its own.
function releaseWindowPin(
  stateDir: string,
  pinId: string | undefined,
  context: { readonly correlationId: string; readonly env: ServerLogEnv },
): SupportIncidentPinRelease {
  if (pinId === undefined) return "not-pinned";
  const result = releaseActivityLogPin(
    stateDir,
    { pinId, correlationId: context.correlationId },
    context.env,
  );
  return result.status === "released" ? "released" : "rejected";
}

function releaseIncidentPin(
  stateDir: string,
  record: SupportIncidentRecord,
  context: { readonly correlationId: string; readonly env: ServerLogEnv },
): SupportIncidentPinRelease {
  return releaseWindowPin(stateDir, record.pin.pinId, context);
}

/**
 * Explicit human dismissal: removes the record and releases its Activity Log pin, so the window
 * returns to ordinary retention. A pin that cannot be released still lapses at its bounded expiry.
 */
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
  releaseRecordClaims(stateDir, record);
  const pinRelease = releaseIncidentPin(stateDir, record, {
    correlationId,
    env: options.env ?? process.env,
  });
  dismissedEvidence(stateDir, record, {
    correlationId,
    openIncidentCount: open.length - 1,
    pinRelease,
  });
  return "dismissed";
}

// ─── The registered-failure trigger ────────────────────────────────────────────────────────────
//
// The Activity Log file sink calls `observeSupportIncidentTrigger` for every persisted line. The
// hook computes eligibility and, for an admitted failure, publishes the Activity Log retention pin
// for its window SYNCHRONOUSLY, in the same turn as the triggering write: the window must be
// protected before any later maintenance pass -- this process's own next segment admission, or a
// second process sharing the same stateDir -- can run against it (a `setImmediate` deferral here
// previously left exactly that gap; #3533 review). Only the rest of candidate creation (the
// directory sweep, deduplication, the quota check, and the record write) runs outside the sink's
// write path, on the next turn of the event loop, and synchronously on process exit so a failure
// that ends the process still becomes a candidate. A duplicate or a rejected candidate releases the
// pin the trigger already published (releasePrePinned) instead of leaving it to its own TTL.

/** A process evaluates at most this many new candidates per rolling minute (all fingerprints). */
export const MAX_SUPPORT_INCIDENT_EVALUATIONS_PER_MINUTE = 6;
const MAX_REMEMBERED_FINGERPRINTS = 128;

interface PendingCandidate {
  readonly stateDir: string;
  readonly draft: CandidateDraft;
  // Captured at trigger time: the same instant the pin's own window was computed from, so the
  // deferred record's window and createdAt/expiresAt line up with what was actually pinned.
  readonly nowMs: number;
}

let triggerDepth = 0;
let triggerOverride: boolean | undefined;
let drainScheduled = false;
let exitFlushInstalled = false;
const recentFingerprints = new Map<string, number>();
const recentEvaluations: number[] = [];
const pendingCandidates: PendingCandidate[] = [];

/** Test seam: force the automatic trigger on or off; `undefined` restores the default. */
export function setSupportIncidentTriggerForTests(enabled: boolean | undefined): void {
  triggerOverride = enabled;
  recentFingerprints.clear();
  recentEvaluations.length = 0;
  pendingCandidates.length = 0;
}

function triggerEnabled(): boolean {
  return triggerOverride ?? !activityLogTestWriterInstalled();
}

// Bounds the cost a failure storm can add: one fingerprint is re-evaluated at most once per
// SUPPORT_INCIDENT_SUPPRESSION_MS, and all fingerprints together at most
// MAX_SUPPORT_INCIDENT_EVALUATIONS_PER_MINUTE times. The failure lines themselves are always
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
  return Array.isArray(frames) ? [...(frames as readonly unknown[])] : undefined;
}

function admittedEvidence(event: ServerLogEvent): SupportIncidentFailureEvidence | undefined {
  if (!supportIncidentEligibleOperation(event.op)) return undefined;
  const evidence: SupportIncidentFailureEvidence = {
    op: event.op,
    errorKind: event.errorKind,
    correlationId: event.correlationId,
    parentCorrelationId: event.parentCorrelationId,
    frames: eventFrames(event),
  };
  const fingerprint = computeDefectFingerprint(failureFingerprintInput(evidence));
  return admitEvaluation(fingerprint, Date.now()) ? evidence : undefined;
}

function reportLostCandidate(error: unknown, correlationId: string | undefined): void {
  // The failure line itself is already persisted; only the candidate is lost, and says so.
  recordActivityLogLoss("persistence-failed");
  reportServerLogFailure(error, {
    op: SUPPORT_INCIDENT_REJECTED_OPERATION.op,
    correlationId,
    loss: "event-dropped",
  });
}

function createQueuedCandidate(pending: PendingCandidate): void {
  triggerDepth += 1;
  try {
    createCandidate(pending.stateDir, pending.draft, { nowMs: pending.nowMs });
  } catch (error) {
    reportLostCandidate(error, pending.draft.evidenceCorrelationId);
  } finally {
    triggerDepth -= 1;
  }
}

/** Creates every queued candidate now: the deferred drain, and the synchronous exit flush. */
export function drainSupportIncidentCandidates(): void {
  drainScheduled = false;
  for (const pending of pendingCandidates.splice(0)) createQueuedCandidate(pending);
}

function scheduleDrain(): void {
  if (!exitFlushInstalled) {
    exitFlushInstalled = true;
    process.once("exit", drainSupportIncidentCandidates);
  }
  if (drainScheduled) return;
  drainScheduled = true;
  setImmediate(drainSupportIncidentCandidates);
}

/**
 * Called by the Activity Log file sink after it persisted `event`. For an eligible, admitted
 * failure, publishes the incident window's retention pin right now (before returning) and queues
 * the rest of candidate creation; never throws. An ineligible or suppressed event does no
 * filesystem work at all.
 */
export function observeSupportIncidentTrigger(stateDir: string, event: ServerLogEvent): void {
  if (triggerDepth > 0 || event.level !== "error" || !triggerEnabled()) return;
  try {
    const evidence = admittedEvidence(event);
    if (evidence === undefined) return;
    const nowMs = Date.now();
    const draft = registeredFailureDraft(evidence);
    const pin = pinIncidentWindow(stateDir, nowMs, draft.evidenceCorrelationId, process.env);
    pendingCandidates.push({ stateDir, draft: { ...draft, prePinned: pin }, nowMs });
    scheduleDrain();
  } catch (error) {
    reportLostCandidate(error, event.correlationId);
  }
}
