/**
 * Whether an abort reason is a Chat tool turn's deadline. The deadline signal is `AbortSignal.timeout`,
 * which aborts with a `TimeoutError`; a person's stop, a dropped request and an authority revocation
 * carry their own reasons. Which cause fired decides whether a deadline answers from the transcript or
 * a turn is cancelled, never a comparison of the wall clock with the deadline inside the timer's own
 * callback: that clock may read a millisecond short of a deadline whose signal has already fired
 * (#4355). A leaf module so the turn and its cancellation signal share one definition.
 */
export function isChatTurnDeadlineReason(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "TimeoutError";
}
