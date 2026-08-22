// Shared SSE backpressure helper. Every SSE path in the server must call res.write() and react to
// the boolean it returns: false means the kernel send-buffer is full and the client is not draining.
// Continuing to write would grow Node's internal stream buffer without bound; the correct response is
// to abort the in-flight generator (so the model/queue call stops producing) and destroy the socket.
//
// Usage (mirrors terminal-routes.ts writeTerminalEvent and run-handlers.ts SseWriter.write):
//
//   writeOrDestroy(ctx.res, frame, controller);
//
// The controller parameter is an AbortController (or null when the caller manages abort separately
// via its own signal). Destroying the socket fires "close" on res, which the caller's existing
// res.on("close", …) listener picks up for any additional cleanup (e.g. registry deregistration).

import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { emitServerDiagnostic, type ServerDiagnosticSink } from "./diagnostics-log.js";
import { getServerLogger } from "./observability/index.js";

/**
 * Backpressure signal (GEN-PERF-CHAT-006). Emitted exactly once when a write is rejected because the
 * client is not draining, BEFORE the socket is destroyed, so a slow-client termination is observable
 * and distinguishable from an intentional user cancel. Carries only non-secret counts — never body
 * bytes — so it cannot leak model tokens if logged.
 */
export interface SseBackpressureSignal {
  readonly frameBytes: number;
  readonly accepted: false;
}

type SseStreamCloseReason =
  "completed" | "client-disconnected" | "backpressure-killed" | "server-error";

interface SseStreamCounterState {
  frameCount: number;
  bytesStreamed: number;
  readonly startedAt: number;
  backpressureKilled: boolean;
  serverErrored: boolean;
  emitted: boolean;
  correlationId: string | undefined;
}

// Per-response frame/byte counters (#2902 w5-sse-counters), keyed by the live `ServerResponse` so
// every SSE write path in the server — `writeOrDestroy` here, plus `sse.ts`'s legacy write path,
// `writeEvent`/`writeMessageEvent` and the heartbeat — shares ONE count per stream without any of
// them needing a threaded "deps" object. A `WeakMap` means a stream that never gets tracked (a
// minimal unit-test double with no `.on`) costs nothing and is never retained past `res`'s own
// lifetime.
const sseStreamCounters = new WeakMap<ServerResponse, SseStreamCounterState>();

function sseStreamReason(res: ServerResponse, state: SseStreamCounterState): SseStreamCloseReason {
  if (state.backpressureKilled) return "backpressure-killed";
  if (state.serverErrored) return "server-error";
  // A stream whose producer called `res.end()` and had it fully flush is "completed"; one whose
  // socket closed without that — the ordinary shape of a client navigating away or losing network —
  // is "client-disconnected". This is the same distinction `logRequestOnClose` does not need to make
  // (a JSON response always ends itself before `close`) but a long-lived SSE stream does.
  return res.writableEnded ? "completed" : "client-disconnected";
}

// Emitted exactly once per stream (guarded by `state.emitted`), on `res`'s terminal `close` event —
// the one event every SSE stream reaches exactly once, whether it finished normally, was killed for
// backpressure, or the client simply disconnected.
function emitSseStreamClosed(res: ServerResponse, state: SseStreamCounterState): void {
  if (state.emitted) return;
  state.emitted = true;
  getServerLogger().info({
    category: "http",
    op: "sse.stream.closed",
    ...(state.correlationId === undefined ? {} : { correlationId: state.correlationId }),
    durationMs: Date.now() - state.startedAt,
    extra: {
      frameCount: state.frameCount,
      bytesStreamed: state.bytesStreamed,
      reason: sseStreamReason(res, state),
    },
  });
}

// Lazily creates and attaches the terminal-line listeners the first time a frame is recorded for
// `res`; the `WeakMap` guard means `close`/`error` are attached exactly once per stream regardless
// of how many frames it writes. A response double that does not implement `.on` (several SSE route
// suites construct a bare `{ write, destroy }` fake) is left untracked rather than throwing — such a
// fake never reaches a real `close` event either, so there is nothing correct to count.
function sseStreamState(res: ServerResponse): SseStreamCounterState | undefined {
  const existing = sseStreamCounters.get(res);
  if (existing !== undefined) return existing;
  if (typeof res.on !== "function") return undefined;
  const state: SseStreamCounterState = {
    frameCount: 0,
    bytesStreamed: 0,
    startedAt: Date.now(),
    backpressureKilled: false,
    serverErrored: false,
    emitted: false,
    correlationId: undefined,
  };
  sseStreamCounters.set(res, state);
  res.on("close", () => {
    emitSseStreamClosed(res, state);
  });
  res.on("error", () => {
    state.serverErrored = true;
  });
  return state;
}

