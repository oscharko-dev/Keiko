import { describe, expect, it } from "vitest";
import { createDapRestartThrottle } from "./dapRestartThrottle.js";

describe("dapRestartThrottle", () => {
  it("permits at most two startup attempts in a rolling minute", () => {
    const throttle = createDapRestartThrottle();
    expect(throttle.mayStart(0, false)).toBe(true);
    expect(throttle.mayStart(1, false)).toBe(true);
    expect(throttle.mayStart(2, false)).toBe(false);
    expect(throttle.attemptCount()).toBe(2);
    expect(throttle.mayStart(59_999, false)).toBe(false);
    expect(throttle.mayStart(60_000, false)).toBe(true);
    expect(throttle.attemptCount()).toBe(2);
  });

  it("never restarts after the debuggee launched", () => {
    const throttle = createDapRestartThrottle();
    expect(throttle.mayStart(0, true)).toBe(false);
    expect(throttle.attemptCount()).toBe(0);
  });
});
