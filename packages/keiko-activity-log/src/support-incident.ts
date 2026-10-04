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
// DEDUPLICATION. Server failures retain one open candidate per defectFingerprint. Version-two
// browser diagnostics retain one per validated causal occurrence, because coarse browser evidence
// can otherwise collapse unrelated failures and discard their windows. The same bounded quota is
// enforced atomically across every process sharing stateDir by an exclusive-create claim file keyed
// by the retention key (#3533 review 4050606506): a repeat of the same key is evidenced as
// `support.incident.deduplicated` on the existing incident instead of pinning a second window. A
// process additionally suppresses re-evaluating a fingerprint for SUPPORT_INCIDENT_SUPPRESSION_MS
// so a failure storm costs no filesystem work. User reports are never merged: each explicit "Report
// a problem" is its own occurrence.
//
// RETENTION. Small candidate records reserve their maximal bytes through exclusive-create claims
// under the governing Activity Log byte policy. Manual reports retain a protected share. On byte
// pressure the oldest eligible candidate rolls out and releases its pin and claims. Unreported
// diagnostics expire after twenty-four hours; generated reports are transient download artifacts.

import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ACTIVITY_LOG_DIRECTORY_NAME,
  ACTIVITY_LOG_FAILURE_CLASS_COVERAGE,
  DEFECT_FINGERPRINT_ALGORITHM_VERSION,
  SUPPORT_INCIDENT_SCHEMA_VERSION,
  SUPPORT_INCIDENT_SLOT_COUNT,
  parseSupportIncidentSlotClaimFileName,
  UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT,
  activityLogEvent,
  activityLogOperationSchema,
  defineActivityLogOperation,
  normalizeDefectFrameSignature,
  recordActivityLogLoss,
  supportIncidentBuild,
  type DefectFingerprintInput,
  type SupportIncidentCorrelation,
  type SupportIncidentPin,
  type SupportIncidentRecord,
  type SupportIncidentDescriptorRecord,
  type SupportIncidentSegmentReference,
  type SupportIncidentTrigger,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  activityLogPinCovers,
  isActivityLogSegmentEntry,
  listActivityLogDirectory,
  readActivityLogPins,
  type ActivityLogPinRecord,
} from "./activity-log-store.js";
import type { ServerLogEnv } from "./log-level.js";
import { supportIncidentRetentionPolicy } from "./support-incident-retention.js";
import {
  claimActivityLogWriterOwnership,
  createFileServerLogSink,
  pinActivityLogWindow,
  releaseActivityLogPin,
  reportServerLogFailure,
  serverLogProcessIdentity,
  type ActivityLogPinResult,
  type ServerLogEvent,
} from "./server-log.js";
import {
  computeDefectFingerprint,
  incidentCorrelationId,
  registeredFailureCorrelation,
  registeredFailureFingerprintInput,
  registeredFailureDeduplicationKey,
} from "./defect-fingerprint.js";
import { activityLogTestWriterInstalled } from "./server-logger.js";
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
  type SupportIncidentClaim,
  type SupportIncidentClaimEntry,
  type SupportIncidentStoreEntry,
} from "./support-incident-store.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** An unreported candidate (and its pin) expires this long after creation. */
export const SUPPORT_INCIDENT_TTL_MS = DAY_MS;
/** The pinned window reaches this far before the incident … */
export const SUPPORT_INCIDENT_WINDOW_BEFORE_MS = 15 * MINUTE_MS;
/** … and this far after it, so segments sealed after the incident are retained too. */
export const SUPPORT_INCIDENT_WINDOW_AFTER_MS = 5 * MINUTE_MS;
/** Legacy compatibility value, superseded by the governing byte reservation policy. */
export const MAX_SUPPORT_INCIDENTS = SUPPORT_INCIDENT_SLOT_COUNT;
/** Legacy compatibility reserve, superseded by the governing byte reservation policy. */
export const MAX_REGISTERED_FAILURE_INCIDENTS = 24;

/** A process re-evaluates one defectFingerprint at most this often. */
export const SUPPORT_INCIDENT_SUPPRESSION_MS = MINUTE_MS;
/**
 * A store file younger than this may still be mid-publication by another process: a record or a
 * claim is exclusive-created before its bytes are written, and a claim exists before the record it
 * names. Only an older file has lost its writer (a crash in that gap), so only an older torn
 * record, or an older claim whose record is missing, is ever removed or taken over (#3533 review
 * 4050606506). A younger claim is honored as held.
 */
