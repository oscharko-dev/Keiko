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

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export function startSseHeartbeat(res: ServerResponse, intervalMs = 15000): () => void {
  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded) return;
    res.write(": keep-alive\n\n");
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
  return res.write(frameEvent(event, redactor));
}

export function writeMessageEvent(
  res: ServerResponse,
  event: StreamEvent,
  redactor: Redactor,
): boolean {
  return res.write(frameMessageEvent(event, redactor));
}
