// Pure rolling-window restart throttle for the LSP process manager (Issue #1381, ADR-0069 D4). A
// crash records a timestamp; the manager may restart while the number of crashes within the trailing
// `windowMs` stays below `maxInWindow`. Once the window is saturated the manager transitions to
// RESTART_THROTTLED and stays down. The state is a plain timestamp ring kept entirely in memory and
// driven by an injected clock so every branch is deterministically testable.
//
// Delegates the window/count bookkeeping to the shared rolling-window throttle primitive, using
// "retain-on-deny" semantics: a denied crash's timestamp stays in the window, so a process that
// keeps crash-looping through the throttle stays throttled for `windowMs` after its own last denied
// attempt, not just after its last permitted one — deliberately different from the DAP restart
// throttle's "drop-on-deny" semantics (see rollingWindowThrottle.ts and KEIKO-0483). `restartCount`
// is tracked separately here: it counts cumulative ALLOWED restarts, which is not the same thing as
// the shared primitive's window size (which, under retain-on-deny, also includes denied attempts).

import { createRollingWindowThrottle } from "../rollingWindowThrottle.js";

export interface LspRestartThrottle {
  // Records a crash at `nowMs` and reports whether a restart is still permitted within the window.
  recordCrashAndMayRestart(nowMs: number): boolean;
  restartCount(): number;
}

export function createLspRestartThrottle(
  windowMs: number,
  maxInWindow: number,
): LspRestartThrottle {
  const throttle = createRollingWindowThrottle(windowMs, maxInWindow, "retain-on-deny");
  let totalRestarts = 0;

  return {
    recordCrashAndMayRestart: (nowMs: number): boolean => {
      const permitted = throttle.attempt(nowMs);
      if (permitted) {
        totalRestarts += 1;
      }
      return permitted;
    },
    restartCount: (): number => totalRestarts,
  };
}
