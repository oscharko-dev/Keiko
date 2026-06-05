// Cancellation bridge between the harness AbortSignal world and the QI dispatcher
// (Epic #270, Issue #273, ADR-0023 D6).
//
// The harness threads a single AbortSignal through workflows. The QI dispatcher
// (#279) accepts an optional AbortSignal too. This adapter is a thin helper that
// composes a parent signal with a per-stage AbortController so an individual
// stage can be cancelled without disturbing the rest of the run. No timers; no
// IO; pure DOM/Node primitives only.

export interface QualityIntelligenceStageCancellationHandle {
  readonly signal: AbortSignal;
  readonly cancel: (reason?: string) => void;
  readonly dispose: () => void;
}

/**
 * Compose a parent cancellation signal with a freshly minted stage controller.
 * If the parent is already aborted, the returned signal is aborted immediately.
 * The handle's `dispose()` MUST be called once the stage finishes so the parent
 * listener is removed (otherwise long-running runs leak DOM listeners across
 * stages on the same parent signal).
 */
export function composeStageCancellation(
  parent: AbortSignal | undefined,
): QualityIntelligenceStageCancellationHandle {
  const controller = new AbortController();
  if (parent !== undefined) {
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      const onParentAbort = (): void => {
        controller.abort(parent.reason);
      };
      parent.addEventListener("abort", onParentAbort, { once: true });
      return Object.freeze({
        signal: controller.signal,
        cancel: (reason?: string): void => {
          controller.abort(reason);
        },
        dispose: (): void => {
          parent.removeEventListener("abort", onParentAbort);
        },
      });
    }
  }
  return Object.freeze({
    signal: controller.signal,
    cancel: (reason?: string): void => {
      controller.abort(reason);
    },
    dispose: (): void => {
      /* no parent listener was attached */
    },
  });
}

/**
 * Returns true when the supplied signal has been aborted. Pure helper around
 * the standard DOM property so the run entries do not sprinkle the property
 * access at every cooperative cancellation check.
 */
export function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
