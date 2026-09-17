// Server activity log — one JSON line per operation into `<stateDir>/logs/server.log`. Written
// unconditionally, no env-var opt-in:
// operators facing a stuck run must not have to know a magic switch to see what the process is
// doing. Redaction stays strict — endpoints, sizes, HTTP statuses, error kinds and correlation
// ids only; request bodies, response bodies, tokens, api-keys and user text never appear, and
// that is enforced structurally by `log-redaction.ts` rather than by caller discipline.
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
// descriptor open for the life of the file, so a line costs a single `write(2)` rather than the
// open/write/close triple `appendFileSync` pays per call. The initial open also verifies the state
// and ancestry descriptors before closing those guards. `server-log.test.ts` asserts that the
// fixed setup count does not grow over a burst — never one open per line — plus one `writeSync` per line and
// a file whose size is the SUM of each line's own byte length (lines are no longer byte-identical
// once `seq` is in the envelope: its digit width grows at each power-of-ten boundary the burst
// crosses). A regression to per-write open/close, or to a quadratic format path, therefore fails
// deterministically instead of showing up as latency in production.
//
// Levels are the volume control instead: an event below the configured threshold returns before
// any string or JSON work happens at all (`KEIKO_LOG_LEVEL`, default `info`).

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  SAFE_ARTIFACT_FILE_FAILURE_KINDS,
  SafeArtifactFileError,
  openSafeArtifactFile,
  safeArtifactContainmentAssurance,
  safeArtifactPermissionAssurance,
} from "@oscharko-dev/keiko-security/fs-hardening";

import { classifyErrorKind } from "@oscharko-dev/keiko-contracts/runtime/observability";

import { correlationIdOrUnknown, isValidCorrelationId } from "../correlation.js";
import { contentFreeErrorClass, machineToken, safeProperty } from "./error-classification.js";
import {
  DEFAULT_SERVER_LOG_LEVEL,
  resolveServerLogThreshold,
  serverLogLevelEnabled,
} from "./log-level.js";
import type { ServerLogEnv, ServerLogLevel, ServerLogThreshold } from "./log-level.js";
import { redactLogFields, redactLogLabel } from "./log-redaction.js";

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

// The four fields the sink stamps once, at the physical write boundary — never left to a caller,
// and never spoofable through `extra` (see `RESERVED_FIELD_NAMES` in `log-redaction.ts`). Bundled
// as one optional parameter on `formatServerLogLine` rather than four, because a caller either
// wants the full process/sequence identity or none of it: the file sink always passes one, and the
// in-memory buffered test sink is free to omit it entirely.
export interface ServerLogIdentity {
  readonly schemaVersion: number;
  readonly pid: number;
  readonly instanceId: string;
  readonly seq: number;
}

export interface ServerLogSink {
  readonly write: (event: ServerLogEvent) => void;
  // Present on sinks that own an OS resource. Both are optional so every existing structural
  // implementation of `ServerLogSink` stays assignable.
  readonly flush?: (() => void) | undefined;
  readonly close?: (() => void) | undefined;
}

// Compatibility value for existing callers. Mutation-based retention is deferred to #3530.
export const DEFAULT_LOG_RETENTION_DAYS = 7;

// A hard ceiling on one serialised line. Every field guard runs first, so reaching this means a
// caller passed an unexpected shape; the line is replaced rather than written, so one pathological
// event cannot fill a disk or blow a log shipper's line limit.
export const MAX_LOG_LINE_BYTES = 8192;

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

