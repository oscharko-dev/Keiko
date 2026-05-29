// Server-Sent Events framing for the run event stream (ADR-0011 D5/D7). One harness/workflow event
// becomes one SSE message: `id:` is the event `seq` (the Last-Event-ID resume cursor), `event:` is
// the event `type`, `data:` is the redacted event JSON on a single line, terminated by a blank line.
// The event JSON is produced by `JSON.stringify`, which never emits a raw newline inside a string
// (newlines are escaped as `\n`), so a single `data:` line is always valid — no regex, no manual
// escaping. A synthetic `ready` message is sent after the buffered replay.

import type { ServerResponse } from "node:http";
import type { StreamEvent } from "./sink.js";
import type { Redactor } from "./deps.js";

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store",
  Connection: "keep-alive",
};

// Frames one event as an SSE message. The event is redacted (defense in depth: live events are
// already redacted by the harness emitter, D7) before serialization.
export function frameEvent(event: StreamEvent, redactor: Redactor): string {
  const data = JSON.stringify(redactor(event));
  return `id: ${String(event.seq)}\nevent: ${event.type}\ndata: ${data}\n\n`;
}

// The synthetic message sent once the buffered replay completes, signalling the client that it is
// now live. Carries no data payload.
export function readyMessage(): string {
  return `event: ready\ndata: {}\n\n`;
}

// Writes one framed event to the response stream.
export function writeEvent(res: ServerResponse, event: StreamEvent, redactor: Redactor): void {
  res.write(frameEvent(event, redactor));
}
