import { createRollingWindowThrottle } from "../rollingWindowThrottle.js";

export interface DapRestartThrottle {
  mayStart(nowMs: number, debuggeeLaunched: boolean): boolean;
  attemptCount(): number;
}

// Permits at most two DAP launch attempts in a rolling 60s window, delegating the window/count
// bookkeeping to the shared rolling-window throttle primitive. Uses "drop-on-deny" semantics: a
// denied attempt's timestamp is not retained in the window (see rollingWindowThrottle.ts for why
// this differs from the LSP restart throttle's "retain-on-deny" semantics, and why that difference
// is deliberate rather than an oversight — KEIKO-0483). The `debuggeeLaunched` guard is DAP-specific
// and stays local rather than moving into the shared primitive.
export function createDapRestartThrottle(): DapRestartThrottle {
  const throttle = createRollingWindowThrottle(60_000, 2, "drop-on-deny");
  return {
    mayStart: (nowMs, debuggeeLaunched): boolean => {
      if (debuggeeLaunched) return false;
      return throttle.attempt(nowMs);
    },
    attemptCount: (): number => throttle.count(),
  };
}
