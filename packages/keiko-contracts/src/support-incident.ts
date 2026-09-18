// The canonical, body-free SupportIncident contract (#3533).
//
// A SupportIncident is a local control and selection artifact over the one logical Activity Log —
// never a second log and never a copy of event bodies. It exists so every later manual exit (the
// public User Finding, the saved private report, local analysis, replay, and fix linkage) derives
// from ONE versioned descriptor instead of re-collecting evidence on its own.
//
// Two layers live here, both pure (no filesystem, no hashing, no clock):
//
//   * `SupportIncidentRecord` — the small persisted candidate the keiko-server incident store
//     writes under `<stateDir>/support-incidents/`. It holds only closed enums, opaque ids, counts,
//     digests, safe version/platform classes, correlation references, and the pinned time window.
//   * `SupportIncident` — the resolved descriptor: the record plus the evidence facts read from the
//     pinned window (segment references, integrity/completeness/loss, diagnostic sufficiency). The
//     public and private projections are derived from it and nothing else.
//
// TWO IDENTIFIERS, ON PURPOSE
//
// `incidentId` is random and opaque (128 bits, minted by the store). It names one occurrence and
// links one public finding to one private report; it carries no time, process, host, user, or
// path information. `defectFingerprint` is deterministic: a SHA-256 over the canonical preimage
// built by `defectFingerprintPreimage` from four allowlisted, release-stable inputs — the owning
// product surface, the registered operation, the closed errorKind, and the normalized Keiko frame
// signature (module identities only; no line, column, build, time, process, instance, host, user,
// or absolute path). Equal inputs yield equal fingerprints across builds and releases within one
// algorithm version, so the same defect groups together for deduplication, regression, and fix
// linkage.
//
// COLLISIONS. The fingerprint is a grouping key, not a proof of identity. Two different defects
// that fail in the same operation, with the same errorKind, through the same Keiko modules share a
// fingerprint by design (they are indistinguishable from body-free evidence); SHA-256 makes an
// accidental collision between different preimages negligible. Consumers must treat a shared
// fingerprint as "probably the same defect" and keep `incidentId` as the only per-occurrence key.
//
// ALGORITHM EVOLUTION. `DEFECT_FINGERPRINT_ALGORITHM_VERSION` is part of the preimage and travels
// next to every fingerprint. Any change to the inputs, their normalization, or the encoding is an
// incompatible change: it bumps the version, and fingerprints of different versions are never
// compared or merged. A reader that meets an unknown version rejects the record (fail closed)
// instead of guessing. Adding a new closed surface, operation, or errorKind value is NOT an
// algorithm change: it only extends the input domain.

import { ACTIVITY_LOG_PIN_ID_PATTERN } from "./activity-log-files.js";
import {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_FAILURE_SURFACES,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_SCHEMA_DIGEST,
} from "./activity-log-registry.generated.js";
// Only hoisted function declarations are imported as values from observability.ts: that module
// re-exports this one, so a `const` binding read here could still be uninitialized.
import {
  isActivityLogCorrelationId,
  isActivityLogErrorKind,
  isActivityLogIdentityDigest,
  isActivityLogPlatformClass,
  isActivityLogProductVersion,
  type ActivityLogCompletenessState,
  type ActivityLogErrorKind,
  type ActivityLogFailureSurface,
  type ActivityLogLossState,
  type DiagnosticSufficiencyReason,
  type DiagnosticSufficiencyStatus,
} from "./observability.js";

export const SUPPORT_INCIDENT_SCHEMA_VERSION = 1;
export const DEFECT_FINGERPRINT_ALGORITHM_VERSION = 1;

/** The store directory under the state directory; one closed-grammar file per incident. */
export const SUPPORT_INCIDENT_DIRECTORY_NAME = "support-incidents";

/** Which trigger created the candidate: a registered failure operation, or Report a problem. */
export const SUPPORT_INCIDENT_TRIGGERS = ["registered-failure", "user-report"] as const;
export type SupportIncidentTrigger = (typeof SUPPORT_INCIDENT_TRIGGERS)[number];

