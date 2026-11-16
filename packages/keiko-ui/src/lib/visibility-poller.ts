// Issue #1580 — poll only while the document is visible; the old fixed interval kept
// fetching/parsing forever in background tabs. Returning to visible does an immediate
// catch-up pull so multi-tab convergence is unchanged. Extracted from the sync effect to
// keep it inside the per-function line ceiling; `sync` is a stable reference so the effect
// can add and remove the same visibilitychange listener.
export function createVisibilityPoller(
  pull: () => void,
  intervalMs: number | (() => number),
): {
  readonly start: () => void;
  readonly sync: () => void;
  readonly stop: () => void;
  readonly reset: () => void;
} {
  let interval: number | null = null;
  let generation = 0;
  const run = (): void => {
    const current = generation;
    pull();
    if (current === generation) start();
  };
  const tick = (): void => {
    interval = null;
    run();
  };
  const start = (): void => {
    if (interval !== null || document.visibilityState === "hidden") return;
    interval =
      typeof intervalMs === "number"
        ? window.setInterval(pull, intervalMs)
        : window.setTimeout(tick, intervalMs());
  };
  const stop = (): void => {
    generation += 1;
    if (interval === null) return;
    if (typeof intervalMs === "number") window.clearInterval(interval);
    else window.clearTimeout(interval);
    interval = null;
  };
  const reset = (): void => {
    stop();
    start();
  };
  const sync = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      stop();
    } else {
      run();
    }
  };
  return { start, sync, stop, reset };
}
