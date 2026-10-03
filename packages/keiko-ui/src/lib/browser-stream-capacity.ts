"use client";

import { reportClientDiagnostic } from "./client-diagnostics";

type CapacityListener = (backgroundStreamsSuspended: boolean) => void;

const listeners = new Set<CapacityListener>();
let interactiveReservations = 0;

export function backgroundBrowserStreamsSuspended(): boolean {
  return interactiveReservations > 0;
}

function notifyCapacityChange(): void {
  const suspended = backgroundBrowserStreamsSuspended();
  for (const listener of listeners) listener(suspended);
}

/**
 * Reserve HTTP/1.1 connection capacity for an interactive, long-lived workflow.
 *
 * Browsers commonly allow only six parallel connections per origin. Editor metadata streams are
 * recoverable and can yield while a coding run needs runtime/activity streams plus ordinary API
 * requests. The returned release callback is idempotent.
 */
export function reserveInteractiveBrowserStreamCapacity(): () => void {
  interactiveReservations += 1;
  if (interactiveReservations === 1) notifyCapacityChange();
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    interactiveReservations = Math.max(0, interactiveReservations - 1);
    if (interactiveReservations === 0) notifyCapacityChange();
  };
}

export function subscribeBrowserStreamCapacity(listener: CapacityListener): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function resetBrowserStreamCapacityForTests(): void {
  interactiveReservations = 0;
  listeners.clear();
  nextPersistentSlot = 0;
  unsupportedCapacityReported = false;
  originCapacityReported = false;
}

const PERSISTENT_STREAM_SLOTS = 3;
const PERSISTENT_STREAM_LEASE_MS = 5_000;
const STREAM_ACQUISITION_TIMEOUT_MS = 15_000;
let nextPersistentSlot = 0;
let unsupportedCapacityReported = false;
let originCapacityReported = false;

/** Hold an origin-wide slot before opening a persistent HTTP connection. */
export function acquirePersistentBrowserStreamCapacity(
  onGranted: () => void,
  onReleased: (reason: "expired" | "cancelled" | "unavailable") => void,
): () => void {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks === undefined) {
    reportUnsupportedCapacity();
    return () => undefined;
  }
  reportOriginCapacity();
  const slot = nextPersistentSlot++ % PERSISTENT_STREAM_SLOTS;
  const abort = new AbortController();
  let ended = false;
  let finishLease: (() => void) | undefined;
  const release = (reason: "expired" | "cancelled" | "unavailable"): void => {
    if (ended) return;
    ended = true;
    abort.abort();
    window.clearTimeout(acquisitionTimer);
    if (reason === "unavailable") {
      reportClientDiagnostic("[keiko] persistent stream origin capacity acquisition unavailable");
    }
    onReleased(reason);
    finishLease?.();
  };
  const acquisitionTimer = window.setTimeout(
    () => release("unavailable"),
    STREAM_ACQUISITION_TIMEOUT_MS,
  );
  void locks
    .request(`keiko:persistent-stream:${String(slot)}`, { signal: abort.signal }, async () => {
      if (ended) return;
      window.clearTimeout(acquisitionTimer);
      const held = new Promise<void>((resolve) => {
        finishLease = resolve;
      });
      const leaseTimer = window.setTimeout(() => release("expired"), PERSISTENT_STREAM_LEASE_MS);
      try {
        onGranted();
        await held;
      } finally {
        window.clearTimeout(leaseTimer);
        release("cancelled");
      }
    })
    .catch(() => release("unavailable"));
  return () => release("cancelled");
}

function reportUnsupportedCapacity(): void {
  if (unsupportedCapacityReported) return;
  unsupportedCapacityReported = true;
  reportClientDiagnostic("[keiko] persistent streams unavailable: origin capacity unsupported");
}

function reportOriginCapacity(): void {
  if (originCapacityReported) return;
  originCapacityReported = true;
  reportClientDiagnostic("[keiko] persistent stream origin budget active (limit=3, lease-ms=5000)");
}
