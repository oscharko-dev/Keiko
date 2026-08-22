// Regression (#2902 w5-sse-counters review finding): `run-handlers.ts`'s two SSE writers
// (`openSseStream`'s writer, reached from `handleRunEvents` — GET /api/runs/:runId/events — and
// `aggregateRunWriter`, reached from `handleAllRunEvents` — GET /api/runs/events) each call
// `res.destroy()` directly on a rejected write instead of going through `writeOrDestroy`/
// `writeOrDestroyLegacy`. Neither called `markSseStreamBackpressureKilled` before destroying, so a
// real slow-client backpressure kill on either stream was indistinguishable in the terminal
// `sse.stream.closed` line from an ordinary client disconnect (`reason: "client-disconnected"`
// instead of `"backpressure-killed"`) — exactly the distinction #2902's SSE terminal-line mechanism
// exists to preserve. Kept in its own file (never a describe block appended to run-handlers.test.ts)
// because that suite's `server`/`afterEach` lifecycle is scoped to a real bound HTTP server every
// test in it starts; these tests call the two handlers directly against hand-built doubles and never
// bind a socket, so sharing that lifecycle would be a foreign, non-hermetic dependency.

import { afterEach, describe, expect, it } from "vitest";

import { buildRedactor, createRunRegistry, handleRunEvents, QueueEventSink } from "./index.js";
import { handleAllRunEvents } from "./run-handlers.js";
import type { RouteContext } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { createInMemoryUiStore } from "./store/index.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
} from "./observability/index.js";

// A minimal `ServerResponse`-shaped double (mirrors `sse-write.test.ts`'s `listenableFakeRes`):
// `write` records the frame it was given, then always rejects, so the very first frame trips the
// writer's own destroy path. `on` records listeners so the test can fire "close" deterministically,
// exactly as the terminal-line mechanism does on a real socket teardown.
function rejectingFakeRes(): {
  res: RouteContext["res"];
  fireClose: () => void;
  readonly frames: readonly string[];
} {
  // A real `ServerResponse` is an EventEmitter: `.on("close", ...)` may legitimately be called more
  // than once (this route does — once for the stream's own frame/byte tracking, once for its
  // sink-detach cleanup) and every registered listener fires on a real "close" event. A single-slot
  // map here would silently drop all but the last registration and misreport this regression as
  // fixed regardless of whether the product code is correct.
  const listeners = new Map<string, (() => void)[]>();
  const frames: string[] = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    write: (chunk: string): boolean => {
      frames.push(chunk);
      return false;
    },
    writeHead: (): void => undefined,
    end: (): void => undefined,
    destroy: (): void => undefined,
    on: (event: string, handler: () => void): void => {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
    },
  } as unknown as RouteContext["res"];
  return {
    res,
    frames,
    fireClose: (): void => {
      for (const handler of listeners.get("close") ?? []) handler();
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

afterEach(() => {
  resetServerLogger();
});

describe("SSE writers report reason=backpressure-killed, not client-disconnected", () => {
  it("handleRunEvents (openSseStream) marks backpressure before destroying on a rejected replay write", () => {
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
    const { res, frames, fireClose } = rejectingFakeRes();
    const ctx: RouteContext = {
      req: fakeReq(),
      res,
      params: { runId: "run-bp-1" },
      url: new URL("http://localhost/api/runs/run-bp-1/events"),
    };

    handleRunEvents(ctx, deps);
    fireClose();

    expect(terminalReason(sink)).toBe("backpressure-killed");
    expect(eventFrameTs(frames)).toBe(FIXED_EVENT_TS);
    deps.store.close();
  });

  it("handleAllRunEvents (aggregateRunWriter) marks backpressure before destroying on a rejected fan-out write", () => {
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
    const { res, frames, fireClose } = rejectingFakeRes();
    const ctx: RouteContext = {
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
    fireClose();

    expect(terminalReason(sink)).toBe("backpressure-killed");
    expect(eventFrameTs(frames)).toBe(FIXED_EVENT_TS);
    deps.store.close();
  });
});
