import { describe, expect, it } from "vitest";

import { createLspRestartThrottle } from "./lspRestartThrottle.js";

// Direct unit tests for the rolling-window restart throttle (Issue #1381, ADR-0069 D4). These pin the
// `> maxInWindow` boundary so a `>=` mutation is caught, and the window-edge inclusivity (`> cutoff`),
// using an injected clock — no wall-clock waits.
describe("createLspRestartThrottle", () => {
  it("permits the first crash and throttles the second when maxInWindow is 1", () => {
    const throttle = createLspRestartThrottle(1_000, 1);

    expect(throttle.recordCrashAndMayRestart(0)).toBe(true);
    expect(throttle.restartCount()).toBe(1);
    // Second crash within the window: count becomes 2 > maxInWindow(1) → throttled.
    expect(throttle.recordCrashAndMayRestart(10)).toBe(false);
    // A throttled crash does not increment the restart count.
    expect(throttle.restartCount()).toBe(1);
  });

  it("does not throttle a second crash once the first has aged out of the window", () => {
    const windowMs = 1_000;
    const throttle = createLspRestartThrottle(windowMs, 1);

    expect(throttle.recordCrashAndMayRestart(0)).toBe(true);
    // At t = windowMs the first crash (t=0) is at the cutoff (0 > 0 is false), so it is dropped from
    // the window; only this crash remains → 1, not > maxInWindow(1) → still permitted.
    expect(throttle.recordCrashAndMayRestart(windowMs)).toBe(true);
    expect(throttle.restartCount()).toBe(2);
  });

  it("throttles a second crash that lands strictly inside the window edge", () => {
    const windowMs = 1_000;
    const throttle = createLspRestartThrottle(windowMs, 1);

    expect(throttle.recordCrashAndMayRestart(0)).toBe(true);
    // At t = windowMs - 1 the first crash (t=0) is still inside (0 > -1) → 2 crashes → throttled.
    expect(throttle.recordCrashAndMayRestart(windowMs - 1)).toBe(false);
  });

  it("throttles the very first crash when maxInWindow is 0", () => {
    const throttle = createLspRestartThrottle(1_000, 0);

    // One crash → count 1 > maxInWindow(0) → immediately throttled, no restart recorded.
    expect(throttle.recordCrashAndMayRestart(0)).toBe(false);
    expect(throttle.restartCount()).toBe(0);
  });

  it("permits up to maxInWindow crashes then throttles the next", () => {
    const throttle = createLspRestartThrottle(10_000, 2);

    expect(throttle.recordCrashAndMayRestart(0)).toBe(true);
    expect(throttle.recordCrashAndMayRestart(1)).toBe(true);
    // Third crash within the window: 3 > 2 → throttled.
    expect(throttle.recordCrashAndMayRestart(2)).toBe(false);
    expect(throttle.restartCount()).toBe(2);
  });
});
