// The progress stream and the cancel answer of a long-running Keiko for Quality operation (review
// runs, Issue #4136; pair qualifications, Issue #4137). The stream is one SSE response under the
// shared flow control (frames are never size-limited and only a stalled reader is torn down), a
// heartbeat, the live events of the operation while it is in flight, and one settled frame for an
// operation that already ended. Every frame is a body-free event the caller builds; this module
// never sees operation content.

import { REVIEW_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import { correlationIdOrUnknown } from "../correlation.js";
import type { UiHandlerDeps } from "../deps.js";
import { errorBody } from "../route-error.js";
import { STREAMING, type HandlerOutcome, type RouteContext, type RouteResult } from "../routes.js";
import { SSE_HEADERS, startSseHeartbeat } from "../sse.js";
import { sseBackpressureReporter, writeSseFrame } from "../sse-write.js";

export interface ReviewEventListener<Event> {
  readonly onEvent: (event: Event) => void;
  readonly onClose: () => void;
}

export interface ReviewEventStreamSource<Event> {
  /** The stream's name on the backpressure diagnostic (`sse.<stream>`). */
  readonly stream: string;
  /** The SSE event name every frame carries. */
  readonly eventName: string;
  /** Subscribes to the live operation; `undefined` when it is no longer in flight. */
  readonly subscribe: (listener: ReviewEventListener<Event>) => (() => void) | undefined;
  /** The one settled event of an operation that already ended, when it has one. */
  readonly settled: () => Promise<Event | undefined>;
}

/** Serves one operation's progress until it settles or the reader goes away. */
export async function serveReviewEventStream<Event>(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  source: ReviewEventStreamSource<Event>,
): Promise<HandlerOutcome> {
  const res = ctx.res;
  const controller = new AbortController();
  const correlationId = correlationIdOrUnknown(ctx.correlationId);
  const reporter = sseBackpressureReporter(deps, source.stream, correlationId);
  const write = (event: Event): void => {
    const frame = `event: ${source.eventName}\ndata: ${JSON.stringify(event)}\n\n`;
    writeSseFrame(res, frame, controller, reporter, correlationId);
  };
  res.writeHead(200, SSE_HEADERS);
  const stopHeartbeat = startSseHeartbeat(res, undefined, undefined, {
    controller,
    onBackpressure: reporter,
    correlationId,
  });
  const close = (): void => {
    stopHeartbeat();
    if (!res.writableEnded) res.end();
  };
  const unsubscribe = source.subscribe({ onEvent: write, onClose: close });
  if (unsubscribe === undefined) {
    const settled = await source.settled();
    if (settled !== undefined) write(settled);
    close();
    return STREAMING;
  }
  res.on("close", () => {
    unsubscribe();
    stopHeartbeat();
    controller.abort();
  });
  return STREAMING;
}

/** How a cancel request ended, and the words its refusals use. */
export interface ReviewCancelSubject {
  readonly notFoundMessage: string;
  readonly settledCode: string;
  readonly settledMessage: string;
}

/** 202 while the operation stops, 404 for an unknown one, 409 for one that already settled. */
export function reviewCancelResult(
  ctx: RouteContext,
  outcome: "cancelling" | "settled" | "not-found",
  subject: ReviewCancelSubject,
): RouteResult {
  if (outcome === "not-found") {
    return {
      status: 404,
      body: errorBody("NOT_FOUND", subject.notFoundMessage, ctx.correlationId),
    };
  }
  if (outcome === "settled") {
    return {
      status: 409,
      body: errorBody(subject.settledCode, subject.settledMessage, ctx.correlationId),
    };
  }
  return { status: 202, body: { schemaVersion: REVIEW_CONTRACT_VERSION, status: "cancelling" } };
}