/**
 * The human-controlled lifecycle. A candidate is what Keiko recorded; acknowledging or reporting
 * it is always an explicit user action. Dismissal and expiry remove the record (and let its pin
 * lapse), so they are transitions, not stored states.
 */
export const SUPPORT_INCIDENT_STATES = ["candidate", "acknowledged", "reported"] as const;
export type SupportIncidentState = (typeof SUPPORT_INCIDENT_STATES)[number];

/** The fingerprint surface for an incident with no registered failure event to attribute. */
export const SUPPORT_INCIDENT_UNATTRIBUTED = "unattributed";
export type SupportIncidentSurface =
  ActivityLogFailureSurface | typeof SUPPORT_INCIDENT_UNATTRIBUTED;

export const SUPPORT_INCIDENT_PIN_STATUSES = ["pinned", "quota-exceeded", "rejected"] as const;
export type SupportIncidentPinStatus = (typeof SUPPORT_INCIDENT_PIN_STATUSES)[number];

/** 128 random bits as 32 lowercase hex characters. */
export const SUPPORT_INCIDENT_ID_PATTERN = /^[a-f0-9]{32}$/u;
/** A SHA-256 as 64 lowercase hex characters. */
export const DEFECT_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

/** At most this many normalized Keiko frames enter the fingerprint (innermost first). */
export const MAX_DEFECT_FINGERPRINT_FRAMES = 8;
/** At most this many child correlations are referenced by one incident. */
export const MAX_SUPPORT_INCIDENT_CHILD_CORRELATIONS = 8;
/** A persisted record never exceeds this many bytes; larger input is rejected, not truncated. */
export const MAX_SUPPORT_INCIDENT_RECORD_BYTES = 4096;

const INCIDENT_FILE_PATTERN = /^incident-([a-f0-9]{32})\.json$/u;
const FINGERPRINT_CLAIM_FILE_PATTERN = /^fingerprint-([a-f0-9]{64})\.claim$/u;
const SLOT_CLAIM_FILE_PATTERN = /^slot-(\d{2})\.claim$/u;
const OPERATION_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/u;
const MAX_OPERATION_LENGTH = 96;

/**
 * The bounded pool of quota-slot claim files (#3533 review 4050606506): `slot-00.claim` through
 * `slot-<N-1>.claim`. Every candidate -- automatic or user-initiated -- atomically claims exactly
 * one slot (exclusive-create, content the owning incidentId) before its record is written, so the
 * store's total-count quota (`MAX_SUPPORT_INCIDENTS` in keiko-server) holds across processes with
 * no read-then-write race. keiko-server imports this constant rather than repeating the number, so
 * the two can never drift apart.
 */
export const SUPPORT_INCIDENT_SLOT_COUNT = 32;

export function supportIncidentFileName(incidentId: string): string {
  if (!SUPPORT_INCIDENT_ID_PATTERN.test(incidentId)) {
    throw new RangeError("invalid SupportIncident id");
  }
  return `incident-${incidentId}.json`;
}

export function supportIncidentSlotClaimFileName(slotIndex: number): string {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= SUPPORT_INCIDENT_SLOT_COUNT) {
    throw new RangeError("invalid SupportIncident quota slot index");
  }
  return `slot-${String(slotIndex).padStart(2, "0")}.claim`;
}

/** The slot index a closed-grammar slot-claim file name carries, else `undefined`. */
export function parseSupportIncidentSlotClaimFileName(name: string): number | undefined {
  const match = SLOT_CLAIM_FILE_PATTERN.exec(name);
  if (match === null) return undefined;
  const slotIndex = Number(match[1]);
  return slotIndex < SUPPORT_INCIDENT_SLOT_COUNT ? slotIndex : undefined;
}