export interface ServerLogFailureContext {
  readonly op?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly loss?: "event-dropped" | "event-location-unknown" | undefined;
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
  emitFailureNotice(error, context, suppressed, now);
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
): void {
  const notice: Record<string, unknown> = {
    ts: new Date(now).toISOString(),
    level: "error",
    category: "diagnostic",
    op: LOG_FAILURE_NOTICE_OP,
    errorKind: errorKindOf(error),
    correlationId: correlationIdOrUnknown(context.correlationId),
    completeness: "unknown",
    loss: context.loss ?? "event-dropped",
  };
  if (context.op !== undefined) notice.failedOp = redactLogLabel(context.op);
  if (suppressed > 0) notice.suppressedNotices = suppressed;
  writeStderrNotice(notice);
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
  writeStderrNotice({
    ts: new Date(now).toISOString(),
    level: "error",
    category: "diagnostic",
    op: LOG_FAILURE_NOTICE_OP,
    correlationId: correlationIdOrUnknown(undefined),
    errorKind: "unknown",
    completeness: "unknown",
    loss: "event-dropped",
    reason: "shutdown-flush",
    suppressedNotices: suppressed,
  });
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
  if (record.schemaVersion !== undefined) replacement.schemaVersion = record.schemaVersion;
  if (record.pid !== undefined) replacement.pid = record.pid;
  if (record.instanceId !== undefined) replacement.instanceId = record.instanceId;
  if (record.seq !== undefined) replacement.seq = record.seq;
  replacement.level = record.level;
  replacement.category = record.category;
  replacement.op = record.op;
  replacement.errorKind = "log-line-oversized";
  replacement.droppedLineBytes = lineBytes;
  return `${JSON.stringify(replacement)}\n`;
}

// Kept in memory so a single process holds one append-mode descriptor for the life of the current
// file.
//
// ONE ActiveLog PER FILE, PROCESS-WIDE. Besides sharing the append descriptor, this keeps one UTC
// boundary state so a process emits exactly one deferred-rotation warning per day.
interface ActiveLog {
  readonly directory: string;
  readonly trustedRoot: string;
  readonly currentPath: string;
  currentDay: string;
  handle: number | null;
  // Set while a record is being written and cleared once it has landed whole, so a write that
  // stalled mid-line is remembered: the file ends mid-record and the next record must open with a
  // newline. See `writeRecord`.
  pendingNewline: boolean;
  pendingSafeOpenEvidence: boolean;
  pendingRotationOutcome: RotationOutcome | undefined;
}

interface RotationOutcome {
  readonly status: "deferred";
  readonly durability: "unchanged";
}

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

function allocateServerLogSeq(): number {
  const seq = nextProcessSeq;
  nextProcessSeq += 1;
  return seq;
}

function allocateServerLogIdentity(): ServerLogIdentity {
  return {
    schemaVersion: SERVER_LOG_SCHEMA_VERSION,
    pid: process.pid,
    instanceId: INSTANCE_ID,
    seq: allocateServerLogSeq(),
  };
}

function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function closeHandle(active: ActiveLog): void {
  if (active.handle === null) return;
  try {
    closeSync(active.handle);
  } catch {
    // A descriptor we can no longer close is a descriptor we must stop using either way.
  }
  active.handle = null;
}

function openActivityLogHandle(active: ActiveLog): number {
  return openSafeArtifactFile(active.currentPath, {
    artifactClass: "activity-log",
    mode: "append-existing-or-create",
    trustedRoot: active.trustedRoot,
  });
}

function handleStillCurrent(active: ActiveLog): boolean {
  if (active.handle === null) return false;
  try {
    const opened = trustedLogIdentity(fstatSync(active.handle));
    const pathname = pathLogIdentity(active.currentPath);
    return opened !== undefined && pathname !== undefined && sameLogNode(opened, pathname);
  } catch {
    return false;
  }
}

// Revalidates the cached descriptor against the current pathname before every append. A peer that
// rotated or replaced `server.log` therefore forces a close/reopen instead of receiving bytes on a
// stale or unlinked inode.
function ensureHandle(active: ActiveLog): number {
  if (handleStillCurrent(active) && active.handle !== null) return active.handle;
  closeHandle(active);
  active.handle = openActivityLogHandle(active);
  active.pendingSafeOpenEvidence = true;
  return active.handle;
}

// Node does not expose descriptor-relative rename/unlink primitives. Every path-based rotation
// implementation therefore has an unavoidable final ancestor-substitution window that can mutate
// a same-UID target outside the trusted root. Until #3530 installs bounded append-only segments,
// keep writing the already-verified current descriptor and record the deferred boundary once.
function rotateIfNeeded(active: ActiveLog): RotationOutcome | undefined {
  const day = todayUtc();
  if (day === active.currentDay) return undefined;
  active.currentDay = day;
  return { status: "deferred", durability: "unchanged" };
}

function refreshPendingRotation(active: ActiveLog): void {
  const outcome = rotateIfNeeded(active);
  if (outcome !== undefined) active.pendingRotationOutcome = outcome;
}

