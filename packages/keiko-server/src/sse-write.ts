// Shared SSE flow control. Every SSE path in the server writes through `writeSseFrame` (or, for a
// framing helper that writes itself, calls `awaitSseDrain` on a false write). `res.write()` returning
// false means Node buffered the frame above its high-water mark — true for any single frame of
// 64 KiB or more even to an idle client — so the frame is queued and the stream waits for `drain`.
// Frame size never ends a stream. Only a reader that drains nothing within
// `SSE_STALLED_READER_TIMEOUT_MS` is a stalled reader: the producer is aborted and the socket
// destroyed, so a dead peer cannot grow the buffer without bound.
//
// Usage (mirrors terminal-routes.ts writeTerminalEvent and run-handlers.ts SseWriter.write):
//
//   writeSseFrame(ctx.res, frame, controller);
//
// The controller parameter is an AbortController (or null when the caller manages abort separately
// via its own signal). Destroying the socket fires "close" on res, which the caller's existing
// res.on("close", …) listener picks up for any additional cleanup (e.g. registry deregistration).

import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";
import { getServerLogger } from "./observability/index.js";

/**
 * Stalled-reader signal (GEN-PERF-CHAT-006). Emitted exactly once when a stream is torn down because
 * its reader drained nothing within `SSE_STALLED_READER_TIMEOUT_MS`, BEFORE the socket is destroyed,
 * so a stalled-reader termination is observable and distinguishable from an intentional user cancel.
 * `frameBytes` is the size of the frame that started the wait. Carries only non-secret counts —
 * never body bytes — so it cannot leak model tokens if logged.
 */
export interface SseBackpressureSignal {
  readonly frameBytes: number;
  readonly accepted: false;
}

type SseStreamCloseReason =
  "completed" | "client-disconnected" | "backpressure-killed" | "server-error" | "server-shutdown";

const SSE_STREAM_CLOSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "sse.stream.closed",
  category: "http",
  owner: "keiko-server",
  emitter: "sse-write.emitSseStreamClosed",
  fields: {
    frameCount: { type: "integer", dataClass: "count", required: true },
    bytesStreamed: { type: "integer", dataClass: "count", required: true },
    // Writes that left Node's buffer above its high-water mark and then waited for `drain`; absent
    // when the stream never had to wait.
    drainWaitCount: { type: "integer", dataClass: "count", required: false },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "completed",
        "client-disconnected",
        "backpressure-killed",
        "server-error",
        "server-shutdown",
      ],
    },
  },
  causal: "none",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["sse-stream"],
  proofIds: ["sse.stream.closed.line"],
  releaseImpact: "patch",
});

// A server that is shutting down closes every live connection at once. Without this, the streams it
// tears down are reported as the shapes they LOOK like from the socket — `backpressure-killed` for a
// stream whose last write was still buffered, `client-disconnected` for the rest — and a customer
// log shows a run cancelled next to a burst of client problems that never happened (run 9, dev lane,
// 2026-09-10). The flag is process-wide because the shutdown is.
let serverShuttingDown = false;

/**
 * Marks this process as shutting down, so every stream torn down from here on names the shutdown as
 * its close reason. Called once from the runtime dispose path before connections are closed; there
 * is deliberately no way back — a process that has begun shutting down does not resume serving.
 */
export function markServerShuttingDown(): void {
  serverShuttingDown = true;
}

/** Test seam: restores the not-shutting-down state a fresh process starts in. */
export function resetServerShuttingDownForTests(): void {
  serverShuttingDown = false;
}

// Live SSE streams, so the shutdown line can say how many were still open when it began. Counted,
// never enumerated: a count is body-free, a list of streams is not.
let openSseStreamCount = 0;

export function currentOpenSseStreamCount(): number {
  return openSseStreamCount;
}

interface SseStreamCounterState {
  frameCount: number;
  bytesStreamed: number;
  readonly startedAt: number;
  backpressureKilled: boolean;
  serverErrored: boolean;
  drainWaitCount: number;
  emitted: boolean;
  correlationId: string | undefined;
}

// Per-response frame/byte counters (#2902 w5-sse-counters), keyed by the live `ServerResponse` so
// every SSE write path in the server — `writeSseFrame` here, plus `sse.ts`'s legacy write path,
// `writeEvent`/`writeMessageEvent` and the heartbeat — shares ONE count per stream without any of
// them needing a threaded "deps" object. A `WeakMap` means a stream that never gets tracked (a
// minimal unit-test double with no `.on`) costs nothing and is never retained past `res`'s own
// lifetime.
const sseStreamCounters = new WeakMap<ServerResponse, SseStreamCounterState>();

