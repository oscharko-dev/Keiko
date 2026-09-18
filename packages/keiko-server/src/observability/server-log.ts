// Server activity log — one JSON line per operation into the one logical Activity Log under
// `<stateDir>/logs/`. Written unconditionally, no env-var opt-in: operators facing a stuck run must
// not have to know a magic switch to see what the process is doing. Redaction stays strict —
// endpoints, sizes, HTTP statuses, error kinds and correlation ids only; request bodies, response
// bodies, tokens, api-keys and user text never appear, and that is enforced structurally by
// `log-redaction.ts` rather than by caller discipline.
//
// BOUNDED IMMUTABLE SEGMENTS (#3530, ADR-0173 D14)
//
// The logical log is physically a sequence of small segments (`activity-log-files.ts` in the
// contracts leaf owns the closed name grammar). Every process instance appends only to its own
// active segment, created exclusively, so no process ever appends to or renames another process's
// open file. A segment is sealed — a final `activity-log.segment.sealed` line, fsync, a guarded
// same-directory rename that drops `.active`, and mode 0400 — when the next line would pass the
// configured byte bound, when it is older than the configured time bound, on close, and on a pin
// request. A sealed segment is never written again. Crash recovery seals an orphaned segment as it is
// and reports a partial final line; valid lines are never rewritten. Retention (byte budget and age,
// with a reserved pin quota) runs whenever a segment is opened, which is at startup and immediately
// after every rollover seal, and every outcome is registered, body-free evidence.
// `activity-log-store.ts` owns the arithmetic; this module owns the one writer and its evidence.
//
// WHY THE WRITE IS SYNCHRONOUS (and stays that way)
//
// The failure this log exists to diagnose is a process that stops making progress: a six-minute
// wall inside an embedding batch, a wedged proxy CONNECT, a migration holding a transaction. A
// write-behind queue is exactly wrong for that shape — the lines an operator needs are the last
// ones before the wedge, and those are the ones a queue still holds when the event loop stops
// turning or the process is killed. Synchronous append is the only mode where "the line is in the
// file" and "the operation happened" cannot come apart.
//
// The cost is bounded and pinned by COUNTING, not by timing. The sink holds ONE append-mode
// descriptor open for the life of a segment, so a line costs a single `write(2)` rather than the
// open/write/close triple `appendFileSync` pays per call. `server-log.test.ts` asserts that the
// fixed setup count does not grow over a burst — never one open per line — plus one `writeSync` per
// line and a segment whose size is the SUM of each line's own byte length (lines are no longer
// byte-identical once `seq` is in the envelope: its digit width grows at each power-of-ten boundary
// the burst crosses). A regression to per-write open/close, or to a quadratic format path,
// therefore fails deterministically instead of showing up as latency in production.
//
// Levels are the volume control instead: an event below the configured threshold returns before
// any string or JSON work happens at all (`KEIKO_LOG_LEVEL`, default `info`).

import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { performance } from "node:perf_hooks";
import {
  SAFE_ARTIFACT_FILE_FAILURE_KINDS,
  SafeArtifactFileError,
  archiveSafeArtifactFile,
  openSafeArtifactFile,
  safeArtifactContainmentAssurance,
  safeArtifactPermissionAssurance,
} from "@oscharko-dev/keiko-security/fs-hardening";

import {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_SCHEMA_DIGEST,
  ActivityLogEventValidationError,
  activityLogErrorKindOr,
  activityLogEvent,
  activityLogSegmentFileName,
  classifyErrorKind,
  defineActivityLogOperation,
  formatActivityLogSegmentId,
  isActivityLogIdentityDigest,
  isActivityLogInstanceId,
  isActivityLogPlatformClass,
  isActivityLogProcessId,
  isActivityLogProductVersion,
  isActivityLogSequence,
  type ActivityLogCompatibilityState,
  type ActivityLogErrorKind,
  type ActivityLogEventFailureKind,
  type ActivityLogFileName,
  type ActivityLogSegmentFileName,
  type ActivityLogSegmentIdentity,
  type ActivityLogWriterCapabilityState,
  validateRegisteredActivityLogEvent,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";

import { correlationIdOrUnknown, isValidCorrelationId } from "../correlation.js";
import {
  DEFAULT_ACTIVITY_LOG_RETENTION_BYTES,
  MAX_ACTIVITY_LOG_PIN_DURATION_MS,
  MAX_ACTIVITY_LOG_PINS,
  MAX_LOG_LINE_BYTES,
  activeActivityLogPins,
  activityLogFreeBytes,
  activityLogLowDiskThresholdBytes,
  activityLogOrphanOwner,
  activityLogPinCovers,
  activityLogSegmentSeqSpan,
  applyActivityLogRetention,
  inspectActivityLogSegmentTail,
  isActivityLogPinScope,
  isActivityLogSegmentEntry,
  listActivityLogDirectory,
  planActivityLogPinProtection,
  processIsAlive,
  readActivityLogPins,
  removeActivityLogFile,
  resolveActivityLogStorageConfig,
  writeActivityLogPinRecord,
  type ActivityLogDirectoryListing,
  type ActivityLogFileEntry,
  type ActivityLogOrphanOwner,
  type ActivityLogPinRead,
  type ActivityLogPinReason,
  type ActivityLogPinRecord,
  type ActivityLogPinScope,
  type ActivityLogRetentionOutcome,
  type ActivityLogSegmentTail,
  type ActivityLogStorageConfig,
} from "./activity-log-store.js";
import { contentFreeErrorClass, machineToken, safeProperty } from "./error-classification.js";
import {
  DEFAULT_SERVER_LOG_LEVEL,
  resolveServerLogThreshold,
  serverLogLevelEnabled,
} from "./log-level.js";
import type { ServerLogEnv, ServerLogLevel, ServerLogThreshold } from "./log-level.js";
import { redactLogFields, redactLogLabel } from "./log-redaction.js";

export {
  ACTIVITY_LOG_PIN_QUOTA_BYTES_ENV,
  ACTIVITY_LOG_RETENTION_BYTES_ENV,
  ACTIVITY_LOG_RETENTION_DAYS_ENV,
  ACTIVITY_LOG_SEGMENT_BYTES_ENV,
  ACTIVITY_LOG_SEGMENT_SECONDS_ENV,
  DEFAULT_ACTIVITY_LOG_PIN_QUOTA_BYTES,
  DEFAULT_ACTIVITY_LOG_RETENTION_BYTES,
  DEFAULT_ACTIVITY_LOG_RETENTION_DAYS,
  DEFAULT_ACTIVITY_LOG_SEGMENT_BYTES,
  DEFAULT_ACTIVITY_LOG_SEGMENT_SECONDS,
  MAX_ACTIVITY_LOG_PIN_DURATION_MS,
  MAX_ACTIVITY_LOG_PIN_SEGMENTS,
  MAX_ACTIVITY_LOG_PIN_WINDOW_MS,
  MAX_ACTIVITY_LOG_PINS,
  MAX_LOG_LINE_BYTES,
  MIN_ACTIVITY_LOG_RETENTION_BYTES,
  MIN_ACTIVITY_LOG_SEGMENT_BYTES,
  resolveActivityLogStorageConfig,
  type ActivityLogPinReason,
  type ActivityLogPinScope,
  type ActivityLogStorageConfig,
} from "./activity-log-store.js";

export type { ServerLogEnv, ServerLogLevel, ServerLogThreshold } from "./log-level.js";
export {
  DEFAULT_SERVER_LOG_LEVEL,
  SERVER_LOG_LEVELS,
  SERVER_LOG_LEVEL_ENV,
  isServerLogLevel,
  isServerLogThreshold,
  parseServerLogThreshold,
  resolveServerLogThreshold,
  serverLogLevelEnabled,
  serverLogLevelRank,
} from "./log-level.js";
export {
  MAX_LOG_ARRAY_LENGTH,
  MAX_LOG_FIELD_COUNT,
  MAX_LOG_FIELD_DEPTH,
  MAX_LOG_STRING_LENGTH,
  REDACTED_KEY,
  REDACTED_LENGTH,
  REDACTED_PATH,
  REDACTED_PERSONAL,
  REDACTED_SECRET,
  REDACTED_SHAPE,
  DROPPED_DEPTH,
  DROPPED_LENGTH,
  closeReasonVocabulary,
  isDeniedLogFieldName,
  normalizeLogFieldName,
  redactLogFields,
  redactLogLabel,
  redactLogString,
} from "./log-redaction.js";
export { redactRoutePath } from "./route-template.js";

// Coarse routing label. Kept a closed union so a typo cannot invent a category an operator's
// grep will never find; `memory` was added for the vault/retrieval surface, `process` for the
// process-lifecycle lines (`process.started`/`process.heartbeat`/`process.exiting`) envelope v2
// adds, `security` (Wave 4a, epic #3233 §8) for `keiko-security`'s own structural
// `SecurityLogSink` port (`packages/keiko-security/src/log-port.ts`), and `consolidation` (Wave 6,
// epic #3233) for `keiko-memory-consolidation`'s own structural `ConsolidationLogSink` port
// (`packages/keiko-memory-consolidation/src/log-port.ts`) — without each of these members here,
// that package's own `*LogEvent.category` union is not a subset of this one, so `ServerLogSink`
// (via `processServerLogSink()`) is not structurally assignable to its port at all, unlike the
// `MemoryVaultLogSink`/`KnowledgeLogSink` ports, whose categories were already subsets of this
// union from the start.
export type ServerLogCategory =
  | "http"
  | "gateway"
  | "embedding"
  | "indexing"
  | "setup"
  | "search"
  | "memory"
  | "security"
  | "diagnostic"
  | "process"
  | "consolidation";

export interface ServerLogEvent {
  // Omitted means `info`. An event below the sink threshold costs nothing.
  readonly level?: ServerLogLevel | undefined;
  readonly category: ServerLogCategory;
  readonly op: string;
  readonly correlationId?: string | undefined;
  // The correlation id of the request/run that SPAWNED this one, when this line's own
  // `correlationId` belongs to a background job/HarnessEvent run minted fresh at that job's own
  // start (ADR-0173 D5 / g12) — never set for an ordinary request-scoped line, which already has
  // continuity through `correlationId` alone. Validated against `isValidCorrelationId`'s
  // `SAFE_CORRELATION_ID` shape (imported, never redeclared) before it reaches the line: a value
  // that does not fit the shape is dropped rather than written, the same fail-closed direction the
  // named-hatch guards in `log-redaction.ts` already take for `frames`/`causeChain`.
  readonly parentCorrelationId?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly status?: number | undefined;
  readonly errorKind?: string | undefined;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

// Bumped only on a breaking change to the line FORMAT (a reserved field renamed, removed, or
// retyped) — never on an additive change, which is what every wave of this schema so far has been.
export const SERVER_LOG_SCHEMA_VERSION = 2;

// One instance id per process, computed once from a single `randomUUID()` call so every line this
// process ever writes carries the SAME value. A pid alone is not a process-identity key: the OS
// reuses pids across restarts, so two different process lifetimes can share one multi-day file.
// `pid` + `instanceId` together, never `pid` alone, is what an agent joins on.
const INSTANCE_ID = randomUUID().replaceAll("-", "").slice(0, 8);

// Exposed so a future consumer (the CLI's support-bundle manifest) can name the same instance the
// running process is stamping onto its own lines, without recomputing or guessing at the value.
export function serverLogInstanceId(): string {
  return INSTANCE_ID;
}

// The identity fields the sink stamps once, at the physical write boundary — never left to a caller,
// and never spoofable through `extra` (see `RESERVED_FIELD_NAMES` in `log-redaction.ts`). Bundled
// as one optional parameter on `formatServerLogLine`, because a caller either
// wants the full process/sequence identity or none of it: the file sink always passes one, and the
// in-memory buffered test sink is free to omit it entirely.
export interface ServerLogIdentity {
  readonly schemaVersion: number;
  readonly registryVersion: number;
  readonly schemaDigest: string;
  readonly catalogDigest: string;
  readonly buildClass: "node-esm";
  readonly releaseClass: "stable" | "prerelease";
  readonly platformClass: string;
  readonly productVersion: string;
  readonly compatibilityState: ActivityLogCompatibilityState;
  readonly writerCapability: ActivityLogWriterCapabilityState;
  readonly pid: number;
  readonly instanceId: string;
  readonly seq: number;
}

const ACTIVITY_LOG_RELEASE_CLASSES: ReadonlySet<unknown> = new Set(["stable", "prerelease"]);
const PERSISTED_WRITER_CAPABILITIES: ReadonlySet<unknown> = new Set(["active", "degraded"]);
const SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set(["darwin", "linux", "win32"]);
const SUPPORTED_ARCHITECTURES: ReadonlySet<string> = new Set(["arm64", "x64"]);

function validRegistryIdentity(identity: ServerLogIdentity): boolean {
  return (
    identity.schemaVersion === SERVER_LOG_SCHEMA_VERSION &&
    identity.registryVersion === ACTIVITY_LOG_REGISTRY_VERSION
  );
}

function validDigestIdentity(identity: ServerLogIdentity): boolean {
  return (
    isActivityLogIdentityDigest(identity.schemaDigest) &&
    identity.schemaDigest === ACTIVITY_LOG_SCHEMA_DIGEST &&
    isActivityLogIdentityDigest(identity.catalogDigest) &&
    identity.catalogDigest === ACTIVITY_LOG_CATALOG_DIGEST
  );
}

function validBuildIdentity(identity: ServerLogIdentity): boolean {
  const buildClass: unknown = Reflect.get(identity, "buildClass");
  const releaseClass: unknown = Reflect.get(identity, "releaseClass");
  const platformClass: unknown = Reflect.get(identity, "platformClass");
  return (
    buildClass === "node-esm" &&
    ACTIVITY_LOG_RELEASE_CLASSES.has(releaseClass) &&
    isActivityLogPlatformClass(platformClass)
  );
}

function validProductIdentity(identity: ServerLogIdentity): boolean {
  return (
    isActivityLogProductVersion(identity.productVersion) &&
    identity.productVersion === KEIKO_PRODUCT_VERSION
  );
}

function validWriterIdentity(identity: ServerLogIdentity): boolean {
  const compatibilityState: unknown = Reflect.get(identity, "compatibilityState");
  const writerCapability: unknown = Reflect.get(identity, "writerCapability");
  return compatibilityState === "supported" && PERSISTED_WRITER_CAPABILITIES.has(writerCapability);
}

function validServerLogIdentity(identity: ServerLogIdentity): boolean {
  return [
    validRegistryIdentity(identity),
    validDigestIdentity(identity),
    validBuildIdentity(identity),
    validProductIdentity(identity),
    validWriterIdentity(identity),
    isActivityLogProcessId(identity.pid),
    isActivityLogInstanceId(identity.instanceId),
    isActivityLogSequence(identity.seq),
  ].every(Boolean);
}

function validateServerLogIdentity(identity: ServerLogIdentity): void {
  if (!validServerLogIdentity(identity)) {
    throw new ActivityLogEventValidationError("invalid-identity");
  }
}

export interface ServerLogSink {
  readonly write: (event: ServerLogEvent) => void;
  // Present on sinks that own an OS resource. Both are optional so every existing structural
  // implementation of `ServerLogSink` stays assignable.
  readonly flush?: (() => void) | undefined;
  readonly close?: (() => void) | undefined;
}

// Retained for the #3532 readiness default provider, which reads it as the byte budget until it
// consumes `activityLogStorageHealth`; it equals the Activity Log's default retention budget.
export const DEFAULT_LOG_CAPACITY_WARNING_BYTES = DEFAULT_ACTIVITY_LOG_RETENTION_BYTES;

const NULL_SINK: ServerLogSink = {
  write(_event: ServerLogEvent): void {
    // Explicit noop for tests and for environments without a state directory.
  },
};

export function nullServerLogSink(): ServerLogSink {
  return NULL_SINK;
}

// Turns an unknown thrown value into a content-free classification: a coded error's `code`, else
// its content-free CLASS, else `unknown`. The MESSAGE is never read — that is the whole point, and
// it is why instrumentation sites should call this instead of `String(error)`. It lives here rather
// than beside the logger because the file sink below classifies its own failures too, and this
// module is the one both sides already depend on.
//
// Delegates to `error-classification.ts`'s `safeProperty`/`machineToken`/`contentFreeErrorClass`
// (ADR-0173 D11) instead of maintaining a second, less-hardened regex-based reader: this used to
// read `code`/`name` off a plain cast with no try/catch, so a hostile `code`/`name` accessor that
// THROWS on read (rather than merely returning prose) crashed classification itself; the shared
// helpers already wrap every reflective read.
//
// `code` is read off ANY object, `Error` or not — this function's contract has always been "read
// the field if it is there", and gating that read on `instanceof Error` would silently drop a
// conforming `code` carried by a plain thrown object (e.g. `{ code: "SQLITE_BUSY" }`), which the
// pre-hardening reader classified correctly.
//
// The `Error`-vs-not split matters only for the FALLBACK once `code` is absent or non-conforming.
// An actual `Error` instance goes through `contentFreeErrorClass`, which trusts `.name` only for a
// specific, curated set of built-ins and otherwise reads the CODE-DECLARED class off the
// prototype — `.name` is a plain mutable own property a hostile thrown value can load with
// request-derived text, and `diagnostics-log.test.ts`'s "degrades an overridden name on a plain
// Error and never serializes it" pins exactly this for every producer that shares this leaf, this
// function included. A non-`Error` object has no declared class to recover, so its own `.name` is
// read through the same shape gate (`classifyErrorKind`) every other package's reducer already
// applies — restoring the pre-hardening reader's fidelity for that shape without reopening the
// `Error`-name hardening above. Either branch still floors on the fixed string `"unknown"` for a
// non-conforming candidate, pinned by `server-logger.test.ts`.
export function errorKindOf(error: unknown): string {
  const safeArtifactKind = safeArtifactErrorKind(error);
  if (safeArtifactKind !== undefined) return safeArtifactKind;
  if (typeof error !== "object" || error === null) return "unknown";
  const code = machineToken(safeProperty(error, "code"));
  if (code !== undefined) return code;
  if (error instanceof Error) return contentFreeErrorClass(error);
  return classifyErrorKind(safeProperty(error, "name")) ?? "unknown";
}

const SAFE_ARTIFACT_ERROR_KINDS: ReadonlySet<string> = new Set(SAFE_ARTIFACT_FILE_FAILURE_KINDS);

function safeArtifactErrorKind(error: unknown): string | undefined {
  try {
    if (!(error instanceof SafeArtifactFileError)) return undefined;
  } catch {
    return undefined;
  }
  const kind = safeProperty(error, "kind");
  return typeof kind === "string" && SAFE_ARTIFACT_ERROR_KINDS.has(kind) ? kind : "open-failed";
}

// LAST-RESORT FAILURE NOTICE
//
// Every layer below the caller swallows its own failures on purpose: a log line is evidence about
// an operation and must never become a new failure mode for it. Swallowed SILENTLY, though, a
// permanently broken log looks exactly like a quiet system — which is the precise silence this
// module exists to end, and the reason four releases shipped against a stuck indexing run.
//
// So a failure is reported once, on an INDEPENDENT channel: stderr, never the sink that just
// failed. A full disk cannot be diagnosed by writing to the disk. The notice carries the same
// body-free shape as a log line — a classification, the op, the correlation id — and is throttled,
// because the failures this catches sit inside per-item loops: a broken descriptor must not turn
// one flood into another. Suppressed notices are counted and reported on the next one, so the
// throttle never hides the SCALE of the failure, only its repetition.
const LOG_FAILURE_NOTICE_OP = "server-log.write-failed";
export const LOG_FAILURE_NOTICE_WINDOW_MS = 60_000;

const SERVER_LOG_FAILURE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "server-log.write-failed",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/server-log.failureNoticeEvent",
  fields: {
    failedOp: { type: "string", dataClass: "opaque-id", required: false, maxLength: 160 },
    rejectionKind: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "unregistered-operation",
        "registration-mismatch",
        "missing-identity",
        "invalid-identity",
        "fields-not-object",
        "missing-field",
        "unknown-field",
        "invalid-field-type",
        "invalid-field-bound",
        "invalid-field-vocabulary",
      ],
    },
    writerCapability: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["unavailable"],
    },
    compatibilityState: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["incomplete"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["shutdown-flush"],
    },
    suppressedNotices: { type: "integer", dataClass: "count", required: false },
  },
  causal: "correlation",
  lifecycle: "loss",
  analyzerProjection: "failure-cluster",
  failureClasses: ["activity-log-persistence", "activity-log-contract"],
  proofIds: ["server-log.write-failed.stderr-line"],
  releaseImpact: "patch",
});

