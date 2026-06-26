// Pure rolling-window restart throttle for the LSP process manager (Issue #1381, ADR-0069 D4). A
// crash records a timestamp; the manager may restart while the number of crashes within the trailing
// `windowMs` stays below `maxInWindow`. Once the window is saturated the manager transitions to
// RESTART_THROTTLED and stays down. The state is a plain timestamp ring kept entirely in memory and
// driven by an injected clock so every branch is deterministically testable.

export interface LspRestartThrottle {
  // Records a crash at `nowMs` and reports whether a restart is still permitted within the window.
  recordCrashAndMayRestart(nowMs: number): boolean;
  restartCount(): number;
}

export function createLspRestartThrottle(
  windowMs: number,
  maxInWindow: number,
): LspRestartThrottle {
  const crashes: number[] = [];
  let totalRestarts = 0;

  return {
    recordCrashAndMayRestart: (nowMs: number): boolean => {
      crashes.push(nowMs);
      const cutoff = nowMs - windowMs;
      const withinWindow = crashes.filter((timestamp) => timestamp > cutoff);
      crashes.length = 0;
      crashes.push(...withinWindow);
      if (withinWindow.length > maxInWindow) {
        return false;
      }
      totalRestarts += 1;
      return true;
    },
    restartCount: (): number => totalRestarts,
  };
}
