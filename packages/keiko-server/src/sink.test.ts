import { describe, expect, it, vi } from "vitest";
import { QueueEventSink, type StreamEvent, type SseWriter } from "./sink.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "./diagnostics-log.js";

// runId is shaped to satisfy correlation.ts's SAFE_CORRELATION_ID (8-128 chars) so the new
// terminal-event diagnostic tests below can assert it survives `sanitizeDiagnosticRecord`
// unchanged, rather than being replaced by the invalid-correlation-id marker.
function event(seq: number, type = "tick"): StreamEvent {
  return { schemaVersion: "1", runId: "run-000001", fingerprint: "fp", seq, ts: seq, type };
}

// Extra members beyond the shared StreamEvent envelope ride along untyped (see sink.ts's own
// header comment), the same way the "bounds aggregate replay bytes" test below builds a
// larger-than-envelope event.
function terminalEvent(seq: number, type: string, extra: Record<string, unknown>): StreamEvent {
  return { ...event(seq, type), ...extra };
}

function recordingDiagnosticSink(): {
  readonly sink: ServerDiagnosticSink;
  readonly records: ServerDiagnosticRecord[];
} {
  const records: ServerDiagnosticRecord[] = [];
  return {
    records,
    sink: {
      record: (record): void => {
        records.push(record);
      },
    },
  };
}

function recordingWriter(): { writer: SseWriter; events: StreamEvent[]; closed: () => boolean } {
  const events: StreamEvent[] = [];
  let isClosed = false;
  return {
    events,
    closed: () => isClosed,
    writer: {
      write: (e): undefined => {
        events.push(e);
        return undefined;
      },
      close: (): void => {
        isClosed = true;
      },
    },
  };
}

