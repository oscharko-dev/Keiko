// Server activity log — one JSON line per operation into `<stateDir>/logs/server.log`, with
// day-based rotation and a rolling 7-day retention. Written unconditionally, no env-var opt-in:
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
// open/write/close triple `appendFileSync` pays per call. `server-log.test.ts` asserts exactly
// that over a burst — one `openSync`, one `writeSync` per line, and a file whose size is the SUM of
// each line's own byte length (lines are no longer byte-identical once `seq` is in the envelope: its
// digit width grows at each power-of-ten boundary the burst crosses) — so a regression to per-write
// open/close, or to a quadratic format path, fails the suite deterministically instead of showing up
// as latency in production. A wall-clock budget would measure the runner's disk instead, and go red
// on a diff that never touched this file.
//
// Levels are the volume control instead: an event below the configured threshold returns before
// any string or JSON work happens at all (`KEIKO_LOG_LEVEL`, default `info`).

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import { classifyErrorKind } from "@oscharko-dev/keiko-contracts";

import { isValidCorrelationId } from "../correlation.js";
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
// adds.
export type ServerLogCategory =
  | "http"
  | "gateway"
  | "embedding"
  | "indexing"
  | "setup"
  | "search"
  | "memory"
  | "diagnostic"
  | "process";

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
// reuses pids across restarts, so two different process lifetimes can share one in a rotated
// multi-day file. `pid` + `instanceId` together, never `pid` alone, is what an agent joins on.
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
  if (typeof error !== "object" || error === null) return "unknown";
  const code = machineToken(safeProperty(error, "code"));
  if (code !== undefined) return code;
  if (error instanceof Error) return contentFreeErrorClass(error);
  return classifyErrorKind(safeProperty(error, "name")) ?? "unknown";
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
  };
  if (context.op !== undefined) notice.failedOp = redactLogLabel(context.op);
  if (context.correlationId !== undefined) {
    notice.correlationId = redactLogLabel(context.correlationId);
  }
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

// Kept in memory so a single process rotates without reopening on every write, and holds one
// append-mode descriptor for the life of the current file.
//
// ONE ActiveLog PER FILE, PROCESS-WIDE. This is a data-loss invariant, not a performance tweak.
// Two independent ActiveLogs on the same `server.log` each carry their own `currentDay`, so at the
// UTC day boundary BOTH run `rotateIfNeeded`: the first renames `server.log` to the archive and
// starts a fresh file, and the second renames that fresh file over the archive the first just
// wrote — destroying every line from the finished day. The CLI already wires one file sink as
// `deps.activityLog` while `getServerLogger()` lazily builds another for deep call sites, so this
// was not a hypothetical arrangement; it was the shipped one.
interface ActiveLog {
  readonly directory: string;
  readonly currentPath: string;
  readonly retentionDays: number;
  currentDay: string;
  handle: number | null;
  // Set while a record is being written and cleared once it has landed whole, so a write that
  // stalled mid-line is remembered: the file ends mid-record and the next record must open with a
  // newline. See `writeRecord`.
  pendingNewline: boolean;
}

// PROCESS-WIDE `seq` ALLOCATOR — one counter, one module, for the life of the process.
//
// It must NOT live on `ActiveLog`. Two independent state directories in the same process (a CLI
// pointed at a workspace-local state dir, and the server logger's own default) each resolve to a
// DIFFERENT `ActiveLog`; a counter kept per `ActiveLog` restarts at 1 for each one, so two lines
// written moments apart — one to each directory — can carry the identical `(pid, instanceId, seq)`
// tuple. That tuple is the join key ADR-0173 (D2) promises an agent a total, gap-free order on, and
// a duplicate breaks the promise regardless of how many log directories the process happens to
// have open. One allocator shared by every `ActiveLog`, every rotation, and every sink built on top
// of any of them is what keeps the tuple unique process-wide.
//
// Claimed as soon as an event clears the level gate, in `createFileSinkFacade.write`, BEFORE the
// write is attempted — never rolled back if that write then throws. The alternative, claiming only
// after a successful write, would let two callers racing the same failure both observe the same
// pre-failure counter value and then both claim the number that follows it, silently reusing a
// sequence number for two different lines. A gap is not a bug in this counter: it is the evidence
// that a line was not persisted, and `reportServerLogFailure`'s suppressed-notice count accounts
// for the writes a gap represents. Monotonic per process; a gap marks a line the sink could not
// persist.
let nextProcessSeq = 1;

