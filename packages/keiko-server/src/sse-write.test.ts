import { observedFailureQuery } from "../../../tests/support/observed-failure-query.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
// GEN-PERF-CHAT-006: a stalled-reader kill must emit a distinct, observable signal exactly once
// BEFORE the socket is destroyed, so a stalled-reader termination is not silently relabeled as a user
// cancel. The signal must carry only non-secret counts (no body bytes) and an observer throw must
// never break the protective abort+destroy path. A write that merely returns false is flow control.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { mockResponse } from "./_support.js";
import {
  currentOpenSseStreamCount,
  markServerShuttingDown,
  markSseStreamBackpressureKilled,
  markSseStreamServerErrored,
  resetServerShuttingDownForTests,
  SSE_STALLED_READER_TIMEOUT_MS,
  sseBackpressureReporter,
  whenSseWritable,
  writeSseFrame,
  type SseBackpressureSignal,
} from "./sse-write.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "./diagnostics-log.js";

interface DrainableFakeRes {
  readonly res: ServerResponse;
  readonly write: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly drain: () => void;
  readonly close: () => void;
}

// An EventEmitter-backed response double: `write` answers as told, `drain`/`close` fire on demand and
// `destroy` behaves like a real socket teardown (marks destroyed, then emits close).
function drainableFakeRes(writeReturns: boolean): DrainableFakeRes {
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    destroyed: false,
    writableEnded: false,
    writableNeedDrain: false,
    write: vi.fn().mockReturnValue(writeReturns),
    destroy: vi.fn(),
  });
  res.write.mockImplementation(() => {
    res.writableNeedDrain ||= !writeReturns;
    return writeReturns;
  });
  res.destroy.mockImplementation(() => {
    res.destroyed = true;
    emitter.emit("close");
  });
  return {
    res: res as unknown as ServerResponse,
    write: res.write,
    destroy: res.destroy,
    drain: (): void => {
      res.writableNeedDrain = false;
      emitter.emit("drain");
    },
    close: () => emitter.emit("close"),
  };
}

