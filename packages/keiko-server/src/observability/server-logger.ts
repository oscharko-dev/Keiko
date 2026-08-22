// The logger callers actually hold.
//
// `ServerLogSink` stays the transport (a file, a buffer, nothing). `ServerLogger` is the calling
// surface on top of it and owns the three things every instrumentation site would otherwise
// reimplement: the level gate, the bound context, and the guarantee that logging cannot break the
// operation being logged.
//
//   const log = getServerLogger().child({ correlationId, capsuleIdDigest });
//   const elapsed = startLogTimer();
//   log.info({ category: "indexing", op: "indexing.job.started", extra: { sourceCount } });
//   log.warn({ op: "indexing.job.skipped", durationMs: elapsed(), extra: { reason } });
//
// Three properties are load-bearing:
//
//  * A filtered event costs one integer comparison. The gate runs BEFORE the event source is
//    evaluated, so a `debug` site may pass a thunk (`log.debug(() => ({ … }))`) and pay nothing
//    at all — no object literal, no string concatenation, no JSON — while the threshold is above
//    it. This is what makes per-item and per-window debug lines affordable.
//  * The bound context is merged into every event, so a call site names a correlation id once.
//    Child bindings compose; the event's own fields always win over the binding.
//  * Nothing thrown by the sink, by a thunk, or by field redaction ever reaches the caller. A log
//    line is evidence about an operation; it must never become a new failure mode for it. It is
//    not DISCARDED either: a swallowed failure makes a permanently broken log look exactly like a
//    quiet system, so the failure is reported once on stderr — an independent channel — throttled
//    and body-free. See `reportServerLogFailure` in `server-log.ts`.

import { performance } from "node:perf_hooks";

import { resolveServerLogThreshold, serverLogLevelEnabled } from "./log-level.js";
import type { ServerLogLevel, ServerLogThreshold } from "./log-level.js";
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

// A flat record of fields to bind. `correlationId` and `category` are lifted onto the event
// envelope; everything else is merged into `extra` and passes the same redaction as any field.
export type ServerLogContext = Readonly<Record<string, unknown>>;

// An event as a call site writes it: the level comes from the method, the category may come from
// the binding.
export interface ServerLogEventInput {
  readonly category?: ServerLogCategory | undefined;
  readonly op: string;
  readonly correlationId?: string | undefined;
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

const LIFTED_CONTEXT_KEYS = new Set<string>(["correlationId", "category"]);

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
  "diagnostic",
  "process",
]);

// A binding resolved once at `child()` time so the emit path never re-partitions the context.
interface ResolvedBinding {
  readonly category: ServerLogCategory | undefined;
  readonly correlationId: string | undefined;
  readonly extra: Readonly<Record<string, unknown>> | undefined;
}

const EMPTY_BINDING: ResolvedBinding = {
  category: undefined,
  correlationId: undefined,
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
  return {
    category: readCategory(context.category) ?? parent.category,
    correlationId: typeof correlationId === "string" ? correlationId : parent.correlationId,
    extra: Object.keys(extra).length === 0 ? undefined : extra,
  };
}

function mergeExtra(
  binding: ResolvedBinding,
  input: ServerLogEventInput,
): Readonly<Record<string, unknown>> | undefined {
  if (binding.extra === undefined) return input.extra;
  if (input.extra === undefined) return binding.extra;
  return { ...binding.extra, ...input.extra };
}

function buildEvent(
  level: ServerLogLevel,
  input: ServerLogEventInput,
  binding: ResolvedBinding,
): ServerLogEvent {
  return {
    level,
    category: input.category ?? binding.category ?? FALLBACK_CATEGORY,
    op: input.op,
    correlationId: input.correlationId ?? binding.correlationId,
    durationMs: input.durationMs,
    status: input.status,
    errorKind: input.errorKind,
    extra: mergeExtra(binding, input),
  };
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

// Split from `createServerLogger` so both it and `child()` share one construction path, and so
// each function stays small.
function buildLogger(
  sink: ServerLogSink,
  level: ServerLogThreshold,
  binding: ResolvedBinding,
): ServerLogger {
  const emit = (eventLevel: ServerLogLevel, source: ServerLogEventSource): void => {
    // The gate is the first statement: below the threshold nothing is evaluated, allocated or
    // serialised, so a suppressed debug site costs one comparison.
    if (!serverLogLevelEnabled(eventLevel, level)) return;
    // Held outside the `try` so the catch can tell "the sink failed on this event" from "the event
    // could not be built at all", and name the op and correlation id in the first case.
    let event: ServerLogEvent | undefined;
    try {
      const input = typeof source === "function" ? source() : source;
      event = buildEvent(eventLevel, input, binding);
      sink.write(event);
    } catch (error) {
      // A sink failure, a throwing thunk or a hostile field getter must never surface to the
      // operation being logged. The line is lost; the request is not. What must NOT be lost is the
      // fact that logging is broken — discarded here, a full disk or a permission change is
      // indistinguishable from a quiet system, which is the silence this log exists to end. The
      // notice goes to stderr, an independent channel, and is throttled by `reportServerLogFailure`.
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

// Process-wide logger. Deep call sites (background indexing runs, capsule preflights, connector
// jobs) have no dependency-injection seam to thread a sink through; they resolve this instead.
// It mirrors the resolution `diagnostics-log.ts` already uses: `KEIKO_STATE_DIR` when the CLI set
// it, otherwise a null sink, so a unit test that never sets the variable writes nothing.
let processLogger: ServerLogger | null = null;

function buildProcessLogger(): ServerLogger {
  const stateDir = process.env.KEIKO_STATE_DIR;
  if (stateDir === undefined || stateDir === "") {
    return createServerLogger({ sink: nullServerLogSink() });
  }
  // `createFileServerLogSink` is a per-file singleton, so this shares the CLI's descriptor and
  // rotation state rather than opening a second one over the same file.
  return createServerLogger({ sink: createFileServerLogSink(stateDir) });
}

export function getServerLogger(): ServerLogger {
  processLogger ??= buildProcessLogger();
  return processLogger;
}

// Explicit wiring (the CLI hands over the same sink it gives `createUiServer`) and test setup.
export function setServerLogger(logger: ServerLogger): void {
  processLogger = logger;
}

// Releases the activity log's OS resources and drops the memoised logger. Dropping the reference
// alone leaked the descriptor: nothing else holds the sink, so the handle stayed open for the life
// of the process and, in a long test run, once per suite that touched the logger. Every line is
// already on disk when `write` returns (the sink is synchronous), so this closes rather than
// flushes. Safe to call more than once, and safe to call early — a later write reopens.
export function shutdownServerLogging(): void {
  processLogger = null;
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
