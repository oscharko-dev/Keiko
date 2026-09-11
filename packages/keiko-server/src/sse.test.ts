import { afterEach, describe, expect, it, vi } from "vitest";
import { SSE_HEADERS, startSseHeartbeat, writeReadyMessage } from "./sse.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "./observability/index.js";

describe("SSE_HEADERS", () => {
  it("disables intermediary buffering for low-latency event delivery", () => {
    expect(SSE_HEADERS).toMatchObject({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  });
});

describe("startSseHeartbeat process-liveness", () => {
  it("unrefs the heartbeat interval so it never keeps the process alive", () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(timer);
    const clearIntervalSpy = vi
      .spyOn(globalThis, "clearInterval")
      .mockImplementation(() => undefined);
    try {
      const listeners = new Map<string, () => void>();
      const res = {
        destroyed: false,
        writableEnded: false,
        write: vi.fn(),
        on: (event: string, handler: () => void) => {
          listeners.set(event, handler);
        },
      } as unknown as import("node:http").ServerResponse;

      const stop = startSseHeartbeat(res);
      // The fix: the interval is unref'd at creation (voice-realtime pattern), so
      // an open SSE stream cannot pin the event loop between heartbeat ticks.
      expect(unref).toHaveBeenCalledTimes(1);

      stop();
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
      expect(listeners.has("close")).toBe(true);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("destroys a slow client when heartbeat backpressure is reported", async () => {
    vi.useFakeTimers();
    try {
      const destroy = vi.fn();
      const write = vi.fn(() => false);
      const res = {
        destroyed: false,
        writableEnded: false,
        write,
        destroy,
        on: vi.fn(),
      } as unknown as import("node:http").ServerResponse;
      const stop = startSseHeartbeat(res, 10);
      await vi.advanceTimersByTimeAsync(10);
      expect(write).toHaveBeenCalledWith(": keep-alive\n\n");
      expect(write).not.toHaveBeenCalledWith("event: heartbeat\ndata: {}\n\n");
      expect(destroy).toHaveBeenCalledOnce();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses comment-only heartbeats by default", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(() => true);
      const res = {
        destroyed: false,
        writableEnded: false,
        write,
        destroy: vi.fn(),
        on: vi.fn(),
      } as unknown as import("node:http").ServerResponse;
      const stop = startSseHeartbeat(res, 10);

      await vi.advanceTimersByTimeAsync(10);

      expect(write).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledWith(": keep-alive\n\n");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits an opt-in observable heartbeat event for browser EventSource clients", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(() => true);
      const res = {
        destroyed: false,
        writableEnded: false,
        write,
        destroy: vi.fn(),
        on: vi.fn(),
      } as unknown as import("node:http").ServerResponse;
      const stop = startSseHeartbeat(res, 10, "heartbeat");

      await vi.advanceTimersByTimeAsync(10);

      expect(write).toHaveBeenNthCalledWith(1, ": keep-alive\n\n");
      expect(write).toHaveBeenNthCalledWith(2, "event: heartbeat\ndata: {}\n\n");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// #3452 audit finding sse.ts:108: several openers wrote the ready frame with a bare `res.write`,
// bypassing `recordSseStreamFrame` entirely. `sseStreamState` (sse-write.ts) attaches its terminal
// `close` listener lazily, on the FIRST recorded frame — a stream whose only write is the ready
// frame before it closes therefore never created that state at all, and never produced a terminal
// `sse.stream.closed` line: an operator could not even tell the attempt happened.
describe("writeReadyMessage (#3452 audit finding sse.ts:108)", () => {
  afterEach(() => {
    resetServerLogger();
  });

  function listenableFakeRes(): {
    res: import("node:http").ServerResponse;
    write: ReturnType<typeof vi.fn>;
    fireClose: () => void;
  } {
    const listeners = new Map<string, () => void>();
    const write = vi.fn().mockReturnValue(true);
    const res = {
      writableEnded: false,
      write,
      destroy: vi.fn(),
      on: (event: string, handler: () => void) => {
        listeners.set(event, handler);
      },
    } as unknown as import("node:http").ServerResponse;
    return { res, write, fireClose: () => listeners.get("close")?.() };
  }

  it("records the ready frame so a stream that closes right after it still gets a terminal sse.stream.closed line, carrying the supplied correlation id", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const { res, write, fireClose } = listenableFakeRes();

    const accepted = writeReadyMessage(res, "corr-ready-1");
    fireClose();

    expect(accepted).toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith("event: ready\ndata: {}\n\n");
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      category: "http",
      op: "sse.stream.closed",
      correlationId: "corr-ready-1",
      extra: { frameCount: 1, reason: "client-disconnected" },
    });
  });
});
