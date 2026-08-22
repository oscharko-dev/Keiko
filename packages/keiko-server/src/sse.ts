// Server-Sent Events framing for the run event stream (ADR-0011 D5/D7). One harness/workflow event
// becomes one SSE message: `id:` is the event `seq` (the Last-Event-ID resume cursor), `event:` is
// the event `type`, `data:` is the redacted event JSON on a single line, terminated by a blank line.
// The event JSON is produced by `JSON.stringify`, which never emits a raw newline inside a string
// (newlines are escaped as `\n`), so a single `data:` line is always valid — no regex, no manual
// escaping. A synthetic `ready` message is sent after the buffered replay.

import type { ServerResponse } from "node:http";
import type { StreamEvent } from "./sink.js";
import type { Redactor } from "./deps.js";
import { redactedEventJson } from "./sse-frame-cache.js";
import {
  markSseStreamBackpressureKilled,
  recordSseStreamFrame,
  writeOrDestroy,
  type SseBackpressureSignal,
} from "./sse-write.js";

/**
 * Optional protective wiring for the heartbeat. A heartbeat can be the FIRST write rejected on an
 * idle stream, so without this the connection is destroyed with no abort of the producer and no
 * backpressure signal — the slow-client kill is silent and indistinguishable from a normal close.
 * Omitting it preserves the historical behaviour exactly (plain write + destroy).
 */
export interface SseHeartbeatBackpressure {
  readonly controller: AbortController;
  readonly onBackpressure?: ((signal: SseBackpressureSignal) => void) | undefined;
  // Attached to this stream's terminal `sse.stream.closed` line (#2902 w5-sse-counters) when the
  // caller already holds the request-scoped correlation id.
  readonly correlationId?: string | undefined;
}

function writeOrDestroyLegacy(res: ServerResponse, frame: string): boolean {
  recordSseStreamFrame(res, frame);
  const accepted = res.write(frame);
  if (!accepted) {
    markSseStreamBackpressureKilled(res);
    res.destroy();
  }
  return accepted;
}

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export function startSseHeartbeat(
  res: ServerResponse,
  intervalMs = 15000,
  observableEvent?: "heartbeat",
  backpressure?: SseHeartbeatBackpressure,
): () => void {
  // With `backpressure` supplied every heartbeat frame goes through the same protective path as
  // event frames: abort the producer, signal the observer, then destroy. Without it the historical
  // plain write + destroy is kept byte-for-byte so the six other SSE callers are unaffected.
  const writeFrame = (frame: string): boolean =>
    backpressure === undefined
      ? writeOrDestroyLegacy(res, frame)
      : writeOrDestroy(
          res,
          frame,
          backpressure.controller,
          backpressure.onBackpressure,
          backpressure.correlationId,
        );
  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded) return;
    if (!writeFrame(": keep-alive\n\n")) {
      return;
    }
    if (observableEvent === "heartbeat") {
      writeFrame("event: heartbeat\ndata: {}\n\n");
    }
  }, intervalMs);
  // The heartbeat must never be what keeps the process alive: on shutdown the
  // socket teardown fires `close` and clears it, but an un-unref'd interval
  // would otherwise pin the event loop between ticks (the voice-realtime
  // heartbeat established this pattern).
  timer.unref();
  const stop = (): void => {
    clearInterval(timer);
  };
  res.on("close", stop);
  return stop;
}

// Frames one event as an SSE message. The event is redacted (defense in depth: live events are
// already redacted by the harness emitter, D7) before serialization. GEN-PERF-FANOUT-001:
// redaction+serialization run once per event and are shared across every subscriber and
// ring-buffer replay of the same event object.
export function frameEvent(event: StreamEvent, redactor: Redactor): string {
  const data = redactedEventJson(redactor, event);
  return `id: ${String(event.seq)}\nevent: ${event.type}\ndata: ${data}\n\n`;
}

// Frames one event as an unnamed SSE message. The event type stays inside the JSON payload, letting
// clients consume every run event through EventSource.onmessage instead of one listener per type.
export function frameMessageEvent(event: StreamEvent, redactor: Redactor): string {
  const data = redactedEventJson(redactor, event);
  return `id: ${String(event.seq)}\ndata: ${data}\n\n`;
}

// The synthetic message sent once the buffered replay completes, signalling the client that it is
// now live. Carries no data payload.
export function readyMessage(): string {
  return `event: ready\ndata: {}\n\n`;
}

// Writes one framed event to the response stream. Returns Node's backpressure signal so the caller can
// detach a slow client instead of letting the HTTP response buffer grow without bound.
export function writeEvent(res: ServerResponse, event: StreamEvent, redactor: Redactor): boolean {
  const frame = frameEvent(event, redactor);
  recordSseStreamFrame(res, frame);
  return res.write(frame);
}

export function writeMessageEvent(
  res: ServerResponse,
  event: StreamEvent,
  redactor: Redactor,
): boolean {
  const frame = frameMessageEvent(event, redactor);
  recordSseStreamFrame(res, frame);
  return res.write(frame);
}
