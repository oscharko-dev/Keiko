// The QueueEventSink bridges the harness's push-only, synchronous EventSink (and the structurally
// identical workflow WorkflowEventSink / BugWorkflowEventSink) to Server-Sent Events (ADR-0011 D7).
// It satisfies all three sink shapes — each is `{ emit(event): void }` over an event that carries
// the `{ schemaVersion, runId, fingerprint, seq, ts, type }` envelope — with one `emit` typed over
// that structural envelope (no `any`; the concrete unions are assignable to it).
//
// It deliberately does NOT set `retainsRawContent`, so the harness emitter redacts every SENSITIVE
// field before this sink ever receives an event (the browser only sees redacted events). Internally
// it (a) appends each received event to a per-run BOUNDED ring buffer for replay-on-connect (oldest
// dropped past the cap), and (b) fans the event out to any currently-attached SSE writers. A late or
// reconnecting subscriber replays the buffer (respecting Last-Event-ID = the harness `seq`), then
// receives live events, then a close after the terminal event.
//
// (c) it also tees every TERMINAL event (run:completed/failed/cancelled, bug:completed/failed,
// workflow:completed/failed — #2902 w4b) through `emitServerDiagnostic`, keyed by the event's own
// `runId`. Before this, a run's terminal outcome existed ONLY as an SSE frame: if no writer was
// attached when it fired — a closed browser tab, a dropped connection — the outcome was fanned out
// to nobody, and once the ring buffer's TTL expired it left no trace anywhere, including
// `server.log`. The tee makes the terminal outcome durable regardless of who, if anyone, was
// listening on SSE at the moment it happened.

import {
  emitServerDiagnostic,
  type ServerDiagnosticSink,
  type ServerDiagnosticSummary,
} from "./diagnostics-log.js";
import { machineToken } from "./observability/error-classification.js";

// The structural event envelope every harness/workflow event satisfies. Extra members vary per
// event type and are not accessed here (the sink only needs `seq` for replay and `type` for SSE
// framing); they ride along untyped-but-present in the serialized `data`.
export interface StreamEvent {
  readonly schemaVersion: "1";
  readonly runId: string;
  readonly fingerprint: string;
  readonly seq: number;
  readonly ts: number;
  readonly type: string;
}

// The closed set of TERMINAL event types across the three structurally-identical envelopes this
// sink fans out for — HarnessEvent (run:*), BugInvestigationEvent (bug:*), and the unit-test
// WorkflowEvent (workflow:*) (verified packages/keiko-contracts/src/{harness,
// bug-investigation-events,unit-test-events}.ts). A closed Set, not a prefix/suffix heuristic: a
// future non-terminal member sharing a substring must never be teed as if it were a run outcome.
// One fixed, code-declared operation/errorClass/message triple per type — never a field read off
// the event itself — so this can never become a channel for foreign event content, whatever a
// future event member adds. Every `message` literal below is registered in diagnostics-log.ts's
// `SERVER_DIAGNOSTIC_SUMMARIES` allowlist; an unregistered string here would silently lose its
// `diagnosticSummary` projection on the activity-log line instead of failing loudly.
interface TerminalDiagnosticLabel {
  readonly operation: string;
  readonly errorClass: string;
  readonly message: ServerDiagnosticSummary;
}

const TERMINAL_DIAGNOSTICS: Readonly<Record<string, TerminalDiagnosticLabel>> = {
  "run:completed": {
    operation: "harness.run.completed",
    errorClass: "HarnessRunCompleted",
    message: "Harness run reached a terminal completed state.",
  },
  "run:failed": {
    operation: "harness.run.failed",
    errorClass: "HarnessRunFailed",
    message: "Harness run reached a terminal failed state.",
  },
  "run:cancelled": {
    operation: "harness.run.cancelled",
    errorClass: "HarnessRunCancelled",
    message: "Harness run reached a terminal cancelled state.",
  },
  "bug:completed": {
    operation: "workflow.bug-investigation.completed",
    errorClass: "BugInvestigationCompleted",
    message: "Bug-investigation workflow reached a terminal completed state.",
  },
  "bug:failed": {
    operation: "workflow.bug-investigation.failed",
    errorClass: "BugInvestigationFailed",
    message: "Bug-investigation workflow reached a terminal failed state.",
  },
  "workflow:completed": {
    operation: "workflow.unit-tests.completed",
    errorClass: "UnitTestWorkflowCompleted",
    message: "Unit-test workflow reached a terminal completed state.",
  },
  "workflow:failed": {
    operation: "workflow.unit-tests.failed",
    errorClass: "UnitTestWorkflowFailed",
    message: "Unit-test workflow reached a terminal failed state.",
  },
};