// The descriptor is opened `a`, so every write is an atomic O_APPEND write at the current end of
// file. Inside one process the registry above already gives every sink on a file the same
// descriptor; O_APPEND is what additionally makes it safe for a SECOND Keiko process sharing the
// same state directory, which no in-process registry can coordinate. `writeSync` may still report
// a short write, so loop until the whole line has landed.
//
// A descriptor that reports ZERO bytes has stopped accepting them: looping would spin, and simply
// returning would leave a partial JSON record behind whose bytes then merge with the NEXT record —
// one stalled line silently costing two, and a reader that splits on newlines losing both. So the
// stall throws: the caller closes the descriptor, and the line is dropped. A dropped line is the
// honest outcome; a truncated one is not, because it damages a record that was never in trouble.
function writeAll(handle: number, payload: Buffer): void {
  let offset = 0;
  while (offset < payload.length) {
    const written = writeSync(handle, payload, offset, payload.length - offset);
    if (written <= 0) throw new SafeArtifactFileError("activity-log", "write-failed");
    offset += written;
  }
}

// The bytes a stalled write already handed to the kernel cannot be recalled, so the damage is
// bounded from the other side: the ActiveLog remembers that the file ends mid-record and the next
// record opens with a newline. That is deterministic — unlike writing a terminator, which asks a
// descriptor that is refusing bytes to accept one more.
function writeRecord(active: ActiveLog, handle: number, line: string): void {
  const payload = Buffer.from(active.pendingNewline ? `\n${line}` : line, "utf8");
  // Cleared only once the whole record has landed; a throw from `writeAll` leaves it set.
  active.pendingNewline = true;
  writeAll(handle, payload);
  active.pendingNewline = false;
}

function writeEventRecord(
  active: ActiveLog,
  handle: number,
  event: ServerLogEvent,
  identity: ServerLogIdentity = allocateServerLogIdentity(),
): void {
  writeRecord(active, handle, formatServerLogLine(event, undefined, identity));
}

function safeOpenEvidence(): ServerLogEvent {
  return {
    category: "diagnostic",
    op: "server-log.safe-open",
    correlationId: correlationIdOrUnknown(undefined),
    extra: {
      artifactClass: "activity-log",
      persistenceStatus: "opened",
      permissionAssurance: safeArtifactPermissionAssurance(),
      containmentAssurance: safeArtifactContainmentAssurance(),
      completeness: "complete",
      loss: "none",
    },
  };
}

function rotationEvidence(
  outcome: RotationOutcome,
  correlationId: string | undefined,
): ServerLogEvent {
  return {
    level: "warn",
    category: "diagnostic",
    op: "server-log.rotation",
    correlationId: correlationIdOrUnknown(correlationId),
    errorKind: "publish-unsupported",
    extra: {
      artifactClass: "activity-log",
      persistenceStatus: outcome.status,
      durabilityAssurance: outcome.durability,
      rotationAssurance: "append-only-current",
      retentionStatus: "deferred",
      retentionReason: "segment-retention-owned-by-3530",
      completeness: "partial",
      loss: "none",
    },
  };
}

function pendingPersistenceEvents(
  active: ActiveLog,
  correlationId: string | undefined,
): readonly ServerLogEvent[] {
  const events: ServerLogEvent[] = [];
  if (active.pendingSafeOpenEvidence) events.push(safeOpenEvidence());
  if (active.pendingRotationOutcome !== undefined) {
    events.push(rotationEvidence(active.pendingRotationOutcome, correlationId));
  }
  return events;
}

function clearPendingPersistenceEvents(active: ActiveLog): void {
  active.pendingSafeOpenEvidence = false;
  active.pendingRotationOutcome = undefined;
}

function writePendingPersistenceEvents(
  active: ActiveLog,
  handle: number,
  firstIdentity: ServerLogIdentity,
  correlationId: string | undefined,
): boolean {
  let firstIdentityUsed = false;
  if (active.pendingSafeOpenEvidence) {
    writeEventRecord(active, handle, safeOpenEvidence(), firstIdentity);
    active.pendingSafeOpenEvidence = false;
    firstIdentityUsed = true;
  }
  if (active.pendingRotationOutcome !== undefined) {
    const identity = firstIdentityUsed ? undefined : firstIdentity;
    writeEventRecord(
      active,
      handle,
      rotationEvidence(active.pendingRotationOutcome, correlationId),
      identity,
    );
    active.pendingRotationOutcome = undefined;
    firstIdentityUsed = true;
  }
  return firstIdentityUsed;
}

