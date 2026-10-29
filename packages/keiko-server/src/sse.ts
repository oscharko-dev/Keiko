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
import { writeSseFrame, type SseBackpressureSignal } from "./sse-write.js";

/**
 * Optional stalled-reader wiring for the heartbeat. A heartbeat can be the first frame written to an
 * idle stream whose reader has gone quiet; with this supplied, tearing that reader down also aborts
 * the producer and emits the stalled-reader signal, so the termination is never silent. Without it a
 * stalled heartbeat stream is still destroyed after the shared bound, only without those two effects.
 */
export interface SseHeartbeatBackpressure {
  readonly controller: AbortController;
  readonly onBackpressure?: ((signal: SseBackpressureSignal) => void) | undefined;
  // Attached to this stream's terminal `sse.stream.closed` line (#2902 w5-sse-counters) when the
  // caller already holds the request-scoped correlation id.
  readonly correlationId?: string | undefined;
}

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** The default keep-alive interval of an SSE stream. */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export function startSseHeartbeat(
  res: ServerResponse,
  intervalMs = SSE_HEARTBEAT_INTERVAL_MS,
  observableEvent?: "heartbeat",
  backpressure?: SseHeartbeatBackpressure,
): () => void {
  // Every heartbeat frame goes through the shared flow control. With `backpressure` supplied a
  // stalled reader also aborts the producer and signals the observer before the socket is destroyed.
  const writeFrame = (frame: string): boolean =>
    writeSseFrame(
      res,
      frame,
      backpressure?.controller ?? null,
      backpressure?.onBackpressure,
      backpressure?.correlationId,
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

// Frames the five domain event streams with their own namespace while preserving the original
// event/redactor cache keys. Redact first: reading kind before serialization changes getter order.
export function writeNamespacedSseEvent(
  res: ServerResponse,
  event: { readonly kind: string },
  seq: number,
  namespace: "command" | "verification" | "container" | "terminal" | "browser",
  redactor: Redactor,
  controller: AbortController,
  onBackpressure?: (signal: SseBackpressureSignal) => void,
): void {
  const data = redactedEventJson(redactor, event);
  const frame = `id: ${String(seq)}\nevent: ${namespace}:${event.kind}\ndata: ${data}\n\n`;
  writeSseFrame(res, frame, controller, onBackpressure);
}

// These three streams share a plain heartbeat. Keep it before controller creation and defer the
// native subscription factory until attachSseSubscription acquires the listener.
export function openPlainNamespacedSseStream(
  res: ServerResponse,
  namespace: "command" | "verification" | "container",
  redactor: Redactor,
  subscribe: (listener: (event: { readonly kind: string }) => void) => () => void,
  onBackpressure?: (signal: SseBackpressureSignal) => void,
  correlationId?: string,
): void {
  res.writeHead(200, SSE_HEADERS);
  startSseHeartbeat(res);
  const controller = new AbortController();
  let seq = 0;
  attachSseSubscription(
    res,
    controller,
    () =>
      subscribe((event) => {
        seq += 1;
        writeNamespacedSseEvent(res, event, seq, namespace, redactor, controller, onBackpressure);
      }),
    onBackpressure,
    correlationId,
  );
}

// The synthetic message sent once the buffered replay completes, signalling the client that it is
// now live. Carries no data payload.
export function readyMessage(): string {
  return `event: ready\ndata: {}\n\n`;
}

// The subscription factory must return before events fire, matching the manager ports. The
// forwarding closure lets its event callback retain the same stop operation used by abort/close.
export function attachSseSubscription(
  res: ServerResponse,
  controller: AbortController,
  subscribe: (stop: () => void) => () => void,
  onBackpressure?: (signal: SseBackpressureSignal) => void,
  correlationId?: string,
): void {
  const unsubscribe = subscribe(() => {
    stop();
  });
  let unsubscribed = false;
  const stop = (): void => {
    if (unsubscribed) return;
    unsubscribed = true;
    unsubscribe();
  };
  controller.signal.addEventListener("abort", stop, { once: true });
  writeSseFrame(res, readyMessage(), controller, onBackpressure, correlationId);
  res.on("close", () => {
    stop();
  });
}

// #3452 audit finding sse.ts:108: several openers write the ready frame with a bare `res.write`,
// bypassing `recordSseStreamFrame` entirely. `sseStreamState` (sse-write.ts) attaches its terminal
// `close` listener lazily, on the FIRST recorded frame — so a stream that opens, sends only `ready`,
// and closes before its first real event or its first heartbeat tick never creates that state at
// all, and the stream is invisible to `sse.stream.closed` (no reason, no duration, no frame count).
// This is the ready-frame counterpart to `writeEvent`/`writeMessageEvent` just above: same
// record-then-write shape, so a caller that opens with `ready` gets the same guarantee those get.
// `correlationId`, when supplied, is bound to the stream by the same set-once-wins rule
// `recordSseStreamFrame` already applies — most openers call this before their first event write, so
// it is normally this call that actually attaches the id (mirrors `writeSseFrame`'s own parameter).
export function writeReadyMessage(res: ServerResponse, correlationId?: string): boolean {
  return writeSseFrame(res, readyMessage(), null, undefined, correlationId);
}

// Writes one framed event to the response stream through the shared flow control (sse-write.ts):
// a buffered frame waits for `drain`, and `false` means only that the stream is already gone.
export function writeEvent(res: ServerResponse, event: StreamEvent, redactor: Redactor): boolean {
  return writeSseFrame(res, frameEvent(event, redactor), null);
}

export function writeMessageEvent(
  res: ServerResponse,
  event: StreamEvent,
  redactor: Redactor,
  correlationId?: string,
): boolean {
  return writeSseFrame(res, frameMessageEvent(event, redactor), null, undefined, correlationId);
}