// The bounded shape `terminalDiagnosticCode` reads a machine-token off of, cast once so every
// extractor below stays a one-line, complexity-free field read rather than a repeated `as`.
interface TerminalDiagnosticRaw {
  readonly errorCode?: unknown;
  readonly status?: unknown;
  readonly atState?: unknown;
  readonly failure?: { readonly category?: unknown };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// Every terminal type that carries a machine-readable outcome code names it directly
// (`errorCode`) or nests it one level under a closed-vocabulary field (`failure.category` — a
// HARNESS_CODE; `atState` — a HarnessStateName; `status` — a BugWorkflowStatus/WorkflowStatus) —
// never free text such as `report`/`reason`/`failure.message`, which no extractor here reads. A
// type absent from this table (e.g. `run:completed`, which carries no outcome code) yields
// `undefined` via the lookup miss in `terminalDiagnosticCode`, not a listed no-op branch.
//
// `errorCode` is NOT itself a closed union at its producer (bug-investigation/stages.ts sets it
// to `error instanceof Error ? error.name : "UNKNOWN"` — a mutable, caller-settable `Error.name`),
// unlike `failure.category` / `atState` / `status`, which are already closed unions at their
// source. So the `bug:failed` / `workflow:failed` extractors additionally bound it through
// `machineToken` (MACHINE_TOKEN_SHAPE) here, at the writer, rather than trusting it as free-form
// `string` and leaving the bound to whatever generic redaction runs downstream.
const CODE_EXTRACTORS: Readonly<
  Record<string, (raw: TerminalDiagnosticRaw) => string | undefined>
> = {
  "run:failed": (raw) => stringOrUndefined(raw.failure?.category),
  "run:cancelled": (raw) => stringOrUndefined(raw.atState),
  "bug:completed": (raw) => stringOrUndefined(raw.status),
  "bug:failed": (raw) => machineToken(raw.errorCode),
  "workflow:completed": (raw) => stringOrUndefined(raw.status),
  "workflow:failed": (raw) => machineToken(raw.errorCode),
};

// Reads a bounded, machine-token-shaped outcome code off a terminal event without importing any
// concrete event union into this structurally-typed sink (see header comment).
function terminalDiagnosticCode(event: StreamEvent): string | undefined {
  const extractor = CODE_EXTRACTORS[event.type];
  return extractor === undefined ? undefined : extractor(event as unknown as TerminalDiagnosticRaw);
}

// A single attached SSE consumer. `write` frames+sends one event; `close` ends the response.
export interface SseWriter {
  readonly write: (event: StreamEvent) => boolean | undefined;
  readonly close: () => void;
}

const DEFAULT_BUFFER_CAPACITY = 512;
// 1 MiB parity with CODING_RUNTIME_EVENT_HUB_MAX_BYTES. Small enough that one large
// patch:proposed diff cannot pin megabytes of buffered replay per active run, big
// enough that a normal SSE burst never trips it.
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

export interface QueueEventSinkOptions {
  // Max events retained for replay. Oldest are dropped once the cap is exceeded (bounded memory).
  readonly bufferCapacity?: number | undefined;
  // Max aggregate serialized bytes retained for replay. Oldest are dropped once exceeded.
  readonly maxBytes?: number | undefined;
  // Where a terminal event's outcome is teed as an operator diagnostic (#2902 w4b). Defaults to
  // the production `defaultServerDiagnosticSink` (via `emitServerDiagnostic(undefined, ...)`) when
  // omitted, so production callers get the durable trace for free; tests inject a capturing sink.
  readonly diagnostics?: ServerDiagnosticSink | undefined;
}

interface BufferedEntry {
  readonly event: StreamEvent;
  readonly bytes: number;
}

const utf8Encoder = new TextEncoder();

function measureEventBytes(event: StreamEvent): number {
  return utf8Encoder.encode(JSON.stringify(event)).length;
}

export class QueueEventSink {
  // retainsRawContent is intentionally absent (never true): the harness must redact before emit.
  private readonly buffer: BufferedEntry[] = [];
  private bufferedBytes = 0;
  private readonly capacity: number;
  private readonly maxBytes: number;
  private readonly writers = new Set<SseWriter>();
  private readonly diagnostics: ServerDiagnosticSink | undefined;
  private terminated = false;

