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
}

const PERSISTENT_STREAM_SLOTS = 3;
const PERSISTENT_STREAM_LEASE_MS = 5_000;
const STREAM_ACQUISITION_TIMEOUT_MS = 15_000;
let nextPersistentSlot = 0;
let unsupportedCapacityReported = false;

interface PersistentCapacityOptions {
  readonly yieldable?: boolean;
  readonly correlationId?: string;
}

type PersistentReleaseReason = "expired" | "cancelled" | "unavailable";

interface PersistentLease {
  readonly abort: AbortController;
  readonly onGranted: () => void;
  readonly onReleased: (reason: PersistentReleaseReason) => void;
  readonly options: PersistentCapacityOptions;
  ended: boolean;
  granted: boolean;
  waiterQueryFailed: boolean;
  acquisitionTimer: number;
  leaseTimer: number | undefined;
  finish: (() => void) | undefined;
}

function releaseLease(lease: PersistentLease, reason: PersistentReleaseReason): void {
  if (lease.ended) return;
  lease.ended = true;
  lease.abort.abort();
  window.clearTimeout(lease.acquisitionTimer);
  window.clearTimeout(lease.leaseTimer);
  if (reason === "unavailable") {
    reportClientDiagnostic("[keiko] persistent stream origin capacity acquisition unavailable", {
      correlationId: lease.options.correlationId,
      errorKind: "timeout",
    });
  }
  lease.onReleased(reason);
  lease.finish?.();
}

async function checkLeaseWaiters(
  locks: LockManager,
  name: string,
  lease: PersistentLease,
): Promise<void> {
  if (lease.ended || lease.options.yieldable === false) return;
  try {
    const snapshot = await locks.query();
    lease.waiterQueryFailed = false;
    if (snapshot.pending?.some((pending) => pending.name === name)) releaseLease(lease, "expired");
  } catch {
    if (lease.ended || lease.waiterQueryFailed) return;
    lease.waiterQueryFailed = true;
    reportClientDiagnostic("[keiko] persistent stream contention query unavailable", {
      correlationId: lease.options.correlationId,
      errorKind: "unavailable",
    });
  }
}

async function holdLease(locks: LockManager, name: string, lease: PersistentLease): Promise<void> {
  const held = new Promise<void>((resolve) => {
    lease.finish = resolve;
  });
  if (lease.options.yieldable !== false) {
    lease.leaseTimer = window.setInterval(() => {
      void checkLeaseWaiters(locks, name, lease);
    }, PERSISTENT_STREAM_LEASE_MS);
  }
  window.clearTimeout(lease.acquisitionTimer);
  lease.onGranted();
  await held;
}

function probeSlot(locks: LockManager, name: string, lease: PersistentLease): Promise<boolean> {
  return new Promise((resolve) => {
    void locks
      .request(name, { ifAvailable: true }, async (lock) => {
        if (lock === null || lease.ended || lease.granted) {
          resolve(false);
          return;
        }
        lease.granted = true;
        resolve(true);
        await holdLease(locks, name, lease);
      })
      .catch(() => resolve(false));
  });
}

async function leastContendedSlot(locks: LockManager, names: readonly string[]): Promise<string> {
  const snapshot = await locks.query();
  return (
    [...names].sort((left, right) => {
      const count = (name: string): number =>
        snapshot.pending?.filter((lock) => lock.name === name).length ?? 0;
      return count(left) - count(right);
    })[0] ??
    names[0] ??
    "keiko:persistent-stream:0"
  );
}

async function requestLease(locks: LockManager, lease: PersistentLease): Promise<void> {
  const start = nextPersistentSlot++ % PERSISTENT_STREAM_SLOTS;
  const names = Array.from(
    { length: PERSISTENT_STREAM_SLOTS },
    (_, offset) => `keiko:persistent-stream:${String((start + offset) % PERSISTENT_STREAM_SLOTS)}`,
  );
  for (const name of names) if (await probeSlot(locks, name, lease)) return;
  if (lease.ended) return;
  const name = await leastContendedSlot(locks, names);
  await locks.request(name, { signal: lease.abort.signal }, async () => {
    if (lease.ended) return;
    lease.granted = true;
    await holdLease(locks, name, lease);
  });
}

/** Hold any free origin slot; healthy non-replayable connections never yield for capacity. */
export function acquirePersistentBrowserStreamCapacity(
  onGranted: () => void,
  onReleased: (reason: PersistentReleaseReason) => void,
  options: PersistentCapacityOptions = {},
): () => void {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks === undefined) {
    reportUnsupportedCapacity();
    return () => undefined;
  }
  const lease: PersistentLease = {
    abort: new AbortController(),
    onGranted,
    onReleased,
    options,
    ended: false,
    granted: false,
    waiterQueryFailed: false,
    acquisitionTimer: 0,
    leaseTimer: undefined,
    finish: undefined,
  };
  lease.acquisitionTimer = window.setTimeout(
    () => releaseLease(lease, "unavailable"),
    STREAM_ACQUISITION_TIMEOUT_MS,
  );
  void requestLease(locks, lease).catch(() => releaseLease(lease, "unavailable"));
  return () => releaseLease(lease, "cancelled");
}

function reportUnsupportedCapacity(): void {
  if (unsupportedCapacityReported) return;
  unsupportedCapacityReported = true;
  reportClientDiagnostic("[keiko] persistent streams unavailable: origin capacity unsupported");
}