const SERVER_LOG_LINE_DROPPED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "server-log.line-dropped",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/server-log.oversizedLine",
  fields: {
    failedOp: { type: "string", dataClass: "opaque-id", required: true, maxLength: 160 },
    droppedLineBytes: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "loss",
  analyzerProjection: "failure-cluster",
  failureClasses: ["activity-log-contract"],
  proofIds: ["server-log.line-dropped.registered-line"],
  releaseImpact: "patch",
});

const SERVER_LOG_ARTIFACT_CLASS_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: true,
  values: ["activity-log"],
} as const;

const SERVER_LOG_TARGET_ASSURANCE_FIELDS = {
  permissionAssurance: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: ["verified-private", "platform-inherited"],
  },
  containmentAssurance: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: ["private-root-guarded", "platform-inherited"],
  },
  completeness: { type: "string", dataClass: "completeness-state", required: true },
  loss: { type: "string", dataClass: "loss-state", required: true },
} as const;

const SERVER_LOG_TARGET_MUTATED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "server-log.target-mutated",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/server-log.mutationEvidence",
  fields: {
    failedOp: { type: "string", dataClass: "opaque-id", required: true, maxLength: 160 },
    artifactClass: SERVER_LOG_ARTIFACT_CLASS_FIELD,
    ...SERVER_LOG_TARGET_ASSURANCE_FIELDS,
  },
  causal: "correlation",
  lifecycle: "loss",
  analyzerProjection: "failure-cluster",
  failureClasses: ["activity-log-persistence"],
  proofIds: ["server-log.target-mutated.registered-line"],
  releaseImpact: "patch",
});

export interface ServerLogFailureContext {
  readonly op?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly loss?: "event-dropped" | "event-location-unknown" | undefined;
  readonly identity?: ServerLogIdentity | undefined;
}

const failureNotice = { lastAt: null as number | null, suppressed: 0 };

// Tests reset this so one suite's notice cannot silence the next suite's assertion; the server
// resets it on shutdown for the same reason. Either caller is clearing `suppressed` — a count that
// otherwise only ever surfaces on the NEXT unthrottled failure — so a suppressed count sitting here
// when the reset runs is flushed to stderr first: without this, a clean shutdown (or a suite that
// never sees another failure) would clear the counter with nothing ever having reported it, and
// `reportServerLogFailure`'s "suppressed notices are counted and reported on the next one" promise
// would be broken for whatever window was still open.
export function resetServerLogFailureNotices(): void {
  if (failureNotice.suppressed > 0) {
    emitShutdownFlushNotice(failureNotice.suppressed, Date.now());
  }
  failureNotice.lastAt = null;
  failureNotice.suppressed = 0;
}

function noticeIsThrottled(now: number): boolean {
  const last = failureNotice.lastAt;
  if (last === null) return false;
  const elapsed = now - last;
  // A backwards system-clock adjustment must not silence the notice for a minute: an elapsed time
  // we cannot trust fails toward visibility.
  return elapsed >= 0 && elapsed < LOG_FAILURE_NOTICE_WINDOW_MS;
}

export function reportServerLogFailure(
  error: unknown,
  context: ServerLogFailureContext = {},
): void {
  const now = Date.now();
  if (noticeIsThrottled(now)) {
    failureNotice.suppressed += 1;
    return;
  }
  const suppressed = failureNotice.suppressed;
  failureNotice.lastAt = now;
  failureNotice.suppressed = 0;
  emitFailureNotice(
    error,
    context,
    suppressed,
    now,
    context.identity ?? allocateServerLogIdentity(),
  );
}

// Shared by every stderr notice this module emits: a diagnostic that cannot itself be delivered
// must not fail the operation (or the shutdown) it was describing. When stderr itself is
// unavailable (a closed descriptor, a broken pipe, ...) the notice still reaches an operator
// through an INDEPENDENT channel — `process.emitWarning` dispatches the 'warning' event
// synchronously to any listener, which fires even when stderr is closed; Node's own default
// handler happens to also print to stderr, but that is Node's problem to swallow, not this
// module's. This is genuinely the last channel: if a 'warning' listener itself throws, or every
// stream this process owns is gone, the notice is lost.
function writeStderrNotice(notice: Record<string, unknown>): void {
  try {
    process.stderr.write(`${JSON.stringify(notice)}\n`);
  } catch {
    emitLogNoticeFailedWarning(notice);
  }
}

function emitLogNoticeFailedWarning(notice: Record<string, unknown>): void {
  try {
    process.emitWarning("keiko server log notice could not be written to stderr", {
      code: "KEIKO_LOG_NOTICE_FAILED",
      // Named `noticeOp`, not `op`: this is a description of a notice, not a log event, and the
      // op-catalog generator indexes every `op:` property in product code.
      detail: JSON.stringify({
        noticeOp: notice.op,
        failedOp: notice.failedOp,
        correlationId: notice.correlationId,
        errorKind: notice.errorKind,
        rejectionKind: notice.rejectionKind,
        writerCapability: notice.writerCapability,
        compatibilityState: notice.compatibilityState,
        completeness: notice.completeness,
        loss: notice.loss,
        suppressedNotices: notice.suppressedNotices,
      }),
    });
  } catch {
    // No channel left to report through; nothing further to do.
  }
}

function emitFailureNotice(
  error: unknown,
  context: ServerLogFailureContext,
  suppressed: number,
  now: number,
  identity: ServerLogIdentity,
): void {
  try {
    const validationFailure = activityLogValidationFailure(error);
    const event = failureNoticeEvent(error, context, suppressed, validationFailure);
    writeStderrNotice(stderrEventRecord(event, identity, now));
  } catch {
    writeStderrNotice(emergencyFailureNotice(identity, now));
  }
}

function emergencyFailureNotice(identity: ServerLogIdentity, now: number): Record<string, unknown> {
  return {
    ts: new Date(now).toISOString(),
    ...failureNoticeIdentity(identity),
    level: "error",
    category: "diagnostic",
    op: LOG_FAILURE_NOTICE_OP,
    correlationId: correlationIdOrUnknown(undefined),
    errorKind: "internal",
    compatibilityState: "incomplete",
    writerCapability: "unavailable",
    completeness: "unknown",
    loss: "event-dropped",
  };
}

function failureNoticeEvent(
  error: unknown,
  context: ServerLogFailureContext,
  suppressed: number,
  rejectionKind: ActivityLogEventFailureKind | undefined,
): ServerLogEvent {
  return activityLogEvent(
    SERVER_LOG_FAILURE_OPERATION,
    {
      level: "error",
      correlationId: correlationIdOrUnknown(context.correlationId),
      errorKind: closedFailureNoticeErrorKind(error),
    },
    {
      ...(rejectionKind === undefined && context.op !== undefined
        ? { failedOp: redactLogLabel(context.op) }
        : {}),
      ...(rejectionKind === undefined ? {} : { rejectionKind }),
      writerCapability: "unavailable",
      compatibilityState: "incomplete",
      completeness: "unknown",
      loss: context.loss ?? "event-dropped",
      ...(suppressed > 0 ? { suppressedNotices: suppressed } : {}),
    },
  );
}

function stderrEventRecord(
  event: ServerLogEvent,
  identity: ServerLogIdentity,
  now: number,
): Record<string, unknown> {
  return {
    ts: new Date(now).toISOString(),
    ...failureNoticeIdentity(identity),
    level: event.level,
    category: event.category,
    ["op"]: event.op,
    correlationId: event.correlationId,
    errorKind: event.errorKind,
    ...event.extra,
  };
}

function activityLogValidationFailure(error: unknown): ActivityLogEventFailureKind | undefined {
  return error instanceof ActivityLogEventValidationError ? error.kind : undefined;
}

function closedFailureNoticeErrorKind(error: unknown): ActivityLogErrorKind {
  if (error instanceof ActivityLogEventValidationError) return "validation-failed";
  return activityLogErrorKindOr(errorKindOf(error), "internal");
}

function failureNoticeIdentity(identity: ServerLogIdentity): Record<string, unknown> {
  return {
    schemaVersion: identity.schemaVersion,
    registryVersion: identity.registryVersion,
    schemaDigest: identity.schemaDigest,
    catalogDigest: identity.catalogDigest,
    buildClass: identity.buildClass,
    releaseClass: identity.releaseClass,
    platformClass: identity.platformClass,
    productVersion: identity.productVersion,
    pid: identity.pid,
    instanceId: identity.instanceId,
    seq: identity.seq,
  };
}

// The last-resort flush: whatever `suppressed` count was still sitting unreported when the notice
// state was reset (a clean process shutdown, or a suite boundary) is announced here, ONCE, before
// `resetServerLogFailureNotices` clears it. This has the same body-free shape as a throttled
// failure notice, plus `reason` so a reader can tell "reported because another failure arrived"
// from "reported because the counter was about to be cleared with nothing else coming."
//
// This still cannot promise EXACT accounting across every possible exit: a hard kill (SIGKILL,
// power loss, or any crash the process never gets to handle) skips this flush entirely, same as it
// skips every other cleanup path. The `seq` gap for such a window still marks that a write failed;
// only the count of how many is not recoverable after that kind of exit.
function emitShutdownFlushNotice(suppressed: number, now: number): void {
  const identity = allocateServerLogIdentity();
  try {
    const event = activityLogEvent(
      SERVER_LOG_FAILURE_OPERATION,
      {
        level: "error",
        correlationId: correlationIdOrUnknown(undefined),
        errorKind: "unknown",
      },
      {
        writerCapability: "unavailable",
        compatibilityState: "incomplete",
        completeness: "unknown",
        loss: "event-dropped",
        reason: "shutdown-flush",
        suppressedNotices: suppressed,
      },
    );
    writeStderrNotice(stderrEventRecord(event, identity, now));
  } catch {
    writeStderrNotice(emergencyFailureNotice(identity, now));
  }
}