class PostWriteMutationError extends SafeArtifactFileError {
  public constructor() {
    super("activity-log", "target-mutated");
  }
}

function mutationEvidence(event: ServerLogEvent): ServerLogEvent {
  return {
    level: "error",
    category: "diagnostic",
    op: LOG_FAILURE_NOTICE_OP,
    correlationId: correlationIdOrUnknown(event.correlationId),
    errorKind: "target-mutated",
    extra: {
      failedOp: redactLogLabel(event.op),
      artifactClass: "activity-log",
      permissionAssurance: safeArtifactPermissionAssurance(),
      containmentAssurance: safeArtifactContainmentAssurance(),
      completeness: "unknown",
      loss: "event-location-unknown",
    },
  };
}

function persistPostWriteMutation(active: ActiveLog, event: ServerLogEvent): void {
  closeHandle(active);
  try {
    const handle = ensureHandle(active);
    writePendingPersistenceEvents(active, handle, allocateServerLogIdentity(), event.correlationId);
    writeEventRecord(active, handle, mutationEvidence(event));
    if (!handleStillCurrent(active)) throw new PostWriteMutationError();
  } catch {
    throw new PostWriteMutationError();
  }
}

function writeCurrentEvent(
  active: ActiveLog,
  event: ServerLogEvent,
  firstIdentity: ServerLogIdentity,
): void {
  const handle = ensureHandle(active);
  const firstIdentityUsed = writePendingPersistenceEvents(
    active,
    handle,
    firstIdentity,
    event.correlationId,
  );
  writeEventRecord(active, handle, event, firstIdentityUsed ? undefined : firstIdentity);
  if (!handleStillCurrent(active)) {
    persistPostWriteMutation(active, event);
    throw new PostWriteMutationError();
  }
}

export interface FileServerLogSinkOptions {
  readonly level?: ServerLogThreshold | undefined;
  // Retained for configuration compatibility while mutation-based retention is deferred to #3530.
  readonly retentionDays?: number | undefined;
  readonly env?: ServerLogEnv | undefined;
}

export type DurableServerLogBatchInspection =
  | { readonly status: "already-complete" }
  | { readonly status: "deferred" }
  | { readonly status: "append"; readonly events: readonly ServerLogEvent[] };