/**
 * A defectFingerprint's dedup claim file: `fingerprint-<64 hex>.claim`. Exclusive-create with the
 * owning incidentId as its whole content makes "at most one open registered-failure candidate per
 * defectFingerprint" hold atomically across processes (#3533 review 4050606506) -- the exclusive
 * create on the random incident-id file alone only ever protected the filename, never the
 * fingerprint two processes could compute identically from the same failure.
 */
export function supportIncidentFingerprintClaimFileName(defectFingerprint: string): string {
  if (!isDefectFingerprint(defectFingerprint)) {
    throw new RangeError("invalid defectFingerprint");
  }
  return `fingerprint-${defectFingerprint}.claim`;
}

/** The fingerprint a closed-grammar fingerprint-claim file name carries, else `undefined`. */
export function parseSupportIncidentFingerprintClaimFileName(name: string): string | undefined {
  return FINGERPRINT_CLAIM_FILE_PATTERN.exec(name)?.[1];
}

/**
 * A closed-grammar identifier this store file name carries: the incident id for an
 * `incident-<id>.json` record, the defectFingerprint for a `fingerprint-<fp>.claim` dedup claim, or
 * the slot index (as a decimal string) for a `slot-<NN>.claim` quota claim -- `undefined` for
 * anything outside the grammar. This is the one function the repair/uninstall ownership predicate
 * calls (`state-paths.ts`), so every file kind this store ever creates must stay recognized here;
 * a caller that needs a real incident id specifically must also confirm it with
 * `isSupportIncidentId`, since a fingerprint or a slot index is never one.
 */
export function parseSupportIncidentFileName(name: string): string | undefined {
  const incidentId = INCIDENT_FILE_PATTERN.exec(name)?.[1];
  if (incidentId !== undefined) return incidentId;
  const fingerprint = FINGERPRINT_CLAIM_FILE_PATTERN.exec(name)?.[1];
  if (fingerprint !== undefined) return fingerprint;
  const slotIndex = parseSupportIncidentSlotClaimFileName(name);
  return slotIndex === undefined ? undefined : String(slotIndex);
}

export function isSupportIncidentId(value: unknown): value is string {
  return typeof value === "string" && SUPPORT_INCIDENT_ID_PATTERN.test(value);
}

export function isDefectFingerprint(value: unknown): value is string {
  return typeof value === "string" && DEFECT_FINGERPRINT_PATTERN.test(value);
}

export function isSupportIncidentSurface(value: unknown): value is SupportIncidentSurface {
  return (
    value === SUPPORT_INCIDENT_UNATTRIBUTED ||
    (ACTIVITY_LOG_FAILURE_SURFACES as readonly unknown[]).includes(value)
  );
}

// ─── Fingerprint inputs ─────────────────────────────────────────────────────────────────────────

export interface DefectFingerprintInput {
  readonly surface: SupportIncidentSurface;
  // A registered operation name, or SUPPORT_INCIDENT_UNATTRIBUTED for a user report.
  readonly op: string;
  readonly errorKind: ActivityLogErrorKind;
  // Dist- or source-anchored Keiko frames as the Activity Log's `frames` field carries them.
  readonly frames: readonly string[];
}

// `packages/<pkg>/(dist|src)/<module>.(js|ts):<line>:<col>` or `(dist|src)/cli/<module>...`: the
// shape the Activity Log's frame reducer emits. Anything else is not a Keiko frame and is dropped.
const KEIKO_FRAME_PATTERN =
  /^(?:packages\/(keiko-[a-z0-9-]+)\/(?:dist|src)|(?:dist|src)\/(cli))\/([A-Za-z0-9_./-]{1,160})\.(?:js|ts):\d{1,6}:\d{1,6}$/u;
const TRAVERSAL_PATTERN = /(?:^|\/)\.\.(?:$|\/)/u;

/**
 * Reduces one frame to its stable module identity: `<package>/<module path without extension>`.
 * Line and column, the dist/src distinction, and the file extension are dropped so a rebuild, a
 * release, and a source checkout all yield the same identity. Returns `undefined` for anything
 * that is not a Keiko frame (never a partially redacted remainder).
 */
