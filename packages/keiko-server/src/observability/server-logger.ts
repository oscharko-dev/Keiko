// The logger callers actually hold.
//
// `ServerLogSink` stays the transport (a file, a buffer, nothing). `ServerLogger` is the calling
// surface on top of it and owns the things every instrumentation site would otherwise reimplement:
// the level gate, the bound context, loss accounting, and the guarantee that logging cannot break
// the operation being logged.
//
//   const log = getServerLogger().child({ correlationId, capsuleIdDigest });
//   const elapsed = startLogTimer();
//   log.info({ category: "indexing", op: "indexing.job.started", extra: { sourceCount } });
//   log.warn({ op: "indexing.job.skipped", durationMs: elapsed(), extra: { reason } });
//
// Four properties are load-bearing:
//
//  * A filtered event costs one integer comparison. The gate runs BEFORE the event source is
//    evaluated, so a `debug` site may pass a thunk (`log.debug(() => ({ … }))`) and pay nothing
//    at all — no object literal, no string concatenation, no JSON — while the threshold is above
//    it. This is what makes per-item and per-window debug lines affordable.
//  * Mandatory evidence is never filtered (#3532): process lifecycle boundaries and every
//    loss/readiness signal pass the gate at any threshold, `silent` included, so an operator who
//    turned the log down can still tell a quiet process from one that lost its evidence. Mandatory
//    evidence is always passed as a registered event object, never as a thunk.
//  * The bound context is merged into every event, so a call site names a correlation id once.
//    Child bindings compose; the event's own fields always win over the binding.
//  * Nothing thrown by the sink, by a thunk, or by field redaction ever reaches the caller. A log
//    line is evidence about an operation; it must never become a new failure mode for it. It is
//    not DISCARDED either: the loss is counted in the process-wide loss ledger (persisted as the
//    `activity-log.loss` summary) and reported once on stderr — an independent channel — throttled
//    and body-free. See `reportServerLogFailure` in `server-log.ts`.

import { performance } from "node:perf_hooks";
import {
  activityLogEventRegistration,
  activityLogEventWillBeRejected,
  attachActivityLogEventRegistration,
  recordActivityLogLoss,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ActivityLogWriterKind } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";

import {
  DEFAULT_SERVER_LOG_LEVEL,
  resolveServerLogThreshold,
  serverLogLevelEnabled,
} from "./log-level.js";
import type { ServerLogEnv, ServerLogLevel, ServerLogThreshold } from "./log-level.js";
import { configuredRuntimeStateDir, resolveRuntimeStateDir } from "./runtime-state-dir.js";
import {
  closeFileServerLogSinks,
  createFileServerLogSink,
  nullServerLogSink,
  reportServerLogFailure,
  resetServerLogFailureNotices,
} from "./server-log.js";
import type {
  ServerLogCategory,
  ServerLogEvent,
  ServerLogFailureContext,
  ServerLogSink,
} from "./server-log.js";

// A flat record of fields to bind. `correlationId`, `parentCorrelationId` and `category` are
// lifted onto the event envelope; everything else is merged into `extra` and passes the same
// redaction as any field.
export type ServerLogContext = Readonly<Record<string, unknown>>;

