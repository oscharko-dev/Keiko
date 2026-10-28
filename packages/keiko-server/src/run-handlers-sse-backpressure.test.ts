import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
// Regression (#2902 w5-sse-counters review finding): `run-handlers.ts`'s two SSE writers
// (`openSseStream`'s writer, reached from `handleRunEvents` — GET /api/runs/:runId/events — and
// `aggregateRunWriter`, reached from `handleAllRunEvents` — GET /api/runs/events) each call
// `res.destroy()` directly on a rejected write instead of going through `writeSseFrame`/
// `writeSseFrameLegacy`. Neither called `markSseStreamBackpressureKilled` before destroying, so a
// real slow-client backpressure kill on either stream was indistinguishable in the terminal
// `sse.stream.closed` line from an ordinary client disconnect (`reason: "client-disconnected"`
// instead of `"backpressure-killed"`) — exactly the distinction #2902's SSE terminal-line mechanism
// exists to preserve. Both writers now go through `writeMessageEvent` → `writeSseFrame`: a false
// write is flow control, and only a reader that drains nothing within
// `SSE_STALLED_READER_TIMEOUT_MS` is marked backpressure-killed and destroyed. Kept in its own file (never a describe block appended to run-handlers.test.ts)
// because that suite's `server`/`afterEach` lifecycle is scoped to a real bound HTTP server every
// test in it starts; these tests call the two handlers directly against hand-built doubles and never
// bind a socket, so sharing that lifecycle would be a foreign, non-hermetic dependency.

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildRedactor, createRunRegistry, handleRunEvents, QueueEventSink } from "./index.js";
import { handleAllRunEvents } from "./run-handlers.js";
import type { RouteContext } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { createInMemoryUiStore } from "./store/index.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { SSE_STALLED_READER_TIMEOUT_MS } from "./sse-write.js";

// A minimal `ServerResponse`-shaped double (mirrors `sse-write.test.ts`'s `drainableFakeRes`):
// `write` records the frame it was given, then returns `writeReturns` (false until a test says
// otherwise), so the very first frame starts the writer's stall wait. It is a real EventEmitter —
// this route registers more than one `"close"` listener (one for the stream's own frame/byte
// tracking, one for its sink-detach cleanup) and the stall wait needs `once`/`off` and a `drain`
// event; `destroy` marks the response destroyed and emits `close`, exactly as a real socket
// teardown does.
function rejectingFakeRes(): {
  res: RouteContext["res"];
  fireClose: () => void;
  fireDrain: () => void;
  readonly frames: readonly string[];
  readonly destroyCount: () => number;
  setWriteReturns: (value: boolean) => void;
} {
  const emitter = new EventEmitter();
  const frames: string[] = [];
  let destroyCount = 0;
  let destroyed = false;
  let writeReturns = false;
  const res = Object.assign(emitter, {
    writableEnded: false,
    get destroyed(): boolean {
      return destroyed;
    },
    write: (chunk: string): boolean => {
      frames.push(chunk);
      return writeReturns;
    },
    writeHead: (): void => undefined,
    end: (): void => undefined,
    destroy: (): void => {
      destroyCount += 1;
      destroyed = true;
      emitter.emit("close");
    },
  }) as unknown as RouteContext["res"];
  return {
    res,
    frames,
    destroyCount: (): number => destroyCount,
    setWriteReturns: (value: boolean): void => {
      writeReturns = value;
    },
    fireClose: (): void => {
      emitter.emit("close");
    },
    fireDrain: (): void => {
      emitter.emit("drain");
    },
  };
}

// The event fixtures' `ts` is not part of the behavior under test (only `reason` is asserted) —
// wall-clock `Date.now()` made them non-deterministic for no reason ("Fixtures are deterministic
// and self-contained", #2902 audit thread 10). A fixed value also lets the tests below prove the
// fixture is what actually reached the wire, rather than merely being unobserved.
const FIXED_EVENT_TS = 1_700_000_000_000;

// The two writers order their `readyMessage()` frame (no `ts` field) and the fixture's event frame
// differently — `openSseStream` replays buffered events before the ready frame, `aggregateRunWriter`
// only fans out an event emitted after it — so this scans every recorded frame for the one carrying
// a `ts`, rather than assuming a fixed position.
function eventFrameTs(frames: readonly string[]): unknown {
  for (const frame of frames) {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (dataLine === undefined) continue;
    const parsed = JSON.parse(dataLine.slice("data: ".length)) as { ts?: unknown };
    if (parsed.ts !== undefined) return parsed.ts;
  }
  return undefined;
}

function fakeReq(): RouteContext["req"] {
  return { headers: {}, on: (): void => undefined } as unknown as RouteContext["req"];
}

function captureServerLog(): BufferedServerLogSink {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  return sink;
}

function minimalDeps(registry: ReturnType<typeof createRunRegistry>): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry,
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
  };
}

function terminalReason(sink: BufferedServerLogSink): unknown {
  const closedLine = sink.events.find((event) => event.op === "sse.stream.closed");
  return (closedLine?.extra as { reason?: unknown } | undefined)?.reason;
}

function closedLineCount(sink: BufferedServerLogSink): number {
  return sink.events.filter((event) => event.op === "sse.stream.closed").length;
}

afterEach(() => {
  resetServerLogger();
  vi.useRealTimers();
});

