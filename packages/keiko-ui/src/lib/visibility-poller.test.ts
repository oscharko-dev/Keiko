import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVisibilityPoller } from "./visibility-poller";

function setVisible(visible: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: visible ? "visible" : "hidden",
  });
}

describe("visibility polling cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisible(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisible(true);
  });

  it("preserves a constant consumer's interval phase and immediate visibility catch-up", () => {
    const started: number[] = [];
    const origin = Date.now();
    const poller = createVisibilityPoller(() => {
      started.push(Date.now() - origin);
    }, 2_000);
    poller.start();
    vi.advanceTimersByTime(1_000);
    poller.sync();
    vi.advanceTimersByTime(1_000);
    expect(started).toEqual([1_000, 2_000]);
    setVisible(false);
    poller.sync();
    vi.advanceTimersByTime(6_000);
    expect(started).toHaveLength(2);
    setVisible(true);
    poller.sync();
    expect(started.at(-1)).toBe(8_000);
    poller.stop();
    vi.advanceTimersByTime(6_000);
    expect(started).toHaveLength(3);
  });

  it("re-arms a dynamic cadence without a second pull and never arms while hidden", () => {
    let delay = 6_000;
    const pull = vi.fn();
    const poller = createVisibilityPoller(pull, () => delay);
    poller.sync();
    vi.advanceTimersByTime(1_000);
    delay = 1_500;
    poller.reset();
    expect(pull).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_499);
    expect(pull).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(pull).toHaveBeenCalledTimes(2);
    setVisible(false);
    poller.sync();
    poller.reset();
    vi.advanceTimersByTime(20_000);
    expect(pull).toHaveBeenCalledTimes(2);
    poller.stop();
  });
  it.each(["tick", "sync"])(
    "does not resurrect a dynamic timer stopped by its %s callback",
    (trigger) => {
      let poller: ReturnType<typeof createVisibilityPoller>;
      const pull = vi.fn(() => {
        poller.stop();
      });
      poller = createVisibilityPoller(pull, () => 1_500);
      if (trigger === "sync") poller.sync();
      else {
        poller.start();
        vi.advanceTimersByTime(1_500);
      }
      expect(pull).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(10_000);
      expect(pull).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
