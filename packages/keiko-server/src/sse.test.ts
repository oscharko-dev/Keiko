import { describe, expect, it, vi } from "vitest";
import { SSE_HEADERS, startSseHeartbeat } from "./sse.js";

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
});