  // Bound so the sink can be passed directly as an `EventSink`/`WorkflowEventSink`/`BugWorkflowEventSink`.
  readonly emit = (event: StreamEvent): void => {
    const bytes = measureEventBytes(event);
    this.buffer.push({ event, bytes });
    this.bufferedBytes += bytes;
    while (this.buffer.length > this.capacity || this.bufferedBytes > this.maxBytes) {
      const dropped = this.buffer.shift();
      if (dropped === undefined) break;
      this.bufferedBytes -= dropped.bytes;
    }
    this.teeTerminalDiagnostic(event);
    const failed: SseWriter[] = [];
    for (const writer of this.writers) {
      try {
        const accepted = writer.write(event);
        if (accepted === false) {
          failed.push(writer);
        }
      } catch {
        failed.push(writer);
      }
    }
    for (const writer of failed) {
      if (this.writers.delete(writer)) {
        writer.close();
      }
    }
  };

  // Writes a durable operator diagnostic for a terminal event's outcome, independent of whether
  // any SSE writer was attached to receive it. `emitServerDiagnostic` never throws, so a
  // diagnostics-sink failure can never interrupt the SSE fan-out this method runs alongside.
  private teeTerminalDiagnostic(event: StreamEvent): void {
    const label = TERMINAL_DIAGNOSTICS[event.type];
    if (label === undefined) return;
    const code = terminalDiagnosticCode(event);
    emitServerDiagnostic(this.diagnostics, {
      correlationId: event.runId,
      timestamp: new Date().toISOString(),
      operation: label.operation,
      source: "sink.terminal-event",
      errorClass: label.errorClass,
      message: label.message,
      ...(code === undefined ? {} : { code }),
    });
  }

  constructor(options: QueueEventSinkOptions = {}) {
    this.capacity = options.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    // Reject NaN / Infinity / negatives: any of the three silently disables the byte cap
    // and lets a run's replay grow without bound — the exact class KEIKO-0165 exists to
    // prevent. A caller passing a bogus option should fail loudly at construction.
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      throw new RangeError("QueueEventSink maxBytes must be a finite, non-negative number");
    }
    this.maxBytes = maxBytes;
    this.diagnostics = options.diagnostics;
  }

  // Attaches an SSE writer: replays the buffered events with `seq` strictly greater than
  // `afterSeq` (Last-Event-ID resume), then keeps the writer attached for live fan-out. Returns a
  // detach function the caller invokes on client disconnect to stop fan-out and avoid leaks.
  attach(writer: SseWriter, afterSeq: number): () => void {
    for (const { event } of this.buffer) {
      if (event.seq > afterSeq) {
        const accepted = writer.write(event);
        if (accepted === false) {
          writer.close();
          return (): void => undefined;
        }
      }
    }
    this.writers.add(writer);
    return (): void => {
      this.writers.delete(writer);
    };
  }

  // Closes and clears every attached writer (called once the run terminates). The ring buffer is
  // retained for the registry TTL so a late subscriber can still replay history before eviction.
  closeAll(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    for (const writer of this.writers) {
      writer.close();
    }
    this.writers.clear();
  }

  isTerminated(): boolean {
    return this.terminated;
  }

  // Snapshot of buffered events with `seq` strictly greater than `afterSeq` (inspection/replay aid).
  buffered(afterSeq = -1): readonly StreamEvent[] {
    return this.buffer.filter(({ event }) => event.seq > afterSeq).map(({ event }) => event);
  }

  // Aggregate serialized-bytes retained across all buffered events. Exposed for tests and
  // observability; the sink evicts internally so callers do not have to poll this.
  bufferedByteSize(): number {
    return this.bufferedBytes;
  }
}
