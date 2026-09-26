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

  // KEIKO-0483: pins LSP's "retain-on-deny" boundary semantics — a throttled crash's timestamp
  // stays in the window instead of being dropped, unlike the DAP restart throttle's "drop-on-deny"
  // semantics (dapRestartThrottle.ts). The two are equivalent for an isolated two-attempt burst but
  // diverge under sustained rapid retries. This sequence proves the divergence: two crashes are
  // permitted, a third (rapid) crash is throttled, then the clock advances to t = windowMs — the
  // instant by which a drop-on-deny throttle configured identically would have (a) aged both
  // permitted crashes (t=0, t=1) out of its window and (b) never recorded the throttled crash (t=2)
  // at all, so it would permit a fourth call (see rollingWindowThrottle.test.ts, which replays this
  // exact sequence against both semantics side by side and asserts the divergence directly). LSP's
  // real, retain-on-deny throttle instead kept the throttled crash's timestamp (t=2) in the window
  // the whole time, so at t=windowMs it is still in-window (2 > 1000-1000=0) alongside the fourth
  // attempt itself, saturating the window again — the fourth call must still be denied. If a future
  // refactor silently rewires LSP onto drop-on-deny, this assertion flips to `true` and fails.
  it("stays throttled by a retained denied crash after the permitted crashes have aged out", () => {
    const windowMs = 1_000;
    const throttle = createLspRestartThrottle(windowMs, 2);

    expect(throttle.recordCrashAndMayRestart(0)).toBe(true);
    expect(throttle.recordCrashAndMayRestart(1)).toBe(true);
    // Third crash within the window: 3 > 2 → throttled, but its timestamp (2) is retained.
    expect(throttle.recordCrashAndMayRestart(2)).toBe(false);
    // Fourth crash at t = windowMs: cutoff is 0, so only t=0 has aged out (0 > 0 is false); t=1,
    // t=2 (the throttled one), and the new t=1000 are all still in-window ([1, 2, 1000], length 3),
    // which is > maxInWindow(2) → still denied.
    expect(throttle.recordCrashAndMayRestart(windowMs)).toBe(false);
    expect(throttle.restartCount()).toBe(2);
  });

  it("restores a throttled rolling window across a supervisor restart", () => {
    const beforeRestart = createLspRestartThrottle(1_000, 2);
    expect(beforeRestart.recordCrashAndMayRestart(10)).toBe(true);
    expect(beforeRestart.recordCrashAndMayRestart(20)).toBe(true);
    expect(beforeRestart.recordCrashAndMayRestart(30)).toBe(false);

    const afterRestart = createLspRestartThrottle(1_000, 2, {
      crashTimestampsMs: beforeRestart.crashTimestamps(40),
      restartCount: beforeRestart.restartCount(),
    });
    expect(afterRestart.isThrottled(40)).toBe(true);
    expect(afterRestart.restartCount()).toBe(2);
    expect(afterRestart.crashTimestamps(40)).toEqual([10, 20, 30]);
  });

  it("expires restored throttle history only at the governed rolling-window boundary", () => {
    const restored = createLspRestartThrottle(1_000, 1, {
      crashTimestampsMs: [10, 20],
      restartCount: 1,
    });

    expect(restored.isThrottled(1_009)).toBe(true);
    expect(restored.isThrottled(1_020)).toBe(false);
    expect(restored.crashTimestamps(1_020)).toEqual([]);
  });
});