// Node 24 answers `false` for any single write of 64 KiB or more, even to an idle local reader. A
// false write is flow control: the frame is queued and the stream waits for `drain`. Only a reader
// that drains nothing within SSE_STALLED_READER_TIMEOUT_MS is torn down (GEN-PERF-CHAT-006 keeps
// its distinct, observable signal for exactly that case).
describe("writeSseFrame flow control", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the stream open when a write is buffered and the reader drains it", () => {
    vi.useFakeTimers();
    const { res, destroy, drain } = drainableFakeRes(false);
    const controller = new AbortController();
    const onBackpressure = vi.fn();

    expect(writeSseFrame(res, "event: big\ndata: {}\n\n", controller, onBackpressure)).toBe(true);
    drain();
    vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS * 2);

    expect(destroy).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    expect(onBackpressure).not.toHaveBeenCalled();
  });

  it("removes finish listeners after more than ten healthy false-write drain cycles", () => {
    vi.useFakeTimers();
    const { res, drain, close, destroy } = drainableFakeRes(false);
    const controller = new AbortController();
    const baselineFinish = res.listenerCount("finish");
    const baselineDrain = res.listenerCount("drain");
    try {
      for (let cycle = 0; cycle < 12; cycle += 1) {
        expect(writeSseFrame(res, "event: token\ndata: {}\n\n", controller)).toBe(true);
        expect(res.writableNeedDrain).toBe(true);
        drain();
        expect(res.writableNeedDrain).toBe(false);
        expect(res.listenerCount("finish")).toBe(baselineFinish);
        expect(res.listenerCount("drain")).toBe(baselineDrain);
      }
      vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS * 2);
      expect(destroy).not.toHaveBeenCalled();
      expect(controller.signal.aborted).toBe(false);
    } finally {
      close();
    }
  });

  it("tears down a reader that drains nothing within the stall bound, signalling exactly once", () => {
    vi.useFakeTimers();
    const { res, destroy } = drainableFakeRes(false);
    const controller = new AbortController();
    const signals: SseBackpressureSignal[] = [];
    const frame = "event: token\ndata: {}\n\n";

    writeSseFrame(res, frame, controller, (s) => signals.push(s));
    writeSseFrame(res, frame, controller, (s) => signals.push(s));
    vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS - 1);
    expect(destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(true);
    expect(signals).toEqual([{ frameBytes: Buffer.byteLength(frame, "utf8"), accepted: false }]);
    expect(writeSseFrame(res, frame, controller)).toBe(false);
  });

  it("emits the stalled-reader signal BEFORE destroying the socket", () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const { res, destroy } = drainableFakeRes(false);
    destroy.mockImplementation(() => order.push("destroy"));

    writeSseFrame(res, "frame", new AbortController(), () => order.push("signal"));
    vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS);

    expect(order).toEqual(["signal", "destroy"]);
  });

  it("still aborts and destroys a stalled reader even if the observer throws", () => {
    vi.useFakeTimers();
    const { res, destroy } = drainableFakeRes(false);
    const controller = new AbortController();

    writeSseFrame(res, "frame", controller, () => {
      throw new Error("observer boom");
    });
    expect(() => vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS)).not.toThrow();

    expect(controller.signal.aborted).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("ends the wait without a kill when the reader closes first", () => {
    vi.useFakeTimers();
    const { res, destroy, close } = drainableFakeRes(false);
    const controller = new AbortController();

    writeSseFrame(res, "frame", controller);
    close();
    vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS * 2);

    expect(destroy).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
  });

  it("tears down an ended stream whose reader never takes the queued tail", () => {
    vi.useFakeTimers();
    const { res, destroy } = drainableFakeRes(false);
    const controller = new AbortController();
    const onBackpressure = vi.fn();

    writeSseFrame(res, "frame", controller, onBackpressure);
    Object.assign(res, { writableEnded: true, writableFinished: false });
    vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(onBackpressure).toHaveBeenCalledTimes(1);
  });

  it("ends the wait without a kill once an ended stream has flushed", () => {
    vi.useFakeTimers();
    const { res, destroy } = drainableFakeRes(false);
    const controller = new AbortController();

    writeSseFrame(res, "frame", controller);
    Object.assign(res, { writableEnded: true, writableFinished: true });
    res.emit("finish");
    vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS * 2);

    expect(destroy).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
  });

  it("refuses to queue on a stream that is already gone", () => {
    const { res, write } = drainableFakeRes(true);
    (res as { destroyed: boolean }).destroyed = true;

    expect(writeSseFrame(res, "frame", new AbortController())).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("does NOT signal or wait on an accepted write", () => {
    const { res, destroy } = drainableFakeRes(true);
    const controller = new AbortController();
    const onBackpressure = vi.fn();

    expect(writeSseFrame(res, "frame", controller, onBackpressure)).toBe(true);
    expect(onBackpressure).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("never throws for a minimal write/destroy-only double", () => {
    const res = {
      write: vi.fn().mockReturnValue(false),
      destroy: vi.fn(),
    } as unknown as ServerResponse;

    expect(() => writeSseFrame(res, "frame", new AbortController())).not.toThrow();
  });
});

// The 1.3.1 blocker (2026-10-28): a frame of 64 KiB or more — a large tool call, a buffered answer —
// made res.write() return false and the old writer destroyed a healthy stream; the reader got
// nothing. Proven over a real loopback socket, not a mocked write.
describe("writeSseFrame over a real socket", () => {
  async function streamOneFrame(
    frameBytes: number,
  ): Promise<{ received: number; killed: boolean }> {
    const frame = `data: ${"x".repeat(frameBytes)}\n\n`;
    let killed = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const controller = new AbortController();
      writeSseFrame(res, frame, controller, () => {
        killed = true;
      });
      res.end();
    });
    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${String(port)}/`);
      const body = await response.text();
      return { received: Buffer.byteLength(body, "utf8"), killed };
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  }

  it.each([70_000, 1_048_576, 8_388_608])(
    "delivers a single %i-byte frame whole and keeps the stream alive",
    async (bytes) => {
      const result = await streamOneFrame(bytes);

      expect(result.killed).toBe(false);
      expect(result.received).toBe(bytes + "data: \n\n".length);
    },
  );
});

// The terminal `sse.stream.closed` line (#2902 w5-sse-counters): a per-response frame/byte counter
// closed over the SAME write path every SSE route already funnels through, surfaced exactly once
// when the stream reaches its terminal `close` event.
describe("sse.stream.closed terminal line", () => {
  function captureServerLog(): BufferedServerLogSink {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    return sink;
  }

  // A hand-rolled EventEmitter-shaped fake (mirrors sse.test.ts's own convention) so a test can fire
  // "close" deterministically without waiting on a real stream's autoDestroy timing.
  function listenableFakeRes(writeReturns: boolean): {
    res: ServerResponse;
    fireClose: () => void;
  } {
    const listeners = new Map<string, () => void>();
    const res = {
      writableEnded: false,
      write: vi.fn().mockReturnValue(writeReturns),
      destroy: vi.fn(),
      on: (event: string, handler: () => void) => {
        listeners.set(event, handler);
      },
    } as unknown as ServerResponse;
    return { res, fireClose: () => listeners.get("close")?.() };
  }

  afterEach(() => {
    resetServerLogger();
    resetServerShuttingDownForTests();
  });

  it("counts every frame written through writeSseFrame and reports reason=completed on a real stream end", async () => {
    const sink = captureServerLog();
    const { res } = mockResponse();
    const controller = new AbortController();
    const frames = ["event: a\ndata: {}\n\n", "event: b\ndata: {}\n\n", "event: c\ndata: {}\n\n"];

    for (const frame of frames) writeSseFrame(res, frame, controller);
    const closed = new Promise<void>((resolve) => res.once("close", resolve));
    res.end();
    await closed;

    expect(sink.events).toHaveLength(1);
    const [event] = sink.events;
    expect(event).toMatchObject({ level: "info", category: "http", op: "sse.stream.closed" });
    expect(typeof event?.durationMs).toBe("number");
    expect(event?.extra).toEqual({
      completeness: "complete",
      loss: "none",
      frameCount: 3,
      bytesStreamed: frames.reduce((sum, f) => sum + Buffer.byteLength(f, "utf8"), 0),
      reason: "completed",
    });
  });

  // Registry-linked executable proof (#3532): the same terminal line above, read back through the
  // real formatter/registry path so `sse.stream.closed.line` resolves against a
  // production-computed event (this task's rule 1: no hand-built event or registration object).
  it("persists sse.stream.closed as a registered Activity Log proof line", async () => {
    const sink = captureServerLog();
    const { res } = mockResponse();
    const controller = new AbortController();

    writeSseFrame(res, "event: a\ndata: {}\n\n", controller, undefined, "corr-sse-closed-proof");
    const closed = new Promise<void>((resolve) => res.once("close", resolve));
    res.end();
    await closed;

    const [event] = sink.events;
    if (event === undefined) throw new Error("expected a stream-closed event");
    const line = formatActivityLogProofLine(event);
    const persisted = expectActivityLogProof("sse.stream.closed.line", line);
    expect(persisted).toMatchObject({
      category: "http",
      correlationId: "corr-sse-closed-proof",
      reason: "completed",
      frameCount: 1,
    });
  });

  it("reports reason=client-disconnected when the socket closes without the producer ending it", async () => {
    const sink = captureServerLog();
    const { res } = mockResponse();
    const controller = new AbortController();

    writeSseFrame(res, "event: a\ndata: {}\n\n", controller);
    const closed = new Promise<void>((resolve) => res.once("close", resolve));
    res.destroy();
    await closed;

    expect(sink.events[0]?.extra).toMatchObject({ reason: "client-disconnected" });
  });

  // Run 9 (2026-09-10): a dev-lane BFF restart closed every live stream at once, and the log showed
  // one `backpressure-killed` plus two `client-disconnected` next to a cancelled run — three symptoms
  // of a shutdown nobody could see from the log. The shutdown is the cause and says so, and the live
  // stream count is what the shutdown line reports.
  it("reports reason=server-shutdown for streams the shutdown tears down, and counts live streams", () => {
    const sink = captureServerLog();
    const before = currentOpenSseStreamCount();
    const killed = listenableFakeRes(false);
    const disconnected = listenableFakeRes(true);
    const controller = new AbortController();

    writeSseFrame(killed.res, "event: a\ndata: {}\n\n", controller, undefined, "corr-kill");
    writeSseFrame(disconnected.res, "event: a\ndata: {}\n\n", controller, undefined, "corr-open");
    expect(currentOpenSseStreamCount()).toBe(before + 2);

    markServerShuttingDown();
    killed.fireClose();
    disconnected.fireClose();

    expect(sink.events.map((event) => event.extra?.reason)).toEqual([
      "server-shutdown",
      "server-shutdown",
    ]);
    expect(currentOpenSseStreamCount()).toBe(before);
  });

  // A stream the producer had already ended finished on its own terms, even though its `close` event
  // arrives after the shutdown began — which is the PRODUCTION order: dispose marks the shutdown
  // first, then connections are torn down. Marking the shutdown after the close event (as this test
  // first did) never entered the branch at all, so `!res.writableEnded` could have been deleted with
  // the test still green (owner review, PR #3452).
  it("keeps reason=completed for a stream that ended before the shutdown tore it down", async () => {
    const sink = captureServerLog();
    const { res } = mockResponse();
    const controller = new AbortController();

    writeSseFrame(res, "event: a\ndata: {}\n\n", controller);
    markServerShuttingDown();
    const closed = new Promise<void>((resolve) => res.once("close", resolve));
    res.end();
    await closed;

    expect(sink.events[0]?.extra).toMatchObject({ reason: "completed" });
  });

  it("reports reason=backpressure-killed for a stalled reader and threads the supplied correlation id", () => {
    vi.useFakeTimers();
    const sink = captureServerLog();
    const { res } = drainableFakeRes(false);
    const controller = new AbortController();

    writeSseFrame(res, "event: a\ndata: {}\n\n", controller, undefined, "corr-sse-1");
    vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS);
    vi.useRealTimers();

    expect(sink.events).toEqual([
      {
        level: "info",
        category: "http",
        op: "sse.stream.closed",
        correlationId: "corr-sse-1",
        durationMs: expect.any(Number) as number,
        parentCorrelationId: undefined,
        status: undefined,
        errorKind: undefined,
        extra: {
          completeness: "complete",
          loss: "none",
          frameCount: 1,
          bytesStreamed: Buffer.byteLength("event: a\ndata: {}\n\n"),
          drainWaitCount: 1,
          reason: "backpressure-killed",
        },
      },
    ]);
  });

  it("preserves a caught server error when destroy does not emit a response error", () => {
    const sink = captureServerLog();
    const { res, fireClose } = listenableFakeRes(true);
    writeSseFrame(res, "bounded-frame", new AbortController(), undefined, "corr-sse-error");
    markSseStreamServerErrored(res);
    res.destroy(new TypeError("private body"));
    fireClose();
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      correlationId: "corr-sse-error",
      extra: { reason: "server-error", frameCount: 1 },
    });
    expect(JSON.stringify(sink.events)).not.toContain("private body");
  });

  it("emits the terminal line exactly once even when close fires more than once", () => {
    const sink = captureServerLog();
    const { res, fireClose } = listenableFakeRes(true);
    const controller = new AbortController();

    writeSseFrame(res, "frame", controller);
    fireClose();
    fireClose();

    expect(sink.events).toHaveLength(1);
  });

  it.each(["server-error", "backpressure-killed", "client-disconnected"] as const)(
    "preserves the actual %s terminal diagnostic when optional context is exhausted",
    (reason) => {
      const sink = captureServerLog();
      const { res, fireClose } = listenableFakeRes(true);
      writeSseFrame(res, "PRIVATE_FRAME", new AbortController(), undefined, "sse-query-failure");
      if (reason === "server-error") markSseStreamServerErrored(res);
      // The stalled-reader teardown marks the stream exactly like this before destroying it.
      if (reason === "backpressure-killed") markSseStreamBackpressureKilled(res);
      fireClose();
      expect(sink.events[0]?.extra?.reason).toBe(reason);
      const query = observedFailureQuery(sink.events);
      const retained = query.events.filter((event) => event.parsed.view.op === "sse.stream.closed");
      expect(retained).toHaveLength(1);
      expect(JSON.stringify(query)).not.toContain("PRIVATE_FRAME");
    },
  );

  it("reports reason=server-error when the response emits an error before closing", () => {
    const sink = captureServerLog();
    const listeners = new Map<string, () => void>();
    const res = {
      writableEnded: false,
      write: vi.fn().mockReturnValue(true),
      destroy: vi.fn(),
      on: (event: string, handler: () => void) => {
        listeners.set(event, handler);
      },
    } as unknown as ServerResponse;
    const controller = new AbortController();

    writeSseFrame(res, "frame", controller);
    listeners.get("error")?.();
    listeners.get("close")?.();

    expect(sink.events[0]?.extra).toMatchObject({ reason: "server-error" });
  });

  it("never tracks or logs a response that does not implement .on", () => {
    const sink = captureServerLog();
    const res = {
      write: vi.fn().mockReturnValue(true),
      destroy: vi.fn(),
    } as unknown as ServerResponse;
    const controller = new AbortController();

    writeSseFrame(res, "frame", controller);

    expect(sink.events).toEqual([]);
  });
});

// ADR-0173 D5 / g12: `sseBackpressureReporter` used to mint a fresh `randomUUID()` INSIDE the
// returned closure on every backpressure signal. A caller with the stream's own request/session id
// already in scope had no way to thread it through, and — the sharper defect — two signals from
// the SAME reporter (the same SSE stream) reported under two disconnected ids.
describe("sseBackpressureReporter correlation id (ADR-0173 D5 / g12)", () => {
  it("threads a caller-supplied correlation id onto the backpressure diagnostic", () => {
    const records: ServerDiagnosticRecord[] = [];
    const diagnostics: ServerDiagnosticSink = { record: (record) => records.push(record) };
    const observe = sseBackpressureReporter({ diagnostics }, "terminal", "req-abc12345");

    observe({ frameBytes: 42, accepted: false });

    expect(records).toHaveLength(1);
    expect(records[0]?.correlationId).toBe("req-abc12345");
  });

  it("mints one id per reporter construction, shared across every signal that reporter emits", () => {
    const records: ServerDiagnosticRecord[] = [];
    const diagnostics: ServerDiagnosticSink = { record: (record) => records.push(record) };
    const observeA = sseBackpressureReporter({ diagnostics }, "terminal");
    const observeB = sseBackpressureReporter({ diagnostics }, "terminal");

    observeA({ frameBytes: 1, accepted: false });
    observeA({ frameBytes: 2, accepted: false });
    observeB({ frameBytes: 3, accepted: false });

    expect(records).toHaveLength(3);
    expect(records[0]?.correlationId).toBe(records[1]?.correlationId);
    expect(records[0]?.correlationId).not.toBe(records[2]?.correlationId);
  });
});

describe("whenSseWritable", () => {
  function writableRes(needDrain: boolean): ServerResponse {
    return Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writableNeedDrain: needDrain,
    }) as unknown as ServerResponse;
  }

  it("resolves at once while the buffer is below the high-water mark", async () => {
    await expect(whenSseWritable(writableRes(false))).resolves.toBeUndefined();
  });

  it("waits for drain while the buffer is above the high-water mark", async () => {
    const res = writableRes(true);
    let resolved = false;
    const waiting = whenSseWritable(res).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    res.emit("drain");
    await waiting;
    expect(resolved).toBe(true);
    expect(res.listenerCount("drain")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("settles an aborted producer without closing the response and removes every waiter", async () => {
    const res = writableRes(true);
    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
    let resolved = false;
    const waiting = whenSseWritable(res, controller.signal).then(() => {
      resolved = true;
    });
    try {
      controller.abort();
      await Promise.resolve();
      expect(resolved).toBe(true);
      expect(res.destroyed).toBe(false);
      expect(res.listenerCount("drain")).toBe(0);
      expect(res.listenerCount("close")).toBe(0);
      expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      res.emit("close");
      await waiting;
    }
  });

  it("does not install waiters for a producer that was already aborted", async () => {
    const res = writableRes(true);
    const controller = new AbortController();
    controller.abort();
    let resolved = false;
    const waiting = whenSseWritable(res, controller.signal).then(() => {
      resolved = true;
    });
    try {
      await Promise.resolve();
      expect(resolved).toBe(true);
      expect(res.listenerCount("drain")).toBe(0);
      expect(res.listenerCount("close")).toBe(0);
    } finally {
      res.emit("close");
      await waiting;
    }
  });

  it.each(["drain", "close"])("removes the producer abort listener after %s", async (event) => {
    const res = writableRes(true);
    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = whenSseWritable(res, controller.signal);
    res.emit(event);
    await expect(waiting).resolves.toBeUndefined();
    expect(res.listenerCount("drain")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("stops waiting when the stream closes", async () => {
    const res = writableRes(true);
    const waiting = whenSseWritable(res);
    res.emit("close");
    await expect(waiting).resolves.toBeUndefined();
    expect(res.listenerCount("drain")).toBe(0);
  });
});