export function normalizeKeikoFrame(frame: string): string | undefined {
  const match = KEIKO_FRAME_PATTERN.exec(frame);
  if (match === null) return undefined;
  const [, workspacePackage, cli, modulePath = ""] = match;
  if (TRAVERSAL_PATTERN.test(modulePath) || modulePath.startsWith("/")) return undefined;
  return `${workspacePackage ?? cli ?? ""}/${modulePath}`;
}

/** The normalized, bounded frame signature: Keiko frames only, consecutive repeats collapsed. */
export function normalizeKeikoFrameSignature(frames: readonly unknown[]): readonly string[] {
  const signature: string[] = [];
  for (const frame of frames) {
    if (signature.length >= MAX_DEFECT_FINGERPRINT_FRAMES) break;
    const normalized = typeof frame === "string" ? normalizeKeikoFrame(frame) : undefined;
    if (normalized !== undefined && signature.at(-1) !== normalized) signature.push(normalized);
  }
  return signature;
}

function validOperation(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === SUPPORT_INCIDENT_UNATTRIBUTED ||
      (value.length <= MAX_OPERATION_LENGTH && OPERATION_PATTERN.test(value)))
  );
}

/**
 * The canonical fingerprint preimage. A JSON array of strings and one integer is an unambiguous
 * framing (no separator can be forged by an input), and every input is closed or normalized
 * first, so only allowlisted stable values ever reach the hash. Throws for an input outside the
 * closed domain instead of fingerprinting it.
 */
export function defectFingerprintPreimage(input: DefectFingerprintInput): string {
  if (!isSupportIncidentSurface(input.surface)) throw new RangeError("invalid surface");
  if (!validOperation(input.op)) throw new RangeError("invalid operation");
  if (!isActivityLogErrorKind(input.errorKind)) throw new RangeError("invalid errorKind");
  return JSON.stringify([
    "keiko-defect-fingerprint",
    DEFECT_FINGERPRINT_ALGORITHM_VERSION,
    input.surface,
    input.op,
    input.errorKind,
    ...normalizeKeikoFrameSignature(input.frames),
  ]);
}

/** The fixed fingerprint inputs of an incident without a registered failure to attribute. */
export const UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT: DefectFingerprintInput = {
  surface: SUPPORT_INCIDENT_UNATTRIBUTED,
  op: SUPPORT_INCIDENT_UNATTRIBUTED,
  errorKind: "unknown",
  frames: [],
};

// ─── The persisted record ───────────────────────────────────────────────────────────────────────

export interface SupportIncidentFingerprint {
  readonly algorithm: typeof DEFECT_FINGERPRINT_ALGORITHM_VERSION;
  readonly defectFingerprint: string;
  readonly surface: SupportIncidentSurface;
  readonly op: string;
  readonly errorKind: ActivityLogErrorKind;
  // Normalized Keiko frames that entered the fingerprint; the frames themselves are never stored.
  readonly frameCount: number;
}

export interface SupportIncidentCorrelation {
  // The operation the failure belongs to: its parentCorrelationId when spawned, else its own id.
  readonly rootCorrelationId?: string | undefined;
  // Spawned operations under the root that the triggering event named (bounded).
  readonly childCorrelationIds: readonly string[];
}

export interface SupportIncidentBuild {
  readonly productVersion: string;
  readonly platformClass: string;
  readonly registryVersion: number;
  readonly schemaDigest: string;
  readonly catalogDigest: string;
}

/** The bounded time window pinned around the incident, in epoch milliseconds. */
export interface SupportIncidentWindow {
  readonly fromMs: number;
  readonly incidentAtMs: number;
  readonly toMs: number;
}

