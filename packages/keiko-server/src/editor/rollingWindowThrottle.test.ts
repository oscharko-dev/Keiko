import { describe, expect, it } from "vitest";

import { createRollingWindowThrottle } from "./rollingWindowThrottle.js";

// Direct unit tests for the shared rolling-window throttle primitive (KEIKO-0483). These cover both
// documented boundary semantics independently, plus a test that replays one call sequence against
// both semantics side by side to make the divergence explicit and independently verifiable outside
// of either DAP's or LSP's own wrapper/call sites.
describe("createRollingWindowThrottle", () => {
  describe("drop-on-deny semantics", () => {
    it("permits at most maxInWindow attempts in the rolling window", () => {
      const throttle = createRollingWindowThrottle(60_000, 2, "drop-on-deny");

      expect(throttle.attempt(0)).toBe(true);
      expect(throttle.attempt(1)).toBe(true);
      expect(throttle.attempt(2)).toBe(false);
      expect(throttle.count()).toBe(2);
    });

    it("does not retain a denied attempt's timestamp in the window", () => {
      const throttle = createRollingWindowThrottle(1_000, 2, "drop-on-deny");

      expect(throttle.attempt(0)).toBe(true);
      expect(throttle.attempt(1)).toBe(true);
      // Denied: window already holds 2 permitted attempts. Its timestamp (2) must NOT be retained.
      expect(throttle.attempt(2)).toBe(false);
      expect(throttle.count()).toBe(2);

      // At t=1000 the cutoff is 0: the first permitted attempt (0) has aged out (0 > 0 is false),
      // and the denied attempt (2) was never recorded at all, so only the second permitted attempt
      // (1) remains — count 1, below maxInWindow — and this attempt is permitted again.
      expect(throttle.attempt(1_000)).toBe(true);
      expect(throttle.count()).toBe(2);
    });

    it("permits again once the last permitted attempt has aged out at the window boundary", () => {
      const throttle = createRollingWindowThrottle(60_000, 2, "drop-on-deny");

      expect(throttle.attempt(0)).toBe(true);
      expect(throttle.attempt(1)).toBe(true);
      expect(throttle.attempt(59_999)).toBe(false);
      expect(throttle.attempt(60_000)).toBe(true);
      expect(throttle.count()).toBe(2);
    });
  });

  describe("retain-on-deny semantics", () => {
    it("permits at most maxInWindow attempts in the rolling window", () => {
      const throttle = createRollingWindowThrottle(10_000, 2, "retain-on-deny");

      expect(throttle.attempt(0)).toBe(true);
      expect(throttle.attempt(1)).toBe(true);
      expect(throttle.attempt(2)).toBe(false);
      expect(throttle.count()).toBe(3);
    });

    it("retains a denied attempt's timestamp, keeping the window saturated past when a drop-on-deny throttle would have recovered", () => {
      const throttle = createRollingWindowThrottle(1_000, 2, "retain-on-deny");

      expect(throttle.attempt(0)).toBe(true);
      expect(throttle.attempt(1)).toBe(true);
      // Denied, but its timestamp (2) IS retained (unlike drop-on-deny, above).
      expect(throttle.attempt(2)).toBe(false);

      // At t=1000 the cutoff is 0: t=0 has aged out (0 > 0 is false), but t=1 and the retained
      // denied t=2 are both still in-window, and this new attempt joins them — 3 entries, still
      // saturated, so this attempt is ALSO denied.
      expect(throttle.attempt(1_000)).toBe(false);
      expect(throttle.count()).toBe(3);
    });
  });

  // The central regression pin for KEIKO-0483: the same call sequence against the same windowMs
  // and maxInWindow, differing only in `semantics`, must diverge at the fourth call. This is the
  // sequence lspRestartThrottle.test.ts pins against the real LSP wrapper (retain-on-deny); this
  // test proves independently, at the primitive level, that swapping to drop-on-deny changes the
  // outcome — i.e. that the two semantics are genuinely distinct and neither one silently subsumes
  // the other.
  it("diverges between drop-on-deny and retain-on-deny under sustained rapid retries", () => {
    const windowMs = 1_000;
    const maxInWindow = 2;
    const callTimes = [0, 1, 2, windowMs];

    const dropOnDeny = createRollingWindowThrottle(windowMs, maxInWindow, "drop-on-deny");
    const retainOnDeny = createRollingWindowThrottle(windowMs, maxInWindow, "retain-on-deny");

    const dropResults = callTimes.map((nowMs) => dropOnDeny.attempt(nowMs));
    const retainResults = callTimes.map((nowMs) => retainOnDeny.attempt(nowMs));

    // Both semantics agree on the first three calls: two permitted, then denied once saturated.
    expect(dropResults.slice(0, 3)).toEqual([true, true, false]);
    expect(retainResults.slice(0, 3)).toEqual([true, true, false]);

    // They diverge on the fourth call: drop-on-deny has already forgotten the throttled attempt and
    // both permitted ones have aged out, so it permits; retain-on-deny still remembers the throttled
    // attempt's timestamp, so it stays denied.
    expect(dropResults[3]).toBe(true);
    expect(retainResults[3]).toBe(false);
  });
});