function eventLevel(event: ServerLogEvent): ServerLogLevel {
  return event.level ?? DEFAULT_SERVER_LOG_LEVEL;
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function applyEnvelopeFields(record: Record<string, unknown>, event: ServerLogEvent): void {
  if (event.correlationId !== undefined) record.correlationId = redactLogLabel(event.correlationId);
  // Shape-guarded, not merely redacted: a `parentCorrelationId` that does not fit
  // `isValidCorrelationId`'s shape is dropped outright rather than written under a marker — an
  // unshaped value here is evidence of a producer bug, never content worth preserving a trace of.
  if (event.parentCorrelationId !== undefined && isValidCorrelationId(event.parentCorrelationId)) {
    record.parentCorrelationId = redactLogLabel(event.parentCorrelationId);
  }
  const durationMs = finiteOrUndefined(event.durationMs);
  if (durationMs !== undefined) record.durationMs = durationMs;
  const status = finiteOrUndefined(event.status);
  if (status !== undefined) record.status = status;
  if (event.errorKind !== undefined) record.errorKind = redactLogLabel(event.errorKind);
}

// `ts`, `schemaVersion`, `pid`, `instanceId`, `seq`, `level`, `category` and `op` are written first
// and are reserved inside `redactLogFields`, so `extra` cannot spoof the identity of a line. The
// remaining envelope fields are applied AFTER `extra` so an explicit `durationMs`/`status`/
// `errorKind` on the event wins, while an instrumentation site that carries the same name in its
// field list still gets it logged.
//
// `identity` is optional so the in-memory buffered sink (tests only) can format a line without a
// process/sequence context; the file sink below always supplies one, so every line that actually
// reaches disk carries the full v2 envelope.
export function formatServerLogLine(
  event: ServerLogEvent,
  now: Date = new Date(),
  identity?: ServerLogIdentity,
): string {
  const record: Record<string, unknown> = { ts: now.toISOString() };
  if (identity !== undefined) {
    record.schemaVersion = identity.schemaVersion;
    record.registryVersion = identity.registryVersion;
    record.schemaDigest = identity.schemaDigest;
    record.catalogDigest = identity.catalogDigest;
    record.buildClass = identity.buildClass;
    record.releaseClass = identity.releaseClass;
    record.platformClass = identity.platformClass;
    record.productVersion = identity.productVersion;
    record.compatibilityState = identity.compatibilityState;
    record.writerCapability = identity.writerCapability;
    record.pid = identity.pid;
    record.instanceId = identity.instanceId;
    record.seq = identity.seq;
  }
  record.level = eventLevel(event);
  record.category = event.category;
  record.op = redactLogLabel(event.op);
  const extra = redactLogFields(event.extra);
  if (extra !== undefined) Object.assign(record, extra);
  applyEnvelopeFields(record, event);
  const line = `${JSON.stringify(record)}\n`;
  // One byte measurement on the happy path; the second only on the line that is being replaced.
  return serverLogLineWithinCap(line) ? line : oversizedLine(record, serverLogLineBytes(line));
}

export function formatRegisteredServerLogLine(
  event: ServerLogEvent,
  now: Date = new Date(),
  identity?: ServerLogIdentity,
): string {
  if (identity === undefined) {
    throw new ActivityLogEventValidationError("missing-identity");
  }
  validateServerLogIdentity(identity);
  validateRegisteredActivityLogEvent(event);
  return formatServerLogLine(event, now, identity);
}

function formatEventLine(event: ServerLogEvent, now?: Date, identity?: ServerLogIdentity): string {
  // Every production persistence path supplies an identity and therefore requires a typed
  // registration. The identity-less branch exists only for the in-memory test sink's redacted
  // line projection; it cannot write a production file.
  return identity === undefined
    ? formatServerLogLine(event, now)
    : formatRegisteredServerLogLine(event, now, identity);
}

// The cap is a cap on BYTES, because the write below encodes UTF-8 and a log shipper's line limit
// counts bytes. `line.length` counts UTF-16 code units, so comparing it against the cap admitted a
// line up to three times the stated size — and multi-byte text is exactly what makes a line
// oversized in the first place, since a document body is the only thing that gets there.
//
// The value guards in `log-redaction.ts` currently refuse a non-ASCII field value outright, so in
// today's wiring the two counts agree. That is a second layer, not a reason to measure the wrong
// thing here: this module's cap must hold on its own for whatever a future producer, or a relaxed
// value guard, puts on a line.
export function serverLogLineBytes(line: string): number {
  return Buffer.byteLength(line, "utf8");
}

export function serverLogLineWithinCap(line: string): boolean {
  return serverLogLineBytes(line) <= MAX_LOG_LINE_BYTES;
}

function oversizedLine(record: Record<string, unknown>, lineBytes: number): string {
  // The identity fields ride along when present: an agent joining lines by (pid, instanceId, seq)
  // must not see a gap in that join key just because the ORIGINAL event happened to be oversized.
  const replacement: Record<string, unknown> = { ts: record.ts };
  for (const field of SERVER_LOG_IDENTITY_FIELDS) {
    if (record[field] !== undefined) replacement[field] = record[field];
  }
  const event = activityLogEvent(
    SERVER_LOG_LINE_DROPPED_OPERATION,
    {
      level: "error",
      correlationId:
        typeof record.correlationId === "string"
          ? correlationIdOrUnknown(record.correlationId)
          : correlationIdOrUnknown(undefined),
      errorKind: "write-failed",
    },
    {
      failedOp: typeof record.op === "string" ? redactLogLabel(record.op) : "unknown",
      droppedLineBytes: lineBytes,
      completeness: "unknown",
      loss: "event-dropped",
    },
  );
  replacement.level = event.level;
  replacement.category = event.category;
  replacement.op = event.op;
  Object.assign(replacement, event.extra);
  applyEnvelopeFields(replacement, event);
  return `${JSON.stringify(replacement)}\n`;
}

const SERVER_LOG_IDENTITY_FIELDS = [
  "schemaVersion",
  "registryVersion",
  "schemaDigest",
  "catalogDigest",
  "buildClass",
  "releaseClass",
  "platformClass",
  "productVersion",
  "compatibilityState",
  "writerCapability",
  "pid",
  "instanceId",
  "seq",
] as const;

// PROCESS-WIDE `seq` ALLOCATOR — one counter, one module, for the life of the process.
//
// It must NOT live on `ActiveLog`. Two independent state directories in the same process (a CLI
// pointed at a workspace-local state dir, and the server logger's own default) each resolve to a
// DIFFERENT `ActiveLog`; a counter kept per `ActiveLog` restarts at 1 for each one, so two lines
// written moments apart — one to each directory — can carry the identical `(pid, instanceId, seq)`
// tuple. That tuple is the join key ADR-0173 (D2) promises an agent a total monotonic order on, and
// a duplicate breaks the promise regardless of how many log directories the process happens to
// have open. One allocator shared by every `ActiveLog` and every sink built on top of any of them
// is what keeps the tuple unique process-wide while gaps expose failed persistence attempts.
//
// Each non-filtered facade call claims one identity before boundary handling or opening. Its first
// persisted record uses that identity; further records claim in physical-write order. Claims are
// never rolled back after failure. A gap is therefore not a counter bug: it marks a facade call or
// subsequent evidence record that could not persist its next line. Monotonic per process; never
// reused.
let nextProcessSeq = 1;

function resolvePlatformClass(): string {
  const platform = SUPPORTED_PLATFORMS.has(process.platform) ? process.platform : "other";
  const architecture = SUPPORTED_ARCHITECTURES.has(process.arch) ? process.arch : "other";
  return `${platform}-${architecture}`;
}

const PLATFORM_CLASS = resolvePlatformClass();

function allocateServerLogSeq(): number {
  const seq = nextProcessSeq;
  nextProcessSeq += 1;
  return seq;
}

/**
 * The identity every line of this process carries, without the per-line `seq`. Exported so a test
 * fixture derives the release and platform classes from here instead of restating their rules.
 */
export function serverLogProcessIdentity(
  writerCapability: Extract<ActivityLogWriterCapabilityState, "active" | "degraded"> = "active",
): Omit<ServerLogIdentity, "seq"> {
  return {
    schemaVersion: SERVER_LOG_SCHEMA_VERSION,
    registryVersion: ACTIVITY_LOG_REGISTRY_VERSION,
    schemaDigest: ACTIVITY_LOG_SCHEMA_DIGEST,
    catalogDigest: ACTIVITY_LOG_CATALOG_DIGEST,
    buildClass: "node-esm",
    releaseClass: KEIKO_PRODUCT_VERSION.includes("-") ? "prerelease" : "stable",
    platformClass: PLATFORM_CLASS,
    productVersion: KEIKO_PRODUCT_VERSION,
    compatibilityState: "supported",
    writerCapability,
    pid: process.pid,
    instanceId: INSTANCE_ID,
  };
}

function allocateServerLogIdentity(
  writerCapability: Extract<ActivityLogWriterCapabilityState, "active" | "degraded"> = "active",
): ServerLogIdentity {
  return { ...serverLogProcessIdentity(writerCapability), seq: allocateServerLogSeq() };
}

// ─── Physical write primitives ─────────────────────────────────────────────────────────────────

class PostWriteMutationError extends SafeArtifactFileError {
  public constructor() {
    super("activity-log", "target-mutated");
  }
}

// A descriptor that stopped accepting bytes (a zero-byte write or EAGAIN): write backpressure.
class ActivityLogBackpressureError extends SafeArtifactFileError {
  public constructor() {
    super("activity-log", "write-failed");
  }
}

// The filesystem refused the bytes (ENOSPC, EDQUOT, EFBIG): the disk or quota is full.
class ActivityLogDiskFullError extends SafeArtifactFileError {
  public constructor() {
    super("activity-log", "write-failed");
  }
}

// Retention could not make room for a new segment inside the byte budget: the event is dropped
// rather than let the Activity Log exceed its bound.
class ActivityLogBudgetError extends Error {
  public override readonly name = "ActivityLogBudgetError";
  public readonly code = "unavailable";

  public constructor() {
    super("activity log byte budget exhausted");
  }
}

const DISK_FULL_CODES: ReadonlySet<string> = new Set(["ENOSPC", "EDQUOT", "EFBIG"]);

function writeChunk(handle: number, payload: Buffer, offset: number): number {
  try {
    return writeSync(handle, payload, offset, payload.length - offset);
  } catch (error) {
    const code = machineToken(safeProperty(error, "code"));
    if (code !== undefined && DISK_FULL_CODES.has(code)) throw new ActivityLogDiskFullError();
    if (code === "EAGAIN") throw new ActivityLogBackpressureError();
    throw error;
  }
}

// `writeSync` may report a short write, so loop until the whole line has landed. A descriptor that
// reports ZERO bytes has stopped accepting them: looping would spin, and simply returning would
// leave a partial JSON record behind whose bytes then merge with the NEXT record — one stalled line
// silently costing two. So the stall throws and the line is dropped. A dropped line is the honest
// outcome; a truncated one is not, because it damages a record that was never in trouble.
function writeAll(handle: number, payload: Buffer): void {
  let offset = 0;
  while (offset < payload.length) {
    const written = writeChunk(handle, payload, offset);
    if (written <= 0) throw new ActivityLogBackpressureError();
    offset += written;
  }
}

// The bytes a stalled write already handed to the kernel cannot be recalled, so the damage is
// bounded from the other side: the store remembers that its active segment ends mid-record and the
// next record opens with a newline. That is deterministic — unlike writing a terminator, which asks a
// descriptor that is refusing bytes to accept one more.
function writeRecord(active: ActiveLog, handle: number, line: string): void {
  const payload = Buffer.from(active.pendingNewline ? `\n${line}` : line, "utf8");
  // Cleared only once the whole record has landed; a throw from `writeAll` leaves it set.
  active.pendingNewline = true;
  writeAll(handle, payload);
  active.pendingNewline = false;
}

// ─── Registered storage evidence ───────────────────────────────────────────────────────────────

const SERVER_LOG_SAFE_OPEN_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "server-log.safe-open",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/server-log.safeOpenEvidence",
  fields: {
    artifactClass: SERVER_LOG_ARTIFACT_CLASS_FIELD,
    persistenceStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["opened"],
    },
    ...SERVER_LOG_TARGET_ASSURANCE_FIELDS,
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["activity-log-persistence"],
  proofIds: ["server-log.safe-open.emitted-line"],
  releaseImpact: "patch",
});

type SealReason = "size-limit" | "age-limit" | "clock-change" | "close" | "pin-request";

const ACTIVITY_LOG_SEGMENT_SEALED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "activity-log.segment.sealed",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/server-log.segmentSealedEvidence",
  fields: {
    sealReason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["size-limit", "age-limit", "clock-change", "close", "pin-request"],
    },
    segmentIndex: { type: "integer", dataClass: "count", required: true },
    segmentFirstSeq: { type: "integer", dataClass: "count", required: true },
    segmentLastSeq: { type: "integer", dataClass: "count", required: true },
    segmentLineCount: { type: "integer", dataClass: "count", required: true },
    segmentBytes: { type: "integer", dataClass: "count", required: true },
    segmentDurationMs: { type: "integer", dataClass: "duration", required: true },
    droppedEventCount: { type: "integer", dataClass: "count", required: true },
    segmentByteLimit: { type: "integer", dataClass: "count", required: true },
    segmentSecondsLimit: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "capability",
  failureClasses: ["activity-log-segment"],
  proofIds: ["activity-log.segment.sealed.emitted-line"],
  releaseImpact: "patch",
});

const ACTIVITY_LOG_SEGMENT_RECOVERED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "activity-log.segment.recovered",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/server-log.segmentRecoveredEvidence",
  fields: {
    recoveryStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["sealed", "failed"],
    },
    recoveryKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["unsealed", "interrupted-seal"],
    },
    ownerState: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["exited", "stale", "same-process"],
    },
    tailState: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["terminated", "truncated", "unknown"],
    },
    truncatedBytes: { type: "integer", dataClass: "count", required: true },
    segmentBytes: { type: "integer", dataClass: "count", required: true },
    segmentIndex: { type: "integer", dataClass: "count", required: true },
    recoveredInstanceId: {
      type: "string",
      dataClass: "opaque-id",
      required: true,
      maxLength: 8,
    },
  },
  causal: "correlation",
  lifecycle: "loss",
  analyzerProjection: "failure-cluster",
  failureClasses: ["activity-log-segment"],
  proofIds: ["activity-log.segment.recovered.emitted-line"],
  releaseImpact: "patch",
});

const ACTIVITY_LOG_RETENTION_PRUNED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "activity-log.retention.pruned",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/server-log.retentionPrunedEvidence",
  fields: {
    retentionStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["pruned", "partial", "failed"],
    },
    prunedSegmentCount: { type: "integer", dataClass: "count", required: true },
    prunedLegacyFileCount: { type: "integer", dataClass: "count", required: true },
    prunedBytes: { type: "integer", dataClass: "count", required: true },
    prunedByAgeCount: { type: "integer", dataClass: "count", required: true },
    prunedByBudgetCount: { type: "integer", dataClass: "count", required: true },
    failedDeletionCount: { type: "integer", dataClass: "count", required: true },
    retainedFileCount: { type: "integer", dataClass: "count", required: true },
    retainedBytes: { type: "integer", dataClass: "count", required: true },
    protectedPinnedBytes: { type: "integer", dataClass: "count", required: true },
    retentionBudgetBytes: { type: "integer", dataClass: "count", required: true },
    retentionDays: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["activity-log-retention"],
  proofIds: ["activity-log.retention.pruned.emitted-line"],
  releaseImpact: "patch",
});

/** A degraded Activity Log storage condition, or `none`. */
export type ActivityLogPressureState =
  | "none"
  | "low-disk-space"
  | "disk-full"
  | "backpressure"
  | "budget-exceeded"
  | "retention-blocked";
type BlockingPressure = Extract<
  ActivityLogPressureState,
  "disk-full" | "backpressure" | "budget-exceeded"