export interface SupportIncidentPin {
  readonly status: SupportIncidentPinStatus;
  // The Activity Log retention pin; absent only when the pin request was rejected.
  readonly pinId?: string | undefined;
  readonly pinnedSegmentCount: number;
  readonly pinnedBytes: number;
  // True when a sealed segment inside the window, visible just before the pin was published, was
  // already gone by the time the pin actually covered it: a maintenance pass -- this process's own
  // next segment admission, or another process sharing the state directory -- raced the narrow gap
  // between observing the window and publishing its pin. The window is then never reported as a
  // clean `pinned` even when `status` is `"pinned"`.
  readonly evidenceLostBeforePin: boolean;
}

export interface SupportIncidentRecord {
  readonly schemaVersion: typeof SUPPORT_INCIDENT_SCHEMA_VERSION;
  readonly incidentId: string;
  readonly trigger: SupportIncidentTrigger;
  readonly state: SupportIncidentState;
  readonly fingerprint: SupportIncidentFingerprint;
  readonly correlation: SupportIncidentCorrelation;
  readonly build: SupportIncidentBuild;
  readonly window: SupportIncidentWindow;
  readonly pin: SupportIncidentPin;
  // The quota-slot claim (#3533 review 4050606506) this record's existence depends on; dismissal
  // and expiry release `slot-<NN>.claim` through it so the slot returns to the free pool.
  readonly slotIndex: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

/** The build identity of the running product, from the generated registry and safe classes. */
export function supportIncidentBuild(
  productVersion: string,
  platformClass: string,
): SupportIncidentBuild {
  return {
    productVersion,
    platformClass,
    registryVersion: ACTIVITY_LOG_REGISTRY_VERSION,
    schemaDigest: ACTIVITY_LOG_SCHEMA_DIGEST,
    catalogDigest: ACTIVITY_LOG_CATALOG_DIGEST,
  };
}

// ─── Closed-schema parsing (fail closed: anything unexpected is not a record) ───────────────────

type PlainObject = Readonly<Record<string, unknown>>;

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasOnlyKeys(
  value: PlainObject,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const own = Object.keys(value);
  return (
    required.every((key) => own.includes(key)) &&
    own.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

function validFingerprint(value: unknown): value is SupportIncidentFingerprint {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, [
      "algorithm",
      "defectFingerprint",
      "surface",
      "op",
      "errorKind",
      "frameCount",
    ]) &&
    value.algorithm === DEFECT_FINGERPRINT_ALGORITHM_VERSION &&
    isDefectFingerprint(value.defectFingerprint) &&
    isSupportIncidentSurface(value.surface) &&
    validOperation(value.op) &&
    isActivityLogErrorKind(value.errorKind) &&
    isCount(value.frameCount) &&
    value.frameCount <= MAX_DEFECT_FINGERPRINT_FRAMES
  );
}

function validCorrelation(value: unknown): value is SupportIncidentCorrelation {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["childCorrelationIds"], ["rootCorrelationId"])
  ) {
    return false;
  }
  const children = value.childCorrelationIds;
  return (
    (value.rootCorrelationId === undefined ||
      isActivityLogCorrelationId(value.rootCorrelationId)) &&
    Array.isArray(children) &&
    children.length <= MAX_SUPPORT_INCIDENT_CHILD_CORRELATIONS &&
    children.every(isActivityLogCorrelationId)
  );
}

function validBuild(value: unknown): value is SupportIncidentBuild {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, [
      "productVersion",
      "platformClass",
      "registryVersion",
      "schemaDigest",
      "catalogDigest",
    ]) &&
    isActivityLogProductVersion(value.productVersion) &&
    isActivityLogPlatformClass(value.platformClass) &&
    isCount(value.registryVersion) &&
    isActivityLogIdentityDigest(value.schemaDigest) &&
    isActivityLogIdentityDigest(value.catalogDigest)
  );
}

function validWindow(value: unknown): value is SupportIncidentWindow {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, ["fromMs", "incidentAtMs", "toMs"]) &&
    isCount(value.fromMs) &&
    isCount(value.incidentAtMs) &&
    isCount(value.toMs) &&
    value.fromMs <= value.incidentAtMs &&
    value.incidentAtMs <= value.toMs
  );
}