export const SUPPORT_INCIDENT_IN_FLIGHT_GRACE_MS = MINUTE_MS;

// The wall clock against the file's own mtime, never an injected `nowMs`: a file's age is a
// filesystem fact. A file from the future (the clock stepped back) stays in flight until the clock
// passes it.
function abandonedStoreFile(modifiedAtMs: number): boolean {
  return Date.now() - modifiedAtMs >= SUPPORT_INCIDENT_IN_FLIGHT_GRACE_MS;
}

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
  owner: "keiko-activity-log",
  emitter: "support-incident.createdEvidence",
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
  owner: "keiko-activity-log",
  emitter: "support-incident.deduplicatedEvidence",
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
  owner: "keiko-activity-log",
  emitter: "support-incident.rejectedEvidence",
  fields: {
    rejectionReason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "quota-exhausted",
        "store-unavailable",
        "record-too-large",
        "evaluation-rate-limited",
      ],
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
  owner: "keiko-activity-log",
  emitter: "support-incident.dismissedEvidence",
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
  owner: "keiko-activity-log",
  emitter: "support-incident.expiredEvidence",
  fields: {
    incidentId: INCIDENT_ID_FIELD,
    expiryReason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["expired", "invalid-record", "retention"],
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

// The candidate an occurrence folds into: its record's own facts, or, while another process is
// still publishing that record, the id its fingerprint claim names with this occurrence's own
// fingerprint and trigger, which are by construction the ones that claim is keyed on.
interface DeduplicationTarget {
  readonly incidentId: string;
  readonly defectFingerprint: string;
  readonly fingerprintAlgorithm: SupportIncidentRecord["fingerprint"]["algorithm"];
  readonly trigger: SupportIncidentTrigger;
}

function deduplicatedEvidence(
  stateDir: string,
  target: DeduplicationTarget,
  correlationId: string,
  openIncidentCount: number,
): void {
  writeEvidence(
    stateDir,
    activityLogEvent(
      SUPPORT_INCIDENT_DEDUPLICATED_OPERATION,
      { correlationId },
      {
        incidentId: target.incidentId,
        defectFingerprint: target.defectFingerprint,
        fingerprintAlgorithm: target.fingerprintAlgorithm,
        trigger: target.trigger,
        openIncidentCount,
      },
    ),
  );
}

export type SupportIncidentRejection =
  "quota-exhausted" | "store-unavailable" | "record-too-large" | "evaluation-rate-limited";

interface RejectionFacts {
  readonly reason: SupportIncidentRejection;
  readonly trigger: SupportIncidentTrigger;
  readonly defectFingerprint: string | undefined;
  readonly correlationId: string;
  readonly openIncidentCount: number;
  readonly fingerprintAlgorithm?: 1 | 2;
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
        fingerprintAlgorithm: facts.fingerprintAlgorithm ?? DEFECT_FINGERPRINT_ALGORITHM_VERSION,
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
  if (reason === "quota-exhausted" || reason === "evaluation-rate-limited") return "rate-limited";
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
  readonly reason?: "retention";
  readonly entry: SupportIncidentStoreEntry;
  readonly removed: boolean;
  readonly correlationId: string;
  readonly openIncidentCount: number;
}

// Automatic cleanup closes the record's own lifecycle, rather than the request that retires it.
function incidentLifecycleCorrelation(
  record: SupportIncidentRecord | undefined,
  fallback?: string,
): string {
  return (
    record?.correlation.childCorrelationIds[0] ??
    record?.correlation.rootCorrelationId ??
    fallback ??
    randomUUID()
  );
}

function expiredEvidence(stateDir: string, facts: ExpiryFacts): void {
  const record = facts.entry.record;
  writeEvidence(
    stateDir,
    activityLogEvent(
      SUPPORT_INCIDENT_EXPIRED_OPERATION,
      { correlationId: incidentLifecycleCorrelation(record, facts.correlationId) },
      {
        incidentId: facts.entry.incidentId,
        expiryReason: facts.reason ?? (record === undefined ? "invalid-record" : "expired"),
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

export { computeDefectFingerprint };

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
  readonly clientKind?: unknown;
  readonly renderFailure?: unknown;
  readonly moduleLoadFailure?: unknown;
  readonly stage?: unknown;
}

// ─── Candidate creation ────────────────────────────────────────────────────────────────────────

// Both non-rejected outcomes name their incident the same way, whether or not its record is readable.
export type SupportIncidentCreation =
  | {
      readonly status: "created";
      readonly incidentId: string;
      readonly record: SupportIncidentRecord;
    }
  | {
      readonly status: "deduplicated";
      readonly incidentId: string;
      // `undefined` while another process is still publishing the record this occurrence folds
      // into: its fingerprint claim is held and names it, but the record is not written yet.
      readonly record: SupportIncidentRecord | undefined;
    }
  | { readonly status: "rejected"; readonly reason: SupportIncidentRejection };

export interface SupportIncidentOptions {
  /** Inspect readable live candidates without expiry cleanup or writer ownership. */
  readonly readOnly?: boolean | undefined;
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

function buildDescriptor(
  draft: CandidateDraft,
  context: Pick<CandidateContext, "nowMs" | "defectFingerprint">,
  pin: SupportIncidentPin,
  incidentId: string,
): SupportIncidentDescriptorRecord {
  const identity = serverLogProcessIdentity();
  return {
    schemaVersion: SUPPORT_INCIDENT_SCHEMA_VERSION,
    incidentId,
    trigger: draft.trigger,
    state: "candidate",
    fingerprint: {
      algorithm: draft.input.algorithm ?? DEFECT_FINGERPRINT_ALGORITHM_VERSION,
      defectFingerprint: context.defectFingerprint,
      surface: draft.input.surface,
      op: draft.input.op,
      errorKind: draft.input.errorKind,
      frameCount: normalizeDefectFrameSignature(draft.input).length,
    },
    correlation: draft.correlation,
    build: supportIncidentBuild(identity.productVersion, identity.platformClass),
    window: incidentWindow(context.nowMs),
    pin,
    createdAtMs: context.nowMs,
    expiresAtMs: context.nowMs + SUPPORT_INCIDENT_TTL_MS,
  };
}

function buildRecord(
  draft: CandidateDraft,
  context: CandidateContext,
  pin: SupportIncidentPin,
  incidentId: string,
  slotIndex: number,
): SupportIncidentRecord {
  return { ...buildDescriptor(draft, context, pin, incidentId), slotIndex };
}

/** A manual export can describe retained evidence without claiming another durable candidate. */
export function prepareUnretainedUserReportIncident(
  _stateDir: string,
  correlationId: string,
): SupportIncidentDescriptorRecord {
  return prepareUnretainedUserReportDescriptor(correlationId);
}

/** Pure transient descriptor: no store, pin, retention or log access. */
export function prepareUnretainedUserReportDescriptor(
  correlationId: string,
): SupportIncidentDescriptorRecord {
  const safeCorrelationId = incidentCorrelationId(correlationId);
  if (safeCorrelationId === undefined) throw new TypeError("Invalid support report correlation");
  const input = UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT;
  return buildDescriptor(
    {
      trigger: "user-report",
      input,
      correlation: { rootCorrelationId: safeCorrelationId, childCorrelationIds: [] },
      evidenceCorrelationId: safeCorrelationId,
    },
    {
      nowMs: Date.now(),
      defectFingerprint: computeDefectFingerprint(input),
    },
    { status: "rejected", pinnedSegmentCount: 0, pinnedBytes: 0, evidenceLostBeforePin: false },
    randomBytes(16).toString("hex"),
  );
}

function slotCapacity(context: CandidateContext, draft: CandidateDraft): number {
  const policy = supportIncidentRetentionPolicy(context.stateDir, context.env);
  if (draft.trigger === "user-report") return policy.capacity;
  return draft.input.op === "client.diagnostic" ? policy.browserCapacity : policy.automaticCapacity;
}

function occupiedSlots(stateDir: string): ReadonlySet<number> {
  return new Set(
    listSupportIncidentClaims(stateDir).flatMap((claim) => {
      const index = parseSupportIncidentSlotClaimFileName(claim.fileName);
      return index === undefined ? [] : [index];
    }),
  );
}

function claimAvailableSlot(
  context: CandidateContext,
  draft: CandidateDraft,
  incidentId: string,
  capacity: number,
): number | undefined {
  const occupied = occupiedSlots(context.stateDir);
  for (let offset = 0; offset < capacity; offset += 1) {
    const index = draft.trigger === "user-report" ? capacity - 1 - offset : offset;
    if (!occupied.has(index) && claimSupportIncidentSlot(context.stateDir, index, incidentId)) {
      return index;
    }
  }
  return undefined;
}

function evictOldestCandidate(
  context: CandidateContext,
  draft: CandidateDraft,
  entries: readonly SupportIncidentStoreEntry[],
  capacity: number,
): string | undefined {
  const entry = entries.find(
    ({ record }) =>
      record !== undefined &&
      record.slotIndex < capacity &&
      (draft.trigger === "user-report" || record.trigger === "registered-failure"),
  );
  if (entry === undefined) return undefined;
  const removed = removeEntry(context.stateDir, entry, context);
  expiredEvidence(context.stateDir, {
    entry,
    removed,
    correlationId: draft.evidenceCorrelationId,
    openIncidentCount: entries.length - Number(removed),
    reason: "retention",
  });
  return removed ? entry.incidentId : undefined;
}

interface ClaimedQuotaSlot {
  readonly slotIndex: number;
  readonly evictedIncidentId?: string;
}

function claimQuotaSlot(
  context: CandidateContext,
  draft: CandidateDraft,
  incidentId: string,
  entries: readonly SupportIncidentStoreEntry[],
): ClaimedQuotaSlot | undefined {
  const capacity = slotCapacity(context, draft);
  const available = claimAvailableSlot(context, draft, incidentId, capacity);
  if (available !== undefined) return { slotIndex: available };
  const evictedIncidentId = evictOldestCandidate(context, draft, entries, capacity);
  if (evictedIncidentId === undefined) return undefined;
  const slotIndex = claimAvailableSlot(context, draft, incidentId, capacity);
  return slotIndex === undefined ? undefined : { slotIndex, evictedIncidentId };
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
    fingerprintAlgorithm: draft.input.algorithm ?? DEFECT_FINGERPRINT_ALGORITHM_VERSION,
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
interface IncidentPinContext {
  readonly stateDir: string;
  readonly nowMs: number;
  readonly correlationId: string;
  readonly env: ServerLogEnv;
}

function ownsDiagnosticPin(record: SupportIncidentRecord, pin: ActivityLogPinRecord): boolean {
  return (
    record.pin.pinId === pin.pinId &&
    pin.reason === "incident" &&
    pin.scope.kind === "window" &&
    pin.scope.fromMs === record.window.fromMs &&
    pin.scope.toMs === record.window.toMs
  );
}

function rollDiagnosticPin(context: IncidentPinContext): boolean {
  const directory = join(context.stateDir, ACTIVITY_LOG_DIRECTORY_NAME);
  const pins = readActivityLogPins(listActivityLogDirectory(directory), directory).flatMap(
    ({ record }) => (record === undefined ? [] : [record]),
  );
  const entries = listSupportIncidentEntries(context.stateDir);
  const oldest = entries.find(
    ({ record }) => record !== undefined && pins.some((pin) => ownsDiagnosticPin(record, pin)),
  );
  if (oldest === undefined) return false;
  const removed = removeEntry(context.stateDir, oldest, context);
  expiredEvidence(context.stateDir, {
    entry: oldest,
    removed,
    reason: "retention",
    correlationId: context.correlationId,
    openIncidentCount: entries.length - Number(removed),
  });
  return removed;
}

function requestIncidentPin(context: IncidentPinContext): ActivityLogPinResult {
  const window = incidentWindow(context.nowMs);
  const request = {
    scope: { kind: "window" as const, fromMs: window.fromMs, toMs: window.toMs },
    expiresAtMs: context.nowMs + SUPPORT_INCIDENT_TTL_MS,
    reason: "incident" as const,
    correlationId: context.correlationId,
  };
  const first = pinActivityLogWindow(context.stateDir, request, context.env);
  if (first.status !== "rejected" || first.reason !== "pin-limit-reached") return first;
  if (!rollDiagnosticPin(context)) return first;
  return pinActivityLogWindow(context.stateDir, request, context.env);
}

function pinIncidentWindow(
  stateDir: string,
  nowMs: number,
  correlationId: string,
  env: ServerLogEnv,
): SupportIncidentPin {
  const window = incidentWindow(nowMs);
  const before = overlappingSealedSegmentNames(stateDir, window, correlationId);
  try {
    const pin = pinFromResult(requestIncidentPin({ stateDir, nowMs, correlationId, env }));
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
  const retainedCount = listSupportIncidentEntries(context.stateDir).filter((entry) =>
    openEntry(entry, context.nowMs),
  ).length;
  createdEvidence(context.stateDir, record, draft.evidenceCorrelationId, retainedCount);
  return { status: "created", incidentId: record.incidentId, record };
}

type DedupOutcome =
  | { readonly status: "claimed" }
  | {
      readonly status: "duplicate";
      readonly incidentId: string;
      readonly record: SupportIncidentRecord | undefined;
    }
  | { readonly status: "unavailable" };

type HeldClaim =
  | {
      readonly kind: "duplicate";
      readonly incidentId: string;
      readonly record: SupportIncidentRecord | undefined;
    }
  | { readonly kind: "read-again" }
  | { readonly kind: "abandoned" };

// What a fingerprint claim another occurrence holds means for this one. Its record exists: a plain
// duplicate. Its record is missing but the claim is younger than the in-flight grace: the holder
// is still publishing, so this occurrence is its duplicate, or, when the holder has not written its
// id yet, the claim is read again. An older claim has lost its holder; removing it is the sweep's
// job, which ran just before, so one still here could not be removed.
function classifyHeldClaim(stateDir: string, holder: SupportIncidentClaim | undefined): HeldClaim {
  if (holder === undefined) return { kind: "read-again" }; // released since the claim attempt
  const { incidentId } = holder;
  const record =
    incidentId === undefined ? undefined : readSupportIncidentRecord(stateDir, incidentId);
  if (incidentId !== undefined && record !== undefined) {
    return { kind: "duplicate", incidentId, record };
  }
  if (abandonedStoreFile(holder.claimedAtMs)) return { kind: "abandoned" };
  return incidentId === undefined
    ? { kind: "read-again" }
    : { kind: "duplicate", incidentId, record: undefined };
}

/**
 * Atomically decides "is this fingerprint already open" (#3533 review 4050606506): exclusive-
 * create on the fingerprint's own claim file can succeed for only one caller, so two processes
 * racing the identical registered failure can never both believe they are first -- the exclusive
 * create on the incident record's own random-id file name alone never protected the fingerprint
 * itself, only the filename. The loser deduplicates onto the id the winner's claim names, even
 * while the winner is still writing its record. A claim torn mid-write is read once more. An
 * abandoned claim the sweep could not remove, or a claim still torn on the second read, makes this
 * occurrence give up as unavailable rather than risk a second, indistinguishable publish.
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
      const held = classifyHeldClaim(
        stateDir,
        readSupportIncidentFingerprintClaim(stateDir, defectFingerprint),
      );
      if (held.kind === "duplicate") {
        return { status: "duplicate", incidentId: held.incidentId, record: held.record };
      }
      if (held.kind === "abandoned") return { status: "unavailable" };
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

function deduplicationTarget(
  incidentId: string,
  record: SupportIncidentRecord | undefined,
  context: CandidateContext,
  draft: CandidateDraft,
): DeduplicationTarget {
  return record === undefined
    ? {
        incidentId,
        defectFingerprint: context.defectFingerprint,
        fingerprintAlgorithm: draft.input.algorithm ?? DEFECT_FINGERPRINT_ALGORITHM_VERSION,
        trigger: draft.trigger,
      }
    : {
        incidentId,
        defectFingerprint: record.fingerprint.defectFingerprint,
        fingerprintAlgorithm: record.fingerprint.algorithm,
        trigger: record.trigger,
      };
}

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
    deduplicatedEvidence(
      stateDir,
      deduplicationTarget(dedup.incidentId, dedup.record, context, draft),
      draft.evidenceCorrelationId,
      openIncidentCount,
    );
    return {
      done: true,
      result: { status: "deduplicated", incidentId: dedup.incidentId, record: dedup.record },
    };
  }
  return { done: false };
}

function draftDeduplicationKey(draft: CandidateDraft, fingerprint: string): string | undefined {
  return draft.trigger === "registered-failure"
    ? registeredFailureDeduplicationKey(
        draft.input.op,
        draft.input.algorithm ?? 1,
        fingerprint,
        draft.correlation,
      )
    : undefined;
}

function createCandidate(
  stateDir: string,
  draft: CandidateDraft,
  options: SupportIncidentOptions,
): SupportIncidentCreation {
  claimActivityLogWriterOwnership(stateDir, draft.evidenceCorrelationId);
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
  const dedupFingerprint = draftDeduplicationKey(draft, context.defectFingerprint);
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

  const quota = claimQuotaSlot(context, draft, incidentId, entries);
  if (quota === undefined) {
    if (dedupFingerprint !== undefined) {
      releaseSupportIncidentFingerprintClaim(stateDir, dedupFingerprint);
    }
    return reject(context, draft, "quota-exhausted", entries.length);
  }

  const retained = entries.filter((entry) => entry.incidentId !== quota.evictedIncidentId);
  const created = publishCandidate(draft, context, retained, incidentId, quota.slotIndex);
  if (created.status !== "created") releaseClaims(stateDir, dedupFingerprint, quota.slotIndex);
  return created;
}

function registeredFailureDraft(evidence: SupportIncidentFailureEvidence): CandidateDraft {
  const correlation = registeredFailureCorrelation(evidence);
  return {
    trigger: "registered-failure",
    input: registeredFailureFingerprintInput(evidence),
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
  const correlationId = incidentCorrelationId(options.correlationId) ?? randomUUID();
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

function candidateExpiry(record: SupportIncidentRecord): number {
  return Math.min(record.expiresAtMs, record.createdAtMs + SUPPORT_INCIDENT_TTL_MS);
}

function openEntry(entry: SupportIncidentStoreEntry, nowMs: number): boolean {
  return entry.record !== undefined && candidateExpiry(entry.record) > nowMs;
}

// An expired record, or an unreadable one whose writer is gone. An unreadable record younger than
// the in-flight grace may still be mid-write by another process: it is neither open nor removed.
function removableEntry(entry: SupportIncidentStoreEntry, nowMs: number): boolean {
  return entry.record === undefined
    ? abandonedStoreFile(entry.modifiedAtMs)
    : candidateExpiry(entry.record) <= nowMs;
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
    record.trigger === "registered-failure"
      ? registeredFailureDeduplicationKey(
          record.fingerprint.op,
          record.fingerprint.algorithm,
          record.fingerprint.defectFingerprint,
          record.correlation,
        )
      : undefined,
    record.slotIndex,
  );
}

function removeEntry(
  stateDir: string,
  entry: SupportIncidentStoreEntry,
  options: Pick<SupportIncidentOptions, "env" | "correlationId"> = {},
): boolean {
  try {
    removeSupportIncidentRecord(stateDir, entry.incidentId);
  } catch (error) {
    reportServerLogFailure(error, { op: SUPPORT_INCIDENT_EXPIRED_OPERATION.op });
    return false;
  }
  if (entry.record !== undefined) {
    releaseRecordClaims(stateDir, entry.record);
    releaseIncidentPin(stateDir, entry.record, {
      correlationId: incidentLifecycleCorrelation(entry.record, options.correlationId),
      env: options.env ?? process.env,
    });
  }
  return true;
}

// A claim whose referenced incidentId names no record right now is an orphan once it is older than
// the in-flight grace: a crash between claiming and writing that record, or a record already
// removed by the loop above in this same pass. A younger claim may belong to an occurrence still
// publishing its record in another process, so it is left alone (#3533 review 4050606506).
// Checks each claim against a FRESH read, never a pre-computed "open" set: entries/open is
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
    if (!abandonedStoreFile(claim.claimedAtMs)) continue;
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
 * Removes every expired record and every unreadable one whose writer is gone (predictable expiry
 * and torn-record recovery), emits one `support.incident.expired` line per removal, sweeps orphaned
 * dedup/quota claims, and returns the records that remain open. A file still inside the in-flight
 * grace is left to the process publishing it.
 */
function sweepExpiredEntries(
  stateDir: string,
  nowMs: number,
  correlationId: string,
): readonly SupportIncidentStoreEntry[] {
  claimActivityLogWriterOwnership(stateDir, correlationId);
  const entries = listSupportIncidentEntries(stateDir);
  const open = entries.filter((entry) => openEntry(entry, nowMs));
  for (const entry of entries) {
    if (!removableEntry(entry, nowMs)) continue;
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
  const nowMs = options.nowMs ?? Date.now();
  const entries =
    options.readOnly === true
      ? listSupportIncidentEntries(stateDir).filter((entry) => openEntry(entry, nowMs))
      : sweepExpiredEntries(stateDir, nowMs, correlationId);
  return entries.flatMap((entry) => (entry.record === undefined ? [] : [entry.record]));
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
  return record !== undefined && candidateExpiry(record) > (options.nowMs ?? Date.now())
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
  record: SupportIncidentDescriptorRecord,
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
function retireSupportIncident(
  stateDir: string,
  incidentId: string,
  options: SupportIncidentOptions,
  state: "candidate" | "reported",
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
  dismissedEvidence(
    stateDir,
    { ...record, state },
    {
      correlationId,
      openIncidentCount: open.length - 1,
      pinRelease,
    },
  );
  return "dismissed";
}

/** Explicit human dismissal of one retained candidate. */
export function dismissSupportIncident(
  stateDir: string,
  incidentId: string,
  options: SupportIncidentOptions = {},
): SupportIncidentDismissal {
  return retireSupportIncident(stateDir, incidentId, options, "candidate");
}

/** The canonical artifact is prepared and cached; this never claims transmission or a saved file. */
export function completePreparedSupportIncident(
  stateDir: string,
  incidentId: string,
  options: SupportIncidentOptions = {},
): SupportIncidentDismissal {
  try {
    return retireSupportIncident(stateDir, incidentId, options, "reported");
  } catch (error) {
    reportServerLogFailure(error, {
      op: SUPPORT_INCIDENT_DISMISSED_OPERATION.op,
      correlationId: options.correlationId,
    });
    return "failed";
  }
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
const MAX_BROWSER_INCIDENT_EVALUATIONS_PER_MINUTE = 2;
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
const recentBrowserEvaluations: number[] = [];
const pendingCandidates: PendingCandidate[] = [];
// The last time a rate-limited evaluation was evidenced (#3533 audit): throttled by the same
// SUPPORT_INCIDENT_SUPPRESSION_MS window as everything else here, so a storm that keeps hitting
// the per-minute cap reports it once per window instead of flooding the log with one line per
// dropped evaluation.
let lastRateLimitEvidenceAtMs: number | undefined;

/** Test seam: force the automatic trigger on or off; `undefined` restores the default. */
export function setSupportIncidentTriggerForTests(enabled: boolean | undefined): void {
  triggerOverride = enabled;
  recentFingerprints.clear();
  recentEvaluations.length = 0;
  recentBrowserEvaluations.length = 0;
  pendingCandidates.length = 0;
  lastRateLimitEvidenceAtMs = undefined;
}

function triggerEnabled(): boolean {
  return triggerOverride ?? !activityLogTestWriterInstalled();
}

type EvaluationAdmission = "admitted" | "suppressed" | "rate-limited";

// Bounds the cost a failure storm can add: one fingerprint is re-evaluated at most once per
// SUPPORT_INCIDENT_SUPPRESSION_MS ("suppressed"), and all fingerprints together at most
// MAX_SUPPORT_INCIDENT_EVALUATIONS_PER_MINUTE times ("rate-limited"). A suppressed recurrence
// loses no evidence -- the failure line itself is always persisted, and the first occurrence's
// pinned window and the Activity Log's own retention already cover it -- but a rate-limited
// evaluation can be a defect Keiko has never seen before, dropped purely because the shared cap was
// already spent; the caller evidences that case explicitly (#3533 audit).
function expireEvaluations(evaluations: number[], nowMs: number): void {
  while (evaluations.length > 0 && nowMs - (evaluations[0] ?? nowMs) >= MINUTE_MS) {
    evaluations.shift();
  }
}

function admitEvaluation(
  fingerprint: string,
  nowMs: number,
  browser: boolean,
): EvaluationAdmission {
  const last = recentFingerprints.get(fingerprint);
  if (last !== undefined && nowMs - last < SUPPORT_INCIDENT_SUPPRESSION_MS) return "suppressed";
  expireEvaluations(recentEvaluations, nowMs);
  expireEvaluations(recentBrowserEvaluations, nowMs);
  if (browser && recentBrowserEvaluations.length >= MAX_BROWSER_INCIDENT_EVALUATIONS_PER_MINUTE)
    return "rate-limited";
  if (recentEvaluations.length >= MAX_SUPPORT_INCIDENT_EVALUATIONS_PER_MINUTE)
    return "rate-limited";
  recentEvaluations.push(nowMs);
  if (browser) recentBrowserEvaluations.push(nowMs);
  if (recentFingerprints.size >= MAX_REMEMBERED_FINGERPRINTS) recentFingerprints.clear();
  recentFingerprints.set(fingerprint, nowMs);
  return "admitted";
}

function eventFrames(event: ServerLogEvent): readonly unknown[] | undefined {
  const frames = event.extra?.frames;
  return Array.isArray(frames) ? [...(frames as readonly unknown[])] : undefined;
}

type AdmissionOutcome =
  | { readonly status: "ineligible" }
  | { readonly status: "admitted"; readonly evidence: SupportIncidentFailureEvidence }
  | { readonly status: "suppressed" }
  | {
      readonly status: "rate-limited";
      readonly defectFingerprint: string;
      readonly fingerprintAlgorithm: 1 | 2;
    };

function admittedEvidence(event: ServerLogEvent): AdmissionOutcome {
  if (!supportIncidentEligibleOperation(event.op)) return { status: "ineligible" };
  const evidence: SupportIncidentFailureEvidence = {
    op: event.op,
    errorKind: event.errorKind,
    correlationId: event.correlationId,
    parentCorrelationId: event.parentCorrelationId,
    frames: eventFrames(event),
    clientKind: event.extra?.clientKind,
    renderFailure: event.extra?.renderFailure,
    moduleLoadFailure: event.extra?.moduleLoadFailure,
    stage: event.extra?.stage,
  };
  const input = registeredFailureFingerprintInput(evidence);
  const defectFingerprint = computeDefectFingerprint(input);
  const key = registeredFailureDeduplicationKey(
    input.op,
    input.algorithm ?? 1,
    defectFingerprint,
    registeredFailureCorrelation(evidence),
  );
  const admission = admitEvaluation(key, Date.now(), event.op === "client.diagnostic");
  if (admission === "admitted") return { status: "admitted", evidence };
  return admission === "rate-limited"
    ? { status: "rate-limited", defectFingerprint, fingerprintAlgorithm: input.algorithm ?? 1 }
    : { status: "suppressed" };
}

// At most one `support.incident.rejected` line per suppression window (see
// lastRateLimitEvidenceAtMs above), so a sustained storm costs one evidenced line per minute, not
// one per dropped evaluation. openIncidentCount is a plain listing, never the full expiry sweep:
// this path exists specifically to stay cheap under a storm.
function reportRateLimitedEvaluation(
  stateDir: string,
  defectFingerprint: string,
  correlationId: string | undefined,
  fingerprintAlgorithm: 1 | 2,
): void {
  const nowMs = Date.now();
  if (
    lastRateLimitEvidenceAtMs !== undefined &&
    nowMs - lastRateLimitEvidenceAtMs < SUPPORT_INCIDENT_SUPPRESSION_MS
  ) {
    return;
  }
  lastRateLimitEvidenceAtMs = nowMs;
  rejectedEvidence(stateDir, {
    reason: "evaluation-rate-limited",
    trigger: "registered-failure",
    defectFingerprint,
    fingerprintAlgorithm,
    correlationId: correlationId ?? randomUUID(),
    openIncidentCount: listSupportIncidentEntries(stateDir).length,
  });
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
    const admission = admittedEvidence(event);
    if (admission.status === "rate-limited") {
      reportRateLimitedEvaluation(
        stateDir,
        admission.defectFingerprint,
        event.correlationId,
        admission.fingerprintAlgorithm,
      );
      return;
    }
    if (admission.status !== "admitted") return;
    const nowMs = Date.now();
    const draft = registeredFailureDraft(admission.evidence);
    const pin = pinIncidentWindow(stateDir, nowMs, draft.evidenceCorrelationId, process.env);
    pendingCandidates.push({ stateDir, draft: { ...draft, prePinned: pin }, nowMs });
    scheduleDrain();
  } catch (error) {
    reportLostCandidate(error, event.correlationId);
  }
}
