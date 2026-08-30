// Pure rolling-window restart throttle for the LSP process manager (Issue #1381, ADR-0069 D4). A
// safely settled crash records a timestamp; the manager may restart while the number of settled
// crashes within the trailing `windowMs` stays below `maxInWindow`. An unsolicited root exit without
// descendant proof never reaches this helper: it remains durably quarantined. Once the window is
// saturated the manager transitions to RESTART_THROTTLED and stays down. The timestamp ring is pure
// injected-clock state which the owning manager persists and rehydrates across supervisor restarts.
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
  // Records a safely settled crash and reports whether a restart is permitted within the window.
  recordCrashAndMayRestart(nowMs: number): boolean;
  restartCount(): number;
  crashTimestamps(nowMs: number): readonly number[];
  isThrottled(nowMs: number): boolean;
}

export interface LspRestartThrottleSeed {
  readonly crashTimestampsMs: readonly number[];
  readonly restartCount: number;
}

const EMPTY_LSP_RESTART_THROTTLE_SEED = Object.freeze({
  crashTimestampsMs: Object.freeze([]),
  restartCount: 0,
}) satisfies LspRestartThrottleSeed;

export function createLspRestartThrottle(
  windowMs: number,
  maxInWindow: number,
  seed: LspRestartThrottleSeed = EMPTY_LSP_RESTART_THROTTLE_SEED,
): LspRestartThrottle {
  const throttle = createRollingWindowThrottle(windowMs, maxInWindow, "retain-on-deny");
  const timestamps = [...seed.crashTimestampsMs];
  for (const timestamp of timestamps) throttle.attempt(timestamp);
  let totalRestarts = seed.restartCount;

  const trim = (nowMs: number): void => {
    const cutoff = nowMs - windowMs;
    const retained = timestamps.filter((timestamp) => timestamp > cutoff);
    timestamps.length = 0;
    timestamps.push(...retained);
  };

  return {
    recordCrashAndMayRestart: (nowMs: number): boolean => {
      timestamps.push(nowMs);
      trim(nowMs);
      const permitted = throttle.attempt(nowMs);
      if (permitted) {
        totalRestarts += 1;
      }
      return permitted;
    },
    restartCount: (): number => totalRestarts,
    crashTimestamps: (nowMs): readonly number[] => {
      trim(nowMs);
      return [...timestamps];
    },
    isThrottled: (nowMs): boolean => {
      trim(nowMs);
      return timestamps.length > maxInWindow;
    },
  };
}