function validPin(value: unknown): value is SupportIncidentPin {
  if (!isPlainObject(value)) return false;
  if (
    !hasOnlyKeys(
      value,
      ["status", "pinnedSegmentCount", "pinnedBytes", "evidenceLostBeforePin"],
      ["pinId"],
    )
  ) {
    return false;
  }
  const pinned = value.status !== "rejected";
  return (
    isOneOf(SUPPORT_INCIDENT_PIN_STATUSES, value.status) &&
    (pinned
      ? typeof value.pinId === "string" && ACTIVITY_LOG_PIN_ID_PATTERN.test(value.pinId)
      : value.pinId === undefined) &&
    isCount(value.pinnedSegmentCount) &&
    isCount(value.pinnedBytes) &&
    typeof value.evidenceLostBeforePin === "boolean"
  );
}

const RECORD_KEYS = [
  "schemaVersion",
  "incidentId",
  "trigger",
  "state",
  "fingerprint",
  "correlation",
  "build",
  "window",
  "pin",
  "slotIndex",
  "createdAtMs",
  "expiresAtMs",
] as const;

function validRecordHeader(value: PlainObject): boolean {
  return (
    hasOnlyKeys(value, RECORD_KEYS) &&
    value.schemaVersion === SUPPORT_INCIDENT_SCHEMA_VERSION &&
    isSupportIncidentId(value.incidentId) &&
    isOneOf(SUPPORT_INCIDENT_TRIGGERS, value.trigger) &&
    isOneOf(SUPPORT_INCIDENT_STATES, value.state) &&
    isCount(value.slotIndex) &&
    value.slotIndex < SUPPORT_INCIDENT_SLOT_COUNT &&
    isCount(value.createdAtMs) &&
    isCount(value.expiresAtMs) &&
    value.expiresAtMs > value.createdAtMs
  );
}

/**
 * Parses one persisted record against the closed schema. Unknown keys, unknown versions, unknown
 * vocabulary values, and out-of-bound values all yield `undefined`: an unreadable record protects
 * and describes nothing, exactly like an unreadable Activity Log pin record.
 */
export function parseSupportIncidentRecord(value: unknown): SupportIncidentRecord | undefined {
  if (!isPlainObject(value) || !validRecordHeader(value)) return undefined;
  return validFingerprint(value.fingerprint) &&
    validCorrelation(value.correlation) &&
    validBuild(value.build) &&
    validWindow(value.window) &&
    validPin(value.pin)
    ? (value as unknown as SupportIncidentRecord)
    : undefined;
}

// ─── The resolved descriptor and its two projections ───────────────────────────────────────────

/** Integrity of the pinned window as the analyzer classified it (ADR-0173 compatibility). */
export const SUPPORT_INCIDENT_EVIDENCE_INTEGRITY = [
  "supported",
  "legacy",
  "unsupported",
  "corrupt",
  "truncated",
  "incomplete",
] as const;
export type SupportIncidentEvidenceIntegrity = (typeof SUPPORT_INCIDENT_EVIDENCE_INTEGRITY)[number];

/** One Activity Log segment the incident window references (a reference, never its content). */
export interface SupportIncidentSegmentReference {
  readonly segmentId: string;
  readonly state: "active" | "sealed";
  readonly sizeBytes: number;
}

export interface SupportIncidentEvidence {
  readonly segments: readonly SupportIncidentSegmentReference[];
  readonly lineCount: number;
  readonly integrity: SupportIncidentEvidenceIntegrity;
  readonly completeness: ActivityLogCompletenessState;
  readonly loss: ActivityLogLossState;
}

export interface SupportIncidentCoverage {
  // Registered failure classes the incident requires evidence for, and how many were observed.
  readonly requiredClassCount: number;
  readonly presentClassCount: number;
  readonly completeClassCount: number;
  readonly degradedClassCount: number;
  readonly insufficientClassCount: number;
}