describe("SSE writers report reason=backpressure-killed, not client-disconnected", () => {
  it("handleRunEvents (openSseStream) marks backpressure before destroying when the reader stalls after a rejected replay write", () => {
    vi.useFakeTimers();
    const sink = captureServerLog();
    const registry = createRunRegistry();
    const eventSink = new QueueEventSink();
    eventSink.emit({
      schemaVersion: "1",
      runId: "run-bp-1",
      fingerprint: "fp-bp-1",
      seq: 0,
      ts: FIXED_EVENT_TS,
      type: "workflow:progress",
    });
    registry.register({
      runId: "run-bp-1",
      fingerprint: "fp-bp-1",
      modelId: "test-model",
      sink: eventSink,
      cancel: () => undefined,
    });
    const deps = minimalDeps(registry);
    const { res, frames, fireClose, destroyCount } = rejectingFakeRes();
    const ctx: RouteContext = {
      correlationId: undefined,
      req: fakeReq(),
      res,
      params: { runId: "run-bp-1" },
      url: new URL("http://localhost/api/runs/run-bp-1/events"),
    };

    handleRunEvents(ctx, deps);

    // A false write is flow control: the replayed frame is queued, and nothing is torn down yet.
    expect(eventFrameTs(frames)).toBe(FIXED_EVENT_TS);
    expect(destroyCount()).toBe(0);
    expect(closedLineCount(sink)).toBe(0);
    vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS - 1);
    expect(destroyCount()).toBe(0);
    expect(closedLineCount(sink)).toBe(0);

    // The reader drained nothing for the whole bound: destroyed once, labelled as a backpressure kill.
    vi.advanceTimersByTime(1);
    expect(destroyCount()).toBe(1);
    expect(terminalReason(sink)).toBe("backpressure-killed");
    // A later `close` from the socket does not emit a second terminal line.
    fireClose();
    expect(closedLineCount(sink)).toBe(1);
    expect(terminalReason(sink)).toBe("backpressure-killed");
    deps.store.close();
  });

  it("keeps the replay stream open and labels a later disconnect client-disconnected when a false write is followed by drain", () => {
    vi.useFakeTimers();
    const sink = captureServerLog();
    const registry = createRunRegistry();
    const eventSink = new QueueEventSink();
    eventSink.emit({
      schemaVersion: "1",
      runId: "run-bp-3",
      fingerprint: "fp-bp-3",
      seq: 0,
      ts: FIXED_EVENT_TS,
      type: "workflow:progress",
    });
    registry.register({
      runId: "run-bp-3",
      fingerprint: "fp-bp-3",
      modelId: "test-model",
      sink: eventSink,
      cancel: () => undefined,
    });
    const deps = minimalDeps(registry);
    const { res, fireClose, fireDrain, destroyCount, setWriteReturns } = rejectingFakeRes();
    const ctx: RouteContext = {
      correlationId: undefined,
      req: fakeReq(),
      res,
      params: { runId: "run-bp-3" },
      url: new URL("http://localhost/api/runs/run-bp-3/events"),
    };

    handleRunEvents(ctx, deps);
    fireDrain();
    setWriteReturns(true);
    vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS * 2);

    expect(destroyCount()).toBe(0);
    expect(closedLineCount(sink)).toBe(0);
    fireClose();
    expect(terminalReason(sink)).toBe("client-disconnected");
    deps.store.close();
  });

  it("handleAllRunEvents (aggregateRunWriter) marks backpressure before destroying when the reader stalls after a rejected fan-out write", () => {
    vi.useFakeTimers();
    const sink = captureServerLog();
    const registry = createRunRegistry();
    const eventSink = new QueueEventSink();
    registry.register({
      runId: "run-bp-2",
      fingerprint: "fp-bp-2",
      modelId: "test-model",
      sink: eventSink,
      cancel: () => undefined,
    });
    const deps = minimalDeps(registry);
    const { res, frames, fireClose, destroyCount } = rejectingFakeRes();
    const ctx: RouteContext = {
      correlationId: undefined,
      req: fakeReq(),
      res,
      params: {},
      url: new URL("http://localhost/api/runs/events"),
    };

    handleAllRunEvents(ctx, deps);
    // The aggregate writer attaches to newly-registered runs on emit; the rejected write this test
    // targets only happens once a live event is actually fanned out.
    eventSink.emit({
      schemaVersion: "1",
      runId: "run-bp-2",
      fingerprint: "fp-bp-2",
      seq: 0,
      ts: FIXED_EVENT_TS,
      type: "workflow:progress",
    });

    // A false write is flow control: the fanned-out frame is queued, and nothing is torn down yet.
    expect(eventFrameTs(frames)).toBe(FIXED_EVENT_TS);
    expect(destroyCount()).toBe(0);
    expect(closedLineCount(sink)).toBe(0);
    vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS - 1);
    expect(destroyCount()).toBe(0);
    expect(closedLineCount(sink)).toBe(0);

    // The reader drained nothing for the whole bound: destroyed once, labelled as a backpressure kill.
    vi.advanceTimersByTime(1);
    expect(destroyCount()).toBe(1);
    expect(terminalReason(sink)).toBe("backpressure-killed");
    fireClose();
    expect(closedLineCount(sink)).toBe(1);
    expect(terminalReason(sink)).toBe("backpressure-killed");
    deps.store.close();
  });
});
