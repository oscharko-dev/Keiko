// Quality Intelligence cancellation composition (Epic #270, Issue #279).
//
// Composes an external AbortSignal with an internal profile-timeout into a single effective
// signal. The dispatcher hands the resulting signal to the underlying ModelPort so it can
// abort the in-flight call on EITHER the timeout firing OR the external signal aborting.
// No timers leak: the caller MUST invoke `dispose()` once the call settles.

export interface QualityIntelligenceCancellationHandle {
  readonly signal: AbortSignal;
  readonly reasonKind: () => "timeout" | "external" | "none";
  readonly dispose: () => void;
}

interface InternalReason {
  kind: "timeout" | "external" | "none";
}

function attachExternal(
  external: AbortSignal | undefined,
  controller: AbortController,
  reason: InternalReason,
): () => void {
  if (external === undefined) {
    return () => {
      /* nothing to detach */
    };
  }
  if (external.aborted) {
    reason.kind = "external";
    controller.abort();
    return () => {
      /* already aborted */
    };
  }
  const onAbort = (): void => {
    reason.kind = "external";
    controller.abort();
  };
  external.addEventListener("abort", onAbort, { once: true });
  return () => {
    external.removeEventListener("abort", onAbort);
  };
}

function attachTimeout(
  timeoutMs: number,
  controller: AbortController,
  reason: InternalReason,
): () => void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return () => {
      /* no timeout requested */
    };
  }
  const timer = setTimeout(() => {
    if (reason.kind === "none") {
      reason.kind = "timeout";
    }
    controller.abort();
  }, timeoutMs);
  return () => {
    clearTimeout(timer);
  };
}

export function composeCancellationSignal(
  timeoutMs: number,
  external: AbortSignal | undefined,
): QualityIntelligenceCancellationHandle {
  const controller = new AbortController();
  const reason: InternalReason = { kind: "none" };
  const detachExternal = attachExternal(external, controller, reason);
  const detachTimeout = attachTimeout(timeoutMs, controller, reason);

  return Object.freeze({
    signal: controller.signal,
    reasonKind: () => reason.kind,
    dispose: () => {
      detachTimeout();
      detachExternal();
    },
  });
}