export interface SupportIncidentSufficiency {
  readonly status: DiagnosticSufficiencyStatus;
  readonly reasons: readonly DiagnosticSufficiencyReason[];
  readonly coverage: SupportIncidentCoverage;
}

/** The canonical resolved descriptor every manual exit derives from. */
export interface SupportIncident extends SupportIncidentRecord {
  readonly evidence: SupportIncidentEvidence;
  readonly sufficiency: SupportIncidentSufficiency;
}

/**
 * The strict public-finding projection: only closed, publicly shareable values. It links to the
 * private report by `incidentId` and groups by `defectFingerprint`; correlation ids, segment
 * references, the time window, pins, and closed reasons stay private.
 */
export interface SupportIncidentPublicProjection {
  readonly schemaVersion: typeof SUPPORT_INCIDENT_SCHEMA_VERSION;
  readonly incidentId: string;
  readonly defectFingerprint: string;
  readonly fingerprintAlgorithm: typeof DEFECT_FINGERPRINT_ALGORITHM_VERSION;
  readonly trigger: SupportIncidentTrigger;
  readonly productVersion: string;
  readonly platformClass: string;
  readonly surface: SupportIncidentSurface;
  readonly op: string;
  readonly errorKind: ActivityLogErrorKind;
  readonly sufficiencyStatus: DiagnosticSufficiencyStatus;
  readonly integrity: SupportIncidentEvidenceIntegrity;
  readonly completeness: ActivityLogCompletenessState;
  readonly loss: ActivityLogLossState;
}

/** The richer, still body-free private-report projection: the public fields plus analysis inputs. */
export interface SupportIncidentPrivateProjection extends SupportIncidentPublicProjection {
  readonly state: SupportIncidentState;
  readonly frameCount: number;
  readonly build: SupportIncidentBuild;
  readonly correlation: SupportIncidentCorrelation;
  readonly window: SupportIncidentWindow;
  readonly pin: SupportIncidentPin;
  readonly segments: readonly SupportIncidentSegmentReference[];
  readonly lineCount: number;
  readonly sufficiencyReasons: readonly DiagnosticSufficiencyReason[];
  readonly coverage: SupportIncidentCoverage;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export function supportIncidentPublicProjection(
  incident: SupportIncident,
): SupportIncidentPublicProjection {
  return {
    schemaVersion: incident.schemaVersion,
    incidentId: incident.incidentId,
    defectFingerprint: incident.fingerprint.defectFingerprint,
    fingerprintAlgorithm: incident.fingerprint.algorithm,
    trigger: incident.trigger,
    productVersion: incident.build.productVersion,
    platformClass: incident.build.platformClass,
    surface: incident.fingerprint.surface,
    op: incident.fingerprint.op,
    errorKind: incident.fingerprint.errorKind,
    sufficiencyStatus: incident.sufficiency.status,
    integrity: incident.evidence.integrity,
    completeness: incident.evidence.completeness,
    loss: incident.evidence.loss,
  };
}

export function supportIncidentPrivateProjection(
  incident: SupportIncident,
): SupportIncidentPrivateProjection {
  return {
    ...supportIncidentPublicProjection(incident),
    state: incident.state,
    frameCount: incident.fingerprint.frameCount,
    build: { ...incident.build },
    correlation: {
      ...(incident.correlation.rootCorrelationId === undefined
        ? {}
        : { rootCorrelationId: incident.correlation.rootCorrelationId }),
      childCorrelationIds: [...incident.correlation.childCorrelationIds],
    },
    window: { ...incident.window },
    pin: { ...incident.pin },
    segments: incident.evidence.segments.map((segment) => ({ ...segment })),
    lineCount: incident.evidence.lineCount,
    sufficiencyReasons: [...incident.sufficiency.reasons],
    coverage: { ...incident.sufficiency.coverage },
    createdAtMs: incident.createdAtMs,
    expiresAtMs: incident.expiresAtMs,
  };
}
