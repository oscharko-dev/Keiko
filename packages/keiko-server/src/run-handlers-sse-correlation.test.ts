// Regression (#2902 audit thread 11): `run-handlers.ts`'s two SSE writers — `openSseStream`'s
// writer, reached from `handleRunEvents` (GET /api/runs/:runId/events), and `aggregateRunWriter`,
// reached from `handleAllRunEvents` (GET /api/runs/events) — never threaded the request's
// `ctx.correlationId` into their `writeMessageEvent` calls, so neither route's `sse.stream.closed`
// terminal line ever carried the correlation id, unlike the desktop chat stream and the relationship
// activity broadcaster (#2902 w5-sse-counters finding 0). Kept in its own file for the same reason
// as `run-handlers-sse-backpressure.test.ts`: these tests call the two handlers directly against
// hand-built doubles and never bind a real socket, so sharing `run-handlers.test.ts`'s real bound
// HTTP server lifecycle would be a foreign, non-hermetic dependency.

import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";

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

// A minimal, ACCEPTING `ServerResponse` double (mirrors `run-handlers-sse-backpressure.test.ts`'s
// `rejectingFakeRes`, but `write` always succeeds): every event this file emits is meant to reach
// the wire so the resulting `sse.stream.closed` line can be inspected for its correlationId.
function listenableFakeRes(): { res: RouteContext["res"]; fireClose: () => void } {
  const emitter = new EventEmitter();
  const res = {
    writableEnded: false,
    destroyed: false,
    write: (): boolean => true,
    writeHead: (): void => undefined,
    end: (): void => undefined,
    destroy: (): void => undefined,
    on: (event: string, handler: (...args: unknown[]) => void): void => {
      emitter.on(event, handler);
    },
  } as unknown as RouteContext["res"];
  return {
    res,
    fireClose: (): void => {
      emitter.emit("close");
    },
  };
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

function terminalCorrelationId(sink: BufferedServerLogSink): unknown {
  const closedLine = sink.events.find((event) => event.op === "sse.stream.closed");
  return closedLine?.correlationId;
}

afterEach(() => {
  resetServerLogger();
});

describe("run SSE writers thread the request correlationId (#2902 audit thread 11)", () => {
  it("handleRunEvents (openSseStream) attaches ctx.correlationId to sse.stream.closed", () => {
    const sink = captureServerLog();
    const registry = createRunRegistry();
    const eventSink = new QueueEventSink();
    registry.register({
      runId: "run-corr-1",
      fingerprint: "fp-corr-1",
      modelId: "test-model",
      sink: eventSink,
      cancel: () => undefined,
    });
    const deps = minimalDeps(registry);
    const { res, fireClose } = listenableFakeRes();
    const ctx: RouteContext = {
      req: fakeReq(),
      res,
      params: { runId: "run-corr-1" },
      url: new URL("http://localhost/api/runs/run-corr-1/events"),
      correlationId: "corr-run-events-1",
    };

    handleRunEvents(ctx, deps);
    eventSink.emit({
      schemaVersion: "1",
      runId: "run-corr-1",
      fingerprint: "fp-corr-1",
      seq: 0,
      ts: 1_700_000_000_000,
      type: "workflow:progress",
    });
    fireClose();

    expect(terminalCorrelationId(sink)).toBe("corr-run-events-1");
    deps.store.close();
  });

  it("handleAllRunEvents (aggregateRunWriter) attaches ctx.correlationId to sse.stream.closed", () => {
    const sink = captureServerLog();
    const registry = createRunRegistry();
    const eventSink = new QueueEventSink();
    registry.register({
      runId: "run-corr-2",
      fingerprint: "fp-corr-2",
      modelId: "test-model",
      sink: eventSink,
      cancel: () => undefined,
    });
    const deps = minimalDeps(registry);
    const { res, fireClose } = listenableFakeRes();
    const ctx: RouteContext = {
      req: fakeReq(),
      res,
      params: {},
      url: new URL("http://localhost/api/runs/events"),
      correlationId: "corr-all-run-events-1",
    };

    handleAllRunEvents(ctx, deps);
    eventSink.emit({
      schemaVersion: "1",
      runId: "run-corr-2",
      fingerprint: "fp-corr-2",
      seq: 0,
      ts: 1_700_000_000_000,
      type: "workflow:progress",
    });
    fireClose();

    expect(terminalCorrelationId(sink)).toBe("corr-all-run-events-1");
    deps.store.close();
  });
});
