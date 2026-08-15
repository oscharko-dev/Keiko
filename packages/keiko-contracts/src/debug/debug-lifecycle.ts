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

// ─── Closed-vocabulary derivation (KEIKO-0377) ──────────────────────────────────
//
// Each `Record<Union, true>` table below is the SINGLE source of truth for its vocabulary: TS
// checks it against the union type in BOTH directions (a union member with no table entry, or a
// table entry not in the union, is a compile error), which a `Set<Union>([...])` literal only did
// in one direction (an extra Set entry failed to compile; a union member missing FROM the Set did
// not, and was instead silently rejected at runtime by hasClosedVocabulary/hasExactKeys — the
// dangerous direction, since it drops evidence rather than refusing to build). The exported
// `DEBUG_*` arrays and `EVIDENCE_KEYS` are what every consumer — including the co-located test
// suite's member-list cases — must derive from; a hand-typed second copy anywhere is the same
// defect this table replaces. Mirrors the `Record<Union, true>` table idiom already used in this
// package (gateway.ts's `PROVIDER_ENDPOINT_STYLE_TABLE`/`REALTIME_AUTH_MODE_TABLE`, each paired
// with an `Object.keys(...)`-derived exported array) and the exported `Readonly<Record<Union, …>>`
// table idiom in editor-agent-governance.ts.

const STATES: Record<DebugSessionState, true> = {
  reserved: true,
  starting: true,
  running: true,
  paused: true,
  stopping: true,
  stopped: true,
  failed: true,
  revoked: true,
  terminationPending: true,
  restartThrottled: true,
};
export const DEBUG_SESSION_STATES = Object.keys(STATES) as readonly DebugSessionState[];

const EVENT_KINDS: Record<DebugLifecycleEventKind, true> = {
  start: true,
  active: true,
  stop: true,
  failure: true,
  "session-revoked": true,
  teardown: true,
};
export const DEBUG_LIFECYCLE_EVENT_KINDS = Object.keys(
  EVENT_KINDS,
) as readonly DebugLifecycleEventKind[];

const REASONS: Record<DebugLifecycleReason, true> = {
  requested: true,
  adapterExit: true,
  debuggeeExit: true,
  malformedFrame: true,
  frameOverflow: true,
  outputOverflow: true,
  wallTimeout: true,
  inactivityTimeout: true,
  activationRevoked: true,
  serverShutdown: true,
  startupFailed: true,
  restartThrottled: true,
  writeFailure: true,
  unexpectedEof: true,
  stopped: true,
};
export const DEBUG_LIFECYCLE_REASONS = Object.keys(REASONS) as readonly DebugLifecycleReason[];

/**
 * The exact `DebugLifecycleEvidence` field set, keyed off `keyof DebugLifecycleEvidence` so a field
 * added to (or removed from) the interface without a matching entry here is a compile error in both
 * directions — replacing the former untyped `Set<string>`, which had no compile-time relationship to
 * the interface at all (KEIKO-0377). Exported so consumers (e.g. a sibling record shape that extends
 * evidence with extra fields) can derive their own key set from this one instead of restating it.
 */
export const EVIDENCE_KEYS: Readonly<Record<keyof DebugLifecycleEvidence, true>> = {
  schemaVersion: true,
  eventKind: true,
  sessionId: true,
  state: true,
  reason: true,
  targetKind: true,
  backend: true,
  network: true,
  filesystem: true,
  provisioningDigest: true,
  timestampMs: true,
  activationRevision: true,
  outputAcceptedBytes: true,
  outputTruncatedEvents: true,
};
function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

// A DebugLifecycleEvent is an evidence record PLUS `sequence`, so it needs its own key table: the
// evidence guard's exact-key scan rejects the extra field, which is why a statically valid
// DebugLifecycleEvent failed isDebugLifecycleEvidence at runtime.
const EVENT_KEYS: Readonly<Record<keyof DebugLifecycleEvidence | "sequence", true>> = {
  ...EVIDENCE_KEYS,
  sequence: true,
};

// `Object.hasOwn` rather than the `in` operator: `in` walks the prototype chain, so
// `"constructor" in STATES` (or `"toString"`, `"hasOwnProperty"`, …) would evaluate `true` on any
// plain object regardless of its own keys — a hostile record could smuggle a prototype method name
// through as an "accepted" vocabulary member. `Object.hasOwn` checks only own properties, matching
// the exact fail-closed behaviour `Set.has()` had (which never consulted a prototype).
function hasExactKeysFrom(
  record: Record<string, unknown>,
  allowed: Readonly<Record<string, true>>,
): boolean {
  const allowedCount = Object.keys(allowed).length;
  const names = Object.getOwnPropertyNames(record);
  const enumerableNames = Object.keys(record);
  return (
    names.length === allowedCount &&
    enumerableNames.length === allowedCount &&
    Object.getOwnPropertySymbols(record).length === 0 &&
    names.every((key) => Object.hasOwn(allowed, key)) &&
    enumerableNames.every((key) => Object.hasOwn(allowed, key))
  );
}

function hasExactKeys(record: Record<string, unknown>): boolean {
  return hasExactKeysFrom(record, EVIDENCE_KEYS);
}

function hasClosedVocabulary(record: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(EVENT_KINDS, record.eventKind as DebugLifecycleEventKind) &&
    Object.hasOwn(STATES, record.state as DebugSessionState) &&
    Object.hasOwn(REASONS, record.reason as DebugLifecycleReason)
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
