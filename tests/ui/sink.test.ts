import { describe, expect, it } from "vitest";
import { QueueEventSink, type StreamEvent, type SseWriter } from "../../src/ui/sink.js";

function event(seq: number, type = "tick"): StreamEvent {
  return { schemaVersion: "1", runId: "run-1", fingerprint: "fp", seq, ts: seq, type };
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