describe("QueueEventSink ring buffer", () => {
  it("drops the oldest events past the capacity bound", () => {
    const sink = new QueueEventSink({ bufferCapacity: 3 });
    for (let i = 1; i <= 5; i++) {
      sink.emit(event(i));
    }
    const buffered = sink.buffered();
    expect(buffered.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("rejects a non-finite or negative maxBytes at construction (KEIKO-0165 hardening)", () => {
    // NaN, Infinity, and negatives would all silently disable the byte cap in the
    // `bufferedBytes > this.maxBytes` comparison, letting replay grow without bound —
    // the exact regression this cap exists to prevent. Fail loudly at construction.
    expect(() => new QueueEventSink({ maxBytes: Number.NaN })).toThrow(RangeError);
    expect(() => new QueueEventSink({ maxBytes: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => new QueueEventSink({ maxBytes: -1 })).toThrow(RangeError);
    expect(() => new QueueEventSink({ maxBytes: 0 })).not.toThrow();
  });

  it("bounds aggregate replay bytes when maxBytes is set (KEIKO-0165)", () => {
    // Emit events whose count is under bufferCapacity but whose combined serialized bytes
    // exceed maxBytes; the sink must evict oldest until aggregate <= maxBytes and only
    // replay that bounded slice to a newly-attached writer.
    const largePayloadEvent = (seq: number): StreamEvent => ({
      ...event(seq, "patch:proposed"),
      // Extra fields ride along in the serialized shape via `as` cast: measure honestly.
      ...({ diff: "x".repeat(4096) } as Record<string, string>),
    });
    const single = new TextEncoder().encode(JSON.stringify(largePayloadEvent(1))).length;
    const maxBytes = single * 3 + 8; // room for exactly three
    const sink = new QueueEventSink({ bufferCapacity: 1024, maxBytes });
    for (let i = 1; i <= 6; i++) {
      sink.emit(largePayloadEvent(i));
    }
    expect(sink.bufferedByteSize()).toBeLessThanOrEqual(maxBytes);
    const sub = recordingWriter();
    sink.attach(sub.writer, -1);
    const replayedBytes = sub.events.reduce(
      (total, replayed) => total + new TextEncoder().encode(JSON.stringify(replayed)).length,
      0,
    );
    expect(replayedBytes).toBeLessThanOrEqual(maxBytes);
    // Only the last N events survive; earliest were evicted first (ring semantics).
    expect(sub.events.length).toBeLessThan(6);
    expect(sub.events[sub.events.length - 1]?.seq).toBe(6);
  });

  it("replays only events after the given seq on attach (Last-Event-ID resume)", () => {
    const sink = new QueueEventSink();
    for (let i = 1; i <= 4; i++) {
      sink.emit(event(i));
    }
    const sub = recordingWriter();
    sink.attach(sub.writer, 2);
    expect(sub.events.map((e) => e.seq)).toEqual([3, 4]);
  });

  it("fans live events out to every attached writer", () => {
    const sink = new QueueEventSink();
    const a = recordingWriter();
    const b = recordingWriter();
    sink.attach(a.writer, -1);
    sink.attach(b.writer, -1);
    sink.emit(event(1));
    expect(a.events.map((e) => e.seq)).toEqual([1]);
    expect(b.events.map((e) => e.seq)).toEqual([1]);
  });

  it("stops fanning out to a detached writer (no leak after disconnect)", () => {
    const sink = new QueueEventSink();
    const a = recordingWriter();
    const detach = sink.attach(a.writer, -1);
    sink.emit(event(1));
    detach();
    sink.emit(event(2));
    expect(a.events.map((e) => e.seq)).toEqual([1]);
  });

  it("drops and closes a writer that reports backpressure", () => {
    const sink = new QueueEventSink();
    let writes = 0;
    let closed = false;
    sink.attach(
      {
        write: (): boolean => {
          writes += 1;
          return false;
        },
        close: (): void => {
          closed = true;
        },
      },
      -1,
    );
    sink.emit(event(1));
    sink.emit(event(2));
    expect(writes).toBe(1);
    expect(closed).toBe(true);
  });

  it("does not attach a replaying writer that reports backpressure", () => {
    const sink = new QueueEventSink();
    sink.emit(event(1));
    let writes = 0;
    let closed = false;
    sink.attach(
      {
        write: (): boolean => {
          writes += 1;
          return false;
        },
        close: (): void => {
          closed = true;
        },
      },
      -1,
    );
    sink.emit(event(2));
    expect(writes).toBe(1);
    expect(closed).toBe(true);
  });

  it("closes every attached writer once and is idempotent on terminate", () => {
    const sink = new QueueEventSink();
    const a = recordingWriter();
    sink.attach(a.writer, -1);
    sink.closeAll();
    sink.closeAll();
    expect(a.closed()).toBe(true);
    expect(sink.isTerminated()).toBe(true);
  });

  it("retains the buffer after terminate so a late subscriber can still replay", () => {
    const sink = new QueueEventSink();
    sink.emit(event(1));
    sink.emit(event(2));
    sink.closeAll();
    expect(sink.buffered().map((e) => e.seq)).toEqual([1, 2]);
  });
});

// #2902 w4b: a run's terminal outcome must reach the operator diagnostic sink regardless of
// whether any SSE writer is attached — the exact gap that left a closed-browser-tab run with no
// trace anywhere once its ring buffer entry was evicted.
describe("QueueEventSink terminal-event diagnostic tee", () => {
  it("tees each terminal event type exactly once, keyed by the event's own runId", () => {
    const { sink: diagnostics, records } = recordingDiagnosticSink();
    const sink = new QueueEventSink({ diagnostics });
    sink.emit(event(1, "run:completed"));
    sink.emit(terminalEvent(2, "run:failed", { failure: { category: "HARNESS_MODEL_ERROR" } }));
    sink.emit(terminalEvent(3, "run:cancelled", { atState: "model-call" }));
    sink.emit(terminalEvent(4, "bug:completed", { status: "fix-applied" }));
    sink.emit(terminalEvent(5, "bug:failed", { errorCode: "TypeError" }));
    sink.emit(terminalEvent(6, "workflow:completed", { status: "dry-run" }));
    sink.emit(terminalEvent(7, "workflow:failed", { errorCode: "RangeError" }));

    expect(records).toHaveLength(7);
    for (const record of records) {
      expect(record.correlationId).toBe("run-000001");
    }
    expect(records.map((record) => record.operation)).toEqual([
      "harness.run.completed",
      "harness.run.failed",
      "harness.run.cancelled",
      "workflow.bug-investigation.completed",
      "workflow.bug-investigation.failed",
      "workflow.unit-tests.completed",
      "workflow.unit-tests.failed",
    ]);
    expect(records.map((record) => record.code)).toEqual([
      undefined,
      "HARNESS_MODEL_ERROR",
      "model-call",
      "fix-applied",
      "TypeError",
      "dry-run",
      "RangeError",
    ]);
  });

  it("drops a bug/workflow errorCode that is not machine-token shaped, even though it would pass generic log redaction", () => {
    const { sink: diagnostics, records } = recordingDiagnosticSink();
    const sink = new QueueEventSink({ diagnostics });
    // Shaped like a hostile Error subclass's freely-settable `.name` (stages.ts derives errorCode
    // from `error.name`): short, printable ASCII, <=3 spaces -- it would sail through
    // redactLogString's generic guards untouched, so only a writer-side shape check can stop it.
    sink.emit(terminalEvent(1, "bug:failed", { errorCode: "internal ledger ref" }));
    sink.emit(terminalEvent(2, "workflow:failed", { errorCode: "internal ledger ref" }));
    expect(records.map((record) => record.code)).toEqual([undefined, undefined]);
  });

  it("never tees a non-terminal event", () => {
    const { sink: diagnostics, records } = recordingDiagnosticSink();
    const sink = new QueueEventSink({ diagnostics });
    for (const type of [
      "run:started",
      "state:transition",
      "model:call:started",
      "tool:call:completed",
      "bug:started",
      "workflow:started",
    ]) {
      sink.emit(event(1, type));
    }
    expect(records).toHaveLength(0);
  });

  it("never reads free-text fields (report/reason/failure.message) into the diagnostic record", () => {
    const { sink: diagnostics, records } = recordingDiagnosticSink();
    const sink = new QueueEventSink({ diagnostics });
    sink.emit(
      terminalEvent(1, "run:failed", {
        failure: { category: "HARNESS_MODEL_ERROR", message: "customer-secret-token-abc123" },
      }),
    );
    sink.emit(
      terminalEvent(2, "run:cancelled", { atState: "model-call", reason: "user hit stop" }),
    );

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("customer-secret-token-abc123");
    expect(serialized).not.toContain("user hit stop");
    // The fixed, code-declared summary is used instead of any field read off the event.
    expect(records[0]?.message).toBe("Harness run reached a terminal failed state.");
  });

  it("falls back to the production diagnostic sink when no diagnostics option is supplied", () => {
    // No `diagnostics` option: emitServerDiagnostic(undefined, ...) resolves to
    // defaultServerDiagnosticSink, which writes one line to stderr — this is what makes the tee
    // work for every existing `new QueueEventSink()` call site in run-engine.ts without change.
    const sink = new QueueEventSink();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      sink.emit(event(1, "run:completed"));
      expect(consoleError).toHaveBeenCalledTimes(1);
      const stderrLine = consoleError.mock.calls[0]?.[0] as string;
      expect(stderrLine).toContain("run-000001");
      expect(stderrLine).toContain("harness.run.completed");
    } finally {
      consoleError.mockRestore();
    }
  });
});