function sseStreamReason(res: ServerResponse, state: SseStreamCounterState): SseStreamCloseReason {
  // The shutdown is the CAUSE of every close that follows it, including the ones that look like
  // backpressure because the socket went away mid-write. It therefore wins over the socket-shaped
  // diagnoses below; a stream the producer had already ended still reports "completed".
  if (serverShuttingDown && !res.writableEnded) return "server-shutdown";
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
  openSseStreamCount = Math.max(0, openSseStreamCount - 1);
  getServerLogger().info(
    activityLogEvent(
      SSE_STREAM_CLOSED_OPERATION,
      {
        ...(state.correlationId === undefined ? {} : { correlationId: state.correlationId }),
        durationMs: Date.now() - state.startedAt,
      },
      {
        frameCount: state.frameCount,
        bytesStreamed: state.bytesStreamed,
        ...(state.drainWaitCount === 0 ? {} : { drainWaitCount: state.drainWaitCount }),
        reason: sseStreamReason(res, state),
      },
    ),
  );
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
    drainWaitCount: 0,
    emitted: false,
    correlationId: undefined,
  };
  sseStreamCounters.set(res, state);
  openSseStreamCount += 1;
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
 * over the SAME write path every SSE route already funnels through — `writeSseFrame` below, plus
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
 * rather than the generic `"client-disconnected"`. Called only when a stalled reader is about to be
 * destroyed because it drained nothing within its bound — never for a write that merely returned
 * `false`, which is ordinary flow control and does not by itself mean the stream is torn down.
 */
export function markSseStreamBackpressureKilled(res: ServerResponse): void {
  const state = sseStreamCounters.get(res);
  if (state !== undefined) state.backpressureKilled = true;
}

/** Marks a caught transport failure before destroy(error), which need not emit a response error. */
export function markSseStreamServerErrored(res: ServerResponse): void {
  const state = sseStreamCounters.get(res);
  if (state !== undefined) state.serverErrored = true;
}

/**
 * How long a stream may keep frames above Node's high-water mark without its peer draining any of
 * them before it counts as a stalled reader. `res.write()` returning `false` only says that Node's
 * buffer is above its high-water mark — Node 24 answers so for every single write of 64 KiB or more,
 * even to an idle loopback client — so a false write is ordinary flow control, never by itself a
 * reason to end a stream. Only a peer that drains nothing for this long is torn down: that bound is
 * time, never frame size, so a frame of any size reaches a reader that is still reading.
 */
export const SSE_STALLED_READER_TIMEOUT_MS = 30_000;

// One pending drain wait per stream. A stream already waiting keeps its first deadline: frames
// written meanwhile are buffered behind the ones the peer has not taken yet, and the stall bound
// measures how long the peer has taken nothing.
const pendingSseDrains = new WeakSet<ServerResponse>();

/**
 * Holds `res` open until its peer drains what Node buffered above the high-water mark. Called after a
 * write returned `false`. When the peer drains, the stream simply continues. When it drains nothing
 * within `SSE_STALLED_READER_TIMEOUT_MS`, the stream is a stalled reader: it is marked
 * `backpressure-killed`, `onBackpressure` is told once, `controller` is aborted so the producer stops,
 * and the socket is destroyed. A peer that closes first ends the wait through its own `close`.
 */
export function awaitSseDrain(
  res: ServerResponse,
  frameBytes: number,
  controller: AbortController | null,
  onBackpressure?: (signal: SseBackpressureSignal) => void,
): void {
  // A response double without `.once` cannot report a drain; it never reaches a real socket either.
  if (typeof res.once !== "function" || pendingSseDrains.has(res)) return;
  pendingSseDrains.add(res);
  const state = sseStreamCounters.get(res);
  if (state !== undefined) state.drainWaitCount += 1;
  const settle = (): void => {
    clearTimeout(timer);
    pendingSseDrains.delete(res);
    res.off("drain", settle);
    res.off("close", settle);
  };
  const timer = setTimeout(() => {
    settle();
    killStalledSseStream(res, frameBytes, controller, onBackpressure);
  }, SSE_STALLED_READER_TIMEOUT_MS);
  timer.unref();
  res.once("drain", settle);
  res.once("finish", settle);
  res.once("close", settle);
}

/**
 * Resolves once `res` can take more data: at once while Node's buffer is below the high-water mark,
 * otherwise on `drain`, or on `close` (a peer that left, or a stalled reader the bound destroyed).
 * A producer that awaits it before pulling more input carries the reader's pace upstream instead of
 * buffering an unbounded backlog in memory; it re-checks its own cancellation after the wait.
 */
