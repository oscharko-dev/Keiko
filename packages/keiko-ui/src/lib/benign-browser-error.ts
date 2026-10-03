// These exact producer-owned notifications describe a deferred resize delivery or a cancelled
// Monaco operation, not a failed user operation. Other cancellations and lookalike prose remain
// actionable. Classification happens locally; no browser message is sent to diagnostics.
export function isMonacoCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "Canceled" && error.message === "Canceled";
}

export function isBenignWindowNotification(event: ErrorEvent): boolean {
  if (isMonacoCancellation(event.error)) return true;
  return (
    event.error === null &&
    (event.message === "ResizeObserver loop completed with undelivered notifications." ||
      event.message === "ResizeObserver loop limit exceeded")
  );
}