export interface DurableServerLogBatchOptions {
  readonly level: ServerLogThreshold;
  readonly inspect: (directory: string) => DurableServerLogBatchInspection;
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

interface LogFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

interface LogDirectoryGuard {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly handle: number | undefined;
}

function sameLogIdentity(left: LogFileIdentity, right: LogFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function sameLogNode(left: LogFileIdentity, right: LogFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
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
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function currentHandleIdentity(active: ActiveLog): LogFileIdentity | undefined {
  if (active.handle === null) return undefined;
  try {
    const descriptor = trustedLogIdentity(fstatSync(active.handle));
    if (descriptor === undefined) return undefined;
    const pathname = pathLogIdentity(active.currentPath);
    return pathname !== undefined && sameLogNode(descriptor, pathname) ? descriptor : undefined;
  } catch {
    return undefined;
  }
}

function openTrustedDurableHandle(active: ActiveLog): LogFileIdentity | undefined {
  const existing = currentHandleIdentity(active);
  if (existing !== undefined) return existing;
  closeHandle(active);
  try {
    ensureHandle(active);
  } catch {
    return undefined;
  }
  return currentHandleIdentity(active);
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

function batchLines(events: readonly ServerLogEvent[]): readonly string[] | undefined {
  const lines: string[] = [];
  for (const event of events) {
    const line = formatServerLogLine(event, undefined, allocateServerLogIdentity());
    if (Buffer.byteLength(line, "utf8") > MAX_LOG_LINE_BYTES) return undefined;
    lines.push(line);
  }
  return lines;
}

interface PreparedDurableLog {
  readonly status: "prepared";
  readonly active: ActiveLog;
  readonly initial: LogFileIdentity;
  readonly directory: string;
}

type DurablePreparationResult =
  PreparedDurableLog | Extract<DurableServerLogBatchResult, { readonly status: "deferred" }>;

type DurableEvidencePersistenceResult =
  | { readonly status: "persisted"; readonly identity: LogFileIdentity }
  | {
      readonly status: "deferred";
      readonly reason: "append-failed" | "durability-uncertain" | "destination-mutated";
    };

function repairPendingRecord(active: ActiveLog): boolean {
  if (!active.pendingNewline) return true;
  const before = currentHandleIdentity(active);
  if (before === undefined || active.handle === null) return false;
  if (!writeBatchRecords(active, [""])) return false;
  if (!syncBatch(active)) return false;
  return completedBatchMatches(active, before, before.size + 1);
}

function currentLogReadStillMatches(
  active: ActiveLog,
  handle: number,
  expected: LogFileIdentity,
  guards: readonly LogDirectoryGuard[],
): boolean {
  const after = trustedLogIdentity(fstatSync(handle));
  const pathname = pathLogIdentity(active.currentPath);
  const filesMatch = [after, pathname].every(
    (identity) => identity !== undefined && sameLogIdentity(expected, identity),
  );
  return filesMatch && guards.every(logDirectoryStillSame);
}

function currentLogHasDelimiter(
  active: ActiveLog,
  expected: LogFileIdentity,
  guards: readonly LogDirectoryGuard[],
): boolean | undefined {
  if (expected.size === 0) return true;
  let handle: number | undefined;
  try {
    const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = openSync(active.currentPath, constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag);
    const before = trustedLogIdentity(fstatSync(handle));
    if (before === undefined || !sameLogIdentity(expected, before)) return undefined;
    const last = Buffer.allocUnsafe(1);
    if (readSync(handle, last, 0, 1, expected.size - 1) !== 1) return undefined;
    if (!currentLogReadStillMatches(active, handle, expected, guards)) return undefined;
    return last[0] === 0x0a;
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function repairCurrentLogTail(
  active: ActiveLog,
  initial: LogFileIdentity,
  guards: readonly LogDirectoryGuard[],
): LogFileIdentity | undefined {
  const terminated = currentLogHasDelimiter(active, initial, guards);
  if (terminated === undefined) return undefined;
  if (!terminated) active.pendingNewline = true;
  if (!repairPendingRecord(active)) return undefined;
  const repaired = currentHandleIdentity(active);
  return repaired !== undefined && guards.every(logDirectoryStillSame) ? repaired : undefined;
}

function prepareDurableLog(
  stateDir: string,
  guards: LogDirectoryGuard[],
): DurablePreparationResult {
  const stateGuard = openLogDirectoryGuard(stateDir);
  if (stateGuard === undefined) return { status: "deferred", reason: "destination-unsafe" };
  guards.push(stateGuard);
  const directory = join(stateDir, "logs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!durableLogDirectory(directory)) return { status: "deferred", reason: "destination-unsafe" };
  const logGuard = openLogDirectoryGuard(directory);
  if (logGuard === undefined) return { status: "deferred", reason: "destination-unsafe" };
  guards.push(logGuard);
  const active = resolveActiveLog(directory);
  refreshPendingRotation(active);
  let initial = openTrustedDurableHandle(active);
  if (initial === undefined || active.handle === null) {
    closeHandle(active);
    return { status: "deferred", reason: "destination-unsafe" };
  }
  initial = repairCurrentLogTail(active, initial, guards);
  if (initial === undefined) return { status: "deferred", reason: "destination-unsafe" };
  const evidence = persistPendingDurableEvidence(active, initial, guards);
  if (evidence.status === "deferred") return evidence;
  return { status: "prepared", active, initial: evidence.identity, directory };
}

function stableBeforeBatch(
  prepared: PreparedDurableLog,
  guards: readonly LogDirectoryGuard[],
): LogFileIdentity | undefined {
  if (!guards.every(logDirectoryStillSame)) return undefined;
  const current = currentHandleIdentity(prepared.active);
  return current !== undefined && sameLogIdentity(prepared.initial, current) ? current : undefined;
}

function writeBatchRecords(active: ActiveLog, lines: readonly string[]): boolean {
  try {
    if (active.handle === null) return false;
    for (const line of lines) writeRecord(active, active.handle, line);
    return true;
  } catch {
    closeHandle(active);
    return false;
  }
}

function syncBatch(active: ActiveLog): boolean {
  try {
    if (active.handle === null) return false;
    fsyncSync(active.handle);
    return true;
  } catch {
    closeHandle(active);
    return false;
  }
}

function completedBatchMatches(
  active: ActiveLog,
  before: LogFileIdentity,
  expectedSize: number,
): boolean {
  return completedBatchIdentity(active, before, expectedSize) !== undefined;
}

function completedBatchIdentity(
  active: ActiveLog,
  before: LogFileIdentity,
  expectedSize: number,
): LogFileIdentity | undefined {
  const completed = currentHandleIdentity(active);
  if (
    completed?.dev !== before.dev ||
    completed.ino !== before.ino ||
    completed.size !== expectedSize
  ) {
    return undefined;
  }
  return completed;
}

function persistPendingDurableEvidence(
  active: ActiveLog,
  before: LogFileIdentity,
  guards: readonly LogDirectoryGuard[],
): DurableEvidencePersistenceResult {
  const events = pendingPersistenceEvents(active, undefined);
  if (events.length === 0) return { status: "persisted", identity: before };
  const lines = batchLines(events);
  if (lines === undefined) return { status: "deferred", reason: "append-failed" };
  const addedBytes = lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8"), 0);
  if (!writeBatchRecords(active, lines)) return { status: "deferred", reason: "append-failed" };
  if (!syncBatch(active)) return { status: "deferred", reason: "durability-uncertain" };
  const completed = completedBatchIdentity(active, before, before.size + addedBytes);
  if (
    completed === undefined ||
    !handleStillCurrent(active) ||
    !guards.every(logDirectoryStillSame)
  ) {
    closeHandle(active);
    return { status: "deferred", reason: "destination-mutated" };
  }
  clearPendingPersistenceEvents(active);
  return { status: "persisted", identity: completed };
}

function appendInspectedBatch(
  prepared: PreparedDurableLog,
  inspection: Extract<DurableServerLogBatchInspection, { status: "append" }>,
  before: LogFileIdentity,
  guards: readonly LogDirectoryGuard[],
  threshold: ServerLogThreshold,
): DurableServerLogBatchResult {
  if (inspection.events.some((event) => !serverLogLevelEnabled(eventLevel(event), threshold))) {
    return { status: "deferred", reason: "level-filtered" };
  }
  const correlationId = inspection.events[0]?.correlationId;
  const persistenceEvents = pendingPersistenceEvents(prepared.active, correlationId);
  const lines = batchLines([...persistenceEvents, ...inspection.events]);
  if (lines === undefined) return { status: "deferred", reason: "append-failed" };
  const addedBytes = lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8"), 0);
  if (!writeBatchRecords(prepared.active, lines)) {
    return { status: "deferred", reason: "append-failed" };
  }
  if (!syncBatch(prepared.active)) {
    return { status: "deferred", reason: "durability-uncertain" };
  }
  if (
    !completedBatchMatches(prepared.active, before, before.size + addedBytes) ||
    !handleStillCurrent(prepared.active) ||
    !guards.every(logDirectoryStillSame)
  ) {
    closeHandle(prepared.active);
    return { status: "deferred", reason: "destination-mutated" };
  }
  clearPendingPersistenceEvents(prepared.active);
  return { status: "appended", appendedCount: inspection.events.length };
}

function inspectAndAppendDurableBatch(
  prepared: PreparedDurableLog,
  guards: readonly LogDirectoryGuard[],
  options: DurableServerLogBatchOptions,
): DurableServerLogBatchResult {
  const inspection = options.inspect(prepared.directory);
  const before = stableBeforeBatch(prepared, guards);
  if (before === undefined) {
    closeHandle(prepared.active);
    return { status: "deferred", reason: "destination-mutated" };
  }
  if (inspection.status === "already-complete") return { status: "already-complete" };
  if (inspection.status === "deferred") return { status: "inspection-deferred" };
  return appendInspectedBatch(prepared, inspection, before, guards, options.level);
}

// Synchronous by design: `inspect` and the append share the process-wide ActiveLog critical
// section (one JavaScript stack), while descriptor/path/size checks expose interference from a
// second process as `deferred`. O_APPEND can still leave duplicate physical records when two
// processes import concurrently; callers obtain semantic deduplication from their stable record
// identities, never an exactly-once filesystem claim.
export function appendDurableServerLogBatch(
  stateDir: string,
  options: DurableServerLogBatchOptions,
): DurableServerLogBatchResult {
  if (!serverLogLevelEnabled("info", options.level)) {
    return { status: "deferred", reason: "level-filtered" };
  }
  const guards: LogDirectoryGuard[] = [];
  try {
    const prepared = prepareDurableLog(stateDir, guards);
    return prepared.status === "deferred"
      ? prepared
      : inspectAndAppendDurableBatch(prepared, guards, options);
  } catch {
    return { status: "deferred", reason: "destination-unsafe" };
  } finally {
    closeLogDirectoryGuards(guards);
  }
}

// The process-wide registry that makes the file sink a singleton per resolved log directory. Every
// consumer of the same file shares one descriptor and one UTC boundary state; the threshold stays
// per-consumer, because that is a caller's own volume control and cannot lose data.
const activeLogs = new Map<string, ActiveLog>();

function resolveActiveLog(directory: string): ActiveLog {
  const key = resolvePath(directory);
  const existing = activeLogs.get(key);
  if (existing !== undefined) return existing;
  const created: ActiveLog = {
    directory,
    trustedRoot: dirname(directory),
    currentPath: join(directory, "server.log"),
    currentDay: todayUtc(),
    handle: null,
    pendingNewline: false,
    pendingSafeOpenEvidence: false,
    pendingRotationOutcome: undefined,
  };
  activeLogs.set(key, created);
  return created;
}

// Closes every open activity-log descriptor. Called by the server logger's shutdown/reset path,
// and by tests so a suite does not leave descriptors behind. A subsequent write reopens: closing
// releases an OS resource, it never disables the log.
//
// The registry entries themselves are KEPT. Dropping them would let a sink created after a
// shutdown build a second ActiveLog over a file some retained sink still writes to.
export function closeFileServerLogSinks(): void {
  for (const active of activeLogs.values()) closeHandle(active);
}

export function createFileServerLogSink(
  stateDir: string,
  options: FileServerLogSinkOptions = {},
): ServerLogSink {
  const directory = join(stateDir, "logs");
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    // If we cannot create the directory we return a null sink rather than crashing the
    // server; the caller keeps running and the operator sees a missing file, not a hang.
    return NULL_SINK;
  }
  const active = resolveActiveLog(directory);
  const threshold = options.level ?? resolveServerLogThreshold(options.env ?? process.env);
  return createFileSinkFacade(active, threshold);
}

// Split out so `createFileServerLogSink` stays inside the 50-line ceiling.
function createFileSinkFacade(active: ActiveLog, threshold: ServerLogThreshold): ServerLogSink {
  return {
    write(event: ServerLogEvent): void {
      // The threshold check comes before any formatting: a filtered event costs one comparison.
      if (!serverLogLevelEnabled(eventLevel(event), threshold)) return;
      const identity = allocateServerLogIdentity();
      try {
        refreshPendingRotation(active);
        writeCurrentEvent(active, event, identity);
      } catch (error) {
        // Writing must never take the server down; a full disk, a permission change or a file
        // removed under us drops the line and forces a reopen on the next write. It does NOT drop
        // the fact that it happened: a log that has stopped working is exactly the condition an
        // operator cannot infer from the absence of lines.
        closeHandle(active);
        reportServerLogFailure(error, {
          op: event.op,
          correlationId: event.correlationId,
          loss:
            error instanceof PostWriteMutationError ? "event-location-unknown" : "event-dropped",
        });
      }
    },
    flush(): void {
      // `writeSync` leaves nothing in user space, so a flush is already complete on return.
    },
    close(): void {
      // The descriptor belongs to the shared ActiveLog, so this releases it for every sink on the
      // file. That is correct for a shutdown path and harmless otherwise: the next write reopens.
      closeHandle(active);
    },
  };
}

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
      return events.map((event) => formatServerLogLine(event));
    },
    clear(): void {
      events.length = 0;
    },
  };
}