export function whenSseWritable(res: ServerResponse): Promise<void> {
  if (res.destroyed || res.writableEnded || !res.writableNeedDrain) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const settle = (): void => {
      res.off("drain", settle);
      res.off("close", settle);
      resolve();
    };
    res.once("drain", settle);
    res.once("close", settle);
  });
}

function killStalledSseStream(
  res: ServerResponse,
  frameBytes: number,
  controller: AbortController | null,
  onBackpressure: ((signal: SseBackpressureSignal) => void) | undefined,
): void {
  // An ended stream whose buffered tail the peer still has not taken is a stalled reader too: it
  // would otherwise hold its socket and buffer for as long as the peer stays silent.
  if (res.destroyed || res.writableFinished) return;
  markSseStreamBackpressureKilled(res);
  if (onBackpressure !== undefined) {
    try {
      onBackpressure({ frameBytes, accepted: false });
    } catch (error) {
      // Observability must never break the protective abort+destroy path, and a throwing observer
      // is itself recorded rather than lost.
      emitServerDiagnostic(
        undefined,
        serverDiagnosticFromError({
          correlationId: sseStreamCounters.get(res)?.correlationId ?? UNKNOWN_CORRELATION_ID,
          operation: "sse.stream.stalled-reader",
          source: "sse.stream.stalled-reader.observer",
          error,
          redact: () => "sse-stalled-reader-observer-failed",
        }),
      );
    }
  }
  controller?.abort();
  res.destroy();
}

/**
 * Writes one SSE `frame` to `res` with drain-based flow control. A `false` result from `res.write`
 * is Node's buffer accounting, not a dead client: the frame is already queued and the stream waits
 * for `drain` (see `awaitSseDrain`). Only a reader that drains nothing within
 * `SSE_STALLED_READER_TIMEOUT_MS` is torn down: `onBackpressure` (if supplied) is invoked exactly once
 * with the byte count of the frame that started the wait, `controller` is aborted and the socket is
 * destroyed — so a stalled-reader termination stays distinguishable from a user cancel.
 *
 * `correlationId` is optional (most SSE routes never received a `RouteContext`, mirroring
 * `readBoundedRequestBody`'s own optional correlation id) and, when supplied, is attached to this
 * stream's terminal `sse.stream.closed` line.
 *
 * Returns `false` only when the frame could not be queued because the stream is already gone, so a
 * caller that sees `false` stops producing.
 */
export function writeSseFrame(
  res: ServerResponse,
  frame: string,
  controller: AbortController | null,
  onBackpressure?: (signal: SseBackpressureSignal) => void,
  correlationId?: string,
): boolean {
  if (res.destroyed || res.writableEnded) return false;
  recordSseStreamFrame(res, frame, correlationId);
  if (!res.write(frame)) {
    awaitSseDrain(res, Buffer.byteLength(frame, "utf8"), controller, onBackpressure);
  }
  return true;
}

/**
 * Builds the production `onBackpressure` observer for an SSE route: a body-free operator diagnostic
 * naming the stream that was killed for not draining. Without this, a slow-client termination is
 * indistinguishable from an intentional cancel in the operator trail — the protective abort+destroy
 * happens either way, but nothing records WHY the stream ended.
 *
 * Carries only the frame byte count (never body bytes), so it cannot leak model tokens if logged.
 *
 * `correlationId` defaults to a fresh mint taken ONCE here, at reporter-construction time (i.e. at
 * SSE stream setup) — not inside the returned closure, which fires at most once anyway, but
 * minting eagerly lets a caller that already has the stream's own request/session id in scope
 * (ADR-0173 D5 / g12) pass it straight through instead of a disconnected one being drawn if and
 * only if the stream is later killed.
 */
export function sseBackpressureReporter(
  deps: { readonly diagnostics?: ServerDiagnosticSink | undefined },
  stream: string,
  correlationId: string = randomUUID(),
): (signal: SseBackpressureSignal) => void {
  return (signal: SseBackpressureSignal): void => {
    emitServerDiagnostic(deps.diagnostics, {
      correlationId,
      timestamp: new Date().toISOString(),
      operation: `sse.${stream}`,
      source: `sse.${stream}.backpressure`,
      errorClass: "SseBackpressureKill",
      message: "SSE stream destroyed because the client stopped draining.",
      frameBytes: signal.frameBytes,
    });
  };
}
