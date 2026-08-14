// Shared rolling-window rate-limit primitive for editor process-restart throttles (KEIKO-0483).
// Both the DAP restart throttle (dap/dapRestartThrottle.ts) and the LSP restart throttle
// (lsp/lspRestartThrottle.ts) need the same core bookkeeping — keep a trailing `windowMs` of
// attempt timestamps and deny once the count would exceed `maxInWindow` — but they were built
// independently under different ADR lineage (Issue #1381 / ADR-0069 D4 for LSP) and, while
// functionally equivalent for an isolated two-attempt burst, they diverge under SUSTAINED RAPID
// RETRIES because they disagree on whether a DENIED attempt's timestamp stays in the window:
//
//   - "drop-on-deny" (DAP's current behavior): a denied attempt's timestamp is never recorded.
//     The window only ever holds timestamps of PERMITTED attempts, so once the last permitted
//     attempt ages out of the window, the very next call is permitted again — repeated denied
//     retries do not extend the throttled period.
//   - "retain-on-deny" (LSP's current behavior): every attempt's timestamp is recorded, whether
//     permitted or not. A denied attempt keeps re-arming the window, so a caller that keeps
//     retrying through the throttle stays throttled for `windowMs` after its OWN last (denied)
//     attempt, not just after the last permitted one.
//
// Neither is "more correct" in the abstract: DAP wants a caller to be able to try again promptly
// once it has genuinely gone idle, while LSP deliberately keeps punishing a crash-looping process
// that keeps retrying through the throttle. Each call site keeps the semantics it already shipped
// — do not default one onto the other. See rollingWindowThrottle.test.ts for a test that replays
// the same call sequence against both semantics and asserts where they diverge.

export type RollingWindowDenySemantics = "drop-on-deny" | "retain-on-deny";

export interface RollingWindowThrottle {
  /** Records an attempt at `nowMs` and reports whether it is permitted within the rolling window. */
  attempt(nowMs: number): boolean;
  /** Current number of timestamps retained in the window (meaning depends on `semantics`, above). */
  count(): number;
}

/**
 * Creates a rolling-window attempt throttle: at most `maxInWindow` attempts are permitted within
 * any trailing `windowMs` interval. `semantics` selects whether a denied attempt's timestamp is
 * dropped or retained — see the module doc comment above for why the two are not interchangeable.
 */
export function createRollingWindowThrottle(
  windowMs: number,
  maxInWindow: number,
  semantics: RollingWindowDenySemantics,
): RollingWindowThrottle {
  const timestamps: number[] = [];

  const trim = (nowMs: number): void => {
    const cutoff = nowMs - windowMs;
    const retained = timestamps.filter((timestamp) => timestamp > cutoff);
    timestamps.length = 0;
    timestamps.push(...retained);
  };

  const attemptDropOnDeny = (nowMs: number): boolean => {
    trim(nowMs);
    if (timestamps.length >= maxInWindow) return false;
    timestamps.push(nowMs);
    return true;
  };

  const attemptRetainOnDeny = (nowMs: number): boolean => {
    timestamps.push(nowMs);
    trim(nowMs);
    return timestamps.length <= maxInWindow;
  };

  return {
    attempt: semantics === "drop-on-deny" ? attemptDropOnDeny : attemptRetainOnDeny,
    count: (): number => timestamps.length,
  };
}