>;
type StandingPressure = Extract<ActivityLogPressureState, "low-disk-space" | "retention-blocked">;

const ACTIVITY_LOG_PRESSURE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "activity-log.pressure",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/server-log.pressureEvidence",
  fields: {
    pressureState: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "low-disk-space",
        "disk-full",
        "backpressure",
        "budget-exceeded",
        "retention-blocked",
        "cleared",
      ],
    },
    previousState: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["low-disk-space", "retention-blocked"],
    },
    droppedEventCount: { type: "integer", dataClass: "count", required: true },
    usedBytes: { type: "integer", dataClass: "count", required: false },
    budgetBytes: { type: "integer", dataClass: "count", required: true },
    pinQuotaBytes: { type: "integer", dataClass: "count", required: true },
    freeBytes: { type: "integer", dataClass: "count", required: false },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["activity-log-pressure"],
  proofIds: ["activity-log.pressure.emitted-line"],
  releaseImpact: "patch",
});

const ACTIVITY_LOG_PIN_CREATED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "activity-log.pin.created",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/server-log.pinCreatedEvidence",
  fields: {
    pinId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 24 },
    pinStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["created", "rejected"],
    },
    rejectionReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["invalid-request", "pin-limit-reached", "storage-unavailable"],
    },
    pinKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["window", "segments"],
    },
    pinReason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["incident", "durable-batch"],
    },
    pinnedSegmentCount: { type: "integer", dataClass: "count", required: true },
    pinnedBytes: { type: "integer", dataClass: "count", required: true },
    windowSeconds: { type: "integer", dataClass: "count", required: false },
    expiresInSeconds: { type: "integer", dataClass: "count", required: true },
    quotaStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["within-quota", "exceeded"],
    },
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "capability",
  failureClasses: ["activity-log-pin"],
  proofIds: ["activity-log.pin.created.emitted-line"],
  releaseImpact: "patch",
});

const ACTIVITY_LOG_PIN_EXPIRED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "activity-log.pin.expired",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/server-log.pinExpiredEvidence",
  fields: {
    pinId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 24 },
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
    releasedSegmentCount: { type: "integer", dataClass: "count", required: true },
    releasedBytes: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "capability",
  failureClasses: ["activity-log-pin"],
  proofIds: ["activity-log.pin.expired.emitted-line"],
  releaseImpact: "patch",
});

const ACTIVITY_LOG_PIN_QUOTA_EXHAUSTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "activity-log.pin.quota-exhausted",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/server-log.pinQuotaExhaustedEvidence",
  fields: {
    pinQuotaBytes: { type: "integer", dataClass: "count", required: true },
    requestedPinnedBytes: { type: "integer", dataClass: "count", required: true },
    protectedPinnedBytes: { type: "integer", dataClass: "count", required: true },
    protectedSegmentCount: { type: "integer", dataClass: "count", required: true },
    unprotectedSegmentCount: { type: "integer", dataClass: "count", required: true },
    unprotectedBytes: { type: "integer", dataClass: "count", required: true },
    unprotectedSeqSpan: { type: "integer", dataClass: "count", required: true },
    unknownSpanSegmentCount: { type: "integer", dataClass: "count", required: true },
    activePinCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "loss",
  analyzerProjection: "failure-cluster",
  failureClasses: ["activity-log-pin"],
  proofIds: ["activity-log.pin.quota-exhausted.emitted-line"],
  releaseImpact: "patch",
});

// ─── The one writer per Activity Log directory ─────────────────────────────────────────────────

type PersistedWriterCapability = Extract<ActivityLogWriterCapabilityState, "active" | "degraded">;

interface ActiveSegment {
  readonly identity: ActivityLogSegmentIdentity;
  readonly segmentId: string;
  readonly activeName: string;
  readonly activePath: string;
  readonly sealedPath: string;
  readonly wallStartMs: number;
  readonly monotonicStartMs: number;
  handle: number | null;
  firstSeq: number | undefined;
  lastSeq: number | undefined;
  lineCount: number;
  droppedEvents: number;
}

interface QueuedEvidence {
  readonly event: ServerLogEvent;
  readonly capability: PersistedWriterCapability;
}

// ONE ActiveLog PER DIRECTORY, PROCESS-WIDE: every sink on the directory shares this process's one
// active segment, its evidence queue and its pressure state; the level threshold stays per sink.
interface ActiveLog {
  readonly directory: string;
  // The Activity Log directory itself is the trust root of every mutation: invariant 15 requires it
  // to be owner-only and non-redirected, and its identity is rechecked around each seal and delete.
  readonly trustedRoot: string;
  readonly config: ActivityLogStorageConfig;
  segment: ActiveSegment | undefined;
  nextIndex: number;
  lastStartMs: number;
  pendingNewline: boolean;
  readonly pendingEvidence: QueuedEvidence[];
  readonly blocked: Map<BlockingPressure, number>;
  admissionRetryAtMs: number;
  standingPressure: StandingPressure | undefined;
  quotaExhaustedReported: boolean;
  recoveredSegments: number;
  readonly failedDeletions: Set<string>;
  readonly failedRecoveries: Set<string>;
  sealTimer: ReturnType<typeof setInterval> | undefined;
}

// The correlation of the operation whose write triggered storage work, and the identity that write
// already claimed (D2: its first persisted record uses it; later records claim in write order).
interface WriteCursor {
  claimed: ServerLogIdentity | undefined;
  readonly correlationId: string | undefined;
}

const SEAL_RESERVE_BYTES = MAX_LOG_LINE_BYTES + 1;
// `seq` can gain digits between measuring a line and writing it; never more than this many.
const SEQ_GROWTH_MARGIN_BYTES = 16;
const MAX_ROLLOVERS_PER_WRITE = 8;
const MAX_QUEUED_EVIDENCE = 256;
const CLOCK_TOLERANCE_MS = 5_000;
const ADMISSION_RETRY_MS = 1_000;
const SEALED_SEGMENT_MODE = 0o400;

const activeLogs = new Map<string, ActiveLog>();

function activeLogKey(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return resolvePath(directory);
  }
}

function resolveActiveLog(directory: string, config: ActivityLogStorageConfig): ActiveLog {
  const key = activeLogKey(directory);
  const existing = activeLogs.get(key);
  if (existing !== undefined) return existing;
  const created: ActiveLog = {
    directory,
    trustedRoot: directory,
    config,
    segment: undefined,
    nextIndex: 1,
    lastStartMs: 0,
    pendingNewline: false,
    pendingEvidence: [],
    blocked: new Map<BlockingPressure, number>(),
    admissionRetryAtMs: 0,
    standingPressure: undefined,
    quotaExhaustedReported: false,
    recoveredSegments: 0,
    failedDeletions: new Set<string>(),
    failedRecoveries: new Set<string>(),
    sealTimer: undefined,
  };
  activeLogs.set(key, created);
  return created;
}

function peekIdentity(
  cursor: WriteCursor,
  capability: PersistedWriterCapability,
): ServerLogIdentity {
  const claimed = cursor.claimed;
  if (claimed !== undefined) return { ...claimed, writerCapability: capability };
  return { ...serverLogProcessIdentity(capability), seq: nextProcessSeq };
}

function nextIdentity(
  cursor: WriteCursor,
  capability: PersistedWriterCapability,
): ServerLogIdentity {
  const claimed = cursor.claimed;
  if (claimed === undefined) return allocateServerLogIdentity(capability);
  cursor.claimed = undefined;
  return { ...claimed, writerCapability: capability };
}

function queueEvidence(
  active: ActiveLog,
  event: ServerLogEvent,
  capability: PersistedWriterCapability = "active",
): void {
  if (active.pendingEvidence.length >= MAX_QUEUED_EVIDENCE) {
    reportServerLogFailure(new SafeArtifactFileError("activity-log", "write-failed"), {
      op: event.op,
      correlationId: event.correlationId,
      loss: "event-dropped",
    });
    return;
  }
  active.pendingEvidence.push({ event, capability });
}

function closeQuietly(handle: number): void {
  try {
    closeSync(handle);
  } catch {
    // A descriptor we can no longer close is a descriptor we must stop using either way.
  }
}

interface LogFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

function trustedLogIdentity(stat: ReturnType<typeof fstatSync>): LogFileIdentity | undefined {
  if (!stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size < 0) {
    return undefined;
  }
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
  };
}