function allocateServerLogSeq(): number {
  const seq = nextProcessSeq;
  nextProcessSeq += 1;
  return seq;
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

// Throws rather than returning null: a descriptor we cannot open is a failure an operator has to
// hear about, and the caller's catch is the one place that both closes and reports.
function ensureHandle(active: ActiveLog): number {
  if (active.handle !== null) return active.handle;
  active.handle = openSync(active.currentPath, "a", 0o600);
  return active.handle;
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  const { code } = error;
  return typeof code === "string" ? code : "";
}

// Names old files with their calendar day, e.g. `server-2026-08-20.log`, and keeps at most
// `retentionDays` of them. A fresh install starts empty. This is the whole rotation policy.
function rotateIfNeeded(active: ActiveLog): void {
  const day = todayUtc();
  if (day === active.currentDay) return;
  closeHandle(active);
  // A successful archive means the file we were mid-record in is no longer the file we append to,
  // so the partial-record debt does not travel to the fresh one.
  if (archiveCurrentDay(active)) active.pendingNewline = false;
  active.currentDay = day;
  pruneOldFiles(active.directory, active.retentionDays);
}

// Rotation has to be atomic ACROSS PROCESSES, not merely within one. `renameSync` REPLACES an
// existing destination, so two Keiko processes sharing a state directory that both reach the UTC
// boundary destroy the finished day: the first archives it, the second renames its own fresh file
// over that archive. An `existsSync` guard does not close that window — it is a check, and the
// window is between the check and the rename. The in-process registry below cannot help either;
// by construction it coordinates only one process.
//
// `link(2)` has no such window: it fails with EEXIST when the destination already exists, so
// exactly one process can ever create `server-<day>.log`. The loser leaves the archive alone and
// only advances its own day; only the winner unlinks the current path, so a fresh file another
// process is already appending to can never be moved on top of a finished day.
// `link(2)` reports "not supported by this filesystem" through these. EPERM is ambiguous — it is
// also plain permission denial — but the state directory is created by this process at 0700, so a
// permission failure on it is not the reachable case, and treating it as unsupported keeps
// removable-media installs rotating.
const NO_HARD_LINK_SUPPORT = new Set(["EPERM", "ENOSYS", "EOPNOTSUPP", "ENOTSUP"]);

function archiveCurrentDay(active: ActiveLog): boolean {
  const rolled = join(active.directory, `server-${active.currentDay}.log`);
  try {
    linkSync(active.currentPath, rolled);
  } catch (error) {
    const code = errorCode(error);
    // EEXIST: a peer already archived this day, and leaving its file untouched is the whole point.
    // ENOENT: there is nothing to archive (a fresh install, or a peer that has already moved it).
    if (code === "EEXIST" || code === "ENOENT") return false;
    // ONLY "this filesystem has no hard links" may fall back to the destination-replacing rename.
    // EACCES, EMLINK, EIO and friends are real failures, and for them the safe outcome is to NOT
    // rotate: one file growing is a nuisance, overwriting a peer's finished archive is data loss.
    // Choose the nuisance. Without this narrowing the fallback re-opened the exact race the
    // hard-link rotation exists to close.
    if (!NO_HARD_LINK_SUPPORT.has(code)) return false;
    return archiveWithoutHardLinks(active, rolled);
  }
  return unlinkCurrentPath(active);
}

// A filesystem that cannot hard-link at all (FAT/exFAT under a state directory on removable
// media). No atomic primitive is left, so this falls back to the guarded rename rather than never
// rotating and letting one file grow without bound — the cross-process window exists only here,
// and only where nothing better is available.
function archiveWithoutHardLinks(active: ActiveLog, rolled: string): boolean {
  if (existsSync(rolled) || !existsSync(active.currentPath)) return false;
  try {
    renameSync(active.currentPath, rolled);
    return true;
  } catch {
    // Windows file-busy and friends: keep appending to the current file — rotation is a
    // convenience, not a correctness requirement.
    return false;
  }
}

function unlinkCurrentPath(active: ActiveLog): boolean {
  try {
    unlinkSync(active.currentPath);
    return true;
  } catch {
    // The archive is written, which is the part that matters. This process keeps appending to the
    // still-linked current file, and the next boundary finds the archive present and leaves it be.
    return false;
  }
}

function pruneOldFiles(directory: string, retentionDays: number): void {
  try {
    const entries = readdirSync(directory).filter((name) =>
      /^server-\d{4}-\d{2}-\d{2}\.log$/.test(name),
    );
    if (entries.length <= retentionDays) return;
    // Explicit collator, not the default lexicographic sort: the names are ISO-dated, so the
    // ordering decides which files rotation deletes.
    entries.sort((left, right) => left.localeCompare(right, "en-US"));
    for (const stale of entries.slice(0, entries.length - retentionDays)) {
      try {
        unlinkSync(join(directory, stale));
      } catch {
        // Best effort; a locked file will be retried on the next rotation.
      }
    }
  } catch {
    // Directory unreadable is not a reason to fail the server; the next write recreates it.
  }
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
    if (written <= 0) throw new Error("activity log descriptor accepted no bytes");
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

export interface FileServerLogSinkOptions {
  readonly level?: ServerLogThreshold | undefined;
  readonly retentionDays?: number | undefined;
  readonly env?: ServerLogEnv | undefined;
}

// The process-wide registry that makes the file sink a singleton per resolved log directory. Every
// consumer of the same file shares one descriptor and one rotation state; the threshold stays
// per-consumer, because that is a caller's own volume control and cannot lose data.
const activeLogs = new Map<string, ActiveLog>();

function resolveActiveLog(directory: string, retentionDays: number): ActiveLog {
  const key = resolvePath(directory);
  const existing = activeLogs.get(key);
  // The first caller's retention wins: a second sink on the same file is the same file, and two
  // retention policies over one directory is not a thing that can be honoured anyway.
  if (existing !== undefined) return existing;
  const created: ActiveLog = {
    directory,
    currentPath: join(directory, "server.log"),
    retentionDays,
    currentDay: todayUtc(),
    handle: null,
    pendingNewline: false,
  };
  activeLogs.set(key, created);
  return created;
}

// Closes every open activity-log descriptor. Called by the server logger's shutdown/reset path,
// and by tests so a suite does not leave descriptors behind. A subsequent write reopens: closing
// releases an OS resource, it never disables the log.
//
// The registry entries themselves are KEPT. Dropping them would let a sink created after a
// shutdown build a second ActiveLog over a file some retained sink still writes to — which is the
// two-rotation-states data loss this registry exists to make impossible.
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
  const active = resolveActiveLog(directory, options.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS);
  const threshold = options.level ?? resolveServerLogThreshold(options.env ?? process.env);
  return createFileSinkFacade(active, threshold);
}

// Split out so `createFileServerLogSink` stays inside the 50-line ceiling.
function createFileSinkFacade(active: ActiveLog, threshold: ServerLogThreshold): ServerLogSink {
  return {
    write(event: ServerLogEvent): void {
      // The threshold check comes before any formatting: a filtered event costs one comparison.
      if (!serverLogLevelEnabled(eventLevel(event), threshold)) return;
      try {
        rotateIfNeeded(active);
        // Claimed as soon as the event clears the gate, before the write is attempted: see
        // `allocateServerLogSeq` for why a dropped write must not roll this number back.
        const seq = allocateServerLogSeq();
        const identity: ServerLogIdentity = {
          schemaVersion: SERVER_LOG_SCHEMA_VERSION,
          pid: process.pid,
          instanceId: INSTANCE_ID,
          seq,
        };
        writeRecord(active, ensureHandle(active), formatServerLogLine(event, undefined, identity));
      } catch (error) {
        // Writing must never take the server down; a full disk, a permission change or a file
        // removed under us drops the line and forces a reopen on the next write. It does NOT drop
        // the fact that it happened: a log that has stopped working is exactly the condition an
        // operator cannot infer from the absence of lines.
        closeHandle(active);
        reportServerLogFailure(error, { op: event.op, correlationId: event.correlationId });
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
