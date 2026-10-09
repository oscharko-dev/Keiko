// Issue #1580 — poll only while the document is visible; the old fixed interval kept
// fetching/parsing forever in background tabs. Returning to visible does an immediate
// catch-up pull so multi-tab convergence is unchanged. Extracted from the sync effect to
// keep it inside the per-function line ceiling; `sync` is a stable reference so the effect
// can add and remove the same visibilitychange listener.
export function createVisibilityPoller(
  pull: () => void,
  intervalMs: number,
): { readonly start: () => void; readonly sync: () => void; readonly stop: () => void } {
  let interval: number | null = null;
  const start = (): void => {
    if (interval !== null || document.visibilityState === "hidden") return;
    interval = window.setInterval(pull, intervalMs);
  };
  const stop = (): void => {
    if (interval === null) return;
    window.clearInterval(interval);
    interval = null;
  };
  const sync = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      stop();
    } else {
      pull();
      start();
    }
  };
  return { start, sync, stop };
}