function pathLogIdentity(path: string): LogFileIdentity | undefined {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size < 0) {
    return undefined;
  }
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameLogNode(left: LogFileIdentity, right: LogFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

// The segment's current size when its cached descriptor still names the inode at its active path,
// else `undefined`. Checked before and after every append, so a peer or operator that replaced or
// removed the path forces a new segment instead of bytes landing on a stale or unlinked inode.
function currentSegmentSize(segment: ActiveSegment): number | undefined {
  if (segment.handle === null) return undefined;
  try {
    const opened = trustedLogIdentity(fstatSync(segment.handle));
    const pathname = pathLogIdentity(segment.activePath);
    return opened !== undefined && pathname !== undefined && sameLogNode(opened, pathname)
      ? opened.size
      : undefined;
  } catch {
    return undefined;
  }
}

function stopSealTimer(active: ActiveLog): void {
  if (active.sealTimer === undefined) return;
  clearInterval(active.sealTimer);
  active.sealTimer = undefined;
}

// A live owner seals its own idle segment within one segment window, which is what lets another
// process treat an active segment older than two windows as abandoned (pid reuse) without ever
// taking over a healthy writer's file.
function startSealTimer(active: ActiveLog): void {
  stopSealTimer(active);
  const periodMs = Math.max(1_000, Math.min(60_000, active.config.segmentSeconds * 250));
  const timer = setInterval(() => {
    sealIfExpired(active, { claimed: undefined, correlationId: undefined });
  }, periodMs);
  timer.unref();
  active.sealTimer = timer;
}

function abandonSegment(active: ActiveLog): void {
  const segment = active.segment;
  if (segment === undefined) return;
  active.segment = undefined;
  stopSealTimer(active);
  if (segment.handle !== null) closeQuietly(segment.handle);
  segment.handle = null;
  active.pendingNewline = false;
}

function noteSegmentLine(segment: ActiveSegment, seq: number): void {
  segment.firstSeq ??= seq;
  segment.lastSeq = seq;
  segment.lineCount += 1;
}

// ─── Evidence builders ─────────────────────────────────────────────────────────────────────────

function safeOpenEvidence(correlationId: string | undefined): ServerLogEvent {
  return activityLogEvent(
    SERVER_LOG_SAFE_OPEN_OPERATION,
    { correlationId: correlationIdOrUnknown(correlationId) },
    {
      artifactClass: "activity-log",
      persistenceStatus: "opened",
      permissionAssurance: safeArtifactPermissionAssurance(),
      containmentAssurance: safeArtifactContainmentAssurance(),
      completeness: "complete",
      loss: "none",
    },
  );
}

function mutationEvidence(event: ServerLogEvent): ServerLogEvent {
  return activityLogEvent(
    SERVER_LOG_TARGET_MUTATED_OPERATION,
    {
      level: "error",
      correlationId: correlationIdOrUnknown(event.correlationId),
      errorKind: "target-mutated",
    },
    {
      failedOp: redactLogLabel(event.op),
      artifactClass: "activity-log",
      permissionAssurance: safeArtifactPermissionAssurance(),
      containmentAssurance: safeArtifactContainmentAssurance(),
      completeness: "unknown",
      loss: "event-location-unknown",
    },
  );
}

interface SealFacts {
  readonly reason: SealReason;
  readonly seq: number;
  readonly segmentBytes: number;
  readonly correlationId: string | undefined;
}

function segmentSealedEvidence(
  segment: ActiveSegment,
  facts: SealFacts,
  config: ActivityLogStorageConfig,
): ServerLogEvent {
  const dropped = segment.droppedEvents;
  return activityLogEvent(
    ACTIVITY_LOG_SEGMENT_SEALED_OPERATION,
    { correlationId: correlationIdOrUnknown(facts.correlationId) },
    {
      sealReason: facts.reason,
      segmentIndex: segment.identity.index,
      segmentFirstSeq: segment.firstSeq ?? facts.seq,
      segmentLastSeq: facts.seq,
      segmentLineCount: segment.lineCount,
      segmentBytes: facts.segmentBytes,
      segmentDurationMs: Math.max(0, Math.round(performance.now() - segment.monotonicStartMs)),
      droppedEventCount: dropped,
      segmentByteLimit: config.segmentBytes,
      segmentSecondsLimit: config.segmentSeconds,
      completeness: dropped > 0 ? "partial" : "complete",
      loss: dropped > 0 ? "event-dropped" : "none",
    },
  );
}

interface RecoveryOutcome {
  readonly status: "sealed" | "failed";
  readonly kind: "unsealed" | "interrupted-seal";
  readonly owner: ActivityLogOrphanOwner;
  readonly tail: ActivityLogSegmentTail | undefined;
  readonly segment: ActivityLogSegmentFileName;
  readonly segmentBytes: number;
  readonly errorKind: ActivityLogErrorKind | undefined;
}

function recoveryLoss(outcome: RecoveryOutcome): "none" | "event-dropped" {
  return outcome.tail?.tailState === "truncated" ? "event-dropped" : "none";
}

interface RecoveredTailFields {
  readonly tailState: "terminated" | "truncated" | "unknown";
  readonly truncatedBytes: number;
  readonly segmentBytes: number;
}

function recoveredTailFields(outcome: RecoveryOutcome): RecoveredTailFields {
  const tail = outcome.tail;
  return tail === undefined
    ? { tailState: "unknown", truncatedBytes: 0, segmentBytes: outcome.segmentBytes }
    : {
        tailState: tail.tailState,
        truncatedBytes: tail.truncatedBytes,
        segmentBytes: tail.sizeBytes,
      };
}

function segmentRecoveredEvidence(
  outcome: RecoveryOutcome,
  correlationId: string | undefined,
): ServerLogEvent {
  const failed = outcome.status === "failed";
  const tail = recoveredTailFields(outcome);
  return activityLogEvent(
    ACTIVITY_LOG_SEGMENT_RECOVERED_OPERATION,
    {
      level: failed ? "error" : "warn",
      correlationId: correlationIdOrUnknown(correlationId),
      ...(outcome.errorKind === undefined ? {} : { errorKind: outcome.errorKind }),
    },
    {
      recoveryStatus: outcome.status,
      recoveryKind: outcome.kind,
      ownerState: outcome.owner,
      tailState: tail.tailState,
      truncatedBytes: tail.truncatedBytes,
      segmentBytes: tail.segmentBytes,
      segmentIndex: outcome.segment.index,
      recoveredInstanceId: outcome.segment.instanceId,
      // An orphan's owner never recorded its own end, so its completeness cannot be proven; only a
      // seal whose rename alone was interrupted carries the owner's own complete seal line.
      completeness: outcome.kind === "interrupted-seal" && !failed ? "complete" : "unknown",
      loss: recoveryLoss(outcome),
    },
  );
}

function retentionStatus(outcome: ActivityLogRetentionOutcome): "pruned" | "partial" | "failed" {
  if (outcome.failedNames.length === 0) return "pruned";
  return outcome.prunedSegmentCount + outcome.prunedLegacyFileCount > 0 ? "partial" : "failed";
}

function retentionPrunedEvidence(
  outcome: ActivityLogRetentionOutcome,
  config: ActivityLogStorageConfig,
  correlationId: string | undefined,
): ServerLogEvent {
  const status = retentionStatus(outcome);
  return activityLogEvent(
    ACTIVITY_LOG_RETENTION_PRUNED_OPERATION,
    {
      level: status === "pruned" ? "info" : "warn",
      correlationId: correlationIdOrUnknown(correlationId),
      ...(status === "pruned" ? {} : { errorKind: "durability-failed" as const }),
    },
    {
      retentionStatus: status,
      prunedSegmentCount: outcome.prunedSegmentCount,
      prunedLegacyFileCount: outcome.prunedLegacyFileCount,
      prunedBytes: outcome.prunedBytes,
      prunedByAgeCount: outcome.prunedByAgeCount,
      prunedByBudgetCount: outcome.prunedByBudgetCount,
      failedDeletionCount: outcome.failedNames.length,
      retainedFileCount: outcome.retainedFileCount,
      retainedBytes: outcome.retainedBytes,
      protectedPinnedBytes: outcome.protection.protectedBytes,
      retentionBudgetBytes: config.retentionBytes,
      retentionDays: config.retentionDays,
      completeness: status === "pruned" ? "complete" : "partial",
      loss: "none",
    },
  );
}

const PRESSURE_ERROR_KIND: Readonly<
  Record<Exclude<ActivityLogPressureState, "none">, ActivityLogErrorKind>
> = {
  "low-disk-space": "unavailable",
  "disk-full": "write-failed",
  backpressure: "write-failed",
  "budget-exceeded": "unavailable",
  "retention-blocked": "durability-failed",
};

interface PressureFacts {
  readonly state: Exclude<ActivityLogPressureState, "none"> | "cleared";
  readonly previousState?: StandingPressure | undefined;
  readonly droppedEventCount: number;
  readonly usedBytes?: number | undefined;
  readonly freeBytes?: number | undefined;
}

function pressureEvidence(
  facts: PressureFacts,
  config: ActivityLogStorageConfig,
  correlationId: string | undefined,
): ServerLogEvent {
  const lost = facts.droppedEventCount > 0;
  return activityLogEvent(
    ACTIVITY_LOG_PRESSURE_OPERATION,
    {
      level: facts.state === "cleared" ? "info" : "warn",
      correlationId: correlationIdOrUnknown(correlationId),
      ...(facts.state === "cleared" ? {} : { errorKind: PRESSURE_ERROR_KIND[facts.state] }),
    },
    {
      pressureState: facts.state,
      ...(facts.previousState === undefined ? {} : { previousState: facts.previousState }),
      droppedEventCount: facts.droppedEventCount,
      ...(facts.usedBytes === undefined ? {} : { usedBytes: facts.usedBytes }),
      budgetBytes: config.retentionBytes,
      pinQuotaBytes: config.pinQuotaBytes,
      ...(facts.freeBytes === undefined ? {} : { freeBytes: facts.freeBytes }),
      completeness: lost ? "partial" : "complete",
      loss: lost ? "event-dropped" : "none",
    },
  );
}

interface PinEvidenceFacts {
  readonly pinId: string | undefined;
  readonly status: "created" | "rejected";
  readonly rejectionReason: ActivityLogPinRejection | undefined;
  readonly scope: ActivityLogPinScope | undefined;
  readonly reason: ActivityLogPinReason;
  readonly pinnedSegmentCount: number;
  readonly pinnedBytes: number;
  readonly expiresInSeconds: number;
  readonly quotaStatus: "within-quota" | "exceeded" | undefined;
}

function pinWindowSeconds(scope: ActivityLogPinScope | undefined): number | undefined {
  return scope?.kind === "window" ? Math.ceil((scope.toMs - scope.fromMs) / 1000) : undefined;
}

interface PinOptionalFields {
  readonly pinId?: string;
  readonly rejectionReason?: ActivityLogPinRejection;
  readonly windowSeconds?: number;
  readonly quotaStatus?: "within-quota" | "exceeded";
}

function pinOptionalFields(facts: PinEvidenceFacts): PinOptionalFields {
  const windowSeconds = pinWindowSeconds(facts.scope);
  return {
    ...(facts.pinId === undefined ? {} : { pinId: facts.pinId }),
    ...(facts.rejectionReason === undefined ? {} : { rejectionReason: facts.rejectionReason }),
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
    ...(facts.quotaStatus === undefined ? {} : { quotaStatus: facts.quotaStatus }),
  };
}

function pinCreatedEvidence(
  facts: PinEvidenceFacts,
  correlationId: string | undefined,
): ServerLogEvent {
  const rejected = facts.status === "rejected";
  const degraded = rejected || facts.quotaStatus === "exceeded";
  return activityLogEvent(
    ACTIVITY_LOG_PIN_CREATED_OPERATION,
    {
      level: degraded ? "warn" : "info",
      correlationId: correlationIdOrUnknown(correlationId),
      ...(rejected ? { errorKind: pinRejectionErrorKind(facts.rejectionReason) } : {}),
    },
    {
      ...pinOptionalFields(facts),
      pinStatus: facts.status,
      pinKind: facts.scope?.kind === "window" ? "window" : "segments",
      pinReason: facts.reason,
      pinnedSegmentCount: facts.pinnedSegmentCount,
      pinnedBytes: facts.pinnedBytes,
      expiresInSeconds: facts.expiresInSeconds,
      completeness: degraded ? "partial" : "complete",
      loss: "none",
    },
  );
}

function pinRejectionErrorKind(reason: ActivityLogPinRejection | undefined): ActivityLogErrorKind {
  if (reason === "invalid-request") return "invalid-request";
  return reason === "pin-limit-reached" ? "rate-limited" : "unavailable";
}

interface PinExpiryFacts {
  readonly pinId: string;
  readonly reason: "expired" | "invalid-record";
  readonly removed: boolean;
  readonly releasedSegmentCount: number;
  readonly releasedBytes: number;
}

function pinExpiredEvidence(
  facts: PinExpiryFacts,
  correlationId: string | undefined,
): ServerLogEvent {
  return activityLogEvent(
    ACTIVITY_LOG_PIN_EXPIRED_OPERATION,
    {
      level: facts.removed ? "info" : "warn",
      correlationId: correlationIdOrUnknown(correlationId),
      ...(facts.removed ? {} : { errorKind: "durability-failed" as const }),
    },
    {
      pinId: facts.pinId,
      expiryReason: facts.reason,
      removalStatus: facts.removed ? "removed" : "failed",
      releasedSegmentCount: facts.releasedSegmentCount,
      releasedBytes: facts.releasedBytes,
      completeness: facts.removed ? "complete" : "partial",
      loss: "none",
    },
  );
}

interface QuotaFacts {
  readonly outcome: ActivityLogRetentionOutcome;
  readonly pinCount: number;
  readonly seqSpan: number;
  readonly unknownSpanSegmentCount: number;
}

function pinQuotaExhaustedEvidence(
  facts: QuotaFacts,
  config: ActivityLogStorageConfig,
  correlationId: string | undefined,
): ServerLogEvent {
  const protection = facts.outcome.protection;
  return activityLogEvent(
    ACTIVITY_LOG_PIN_QUOTA_EXHAUSTED_OPERATION,
    {
      level: "error",
      correlationId: correlationIdOrUnknown(correlationId),
      errorKind: "unavailable",
    },
    {
      pinQuotaBytes: config.pinQuotaBytes,
      requestedPinnedBytes: protection.requestedBytes,
      protectedPinnedBytes: protection.protectedBytes,
      protectedSegmentCount: protection.protectedNames.size,
      unprotectedSegmentCount: protection.unprotected.length,
      unprotectedBytes: protection.unprotected.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      unprotectedSeqSpan: facts.seqSpan,
      unknownSpanSegmentCount: facts.unknownSpanSegmentCount,
      activePinCount: facts.pinCount,
      completeness: "partial",
      loss: "event-dropped",
    },
  );
}

// ─── Maintenance: recovery, pin expiry, retention, quota, pressure ─────────────────────────────

function sharesInode(left: string, right: string): boolean {
  try {
    const a = lstatSync(left);
    const b = lstatSync(right);
    return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function pathMissing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return machineToken(safeProperty(error, "code")) === "ENOENT";
  }
}

function closedErrorKind(error: unknown): ActivityLogErrorKind {
  return activityLogErrorKindOr(errorKindOf(error), "internal");
}

type SegmentEntry = ActivityLogFileEntry & { readonly file: ActivityLogSegmentFileName };

function sealedTwinPath(active: ActiveLog, segment: ActivityLogSegmentIdentity): string {
  return join(active.directory, activityLogSegmentFileName(segment, "sealed"));
}

function readSealedTail(path: string, trustedRoot: string): ActivityLogSegmentTail | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSafeArtifactFile(path, {
      artifactClass: "activity-log",
      mode: "read",
      trustedRoot,
    });
    return inspectActivityLogSegmentTail(descriptor, ACTIVITY_LOG_SEGMENT_SEALED_OPERATION.op);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeQuietly(descriptor);
  }
}

function archiveOptions(active: ActiveLog): { artifactClass: "activity-log"; trustedRoot: string } {
  return { artifactClass: "activity-log", trustedRoot: active.trustedRoot };
}

// A crash between the hard link and the unlink of a seal leaves both names on one inode; finishing
// the archive removes only the active name, and the sealed segment is then inspected as it stands.
function finishInterruptedSeal(
  active: ActiveLog,
  entry: SegmentEntry,
  owner: ActivityLogOrphanOwner,
  sealedPath: string,
): RecoveryOutcome {
  const base = { owner, segment: entry.file, segmentBytes: entry.sizeBytes };
  try {
    archiveSafeArtifactFile(entry.path, sealedPath, archiveOptions(active));
    const tail = readSealedTail(sealedPath, active.trustedRoot);
    return { ...base, status: "sealed", kind: "interrupted-seal", tail, errorKind: undefined };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      kind: "interrupted-seal",
      tail: undefined,
      errorKind: closedErrorKind(error),
    };
  }
}

// Durability and read-only mode are best effort for a file another process wrote: the content is
// never modified, and a platform that cannot apply either still leaves a private sealed segment.
function settleOrphanDescriptor(descriptor: number): void {
  try {
    fsyncSync(descriptor);
  } catch {
    // Some platforms refuse fsync on a read-only descriptor; the sealing rename still proceeds.
  }
  try {
    fchmodSync(descriptor, SEALED_SEGMENT_MODE);
  } catch {
    // The segment stays owner-private (0600); retention and readers accept that mode.
  }
}

function sealOrphanDescriptor(
  active: ActiveLog,
  entry: SegmentEntry,
  descriptor: number,
  sealedPath: string,
): { readonly tail: ActivityLogSegmentTail; readonly archived: boolean } {
  const tail = inspectActivityLogSegmentTail(descriptor, ACTIVITY_LOG_SEGMENT_SEALED_OPERATION.op);
  settleOrphanDescriptor(descriptor);
  const result = archiveSafeArtifactFile(entry.path, sealedPath, archiveOptions(active));
  if (result === "archive-exists") throw new SafeArtifactFileError("activity-log", "target-exists");
  return { tail, archived: result !== "source-missing" };
}

function recoverOrphanedSegment(
  active: ActiveLog,
  entry: SegmentEntry,
  owner: ActivityLogOrphanOwner,
): RecoveryOutcome | undefined {
  const sealedPath = sealedTwinPath(active, entry.file);
  if (sharesInode(entry.path, sealedPath)) {
    return finishInterruptedSeal(active, entry, owner, sealedPath);
  }
  const base = { owner, segment: entry.file, segmentBytes: entry.sizeBytes };
  let descriptor: number;
  try {
    descriptor = openSafeArtifactFile(entry.path, { ...archiveOptions(active), mode: "read" });
  } catch (error) {
    if (pathMissing(entry.path)) return undefined;
    const errorKind = closedErrorKind(error);
    return { ...base, status: "failed", kind: "unsealed", tail: undefined, errorKind };
  }
  try {
    const sealed = sealOrphanDescriptor(active, entry, descriptor, sealedPath);
    if (!sealed.archived) return undefined;
    const kind = sealed.tail.sealLinePresent ? "interrupted-seal" : "unsealed";
    return { ...base, status: "sealed", kind, tail: sealed.tail, errorKind: undefined };
  } catch (error) {
    const errorKind = closedErrorKind(error);
    return { ...base, status: "failed", kind: "unsealed", tail: undefined, errorKind };
  } finally {
    closeQuietly(descriptor);
  }
}

function recoverOrphanedSegments(
  active: ActiveLog,
  cursor: WriteCursor,
  listing: ActivityLogDirectoryListing,
  nowMs: number,
): boolean {
  const context = {
    pid: process.pid,
    instanceId: INSTANCE_ID,
    currentName: active.segment?.activeName,
    nowMs,
    segmentSeconds: active.config.segmentSeconds,
    isAlive: processIsAlive,
  };
  let changed = false;
  for (const entry of listing.files) {
    if (!isActivityLogSegmentEntry(entry) || active.failedRecoveries.has(entry.file.name)) continue;
    const owner = activityLogOrphanOwner(entry, context);
    if (owner === undefined) continue;
    const outcome = recoverOrphanedSegment(active, entry, owner);
    if (outcome === undefined) continue;
    changed = true;
    if (outcome.status === "failed") active.failedRecoveries.add(entry.file.name);
    else active.recoveredSegments += 1;
    queueEvidence(active, segmentRecoveredEvidence(outcome, cursor.correlationId));
  }
  return changed;
}

function pinCoverage(
  pin: ActivityLogPinRecord | undefined,
  files: readonly ActivityLogFileEntry[],
): { readonly count: number; readonly bytes: number } {
  let count = 0;
  let bytes = 0;
  if (pin === undefined) return { count, bytes };
  for (const entry of files) {
    if (entry.file.kind !== "sealed" || !isActivityLogSegmentEntry(entry)) continue;
    if (!activityLogPinCovers(pin, entry)) continue;
    count += 1;
    bytes += entry.sizeBytes;
  }
  return { count, bytes };
}

function removePinRecordQuietly(active: ActiveLog, read: ActivityLogPinRead): boolean {
  try {
    removeActivityLogFile(read.entry.path, active.trustedRoot);
    return true;
  } catch {
    active.failedDeletions.add(read.entry.path);
    return false;
  }
}

// Expired and unreadable pin records protect nothing; removing them is bounded cleanup, and each
// removal is evidenced once. A record this process already failed to remove is not retried.
function expireActivityLogPins(
  active: ActiveLog,
  cursor: WriteCursor,
  listing: ActivityLogDirectoryListing,
  reads: readonly ActivityLogPinRead[],
  nowMs: number,
): void {
  for (const read of reads) {
    if (read.record !== undefined && read.record.expiresAtMs > nowMs) continue;
    if (active.failedDeletions.has(read.entry.path)) continue;
    const coverage = pinCoverage(read.record, listing.files);
    const removed = removePinRecordQuietly(active, read);
    const facts: PinExpiryFacts = {
      pinId: read.entry.pinId,
      reason: read.record === undefined ? "invalid-record" : "expired",
      removed,
      releasedSegmentCount: coverage.count,
      releasedBytes: coverage.bytes,
    };
    queueEvidence(active, pinExpiredEvidence(facts, cursor.correlationId));
  }
}

