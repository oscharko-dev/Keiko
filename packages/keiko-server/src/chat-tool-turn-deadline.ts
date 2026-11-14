/**
 * The deadline of a Chat tool turn is a signal, and what ended a turn is told by WHICH signal fired,
 * never by comparing the wall clock with the deadline inside the timer's own callback: that clock may
 * read a millisecond short of a deadline whose signal has already fired (#4355). A leaf module so the
 * turn, its cancellation signal and the catalog settlement share one definition.
 *
 * The turn's deadline signal is made here, and the reason it aborts with is remembered by identity. A
 * `TimeoutError` that comes from anything else (a per-call or provider timeout that surfaces on a
 * signal) is therefore never mistaken for the turn's own deadline.
 */
const DEADLINE_REASONS = new WeakSet();

/** `AbortSignal.timeout` whose abort reason is recorded as the turn's deadline. */
export function chatTurnDeadlineSignal(milliseconds: number): AbortSignal {
  const signal = AbortSignal.timeout(milliseconds);
  signal.addEventListener(
    "abort",
    () => {
      const { reason } = signal as { readonly reason: unknown };
      if (typeof reason === "object" && reason !== null) DEADLINE_REASONS.add(reason);
    },
    { once: true },
  );
  return signal;
}

/** Whether this abort reason is the deadline of a Chat tool turn, by identity. */
export function isChatTurnDeadlineReason(reason: unknown): boolean {
  return typeof reason === "object" && reason !== null && DEADLINE_REASONS.has(reason);
}