// An event as a call site writes it: the level comes from the method, the category may come from
// the binding.
export interface ServerLogEventInput {
  readonly category?: ServerLogCategory | undefined;
  readonly op: string;
  readonly correlationId?: string | undefined;
  // See `ServerLogEvent.parentCorrelationId` (server-log.ts) — set only when this event belongs to
  // a background job/HarnessEvent run spawned from a request whose id is known.
  readonly parentCorrelationId?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly status?: number | undefined;
  readonly errorKind?: string | undefined;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

// A thunk defers every allocation until after the level gate has passed.
export type ServerLogEventSource = ServerLogEventInput | (() => ServerLogEventInput);

export interface ServerLogger {
  readonly level: ServerLogThreshold;
  readonly isLevelEnabled: (level: ServerLogLevel) => boolean;
  readonly debug: (source: ServerLogEventSource) => void;
  readonly info: (source: ServerLogEventSource) => void;
  readonly warn: (source: ServerLogEventSource) => void;
  readonly error: (source: ServerLogEventSource) => void;
  readonly log: (level: ServerLogLevel, source: ServerLogEventSource) => void;
  readonly child: (context: ServerLogContext) => ServerLogger;
}

const FALLBACK_CATEGORY: ServerLogCategory = "diagnostic";

const LIFTED_CONTEXT_KEYS = new Set<string>(["correlationId", "parentCorrelationId", "category"]);

// Kept in lockstep with `ServerLogCategory` in `server-log.ts` — this is the runtime mirror of that
// compile-time union, consulted by `readCategory` below so a bound context can only ever lift a
// category the type actually declares onto the envelope.
const KNOWN_CATEGORIES = new Set<string>([
  "http",
  "gateway",
  "embedding",
  "indexing",
  "setup",
  "search",
  "memory",
  "security",
  "diagnostic",
  "process",
  "consolidation",
]);

// Evidence the configured level must never silence (#3532). Every registered `loss` operation is
// mandatory by its lifecycle phase; these operations are mandatory by name because they bound the
// process lifetime or state whether the log can be trusted at all.
const MANDATORY_OPERATIONS: ReadonlySet<string> = new Set([
  "process.started",
  "process.exiting",
  "process.fatal",
  "activity-log.readiness",
  "activity-log.loss",
]);

/**
 * True for registered evidence that bypasses the level threshold: process lifecycle boundaries,
 * readiness, and every loss signal. Unregistered events are never mandatory.
 */
export function isMandatoryActivityLogEvent(event: object): boolean {
  // Reading the registration marker is a property read on an object this layer did not build; a
  // hostile accessor that throws makes the event ordinary, never a new failure of the caller.
  try {
    const registration = activityLogEventRegistration(event);
    return (
      registration !== undefined &&
      (registration.lifecycle === "loss" || MANDATORY_OPERATIONS.has(registration.op))
    );
  } catch {
    return false;
  }
}

function sourcePassesGate(
  eventLevel: ServerLogLevel,
  threshold: ServerLogThreshold,
  source: ServerLogEventSource,
): boolean {
  if (serverLogLevelEnabled(eventLevel, threshold)) return true;
  return typeof source !== "function" && isMandatoryActivityLogEvent(source);
}

// A binding resolved once at `child()` time so the emit path never re-partitions the context.
interface ResolvedBinding {
  readonly category: ServerLogCategory | undefined;
  readonly correlationId: string | undefined;
  readonly parentCorrelationId: string | undefined;
  readonly extra: Readonly<Record<string, unknown>> | undefined;
}

const EMPTY_BINDING: ResolvedBinding = {
  category: undefined,
  correlationId: undefined,
  parentCorrelationId: undefined,
  extra: undefined,
};

function readCategory(value: unknown): ServerLogCategory | undefined {
  return typeof value === "string" && KNOWN_CATEGORIES.has(value)
    ? (value as ServerLogCategory)
    : undefined;
}

function resolveBinding(parent: ResolvedBinding, context: ServerLogContext): ResolvedBinding {
  const extra: Record<string, unknown> = { ...parent.extra };
  for (const [name, value] of Object.entries(context)) {
    if (!LIFTED_CONTEXT_KEYS.has(name)) extra[name] = value;
  }
  const correlationId = context.correlationId;
  const parentCorrelationId = context.parentCorrelationId;
  return {
    category: readCategory(context.category) ?? parent.category,
    correlationId: typeof correlationId === "string" ? correlationId : parent.correlationId,
    parentCorrelationId:
      typeof parentCorrelationId === "string" ? parentCorrelationId : parent.parentCorrelationId,
    extra: Object.keys(extra).length === 0 ? undefined : extra,
  };
}

function mergeExtra(
  binding: ResolvedBinding,
  input: ServerLogEventInput,
  registeredFields?: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | undefined {
  const bound =
    registeredFields === undefined || binding.extra === undefined
      ? binding.extra
      : Object.fromEntries(
          Object.entries(binding.extra).filter(([name]) => registeredFields.has(name)),
        );
  if (bound === undefined || Object.keys(bound).length === 0) return input.extra;
  if (input.extra === undefined) return bound;
  return { ...bound, ...input.extra };
}

function buildEvent(
  level: ServerLogLevel,
  input: ServerLogEventInput,
  binding: ResolvedBinding,
): ServerLogEvent {
  const registration = activityLogEventRegistration(input);
  const registeredFields =
    registration === undefined ? undefined : new Set(Object.keys(registration.fields));
  const event: ServerLogEvent = {
    level,
    category: input.category ?? binding.category ?? FALLBACK_CATEGORY,
    op: input.op,
    correlationId: input.correlationId ?? binding.correlationId,
    parentCorrelationId: input.parentCorrelationId ?? binding.parentCorrelationId,
    durationMs: input.durationMs,
    status: input.status,
    errorKind: input.errorKind,
    extra: mergeExtra(binding, input, registeredFields),
  };
  return attachActivityLogEventRegistration(event, registration);
}

export interface ServerLoggerOptions {
  readonly sink: ServerLogSink;
  readonly level?: ServerLogThreshold | undefined;
  readonly context?: ServerLogContext | undefined;
}

export function createServerLogger(options: ServerLoggerOptions): ServerLogger {
  const level = options.level ?? resolveServerLogThreshold(process.env);
  const binding =
    options.context === undefined ? EMPTY_BINDING : resolveBinding(EMPTY_BINDING, options.context);
  return buildLogger(options.sink, level, binding);
}

// `undefined` means the failure happened while BUILDING the event, so there is no op to name and
// the notice says only what kind of failure it was.
function failureContext(event: ServerLogEvent | undefined): ServerLogFailureContext {
  if (event === undefined) return {};
  if (event.correlationId === undefined) return { op: event.op };
  return { op: event.op, correlationId: event.correlationId };
}

// Counts a validation refusal before the sink drops the event, so a rejected event is a counted
// loss rather than only a throttled stderr notice. A marker read, never a second validation.
function writeCounted(sink: ServerLogSink, event: ServerLogEvent): void {
  if (activityLogEventWillBeRejected(event)) recordActivityLogLoss("schema-rejected");
  sink.write(event);
}

// Split from `createServerLogger` so both it and `child()` share one construction path, and so
// each function stays small.
function buildLogger(
  sink: ServerLogSink,
  level: ServerLogThreshold,
  binding: ResolvedBinding,
): ServerLogger {
  const emit = (eventLevel: ServerLogLevel, source: ServerLogEventSource): void => {
    // The gate is the first statement: below the threshold nothing is evaluated, allocated or
    // serialised unless the source is mandatory evidence, so a suppressed debug site costs one
    // comparison and one `typeof`.
    if (!sourcePassesGate(eventLevel, level, source)) return;
    // Held outside the `try` so the catch can tell "the sink failed on this event" from "the event
    // could not be built at all", and name the op and correlation id in the first case.
    let event: ServerLogEvent | undefined;
    try {
      const input = typeof source === "function" ? source() : source;
      event = buildEvent(eventLevel, input, binding);
      writeCounted(sink, event);
    } catch (error) {
      // A sink failure, a throwing thunk or a hostile field getter must never surface to the
      // operation being logged. The line is lost; the request is not. What must NOT be lost is the
      // fact that logging is broken — so the loss is counted, and the notice goes to stderr, an
      // independent channel, throttled by `reportServerLogFailure`.
      recordActivityLogLoss("logger-write-failed");
      reportServerLogFailure(error, failureContext(event));
    }
  };
  return {
    level,
    isLevelEnabled: (candidate: ServerLogLevel): boolean => serverLogLevelEnabled(candidate, level),
    debug: (source: ServerLogEventSource): void => {
      emit("debug", source);
    },
    info: (source: ServerLogEventSource): void => {
      emit("info", source);
    },
    warn: (source: ServerLogEventSource): void => {
      emit("warn", source);
    },
    error: (source: ServerLogEventSource): void => {
      emit("error", source);
    },
    log: emit,
    child: (context: ServerLogContext): ServerLogger =>
      buildLogger(sink, level, resolveBinding(binding, context)),
  };
}

/**
 * A logger that writes nothing. Reachable only through explicit injection (`setServerLogger`) or
 * the explicit test writer below — never as a production fallback.
 */
export function nullServerLogger(): ServerLogger {
  return createServerLogger({ sink: nullServerLogSink(), level: "silent" });
}

// Monotonic elapsed-milliseconds stopwatch. `performance.now()` rather than `Date.now()` so a
// system-clock adjustment mid-operation cannot produce a negative or absurd duration.
export function startLogTimer(): () => number {
  const startedAt = performance.now();
  return (): number => Number((performance.now() - startedAt).toFixed(3));
}

// `errorKindOf` lives in `server-log.js` — the file sink classifies its own failures too, so the
// module both sides already depend on owns it. It stays reachable from this module's barrel.

export interface ActivityLogSinkOptions {
  readonly level?: ServerLogThreshold | undefined;
  readonly env?: ServerLogEnv | undefined;
}

/**
 * The production Activity Log sink for one state directory, gated like the logger: events below the
 * configured threshold are dropped unless they are mandatory evidence, a validation refusal is
 * counted, and a thrown write is counted and reported instead of propagating. Every composition
 * site that writes lifecycle or loss evidence directly (the UI process lifecycle, the fatal guard)
 * uses this instead of a raw file sink, whose own threshold would silence that evidence.
 */
export function createActivityLogSink(
  stateDir: string,
  options: ActivityLogSinkOptions = {},
): ServerLogSink {
  const file = createFileServerLogSink(stateDir, { level: "debug" });
  const threshold = options.level ?? resolveServerLogThreshold(options.env ?? process.env);
  return {
    write(event: ServerLogEvent): void {
      try {
        if (!sourcePassesGate(event.level ?? DEFAULT_SERVER_LOG_LEVEL, threshold, event)) return;
        writeCounted(file, event);
      } catch (error) {
        recordActivityLogLoss("logger-write-failed");
        reportServerLogFailure(error, failureContext(event));
      }
    },
    flush(): void {
      file.flush?.();
    },
    close(): void {
      file.close?.();
    },
  };
}

// ─── The process-wide logger ─────────────────────────────────────────────────────
//
// Deep call sites (background indexing runs, capsule preflights, connector jobs) have no
// dependency-injection seam to thread a sink through; they resolve this instead. It always resolves
// to the production Activity Log of the runtime state directory — `KEIKO_STATE_DIR`, else the
// CLI's default `<cwd>/.keiko` — so no production process can silently log to nowhere (#3532).
//
// The one exception is EXPLICIT test injection: a test harness sets the global marker below (the
// repository's Vitest setup does) so a unit test that configures no state directory writes nothing,
// exactly as before, while readiness reports the writer as `test-injected` rather than production.
// A production process never sets the marker; it is not an environment variable an operator could
// flip, and nothing in the product imports the setter.

const ACTIVITY_LOG_TEST_WRITER = Symbol.for("@oscharko-dev/keiko-server/activity-log-test-writer");

function activityLogTestWriterInstalled(): boolean {
  return (globalThis as Readonly<Record<symbol, unknown>>)[ACTIVITY_LOG_TEST_WRITER] === true;
}

/** Test harness only: marks this process as running under an explicitly injected test writer. */
export function installActivityLogTestWriter(installed = true): void {
  (globalThis as Record<symbol, unknown>)[ACTIVITY_LOG_TEST_WRITER] = installed;
}

interface ProcessLoggerSlot {
  readonly logger: ServerLogger;
  readonly writer: ActivityLogWriterKind;
  readonly stateDir: string | undefined;
  // The configured `KEIKO_STATE_DIR` the slot was resolved for; a changed value rebuilds it.
  readonly configuredStateDir: string | undefined;
  // True when a caller injected the logger explicitly; an explicit logger wins until reset.
  readonly explicit: boolean;
}

let processSlot: ProcessLoggerSlot | null = null;

// A logger for a process whose production Activity Log could not be opened. It never pretends to
// be quiet: every event it receives is counted as lost, and readiness reports the writer as
// unavailable until a later resolution succeeds.
function unavailableServerLogger(): ServerLogger {
  return createServerLogger({
    sink: {
      write(): void {
        recordActivityLogLoss("logger-unavailable");
      },
    },
  });
}

/**
 * The state directory whose Activity Log this process writes: the configured or default runtime
 * state directory, or `undefined` when an explicit test writer replaces the production log.
 */
export function resolveActivityLogStateDir(env: ServerLogEnv = process.env): string | undefined {
  if (configuredRuntimeStateDir(env) === undefined && activityLogTestWriterInstalled()) {
    return undefined;
  }
  return resolveRuntimeStateDir(env);
}

function buildProcessSlot(configuredStateDir: string | undefined): ProcessLoggerSlot {
  const base = { configuredStateDir, explicit: false } as const;
  const stateDir = resolveActivityLogStateDir();
  if (stateDir === undefined) {
    return { ...base, logger: nullServerLogger(), writer: "test-injected", stateDir: undefined };
  }
  // `createFileServerLogSink` is a per-directory singleton, so this shares the CLI's descriptor and
  // rotation state rather than opening a second one over the same file. The sink passes every
  // level through; the logger's own gate applies the threshold and the mandatory bypass.
  try {
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    return { ...base, logger: createServerLogger({ sink }), writer: "production-file", stateDir };
  } catch (error) {
    reportServerLogFailure(error, { op: "server-log.initialize", loss: "event-dropped" });
    return { ...base, logger: unavailableServerLogger(), writer: "unavailable", stateDir };
  }
}

function currentProcessSlot(): ProcessLoggerSlot {
  const configuredStateDir = configuredRuntimeStateDir(process.env);
  if (
    processSlot !== null &&
    (processSlot.explicit || processSlot.configuredStateDir === configuredStateDir)
  ) {
    return processSlot;
  }
  const slot = buildProcessSlot(configuredStateDir);
  // An initialization failure must not become a permanently memoised unavailable logger: the slot
  // stays empty so a later operation recovers automatically once the filesystem problem is fixed.
  // Repeated failure notices remain body-free and are throttled by `reportServerLogFailure`.
  processSlot = slot.writer === "unavailable" ? null : slot;
  return slot;
}

export function getServerLogger(): ServerLogger {
  return currentProcessSlot().logger;
}

export interface ActivityLogWriterState {
  readonly writer: ActivityLogWriterKind;
  // The state directory the production writer appends to; undefined for a test writer.
  readonly stateDir: string | undefined;
}

/** Which writer the process-wide logger resolves to right now, and for which state directory. */
export function activityLogWriterState(): ActivityLogWriterState {
  const slot = currentProcessSlot();
  return { writer: slot.writer, stateDir: slot.stateDir };
}

// Explicit wiring and test setup. An explicitly injected logger is reported as a test writer unless
// the caller states it is the production file writer.
export function setServerLogger(
  logger: ServerLogger,
  writer: ActivityLogWriterKind = "test-injected",
  stateDir?: string,
): void {
  processSlot = { logger, writer, stateDir, configuredStateDir: undefined, explicit: true };
}

// Releases the activity log's OS resources and drops the memoised logger. Dropping the reference
// alone leaked the descriptor: nothing else holds the sink, so the handle stayed open for the life
// of the process and, in a long test run, once per suite that touched the logger. Every line is
// already on disk when `write` returns (the sink is synchronous), so this closes rather than
// flushes. Safe to call more than once, and safe to call early — a later write reopens.
export function shutdownServerLogging(): void {
  processSlot = null;
  closeFileServerLogSinks();
  // The failure-notice throttle is process-wide state too: a notice emitted before a shutdown must
  // not silence the first failure of whatever runs next.
  resetServerLogFailureNotices();
}

// Tests MUST call this in `afterEach` so the process-wide slot is not shared mutable state
// between suites — and so the descriptor it opened does not outlive the suite.
export function resetServerLogger(): void {
  shutdownServerLogging();
}