/**
 * Records one SSE frame write against `res`'s per-stream counter (#2902 w5-sse-counters). Closed
 * over the SAME write path every SSE route already funnels through — `writeOrDestroy` below, plus
 * `sse.ts`'s legacy write path, `writeEvent`, `writeMessageEvent` and the heartbeat — so no route
 * handler has to opt in. Never throws: observability must never break a write.
 */
export function recordSseStreamFrame(
  res: ServerResponse,
  frame: string,
  correlationId?: string,
): void {
  const state = sseStreamState(res);
  if (state === undefined) return;
  state.frameCount += 1;
  state.bytesStreamed += Buffer.byteLength(frame, "utf8");
  if (correlationId !== undefined && state.correlationId === undefined) {
    state.correlationId = correlationId;
  }
}

/**
 * Marks `res`'s stream as ended-by-backpressure so the terminal line reports `"backpressure-killed"`
 * rather than the generic `"client-disconnected"`. Called only from a write path that is about to
 * `destroy()` the socket as a direct, deterministic consequence of the rejected write — never from
 * `writeEvent`/`writeMessageEvent`, where a caller-observed `false` does not by itself mean the
 * stream is being torn down.
 */
export function markSseStreamBackpressureKilled(res: ServerResponse): void {
  const state = sseStreamCounters.get(res);
  if (state !== undefined) state.backpressureKilled = true;
}

/**
 * Writes `frame` to `res`. When `res.write` returns false (TCP send-buffer full / slow client),
 * aborts `controller` (stops the upstream producer) and destroys the socket.
 *
 * When the write is rejected, `onBackpressure` (if supplied) is invoked exactly once with the frame
 * byte count before the socket is destroyed, giving callers a distinct, observable signal for a
 * backpressure kill rather than silently relabeling it as a user cancel. The callback is wrapped in a
 * try/catch so an observer throw can never propagate into the write loop.
 *
 * `correlationId` is optional (most SSE routes never received a `RouteContext`, mirroring
 * `readBoundedRequestBody`'s own optional correlation id) and, when supplied, is attached to this
 * stream's terminal `sse.stream.closed` line.
 *
 * Returns the raw boolean from `res.write` so callers can short-circuit if needed.
 */
export function writeOrDestroy(
  res: ServerResponse,
  frame: string,
  controller: AbortController,
  onBackpressure?: (signal: SseBackpressureSignal) => void,
  correlationId?: string,
): boolean {
  recordSseStreamFrame(res, frame, correlationId);
  const accepted = res.write(frame);
  if (!accepted) {
    markSseStreamBackpressureKilled(res);
    if (onBackpressure !== undefined) {
      try {
        onBackpressure({ frameBytes: Buffer.byteLength(frame, "utf8"), accepted: false });
      } catch {
        // Observability must never break the protective abort+destroy path.
      }
    }
    controller.abort();
    res.destroy();
  }
  return accepted;
}

/**
 * Builds the production `onBackpressure` observer for an SSE route: a body-free operator diagnostic
 * naming the stream that was killed for not draining. Without this, a slow-client termination is
 * indistinguishable from an intentional cancel in the operator trail — the protective abort+destroy
 * happens either way, but nothing records WHY the stream ended.
 *
 * Carries only the frame byte count (never body bytes), so it cannot leak model tokens if logged.
 */
export function sseBackpressureReporter(
  deps: { readonly diagnostics?: ServerDiagnosticSink | undefined },
  stream: string,
): (signal: SseBackpressureSignal) => void {
  return (signal: SseBackpressureSignal): void => {
    emitServerDiagnostic(deps.diagnostics, {
      correlationId: randomUUID(),
      timestamp: new Date().toISOString(),
      operation: `sse.${stream}`,
      source: `sse.${stream}.backpressure`,
      errorClass: "SseBackpressureKill",
      message: "SSE stream destroyed because the client stopped draining.",
      frameBytes: signal.frameBytes,
    });
  };
}
