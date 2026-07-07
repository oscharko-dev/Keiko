// GEN-PERF-FANOUT-001 — once-per-event redact+serialize for SSE fan-out. Pins the three
// contract points: (1) the cache collapses per-subscriber redaction of the SAME event to
// one pass, (2) ring-buffer replays reuse the cached bytes instead of re-redacting, and
// (3) distinct events / distinct redactors never share entries. The fan-out test fails on
// the pre-fix code (one redactor pass per attached writer).

import { describe, expect, it } from "vitest";
import { redactedEventJson } from "./sse-frame-cache.js";
import { frameMessageEvent } from "./sse.js";
import { QueueEventSink, type SseWriter, type StreamEvent } from "./sink.js";
import type { Redactor } from "./deps.js";

function countingRedactor(): { readonly redactor: Redactor; readonly calls: { count: number } } {
  const calls = { count: 0 };
  const redactor: Redactor = (value) => {
    calls.count += 1;
    return value;
  };
  return { redactor, calls };
}

function event(seq: number): StreamEvent {
  return {
    schemaVersion: "1",
    runId: "run-fanout",
    fingerprint: "fp-1",
    seq,
    ts: seq,
    type: "run:started",
  };
}

describe("redactedEventJson", () => {
  it("redacts and serializes a given event exactly once per redactor", () => {
    const { redactor, calls } = countingRedactor();
    const first = event(1);
    const a = redactedEventJson(redactor, first);
    const b = redactedEventJson(redactor, first);
    expect(calls.count).toBe(1);
    expect(b).toBe(a);
  });

  it("keeps distinct events and distinct redactors isolated", () => {
    const left = countingRedactor();
    const right = countingRedactor();
    const shared = event(1);
    redactedEventJson(left.redactor, shared);
    redactedEventJson(left.redactor, event(2));
    redactedEventJson(right.redactor, shared);
    expect(left.calls.count).toBe(2);
    expect(right.calls.count).toBe(1);
  });
});

describe("QueueEventSink fan-out through frameMessageEvent", () => {
  function collectingWriter(redactor: Redactor): {
    readonly writer: SseWriter;
    readonly frames: string[];
  } {
    const frames: string[] = [];
    const writer: SseWriter = {
      write: (streamEvent: StreamEvent): boolean => {
        frames.push(frameMessageEvent(streamEvent, redactor));
        return true;
      },
      close: (): void => undefined,
    };
    return { writer, frames };
  }

  it("redacts one emitted event once for K attached subscribers", () => {
    const { redactor, calls } = countingRedactor();
    const sink = new QueueEventSink();
    const first = collectingWriter(redactor);
    const second = collectingWriter(redactor);
    sink.attach(first.writer, -1);
    sink.attach(second.writer, -1);
    sink.emit(event(1));
    // Pre-fix: one redactor pass PER WRITER (2). Shared: exactly one.
    expect(calls.count).toBe(1);
    expect(first.frames).toHaveLength(1);
    expect(second.frames).toEqual(first.frames);
  });

  it("replays buffered events to a late joiner from the cache without re-redacting", () => {
    const { redactor, calls } = countingRedactor();
    const sink = new QueueEventSink();
    const live = collectingWriter(redactor);
    sink.attach(live.writer, -1);
    sink.emit(event(1));
    sink.emit(event(2));
    expect(calls.count).toBe(2);
    const late = collectingWriter(redactor);
    sink.attach(late.writer, -1);
    // The ring buffer replays the SAME event objects — the cache serves them.
    expect(calls.count).toBe(2);
    expect(late.frames).toEqual(live.frames);
  });

  it("still redacts every distinct event", () => {
    const { redactor, calls } = countingRedactor();
    const sink = new QueueEventSink();
    sink.attach(collectingWriter(redactor).writer, -1);
    sink.emit(event(1));
    sink.emit(event(2));
    sink.emit(event(3));
    expect(calls.count).toBe(3);
  });
});
