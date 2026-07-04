// GEN-PERF-CHAT-006: a backpressure kill (res.write -> false) must emit a distinct, observable signal
// exactly once BEFORE the socket is destroyed, so a slow-client termination is not silently relabeled
// as a user cancel. The signal must carry only non-secret counts (no body bytes) and an observer throw
// must never break the protective abort+destroy path.
import { describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { writeOrDestroy, type SseBackpressureSignal } from "./sse-write.js";

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
});