function tightenLegacyFile(path: string, trustedRoot: string): boolean {
  try {
    // The shared open primitive narrows a non-private owned file to 0600 before handing back a
    // verified descriptor; no byte is read or written.
    closeSync(
      openSafeArtifactFile(path, {
        artifactClass: "activity-log",
        mode: "read-write-existing",
        trustedRoot,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function removeRetentionTarget(active: ActiveLog, entry: ActivityLogFileEntry): boolean {
  try {
    removeActivityLogFile(entry.path, active.trustedRoot);
    return true;
  } catch (error) {
    const permissionUnsafe =
      error instanceof SafeArtifactFileError && error.kind === "permission-unsafe";
    if (!permissionUnsafe || !tightenLegacyFile(entry.path, active.trustedRoot)) return false;
  }
  try {
    removeActivityLogFile(entry.path, active.trustedRoot);
    return true;
  } catch {
    return false;
  }
}

function queueRetentionEvidence(
  active: ActiveLog,
  cursor: WriteCursor,
  outcome: ActivityLogRetentionOutcome,
): void {
  const pruned = outcome.prunedSegmentCount + outcome.prunedLegacyFileCount;
  if (pruned === 0 && outcome.failedNames.length === 0) return;
  queueEvidence(active, retentionPrunedEvidence(outcome, active.config, cursor.correlationId));
}

function unprotectedSpan(
  active: ActiveLog,
  outcome: ActivityLogRetentionOutcome,
): { readonly seqSpan: number; readonly unknown: number } {
  let seqSpan = 0;
  let unknown = 0;
  for (const entry of outcome.protection.unprotected) {
    const span = activityLogSegmentSeqSpan(entry.path, active.trustedRoot);
    if (span === undefined) unknown += 1;
    else seqSpan += span;
  }
  return { seqSpan, unknown };
}

// Exactly one loss marker per exhaustion episode: the first pass that finds pinned evidence the
// quota cannot hold reports it, later passes stay quiet until the quota holds every pin again.
function queueQuotaEvidence(
  active: ActiveLog,
  cursor: WriteCursor,
  outcome: ActivityLogRetentionOutcome,
  pinCount: number,
): void {
  if (outcome.protection.unprotected.length === 0) {
    active.quotaExhaustedReported = false;
    return;
  }
  if (active.quotaExhaustedReported) return;
  active.quotaExhaustedReported = true;
  const span = unprotectedSpan(active, outcome);
  const facts: QuotaFacts = {
    outcome,
    pinCount,
    seqSpan: span.seqSpan,
    unknownSpanSegmentCount: span.unknown,
  };
  queueEvidence(active, pinQuotaExhaustedEvidence(facts, active.config, cursor.correlationId));
}

function standingPressure(
  active: ActiveLog,
  outcome: ActivityLogRetentionOutcome,
  freeBytes: number | undefined,
): StandingPressure | undefined {
  if (outcome.failedNames.length > 0) return "retention-blocked";
  const lowDisk = activityLogLowDiskThresholdBytes(active.config);
  return freeBytes !== undefined && freeBytes < lowDisk ? "low-disk-space" : undefined;
}

// Standing conditions are reported on entry and once more when they clear; conditions that block
// writing (disk full, backpressure, an exhausted budget) are reported when writing resumes, with the
// exact number of events they cost.
function queuePressureTransition(
  active: ActiveLog,
  cursor: WriteCursor,
  outcome: ActivityLogRetentionOutcome,
): void {
  const freeBytes = activityLogFreeBytes(active.directory);
  const state = standingPressure(active, outcome, freeBytes);
  const previous = active.standingPressure;
  if (state === previous) return;
  active.standingPressure = state;
  const facts: PressureFacts =
    state === undefined
      ? { state: "cleared", previousState: previous, droppedEventCount: 0, freeBytes }
      : { state, droppedEventCount: 0, usedBytes: outcome.usageBytes, freeBytes };
  queueEvidence(active, pressureEvidence(facts, active.config, cursor.correlationId));
}

function pinRecordBytes(reads: readonly ActivityLogPinRead[], nowMs: number): number {
  return reads
    .filter((read) => read.record !== undefined && read.record.expiresAtMs > nowMs)
    .reduce((sum, read) => sum + read.entry.sizeBytes, 0);
}

function applyRetention(
  active: ActiveLog,
  cursor: WriteCursor,
  nowMs: number,
  reserveBytes: number,
): ActivityLogRetentionOutcome {
  const listing = listActivityLogDirectory(active.directory);
  const reads = readActivityLogPins(listing, active.trustedRoot);
  expireActivityLogPins(active, cursor, listing, reads, nowMs);
  const pins = activeActivityLogPins(reads, nowMs);
  const outcome = applyActivityLogRetention(
    {
      files: listing.files,
      pins,
      pinRecordBytes: pinRecordBytes(reads, nowMs),
      config: active.config,
      nowMs,
      reserveBytes,
      skipNames: active.failedDeletions,
    },
    (entry) => removeRetentionTarget(active, entry),
  );
  for (const name of outcome.failedNames) active.failedDeletions.add(name);
  queueRetentionEvidence(active, cursor, outcome);
  queueQuotaEvidence(active, cursor, outcome, pins.length);
  queuePressureTransition(active, cursor, outcome);
  return outcome;
}

// Runs before every new segment: recover orphans, expire pins, apply retention with the new
// segment's reservation, and report quota and pressure. Returns whether the reservation fits.
function runMaintenance(active: ActiveLog, cursor: WriteCursor, reserveBytes: number): boolean {
  const nowMs = Date.now();
  recoverOrphanedSegments(active, cursor, listActivityLogDirectory(active.directory), nowMs);
  return applyRetention(active, cursor, nowMs, reserveBytes).admitted;
}

// ─── Segment lifecycle ─────────────────────────────────────────────────────────────────────────

function nextSegmentIdentity(active: ActiveLog): ActivityLogSegmentIdentity {
  // Monotonic per instance even when the wall clock steps backwards, so an instance's segments
  // never sort out of index order.
  const startMs = Math.max(Date.now(), active.lastStartMs);
  active.lastStartMs = startMs;
  const index = active.nextIndex;
  active.nextIndex += 1;
  return { startMs, pid: process.pid, instanceId: INSTANCE_ID, index };
}

function installSegment(
  active: ActiveLog,
  identity: ActivityLogSegmentIdentity,
  handle: number,
  cursor: WriteCursor,
): ActiveSegment {
  const activeName = activityLogSegmentFileName(identity, "active");
  const segment: ActiveSegment = {
    identity,
    segmentId: formatActivityLogSegmentId(identity),
    activeName,
    activePath: join(active.directory, activeName),
    sealedPath: sealedTwinPath(active, identity),
    wallStartMs: Date.now(),
    monotonicStartMs: performance.now(),
    handle,
    firstSeq: undefined,
    lastSeq: undefined,
    lineCount: 0,
    droppedEvents: 0,
  };
  active.segment = segment;
  active.pendingNewline = false;
  // The segment's first line is its own safe-open evidence, ahead of any queued maintenance record.
  active.pendingEvidence.unshift({
    event: safeOpenEvidence(cursor.correlationId),
    capability: "active",
  });
  startSealTimer(active);
  return segment;
}

function admitNewSegment(active: ActiveLog, cursor: WriteCursor): void {
  const nowMs = Date.now();
  if (active.blocked.has("budget-exceeded") && nowMs < active.admissionRetryAtMs) {
    throw new ActivityLogBudgetError();
  }
  if (runMaintenance(active, cursor, active.config.segmentBytes)) return;
  active.admissionRetryAtMs = nowMs + ADMISSION_RETRY_MS;
  throw new ActivityLogBudgetError();
}

function openSegment(active: ActiveLog, cursor: WriteCursor): ActiveSegment {
  admitNewSegment(active, cursor);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const identity = nextSegmentIdentity(active);
    const path = join(active.directory, activityLogSegmentFileName(identity, "active"));
    try {
      const handle = openSafeArtifactFile(path, {
        artifactClass: "activity-log",
        mode: "exclusive-create",
        trustedRoot: active.trustedRoot,
      });
      return installSegment(active, identity, handle, cursor);
    } catch (error) {
      // Only a leftover of this very instance can own the name; skip to the next index.
      if (!(error instanceof SafeArtifactFileError) || error.kind !== "target-exists") throw error;
    }
  }
  throw new SafeArtifactFileError("activity-log", "target-exists");
}

interface OpenSegment {
  readonly segment: ActiveSegment;
  readonly sizeBytes: number;
}

function ensureSegment(active: ActiveLog, cursor: WriteCursor): OpenSegment {
  const current = active.segment;
  if (current !== undefined) {
    const sizeBytes = currentSegmentSize(current);
    if (sizeBytes !== undefined) return { segment: current, sizeBytes };
    abandonSegment(active);
  }
  const segment = openSegment(active, cursor);
  return { segment, sizeBytes: currentSegmentSize(segment) ?? 0 };
}

function restrictSealedMode(handle: number): void {
  try {
    fchmodSync(handle, SEALED_SEGMENT_MODE);
  } catch {
    // The sealed segment stays owner-private (0600); it is still never opened for writing again.
  }
}

function descriptorAtPath(handle: number, path: string): boolean {
  try {
    const opened = fstatSync(handle);
    const pathname = lstatSync(path);
    return pathname.isFile() && opened.dev === pathname.dev && opened.ino === pathname.ino;
  } catch {
    return false;
  }
}

function writeSealAndPublish(
  active: ActiveLog,
  segment: ActiveSegment,
  handle: number,
  cursor: WriteCursor,
  reason: SealReason,
): void {
  const segmentBytes = currentSegmentSize(segment);
  if (segmentBytes === undefined) throw new SafeArtifactFileError("activity-log", "target-mutated");
  const identity = nextIdentity(cursor, "active");
  const facts: SealFacts = {
    reason,
    seq: identity.seq,
    segmentBytes,
    correlationId: cursor.correlationId,
  };
  const event = segmentSealedEvidence(segment, facts, active.config);
  writeRecord(active, handle, formatRegisteredServerLogLine(event, new Date(), identity));
  noteSegmentLine(segment, identity.seq);
  fsyncSync(handle);
  archiveSafeArtifactFile(segment.activePath, segment.sealedPath, archiveOptions(active));
  if (!descriptorAtPath(handle, segment.sealedPath)) {
    throw new SafeArtifactFileError("activity-log", "target-mutated");
  }
  // Applied after the rename: on Windows the read-only attribute would otherwise follow the inode
  // into the unlink of the active name.
  restrictSealedMode(handle);
}

// Seals the active segment: a final registered seal line, fsync, the guarded rename that drops
// `.active`, then read-only mode. On any failure the file keeps its active name and this process's
// next maintenance pass seals it as its own abandoned segment; the writer never appends to it again.
function sealSegment(active: ActiveLog, cursor: WriteCursor, reason: SealReason): void {
  const segment = active.segment;
  if (segment === undefined) return;
  active.segment = undefined;
  stopSealTimer(active);
  const handle = segment.handle;
  try {
    if (handle === null) throw new SafeArtifactFileError("activity-log", "target-mutated");
    writeSealAndPublish(active, segment, handle, cursor, reason);
  } catch (error) {
    reportServerLogFailure(error, {
      op: ACTIVITY_LOG_SEGMENT_SEALED_OPERATION.op,
      correlationId: cursor.correlationId,
      loss: "event-dropped",
    });
  } finally {
    segment.handle = null;
    if (handle !== null) closeQuietly(handle);
    active.pendingNewline = false;
  }
}

function segmentExpiryReason(
  segment: ActiveSegment,
  config: ActivityLogStorageConfig,
): SealReason | undefined {
  const wallElapsed = Date.now() - segment.wallStartMs;
  if (wallElapsed < -CLOCK_TOLERANCE_MS) return "clock-change";
  const elapsed = Math.max(wallElapsed, performance.now() - segment.monotonicStartMs);
  return elapsed >= config.segmentSeconds * 1000 ? "age-limit" : undefined;
}

function sealIfExpired(active: ActiveLog, cursor: WriteCursor): void {
  const segment = active.segment;
  if (segment === undefined) return;
  const reason = segmentExpiryReason(segment, active.config);
  if (reason !== undefined) sealSegment(active, cursor, reason);
}

// ─── Record placement ──────────────────────────────────────────────────────────────────────────

interface PlacedRecord {
  readonly event: ServerLogEvent;
  readonly capability: PersistedWriterCapability;
}

function persistPostWriteMutation(
  active: ActiveLog,
  event: ServerLogEvent,
  cursor: WriteCursor,
): void {
  abandonSegment(active);
  queueEvidence(active, mutationEvidence(event));
  try {
    writeQueued(active, cursor, undefined);
  } catch {
    // The caller reports the event whose location is unknown; the evidence stays queued.
  }
}

// Appends `record` when it fits below the byte bound with room for the seal line; returns the bytes
// it added, or 0 when the segment must be sealed first. The line is formatted once with the
// identity it will carry: nothing can claim a `seq` between measuring and writing it.
function appendIfFits(
  active: ActiveLog,
  open: OpenSegment,
  cursor: WriteCursor,
  record: PlacedRecord,
): number {
  const identity = peekIdentity(cursor, record.capability);
  const line = formatEventLine(record.event, undefined, identity);
  const bytes = serverLogLineBytes(line) + (active.pendingNewline ? 1 : 0);
  if (
    open.sizeBytes + bytes + SEQ_GROWTH_MARGIN_BYTES + SEAL_RESERVE_BYTES >
    active.config.segmentBytes
  ) {
    return 0;
  }
  const claimed = nextIdentity(cursor, record.capability);
  const handle = open.segment.handle;
  if (handle === null) throw new SafeArtifactFileError("activity-log", "target-mutated");
  writeRecord(
    active,
    handle,
    claimed.seq === identity.seq ? line : formatEventLine(record.event, undefined, claimed),
  );
  noteSegmentLine(open.segment, claimed.seq);
  if (currentSegmentSize(open.segment) === undefined) {
    persistPostWriteMutation(active, record.event, cursor);
    throw new PostWriteMutationError();
  }
  return bytes;
}

type RecordSource =
  | { readonly kind: "queued"; readonly record: PlacedRecord }
  | { readonly kind: "blocked"; readonly record: PlacedRecord; readonly state: BlockingPressure }
  | { readonly kind: "caller"; readonly record: PlacedRecord };

type Placement =
  | { readonly status: "placed"; readonly bytes: number }
  | { readonly status: "skipped" }
  | { readonly status: "full" };

// Order inside one segment: queued storage evidence (safe-open first), then the loss a blocking
// condition caused while writing was impossible, then the caller's own record. A blocking count is
// cleared only once its line is on disk, so a still-full disk accumulates one exact count instead of
// queueing a line per failed attempt.
function nextRecord(
  active: ActiveLog,
  cursor: WriteCursor,
  caller: ServerLogEvent | undefined,
): RecordSource | undefined {
  const queued = active.pendingEvidence[0];
  if (queued !== undefined) return { kind: "queued", record: queued };
  const blocked = [...active.blocked.entries()][0];
  if (blocked !== undefined) {
    const [state, droppedEventCount] = blocked;
    const event = pressureEvidence(
      { state, droppedEventCount },
      active.config,
      cursor.correlationId,
    );
    return { kind: "blocked", state, record: { event, capability: "degraded" } };
  }
  return caller === undefined
    ? undefined
    : { kind: "caller", record: { event: caller, capability: "active" } };
}

function consumeRecord(active: ActiveLog, source: RecordSource): void {
  if (source.kind === "queued") active.pendingEvidence.shift();
  else if (source.kind === "blocked") active.blocked.delete(source.state);
}

function placeRecord(
  active: ActiveLog,
  open: OpenSegment,
  cursor: WriteCursor,
  source: RecordSource,
): Placement {
  let bytes: number;
  try {
    bytes = appendIfFits(active, open, cursor, source.record);
  } catch (error) {
    if (source.kind === "caller" || !(error instanceof ActivityLogEventValidationError))
      throw error;
    // A storage-evidence record the registry rejects is dropped and reported; it must never block
    // every later write behind it.
    consumeRecord(active, source);
    reportServerLogFailure(error, { op: source.record.event.op, loss: "event-dropped" });
    return { status: "skipped" };
  }
  if (bytes === 0) return { status: "full" };
  consumeRecord(active, source);
  return { status: "placed", bytes };
}

function rollOver(active: ActiveLog, cursor: WriteCursor, rollovers: number): number {
  if (rollovers >= MAX_ROLLOVERS_PER_WRITE) throw new ActivityLogBackpressureError();
  sealSegment(active, cursor, "size-limit");
  return rollovers + 1;
}

// Writes every queued evidence record and blocking-loss count, then `caller`, rolling over to a new
// segment whenever the next record would pass the byte bound. Bounded: a write that cannot be placed
// after a handful of rollovers is dropped and reported rather than looping.
function writeQueued(
  active: ActiveLog,
  cursor: WriteCursor,
  caller: ServerLogEvent | undefined,
): void {
  let pendingCaller = caller;
  let rollovers = 0;
  let open: OpenSegment | undefined;
  for (;;) {
    open ??= ensureSegment(active, cursor);
    const source = nextRecord(active, cursor, pendingCaller);
    if (source === undefined) return;
    const placement = placeRecord(active, open, cursor, source);
    if (placement.status === "full") {
      rollovers = rollOver(active, cursor, rollovers);
      open = undefined;
      continue;
    }
    if (placement.status === "placed") {
      open = { segment: open.segment, sizeBytes: open.sizeBytes + placement.bytes };
    }
    if (source.kind === "caller") pendingCaller = undefined;
  }
}

function blockingPressure(error: unknown): BlockingPressure | undefined {
  if (error instanceof ActivityLogDiskFullError) return "disk-full";
  if (error instanceof ActivityLogBackpressureError) return "backpressure";
  return error instanceof ActivityLogBudgetError ? "budget-exceeded" : undefined;
}

function noteDroppedEvent(active: ActiveLog, error: unknown): void {
  if (active.segment !== undefined) active.segment.droppedEvents += 1;
  const state = blockingPressure(error);
  if (state === undefined) return;
  active.blocked.set(state, (active.blocked.get(state) ?? 0) + 1);
}

function persistCallerEvent(active: ActiveLog, event: ServerLogEvent, cursor: WriteCursor): void {
  sealIfExpired(active, cursor);
  writeQueued(active, cursor, event);
}

function closeActiveLog(active: ActiveLog): void {
  const cursor: WriteCursor = { claimed: undefined, correlationId: undefined };
  if (active.pendingEvidence.length > 0 || active.blocked.size > 0) {
    try {
      writeQueued(active, cursor, undefined);
    } catch (error) {
      // Nothing can be persisted for this directory now; the loss is reported once, not retried at
      // every later close.
      active.pendingEvidence.length = 0;
      active.blocked.clear();
      reportServerLogFailure(error, {
        op: SERVER_LOG_SAFE_OPEN_OPERATION.op,
        loss: "event-dropped",
      });
    }
  }
  sealSegment(active, cursor, "close");
}

export interface FileServerLogSinkOptions {
  readonly level?: ServerLogThreshold | undefined;
  // Level threshold and storage bounds (`KEIKO_LOG_*`); defaults to the process environment. The
  // first sink for a directory fixes that directory's storage configuration for the process.
  readonly env?: ServerLogEnv | undefined;
}

// Seals every open Activity Log segment. Called by the server logger's shutdown/reset path, and by
// tests so a suite does not leave descriptors behind. A subsequent write opens a new segment:
// closing releases an OS resource and completes a segment, it never disables the log.
//
// The registry entries themselves are KEPT so a sink created after a shutdown shares the same
// per-directory state (segment index, pressure, failure memory) instead of building a second one.
export function closeFileServerLogSinks(): void {
  for (const active of activeLogs.values()) closeActiveLog(active);
}

export function createFileServerLogSink(
  stateDir: string,
  options: FileServerLogSinkOptions = {},
): ServerLogSink {
  const directory = join(stateDir, "logs");
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    // A configured production Activity Log is mandatory reconstruction evidence. Returning the
    // null sink here made startup appear healthy while every later operation was silently
    // unevidenced. Fail with the existing closed filesystem classification instead; callers that
    // intentionally need no persistence must choose nullServerLogSink() explicitly.
    throw new SafeArtifactFileError("activity-log", "open-failed");
  }
  const env = options.env ?? process.env;
  const active = resolveActiveLog(directory, resolveActivityLogStorageConfig(env));
  const threshold = options.level ?? resolveServerLogThreshold(env);
  return createFileSinkFacade(active, threshold);
}

function failureLoss(error: unknown): "event-dropped" | "event-location-unknown" {
  return error instanceof PostWriteMutationError ? "event-location-unknown" : "event-dropped";
}

// Split out so `createFileServerLogSink` stays inside the 50-line ceiling.
function createFileSinkFacade(active: ActiveLog, threshold: ServerLogThreshold): ServerLogSink {
  return {
    write(event: ServerLogEvent): void {
      // The threshold check comes before any formatting: a filtered event costs one comparison.
      if (!serverLogLevelEnabled(eventLevel(event), threshold)) return;
      const identity = allocateServerLogIdentity();
      try {
        persistCallerEvent(active, event, {
          claimed: identity,
          correlationId: event.correlationId,
        });
      } catch (error) {
        // Writing must never take the server down; a full disk, an exhausted budget or a file
        // removed under us drops the line. It does NOT drop the fact that it happened: a log that
        // has stopped working is exactly the condition an operator cannot infer from the absence
        // of lines, so the loss is counted for the next persisted pressure line and announced on
        // the independent stderr channel now.
        noteDroppedEvent(active, error);
        reportServerLogFailure(error, {
          op: event.op,
          correlationId: event.correlationId,
          identity,
          loss: failureLoss(error),
        });
      }
    },
    flush(): void {
      // `writeSync` leaves nothing in user space, so a flush is already complete on return.
    },
    close(): void {
      // The segment belongs to the shared per-directory store, so this seals it for every sink on
      // the directory. That is correct for a shutdown path and harmless otherwise: the next write
      // opens a new segment.
      closeActiveLog(active);
    },
  };
}

// ─── Retention pins (#3530: the primitive; #3533 decides when and what to pin) ─────────────────

export type ActivityLogPinRejection =
  "invalid-request" | "pin-limit-reached" | "storage-unavailable";

export interface ActivityLogPinRequest {
  readonly scope: ActivityLogPinScope;
  readonly expiresAtMs: number;
  readonly reason?: ActivityLogPinReason | undefined;
  readonly correlationId?: string | undefined;
}

export type ActivityLogPinResult =
  | {
      readonly status: "pinned";
      readonly pinId: string;
      readonly pinnedSegmentCount: number;
      readonly pinnedBytes: number;
      readonly quotaStatus: "within-quota" | "exceeded";
    }
  | { readonly status: "rejected"; readonly reason: ActivityLogPinRejection };

function validPinRequest(request: ActivityLogPinRequest, nowMs: number): boolean {
  const expiresAtMs: unknown = Reflect.get(request, "expiresAtMs");
  const reason: unknown = Reflect.get(request, "reason");
  return (
    isActivityLogPinScope(Reflect.get(request, "scope")) &&
    typeof expiresAtMs === "number" &&
    Number.isSafeInteger(expiresAtMs) &&
    expiresAtMs > nowMs &&
    expiresAtMs - nowMs <= MAX_ACTIVITY_LOG_PIN_DURATION_MS &&
    (reason === undefined || reason === "incident" || reason === "durable-batch")
  );
}

function copyPinScope(scope: ActivityLogPinScope): ActivityLogPinScope {
  return scope.kind === "window"
    ? { kind: "window", fromMs: scope.fromMs, toMs: scope.toMs }
    : { kind: "segments", segmentIds: [...scope.segmentIds] };
}

interface PinAttempt {
  readonly result: ActivityLogPinResult;
  readonly facts: PinEvidenceFacts;
}

function rejectedPin(
  request: ActivityLogPinRequest,
  reason: ActivityLogPinRejection,
  scope: ActivityLogPinScope | undefined,
): PinAttempt {
  return {
    result: { status: "rejected", reason },
    facts: {
      pinId: undefined,
      status: "rejected",
      rejectionReason: reason,
      scope,
      reason: request.reason === "durable-batch" ? "durable-batch" : "incident",
      pinnedSegmentCount: 0,
      pinnedBytes: 0,
      expiresInSeconds: 0,
      quotaStatus: undefined,
    },
  };
}

function pinOutcome(active: ActiveLog, record: ActivityLogPinRecord, nowMs: number): PinAttempt {
  const listing = listActivityLogDirectory(active.directory);
  const reads = readActivityLogPins(listing, active.trustedRoot);
  const protection = planActivityLogPinProtection(
    listing.files,
    activeActivityLogPins(reads, nowMs),
    active.config.pinQuotaBytes,
  );
  const covered = listing.files.filter(
    (entry): entry is SegmentEntry =>
      entry.file.kind === "sealed" &&
      isActivityLogSegmentEntry(entry) &&
      activityLogPinCovers(record, entry),
  );
  const quotaStatus = covered.every((entry) => protection.protectedNames.has(entry.file.name))
    ? "within-quota"
    : "exceeded";
  const pinnedBytes = covered.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return {
    result: {
      status: "pinned",
      pinId: record.pinId,
      pinnedSegmentCount: covered.length,
      pinnedBytes,
      quotaStatus,
    },
    facts: {
      pinId: record.pinId,
      status: "created",
      rejectionReason: undefined,
      scope: record.scope,
      reason: record.reason,
      pinnedSegmentCount: covered.length,
      pinnedBytes,
      expiresInSeconds: Math.ceil((record.expiresAtMs - nowMs) / 1000),
      quotaStatus,
    },
  };
}

function createPin(
  active: ActiveLog,
  request: ActivityLogPinRequest,
  cursor: WriteCursor,
  nowMs: number,
): PinAttempt {
  if (!validPinRequest(request, nowMs)) return rejectedPin(request, "invalid-request", undefined);
  const scope = copyPinScope(request.scope);
  const listing = listActivityLogDirectory(active.directory);
  const pins = activeActivityLogPins(readActivityLogPins(listing, active.trustedRoot), nowMs);
  if (pins.length >= MAX_ACTIVITY_LOG_PINS) return rejectedPin(request, "pin-limit-reached", scope);
  const record: ActivityLogPinRecord = {
    schemaVersion: 1,
    pinId: randomBytes(12).toString("hex"),
    reason: request.reason ?? "incident",
    createdAtMs: nowMs,
    expiresAtMs: request.expiresAtMs,
    scope,
  };
  try {
    // Published before the seal, so the retention pass the next segment runs already honors it.
    writeActivityLogPinRecord(active.directory, active.trustedRoot, record);
  } catch {
    return rejectedPin(request, "storage-unavailable", scope);
  }
  sealSegment(active, cursor, "pin-request");
  return pinOutcome(active, record, nowMs);
}

function storeForStateDir(stateDir: string, env: ServerLogEnv): ActiveLog {
  const directory = join(stateDir, "logs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return resolveActiveLog(directory, resolveActivityLogStorageConfig(env));
}

function persistPinEvidence(active: ActiveLog, cursor: WriteCursor, facts: PinEvidenceFacts): void {
  try {
    queueEvidence(active, pinCreatedEvidence(facts, cursor.correlationId));
    writeQueued(active, cursor, undefined);
  } catch (error) {
    noteDroppedEvent(active, error);
    reportServerLogFailure(error, {
      op: ACTIVITY_LOG_PIN_CREATED_OPERATION.op,
      correlationId: cursor.correlationId,
      loss: failureLoss(error),
    });
  }
}

/**
 * Pins a bounded time window (across every process instance, including segments sealed later
 * inside it) or an explicit set of segments against retention until `expiresAtMs`. Seals this
 * process's active segment, publishes one closed-grammar pin record, and evidences the request.
 * Pinned segments are protected only within the reserved pin quota; a pin the quota cannot hold is
 * still recorded, reports `quotaStatus: "exceeded"`, and produces one quota-exhaustion loss marker.
 */
export function pinActivityLogWindow(
  stateDir: string,
  request: ActivityLogPinRequest,
  env: ServerLogEnv = process.env,
): ActivityLogPinResult {
  let active: ActiveLog;
  try {
    active = storeForStateDir(stateDir, env);
  } catch (error) {
    reportServerLogFailure(error, {
      op: ACTIVITY_LOG_PIN_CREATED_OPERATION.op,
      correlationId: request.correlationId,
      loss: "event-dropped",
    });
    return { status: "rejected", reason: "storage-unavailable" };
  }
  const cursor: WriteCursor = { claimed: undefined, correlationId: request.correlationId };
  const attempt = createPin(active, request, cursor, Date.now());
  persistPinEvidence(active, cursor, attempt.facts);
  return attempt.result;
}

// ─── Storage health (read-only; consumed by the diagnostic-readiness check, #3532) ─────────────

/** The coarse severity the diagnostic-readiness check (#3532) reads from `pressure`. */
export type ActivityLogPressureSeverity = "none" | "elevated" | "critical";

export interface ActivityLogStoreHealth {
  // The Activity Log directory (or, before first use, its state directory) is an owner-matched,
  // non-redirected directory the store can seal and prune in, and no write is currently blocked.
  readonly writable: boolean;
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly pinQuotaBytes: number;
  readonly pinnedBytes: number;
  readonly freeBytes?: number;
  readonly activeSegments: number;
  readonly sealedSegments: number;
  readonly legacyFiles: number;
  // Active segments whose owning process has exited (or gone stale) and await recovery.
  readonly orphanedSegments: number;
  // `critical` when writing is blocked or the budget cannot hold the store, `elevated` for a
  // standing condition that has not cost an event yet; `pressureState` names the exact condition.
  readonly pressure: ActivityLogPressureSeverity;
  readonly pressureState: ActivityLogPressureState;
  // Orphaned segments this process has recovered since it started.
  readonly recoveredSegments: number;
}

const PRESSURE_SEVERITY: Readonly<Record<ActivityLogPressureState, ActivityLogPressureSeverity>> = {
  none: "none",
  "low-disk-space": "elevated",
  "retention-blocked": "elevated",
  backpressure: "elevated",
  "disk-full": "critical",
  "budget-exceeded": "critical",
};

function ownedDirectory(path: string, requireOwnerOnly: boolean): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (process.platform === "win32") return true;
    const owner = process.geteuid?.();
    if (owner === undefined || stat.uid !== owner) return false;
    return !requireOwnerOnly || (stat.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

function storageWritable(stateDir: string, directory: string): boolean {
  return pathMissing(directory) ? ownedDirectory(stateDir, false) : ownedDirectory(directory, true);
}

function orphanedSegmentCount(
  files: readonly ActivityLogFileEntry[],
  config: ActivityLogStorageConfig,
  currentName: string | undefined,
): number {
  const context = {
    pid: process.pid,
    instanceId: INSTANCE_ID,
    currentName,
    nowMs: Date.now(),
    segmentSeconds: config.segmentSeconds,
    isAlive: processIsAlive,
  };
  return files.filter(
    (entry) =>
      isActivityLogSegmentEntry(entry) && activityLogOrphanOwner(entry, context) !== undefined,
  ).length;
}

function derivedPressure(
  active: ActiveLog | undefined,
  unprotectedBytes: number,
  config: ActivityLogStorageConfig,
  freeBytes: number | undefined,
): ActivityLogPressureState {
  const blocked = active === undefined ? undefined : [...active.blocked.keys()][0];
  if (blocked !== undefined) return blocked;
  if (active?.standingPressure !== undefined) return active.standingPressure;
  if (unprotectedBytes > config.retentionBytes) return "budget-exceeded";
  return freeBytes !== undefined && freeBytes < activityLogLowDiskThresholdBytes(config)
    ? "low-disk-space"
    : "none";
}

function countKind(
  files: readonly ActivityLogFileEntry[],
  kinds: ReadonlySet<ActivityLogFileName["kind"]>,
): number {
  return files.filter((entry) => kinds.has(entry.file.kind)).length;
}

interface StorageSnapshot {
  readonly listing: ActivityLogDirectoryListing;
  readonly usedBytes: number;
  readonly pinnedBytes: number;
  readonly freeBytes: number | undefined;
}

function storageSnapshot(
  stateDir: string,
  directory: string,
  config: ActivityLogStorageConfig,
): StorageSnapshot {
  const listing = listActivityLogDirectory(directory);
  const reads = readActivityLogPins(listing, directory);
  const protection = planActivityLogPinProtection(
    listing.files,
    activeActivityLogPins(reads, Date.now()),
    config.pinQuotaBytes,
  );
  const pinRecordSize = reads.reduce((sum, read) => sum + read.entry.sizeBytes, 0);
  return {
    listing,
    usedBytes: listing.files.reduce((sum, entry) => sum + entry.sizeBytes, 0) + pinRecordSize,
    pinnedBytes: protection.protectedBytes,
    freeBytes: activityLogFreeBytes(pathMissing(directory) ? stateDir : directory),
  };
}

/**
 * A cheap, read-only snapshot of the Activity Log store: one directory listing, the small pin
 * records, and one `statfs`. Never creates, seals, or deletes anything.
 */
export function activityLogStorageHealth(
  stateDir: string,
  env: ServerLogEnv = process.env,
): ActivityLogStoreHealth {
  const directory = join(stateDir, "logs");
  const active = activeLogs.get(activeLogKey(directory));
  const config = active?.config ?? resolveActivityLogStorageConfig(env);
  const snapshot = storageSnapshot(stateDir, directory, config);
  const writer = writerView(active);
  const files = snapshot.listing.files;
  const unprotectedBytes = snapshot.usedBytes - snapshot.pinnedBytes;
  const pressureState = derivedPressure(active, unprotectedBytes, config, snapshot.freeBytes);
  return {
    writable: storageWritable(stateDir, directory) && !writer.blocked,
    usedBytes: snapshot.usedBytes,
    budgetBytes: config.retentionBytes,
    pinQuotaBytes: config.pinQuotaBytes,
    pinnedBytes: snapshot.pinnedBytes,
    ...(snapshot.freeBytes === undefined ? {} : { freeBytes: snapshot.freeBytes }),
    activeSegments: countKind(files, new Set(["active"])),
    sealedSegments: countKind(files, new Set(["sealed"])),
    legacyFiles: countKind(files, new Set(["legacy-archive", "legacy-current"])),
    orphanedSegments: orphanedSegmentCount(files, config, writer.currentName),
    pressure: PRESSURE_SEVERITY[pressureState],
    pressureState,
    recoveredSegments: writer.recoveredSegments,
  };
}

interface WriterView {
  readonly blocked: boolean;
  readonly currentName: string | undefined;
  readonly recoveredSegments: number;
}

function writerView(active: ActiveLog | undefined): WriterView {
  if (active === undefined) return { blocked: false, currentName: undefined, recoveredSegments: 0 };
  return {
    blocked: active.blocked.size > 0,
    currentName: active.segment?.activeName,
    recoveredSegments: active.recoveredSegments,
  };
}

export interface ActivityLogFileInfo {
  readonly name: string;
  readonly path: string;
  readonly kind: ActivityLogFileName["kind"];
  readonly sizeBytes: number;
}

/** Every Activity Log file of `stateDir`, legacy and segmented, in logical-log order. */
export function listActivityLogFiles(stateDir: string): readonly ActivityLogFileInfo[] {
  return listActivityLogDirectory(join(stateDir, "logs")).files.map((entry) => ({
    name: entry.file.name,
    path: entry.path,
    kind: entry.file.kind,
    sizeBytes: entry.sizeBytes,
  }));
}

// ─── Durable batches (the legacy update-audit import) ──────────────────────────────────────────

export type DurableServerLogBatchInspection =
  | { readonly status: "already-complete" }
  | { readonly status: "deferred" }
  | { readonly status: "append"; readonly events: readonly ServerLogEvent[] };

export interface DurableServerLogBatchOptions {
  readonly level: ServerLogThreshold;
  // `pinned`: the batch's segments are sealed and pinned (reason `durable-batch`) so retention can
  // never age the batch out. `standard` (the default) appends, fsyncs and verifies only.
  readonly retention?: "standard" | "pinned" | undefined;
  // Receives the Activity Log directory and the closed-grammar names that can hold an earlier durable
  // batch, oldest first: the read-only legacy files, then segments pinned for durable batches.
  // Inspection is read-only; the batch itself is appended by the store.
  readonly inspect: (
    directory: string,
    files: readonly string[],
  ) => DurableServerLogBatchInspection;
}

export type DurableServerLogBatchResult =
  | { readonly status: "already-complete" }
  | { readonly status: "inspection-deferred" }
  | { readonly status: "appended"; readonly appendedCount: number }
  | {
      readonly status: "deferred";
      readonly reason:
        | "level-filtered"
        | "destination-unsafe"
        | "destination-mutated"
        | "append-failed"
        | "durability-uncertain";
    };

interface LogDirectoryGuard {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly handle: number | undefined;
}

function durableLogDirectory(directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function openLogDirectoryGuard(path: string): LogDirectoryGuard | undefined {
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) return undefined;
  let handle: number | undefined;
  try {
    const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
    const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = openSync(path, constants.O_RDONLY | directoryFlag | noFollowFlag);
    return validateOpenedLogDirectory(path, before.dev, before.ino, handle);
  } catch {
    if (handle !== undefined) closeSync(handle);
    return windowsLogDirectoryGuard(path, before.dev, before.ino);
  }
}

function validateOpenedLogDirectory(
  path: string,
  dev: number,
  ino: number,
  handle: number,
): LogDirectoryGuard {
  const opened = fstatSync(handle);
  const pathname = lstatSync(path);
  if (
    !opened.isDirectory() ||
    !pathname.isDirectory() ||
    pathname.isSymbolicLink() ||
    opened.dev !== pathname.dev ||
    opened.ino !== pathname.ino ||
    opened.dev !== dev ||
    opened.ino !== ino
  ) {
    throw new Error("log directory changed");
  }
  return { path, dev: opened.dev, ino: opened.ino, handle };
}

function windowsLogDirectoryGuard(
  path: string,
  dev: number,
  ino: number,
): LogDirectoryGuard | undefined {
  if (process.platform !== "win32") return undefined;
  const after = lstatSync(path);
  if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== dev || after.ino !== ino) {
    return undefined;
  }
  return { path, dev: after.dev, ino: after.ino, handle: undefined };
}

function logDirectoryStillSame(guard: LogDirectoryGuard): boolean {
  try {
    const pathname = lstatSync(guard.path);
    if (
      !pathname.isDirectory() ||
      pathname.isSymbolicLink() ||
      pathname.dev !== guard.dev ||
      pathname.ino !== guard.ino
    ) {
      return false;
    }
    if (guard.handle === undefined) return process.platform === "win32";
    const opened = fstatSync(guard.handle);
    return opened.isDirectory() && opened.dev === guard.dev && opened.ino === guard.ino;
  } catch {
    return false;
  }
}

function closeLogDirectoryGuards(guards: readonly LogDirectoryGuard[]): void {
  for (const guard of guards) {
    if (guard.handle !== undefined) closeSync(guard.handle);
  }
}

// Legacy files and segments pinned for durable batches: the only places a completed earlier batch
// can live, and a set whose size is bounded by the legacy window and the pin quota.
function durableBatchScope(active: ActiveLog, nowMs: number): readonly string[] {
  const listing = listActivityLogDirectory(active.directory);
  const pinned = new Set<string>();
  for (const pin of activeActivityLogPins(
    readActivityLogPins(listing, active.trustedRoot),
    nowMs,
  )) {
    if (pin.reason !== "durable-batch" || pin.scope.kind !== "segments") continue;
    for (const segmentId of pin.scope.segmentIds) pinned.add(segmentId);
  }
  return listing.files
    .filter((entry) => !isActivityLogSegmentEntry(entry) || pinned.has(entry.file.segmentId))
    .map((entry) => entry.file.name);
}

// Formats every event once with a provisional identity before anything is written, so an invalid or
// oversized event defers the whole batch instead of leaving half of it in the log.
function batchIsWritable(events: readonly ServerLogEvent[]): boolean {
  try {
    return events.every((event) => {
      const line = formatEventLine(event, undefined, {
        ...serverLogProcessIdentity(),
        seq: nextProcessSeq,
      });
      return serverLogLineWithinCap(line) && line.includes(`"op":"${redactLogLabel(event.op)}"`);
    });
  } catch {
    return false;
  }
}

function syncActiveSegment(active: ActiveLog): boolean {
  const handle = active.segment?.handle;
  if (handle === undefined || handle === null) return false;
  try {
    fsyncSync(handle);
    return true;
  } catch {
    return false;
  }
}

function writeDurableEvents(
  active: ActiveLog,
  events: readonly ServerLogEvent[],
  segmentIds: Set<string>,
): boolean {
  for (const event of events) {
    const cursor: WriteCursor = { claimed: undefined, correlationId: event.correlationId };
    try {
      writeQueued(active, cursor, event);
    } catch (error) {
      noteDroppedEvent(active, error);
      return false;
    }
    const segmentId = active.segment?.segmentId;
    if (segmentId !== undefined) segmentIds.add(segmentId);
  }
  return true;
}

function pinDurableBatch(
  active: ActiveLog,
  segmentIds: ReadonlySet<string>,
  correlationId: string | undefined,
): boolean {
  const cursor: WriteCursor = { claimed: undefined, correlationId };
  const pinned = createPin(
    active,
    {
      scope: { kind: "segments", segmentIds: [...segmentIds] },
      expiresAtMs: Date.now() + MAX_ACTIVITY_LOG_PIN_DURATION_MS,
      reason: "durable-batch",
    },
    cursor,
    Date.now(),
  );
  persistPinEvidence(active, cursor, pinned.facts);
  return pinned.result.status === "pinned";
}

function appendInspectedBatch(
  active: ActiveLog,
  events: readonly ServerLogEvent[],
  guards: readonly LogDirectoryGuard[],
  options: DurableServerLogBatchOptions,
): DurableServerLogBatchResult {
  if (events.some((event) => !serverLogLevelEnabled(eventLevel(event), options.level))) {
    return { status: "deferred", reason: "level-filtered" };
  }
  if (events.length === 0) return { status: "appended", appendedCount: 0 };
  if (!batchIsWritable(events)) return { status: "deferred", reason: "append-failed" };
  const segmentIds = new Set<string>();
  if (!writeDurableEvents(active, events, segmentIds)) {
    return { status: "deferred", reason: "append-failed" };
  }
  if (!syncActiveSegment(active)) return { status: "deferred", reason: "durability-uncertain" };
  if (!guards.every(logDirectoryStillSame)) {
    return { status: "deferred", reason: "destination-mutated" };
  }
  if (
    options.retention === "pinned" &&
    !pinDurableBatch(active, segmentIds, events[0]?.correlationId)
  ) {
    return { status: "deferred", reason: "durability-uncertain" };
  }
  return { status: "appended", appendedCount: events.length };
}

function prepareDurableDirectory(
  stateDir: string,
  guards: LogDirectoryGuard[],
): ActiveLog | undefined {
  const stateGuard = openLogDirectoryGuard(stateDir);
  if (stateGuard === undefined) return undefined;
  guards.push(stateGuard);
  const directory = join(stateDir, "logs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!durableLogDirectory(directory)) return undefined;
  const logGuard = openLogDirectoryGuard(directory);
  if (logGuard === undefined) return undefined;
  guards.push(logGuard);
  return resolveActiveLog(directory, resolveActivityLogStorageConfig(process.env));
}

function inspectAndAppendDurableBatch(
  active: ActiveLog,
  guards: readonly LogDirectoryGuard[],
  options: DurableServerLogBatchOptions,
): DurableServerLogBatchResult {
  const inspection = options.inspect(active.directory, durableBatchScope(active, Date.now()));
  if (!guards.every(logDirectoryStillSame)) {
    return { status: "deferred", reason: "destination-mutated" };
  }
  if (inspection.status === "already-complete") return { status: "already-complete" };
  if (inspection.status === "deferred") return { status: "inspection-deferred" };
  return appendInspectedBatch(active, inspection.events, guards, options);
}

// Synchronous by design: `inspect` and the append share one JavaScript stack. The batch is written
// through the ordinary segment writer (bounds, rollover and evidence apply unchanged), fsynced, and
// its segments are then pinned with reason `durable-batch`, so a later inspection finds the
// completed batch among a bounded set of files and retention can never age it out. Concurrent
// imports by two processes can still append duplicate physical records; callers obtain semantic
// deduplication from their stable record identities, never an exactly-once filesystem claim.
export function appendDurableServerLogBatch(
  stateDir: string,
  options: DurableServerLogBatchOptions,
): DurableServerLogBatchResult {
  if (!serverLogLevelEnabled("info", options.level)) {
    return { status: "deferred", reason: "level-filtered" };
  }
  const guards: LogDirectoryGuard[] = [];
  try {
    const active = prepareDurableDirectory(stateDir, guards);
    return active === undefined
      ? { status: "deferred", reason: "destination-unsafe" }
      : inspectAndAppendDurableBatch(active, guards, options);
  } catch {
    return { status: "deferred", reason: "destination-unsafe" };
  } finally {
    closeLogDirectoryGuards(guards);
  }
}

// ─── Test-only in-memory sink ──────────────────────────────────────────────────────────────────

export interface BufferedServerLogSink extends ServerLogSink {
  readonly events: ServerLogEvent[];
  // The redacted lines the file sink would have written, for redaction assertions.
  readonly lines: () => readonly string[];
  readonly clear: () => void;
}

// Test-only helper: buffered sink that keeps every event in memory so tests can assert on
// order and content without touching the filesystem. It captures RAW events and applies no
// threshold of its own, so a test can tell "the logger filtered this" from "the sink did".
//
// "Test-only" is enforced by where it is reachable from, not by the comment: it is exported from
// this module and from the in-package `observability/` barrel that every keiko-server test imports,
// and deliberately NOT from the package's public entry point. Nothing outside this package has a
// use for it, and a packaged export is a promise that has to be kept.
export function createBufferedServerLogSink(): BufferedServerLogSink {
  const events: ServerLogEvent[] = [];
  return {
    events,
    write(event: ServerLogEvent): void {
      events.push(event);
    },
    lines(): readonly string[] {
      return events.map((event) => formatEventLine(event));
    },
    clear(): void {
      events.length = 0;
    },
  };
}
