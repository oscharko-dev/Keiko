// GEN-PERF-CHAT-006: a backpressure kill (res.write -> false) must emit a distinct, observable signal
// exactly once BEFORE the socket is destroyed, so a slow-client termination is not silently relabeled
// as a user cancel. The signal must carry only non-secret counts (no body bytes) and an observer throw
// must never break the protective abort+destroy path.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { mockResponse } from "./_support.js";
import { writeOrDestroy, type SseBackpressureSignal } from "./sse-write.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
} from "./observability/index.js";

function fakeRes(writeReturns: boolean): {
  res: ServerResponse;
  destroy: ReturnType<typeof vi.fn>;
  aborted: () => boolean;
  destroyed: () => boolean;
} {
  let destroyed = false;
  const destroy = vi.fn().mockImplementation(() => {
    destroyed = true;
  });
  const res = {
    write: vi.fn().mockReturnValue(writeReturns),
    destroy,
  } as unknown as ServerResponse;
  return { res, destroy, aborted: () => false, destroyed: () => destroyed };
}

describe("writeOrDestroy backpressure signal (GEN-PERF-CHAT-006)", () => {
  it("invokes onBackpressure exactly once with the frame byte count when the write is rejected", () => {
    const { res, destroy } = fakeRes(false);
    const controller = new AbortController();
    const signals: SseBackpressureSignal[] = [];

    const accepted = writeOrDestroy(res, "event: token\ndata: {}\n\n", controller, (s) => {
      signals.push(s);
    });

    expect(accepted).toBe(false);
    expect(controller.signal.aborted).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual({
      frameBytes: Buffer.byteLength("event: token\ndata: {}\n\n", "utf8"),
      accepted: false,
    });
  });

  it("does NOT invoke onBackpressure on a successful (accepted) write", () => {
    const { res, destroy } = fakeRes(true);
    const controller = new AbortController();
    const onBackpressure = vi.fn();

    const accepted = writeOrDestroy(res, "frame", controller, onBackpressure);

    expect(accepted).toBe(true);
    expect(onBackpressure).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("emits the signal BEFORE destroying the socket", () => {
    const order: string[] = [];
    const res = {
      write: vi.fn().mockReturnValue(false),
      destroy: vi.fn().mockImplementation(() => order.push("destroy")),
    } as unknown as ServerResponse;
    const controller = new AbortController();

    writeOrDestroy(res, "frame", controller, () => order.push("signal"));

    expect(order).toEqual(["signal", "destroy"]);
  });

  it("still aborts and destroys even if the observer throws", () => {
    const { res, destroy } = fakeRes(false);
    const controller = new AbortController();

    expect(() =>
      writeOrDestroy(res, "frame", controller, () => {
        throw new Error("observer boom");
      }),
    ).not.toThrow();

    expect(controller.signal.aborted).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps backwards-compatible behavior when no observer is supplied", () => {
    const { res, destroy } = fakeRes(false);
    const controller = new AbortController();

    const accepted = writeOrDestroy(res, "frame", controller);

    expect(accepted).toBe(false);
    expect(controller.signal.aborted).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("never throws when res.on is not implemented (a minimal write/destroy-only double)", () => {
    const { res } = fakeRes(true);
    const controller = new AbortController();

    expect(() => writeOrDestroy(res, "frame", controller)).not.toThrow();
  });
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
  });

  it("counts every frame written through writeOrDestroy and reports reason=completed on a real stream end", async () => {
    const sink = captureServerLog();
    const { res } = mockResponse();
    const controller = new AbortController();
    const frames = ["event: a\ndata: {}\n\n", "event: b\ndata: {}\n\n", "event: c\ndata: {}\n\n"];

    for (const frame of frames) writeOrDestroy(res, frame, controller);
    const closed = new Promise<void>((resolve) => res.once("close", resolve));
    res.end();
    await closed;

    expect(sink.events).toHaveLength(1);
    const [event] = sink.events;
    expect(event).toMatchObject({ level: "info", category: "http", op: "sse.stream.closed" });
    expect(typeof event?.durationMs).toBe("number");
    expect(event?.extra).toEqual({
      frameCount: 3,
      bytesStreamed: frames.reduce((sum, f) => sum + Buffer.byteLength(f, "utf8"), 0),
      reason: "completed",
    });
  });

  it("reports reason=client-disconnected when the socket closes without the producer ending it", async () => {
    const sink = captureServerLog();
    const { res } = mockResponse();
    const controller = new AbortController();

    writeOrDestroy(res, "event: a\ndata: {}\n\n", controller);
    const closed = new Promise<void>((resolve) => res.once("close", resolve));
    res.destroy();
    await closed;

    expect(sink.events[0]?.extra).toMatchObject({ reason: "client-disconnected" });
  });

  it("reports reason=backpressure-killed and threads the supplied correlation id", () => {
    const sink = captureServerLog();
    const { res, fireClose } = listenableFakeRes(false);
    const controller = new AbortController();

    writeOrDestroy(res, "event: a\ndata: {}\n\n", controller, undefined, "corr-sse-1");
    fireClose();

    expect(sink.events).toEqual([
      {
        level: "info",
        category: "http",
        op: "sse.stream.closed",
        correlationId: "corr-sse-1",
        durationMs: expect.any(Number) as number,
        status: undefined,
        errorKind: undefined,
        extra: {
          frameCount: 1,
          bytesStreamed: Buffer.byteLength("event: a\ndata: {}\n\n"),
          reason: "backpressure-killed",
        },
      },
    ]);
  });

  it("emits the terminal line exactly once even when close fires more than once", () => {
    const sink = captureServerLog();
    const { res, fireClose } = listenableFakeRes(true);
    const controller = new AbortController();

    writeOrDestroy(res, "frame", controller);
    fireClose();
    fireClose();

    expect(sink.events).toHaveLength(1);
  });

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

    writeOrDestroy(res, "frame", controller);
    listeners.get("error")?.();
    listeners.get("close")?.();

    expect(sink.events[0]?.extra).toMatchObject({ reason: "server-error" });
  });

  it("never tracks or logs a response that does not implement .on", () => {
    const sink = captureServerLog();
    const { res } = fakeRes(true);
    const controller = new AbortController();

    writeOrDestroy(res, "frame", controller);

    expect(sink.events).toEqual([]);
  });
});
