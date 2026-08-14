export const DEBUG_LIFECYCLE_SCHEMA_VERSION = "1" as const;

export type DebugSessionState =
  | "reserved"
  | "starting"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed"
  | "revoked"
  | "terminationPending"
  | "restartThrottled";

export type DebugLifecycleEventKind =
  "start" | "active" | "stop" | "failure" | "session-revoked" | "teardown";

export type DebugLifecycleReason =
  | "requested"
  | "adapterExit"
  | "debuggeeExit"
  | "malformedFrame"
  | "frameOverflow"
  | "outputOverflow"
  | "wallTimeout"
  | "inactivityTimeout"
  | "activationRevoked"
  | "serverShutdown"
  | "startupFailed"
  | "restartThrottled"
  | "writeFailure"
  | "unexpectedEof"
  | "stopped";

export type DebugProcessErrorCode =
  | "MALFORMED_HEADER"
  | "PAYLOAD_TOO_LARGE"
  | "MALFORMED_MESSAGE"
  | "REQUEST_LIMIT"
  | "REQUEST_TIMEOUT"
  | "REQUEST_CANCELLED"
  | "CLIENT_DISPOSED"
  | "ADAPTER_REJECTED"
  | "REVERSE_REQUEST_DENIED"
  | "EXECUTABLE_NOT_FOUND"
  | "CAPACITY"
  | "EVIDENCE_PENDING"
  | "SESSION_NOT_FOUND"
  | "STARTUP_THROTTLED"
  | "SESSION_TERMINATING"
  | "TERMINATION_PENDING"
  | "WRITE_FAILED"
  | "UNEXPECTED_EOF"
  | "INVALID_CAPSULE_PLAN"
  | "PRIVATE_ENDPOINT_INVALID"
  | "PRIVATE_ENDPOINT_UNSUPPORTED";

export interface DebugLifecycleEvidence {
  readonly schemaVersion: typeof DEBUG_LIFECYCLE_SCHEMA_VERSION;
  readonly eventKind: DebugLifecycleEventKind;
  readonly sessionId: string;
  readonly state: DebugSessionState;
  readonly reason: DebugLifecycleReason;
  readonly targetKind: "catalog" | "file";
  readonly backend: "oci" | "linuxNamespace" | "windowsContainer";
  readonly network: "none";
  readonly filesystem: "executionRoot";
  readonly provisioningDigest: string;
  readonly timestampMs: number;
  readonly activationRevision: number;
  readonly outputAcceptedBytes: number;
  readonly outputTruncatedEvents: number;
}

export interface DebugLifecycleEvent extends DebugLifecycleEvidence {
  readonly sequence: number;
}

const DIGEST = /^[a-f0-9]{64}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_KINDS = new Set<DebugLifecycleEventKind>([
  "start",
  "active",
  "stop",
  "failure",
  "session-revoked",
  "teardown",
]);
const STATES = new Set<DebugSessionState>([
  "reserved",
  "starting",
  "running",
  "paused",
  "stopping",
  "stopped",
  "failed",
  "revoked",
  "terminationPending",
  "restartThrottled",
]);
const REASONS = new Set<DebugLifecycleReason>([
  "requested",
  "adapterExit",
  "debuggeeExit",
  "malformedFrame",
  "frameOverflow",
  "outputOverflow",
  "wallTimeout",
  "inactivityTimeout",
  "activationRevoked",
  "serverShutdown",
  "startupFailed",
  "restartThrottled",
  "writeFailure",
  "unexpectedEof",
  "stopped",
]);
const EVIDENCE_KEYS = new Set([
  "schemaVersion",
  "eventKind",
  "sessionId",
  "state",
  "reason",
  "targetKind",
  "backend",
  "network",
  "filesystem",
  "provisioningDigest",
  "timestampMs",
  "activationRevision",
  "outputAcceptedBytes",
  "outputTruncatedEvents",
]);

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

// A DebugLifecycleEvent is an evidence record PLUS `sequence`, so it needs its own key set: the
// evidence guard's exact-key scan rejects the extra field, which is why a statically valid
// DebugLifecycleEvent failed isDebugLifecycleEvidence at runtime.
const EVENT_KEYS = new Set([...EVIDENCE_KEYS, "sequence"]);

function hasExactKeysFrom(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const names = Object.getOwnPropertyNames(record);
  const enumerableNames = Object.keys(record);
  return (
    names.length === allowed.size &&
    enumerableNames.length === allowed.size &&
    Object.getOwnPropertySymbols(record).length === 0 &&
    names.every((key) => allowed.has(key)) &&
    enumerableNames.every((key) => allowed.has(key))
  );
}

function hasExactKeys(record: Record<string, unknown>): boolean {
  return hasExactKeysFrom(record, EVIDENCE_KEYS);
}

function hasClosedVocabulary(record: Record<string, unknown>): boolean {
  return (
    EVENT_KINDS.has(record.eventKind as DebugLifecycleEventKind) &&
    STATES.has(record.state as DebugSessionState) &&
    REASONS.has(record.reason as DebugLifecycleReason)
  );
}

function hasClosedIdentity(record: Record<string, unknown>): boolean {
  return (
    record.schemaVersion === DEBUG_LIFECYCLE_SCHEMA_VERSION &&
    typeof record.sessionId === "string" &&
    SESSION_ID.test(record.sessionId) &&
    typeof record.provisioningDigest === "string" &&
    DIGEST.test(record.provisioningDigest)
  );
}

function hasClosedAttestation(record: Record<string, unknown>): boolean {
  const backend = record.backend;
  return (
    (record.targetKind === "catalog" || record.targetKind === "file") &&
    (backend === "oci" || backend === "linuxNamespace" || backend === "windowsContainer") &&
    record.network === "none" &&
    record.filesystem === "executionRoot"
  );
}

function hasValidCounters(record: Record<string, unknown>): boolean {
  return (
    isNonnegativeInteger(record.timestampMs) &&
    isNonnegativeInteger(record.activationRevision) &&
    isNonnegativeInteger(record.outputAcceptedBytes) &&
    isNonnegativeInteger(record.outputTruncatedEvents)
  );
}

export function isDebugLifecycleEvidence(value: unknown): value is DebugLifecycleEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    hasExactKeys(record) &&
    hasClosedIdentity(record) &&
    hasClosedVocabulary(record) &&
    hasClosedAttestation(record) &&
    hasValidCounters(record)
  );
}

/**
 * Runtime guard for a DebugLifecycleEvent: every DebugLifecycleEvidence field plus `sequence`.
 *
 * `sequence` is 1-based and strictly positive — it is the ordinal of the event within a session, so
 * 0, a negative value and a fractional value are all malformed rather than merely unusual.
 *
 * This guard exists because the type is statically a DebugLifecycleEvidence, but the evidence guard
 * scans for an EXACT key set and therefore rejects the extra `sequence` field — so every consumer
 * had to hand-roll its own check, and the one in keiko-server did not bound the sequence at all.
 */
export function isDebugLifecycleEvent(value: unknown): value is DebugLifecycleEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    hasExactKeysFrom(record, EVENT_KEYS) &&
    hasClosedIdentity(record) &&
    hasClosedVocabulary(record) &&
    hasClosedAttestation(record) &&
    hasValidCounters(record) &&
    Number.isSafeInteger(record.sequence) &&
    (record.sequence as number) >= 1
  );
}
