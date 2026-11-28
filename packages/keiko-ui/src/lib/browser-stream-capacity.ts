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

// A browser allows six HTTP/1.1 connections per origin. Persistent streams may hold four of them;
// the other two stay free so a finite read (a run status read, readiness, a snapshot) never queues
// behind streams until its own deadline expires (U-37). The ceiling is enforced at admission by an
// origin-wide Web Locks pool shared by every document of the origin: the shared event-source pool
// and every direct stream take a lease before they open a connection.
export const PERSISTENT_STREAM_CONNECTION_CEILING = 4;
// What the shared pool may hold when nothing else is open.
const SHARED_STREAM_CONNECTIONS = 3;
// Direct streams and the shared pool draw from the same lock names, so together they never exceed
// the ceiling; the shared pool only ever uses the first SHARED_STREAM_CONNECTIONS of them.
let directStreams = 0;
let admittedDirectStreams = 0;

/**
 * `essential` streams (the Workbench run streams, the viewed run's events, editor verification)
 * never yield their slot. `background` streams (relationship activity, the editor agent, Browser)
 * give theirs up when an essential stream waits, so an essential stream always opens eventually.
 */
export type DirectStreamPriority = "essential" | "background";

export interface DirectStreamOptions {
  readonly priority?: DirectStreamPriority;
  /** A background stream lost its slot to an essential one: close the connection. */
  readonly onYield?: () => void;
  readonly correlationId?: string;
}

const DIRECT_RETRY_INITIAL_MS = 1_000;
const DIRECT_RETRY_MAX_MS = 30_000;

function directRetryDelay(attempt: number): number {
  return Math.min(DIRECT_RETRY_MAX_MS, DIRECT_RETRY_INITIAL_MS * 2 ** attempt);
}

interface DirectSlotRequest {
  readonly admit: () => void;
  readonly lose: () => void;
  readonly background: boolean;
  readonly correlationId: string | undefined;
}

function requestDirectSlot(request: DirectSlotRequest): () => void {
  if (typeof navigator === "undefined" || navigator.locks === undefined) {
    if (admittedDirectStreams >= PERSISTENT_STREAM_CONNECTION_CEILING) {
      request.lose();
    } else {
      reportUnsupportedCapacity();
      request.admit();
    }
    return () => undefined;
  }
  return acquirePersistentBrowserStreamCapacity(
    request.admit,
    (reason) => {
      if (reason !== "cancelled") request.lose();
    },
    {
      yieldable: request.background,
      waitOnEverySlot: !request.background,
      slots: PERSISTENT_STREAM_CONNECTION_CEILING,
      ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
    },
  );
}

interface DirectStreamState {
  settled: boolean;
  admitted: boolean;
  attempt: number;
  retryTimer: number | undefined;
  releaseLease: () => void;
}

function setDirectAdmitted(state: DirectStreamState, value: boolean): void {
  if (state.admitted === value) return;
  state.admitted = value;
  admittedDirectStreams = Math.max(0, admittedDirectStreams + (value ? 1 : -1));
}

function releaseDirectStream(state: DirectStreamState): void {
  if (state.settled) return;
  state.settled = true;
  window.clearTimeout(state.retryTimer);
  setDirectAdmitted(state, false);
  directStreams = Math.max(0, directStreams - 1);
  notifyCapacityChange();
  state.releaseLease();
}

/** A direct stream's slot: `active` while it awaits or holds a slot; `release` gives it up. */
export interface DirectStreamAdmission {
  readonly active: boolean;
  readonly release: () => void;
}

/**
 * Admit a long-lived stream that opens its own connection outside the shared stream pool (the run
 * event stream, the Workbench streams, the Browser and editor streams). The stream may open only
 * after `onAdmitted` runs: it holds one of the origin's persistent connection slots until the
 * returned admission is released, so no mix of documents and widgets can take more than
 * {@link PERSISTENT_STREAM_CONNECTION_CEILING} connections. Admission never gives up: while no slot
 * is free the request is repeated on a bounded backoff until it is granted or released, and a
 * background stream that yielded its slot (`onYield`) asks for one again, so `onAdmitted` may run
 * several times. The shared pool gives up its slots at once while a direct stream is pending or
 * admitted. Without Web Locks the ceiling is enforced for this document only, and a callback may
 * run before this function returns, so callers test `active` rather than a stored handle.
 * `release` is idempotent and also cancels a pending admission.
 */
export function admitDirectBrowserStream(
  onAdmitted: () => void,
  options: DirectStreamOptions = {},
): DirectStreamAdmission {
  directStreams += 1;
  notifyCapacityChange();
  const state: DirectStreamState = {
    settled: false,
    admitted: false,
    attempt: 0,
    retryTimer: undefined,
    releaseLease: () => undefined,
  };
  const request = (): void => {
    if (state.settled) return;
    state.releaseLease = requestDirectSlot({
      admit: () => {
        if (state.settled) return;
        state.attempt = 0;
        setDirectAdmitted(state, true);
        onAdmitted();
      },
      lose: () => {
        if (state.settled) return;
        if (state.admitted) {
          setDirectAdmitted(state, false);
          options.onYield?.();
        }
        state.retryTimer = window.setTimeout(request, directRetryDelay(state.attempt));
        state.attempt += 1;
      },
      background: options.priority === "background",
      correlationId: options.correlationId,
    });
  };
  request();
  return {
    get active(): boolean {
      return !state.settled;
    },
    release: (): void => {
      releaseDirectStream(state);
    },
  };
}

/**
 * Promise form of {@link admitDirectBrowserStream} for an essential stream a caller awaits: it
 * resolves with the release callback once a slot admits the stream, or with `null` when the signal
 * aborted first.
 */
export function admitDirectBrowserStreamAsync(
  signal: AbortSignal,
  correlationId?: string,
): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    let admission: DirectStreamAdmission | undefined;
    const cancel = (): void => {
      admission?.release();
      resolve(null);
    };
    admission = admitDirectBrowserStream(
      () => {
        signal.removeEventListener("abort", cancel);
        resolve(() => admission?.release());
      },
      correlationId === undefined ? {} : { correlationId },
    );
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/**
 * How many connections the shared stream pool may hold now. It is zero while direct streams hold
 * or await the whole ceiling, so the pool yields its last slot instead of exceeding it.
 */
export function sharedStreamConnectionBudget(): number {
  return Math.max(
    0,
    Math.min(SHARED_STREAM_CONNECTIONS, PERSISTENT_STREAM_CONNECTION_CEILING - directStreams),
  );
}

export function subscribeBrowserStreamCapacity(listener: CapacityListener): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function resetBrowserStreamCapacityForTests(): void {
  interactiveReservations = 0;
  directStreams = 0;
  admittedDirectStreams = 0;
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
  readonly slots?: number;
  readonly waitOnEverySlot?: boolean;
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
  staggerTimer: number | undefined;
  finish: (() => void) | undefined;
}

function releaseLease(lease: PersistentLease, reason: PersistentReleaseReason): void {
  if (lease.ended) return;
  lease.ended = true;
  lease.abort.abort();
  window.clearTimeout(lease.acquisitionTimer);
  window.clearInterval(lease.leaseTimer);
  window.clearTimeout(lease.staggerTimer);
  if (reason === "unavailable") {
    reportClientDiagnostic("[keiko] persistent stream origin capacity acquisition unavailable", {
      correlationId: lease.options.correlationId,
      errorKind: "timeout",
    });
  }
  lease.onReleased(reason);
  lease.finish?.();
}

const LEASE_CHECK_STAGGER_MS = 100;

// Each slot checks for waiters at its own offset, so holders of different slots never decide on
// the same snapshot.
function staggerLeaseCheck(name: string, lease: PersistentLease): Promise<void> {
  const index = Number(name.slice(name.lastIndexOf(":") + 1));
  return new Promise((resolve) => {
    lease.staggerTimer = window.setTimeout(resolve, (index + 1) * LEASE_CHECK_STAGGER_MS);
  });
}

async function checkLeaseWaiters(
  locks: LockManager,
  name: string,
  lease: PersistentLease,
): Promise<void> {
  if (lease.ended || lease.options.yieldable === false) return;
  try {
    // Direct streams are checked at staggered moments: one waiter pending on every slot would
    // otherwise make every background holder yield in the same tick, though one slot serves it.
    if (lease.options.slots !== undefined) await staggerLeaseCheck(name, lease);
    if (lease.ended) return;
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

function yieldableSlotName(name: string): boolean {
  return Number(name.slice(name.lastIndexOf(":") + 1)) < PERSISTENT_STREAM_SLOTS;
}

// The shared pool rotates over its own slots. A direct stream probes from the top, so it takes the
// slot only direct streams use first and leaves the shared pool as many slots as possible.
function leaseSlotNames(directSlots: number | undefined): string[] {
  const slotName = (index: number): string => `keiko:persistent-stream:${String(index)}`;
  if (directSlots !== undefined) {
    return Array.from({ length: directSlots }, (_, offset) => slotName(directSlots - 1 - offset));
  }
  const start = nextPersistentSlot++ % PERSISTENT_STREAM_SLOTS;
  return Array.from({ length: PERSISTENT_STREAM_SLOTS }, (_, offset) =>
    slotName((start + offset) % PERSISTENT_STREAM_SLOTS),
  );
}

async function requestLease(locks: LockManager, lease: PersistentLease): Promise<void> {
  const names = leaseSlotNames(lease.options.slots);
  for (const name of names) if (await probeSlot(locks, name, lease)) return;
  if (lease.ended) return;
  // The shared pool's slots yield to a waiter, so queueing there always ends. A direct stream also
  // waits for the slot only direct streams use, because that slot may be the one that frees first;
  // the first slot granted wins and the other request is withdrawn.
  const yieldable = await leastContendedSlot(locks, names.filter(yieldableSlotName));
  // An essential direct stream waits on every slot: whichever holder frees or yields first serves it.
  const candidates =
    lease.options.waitOnEverySlot === true
      ? names
      : lease.options.slots === undefined
        ? [yieldable]
        : [yieldable, ...names.slice(0, 1)];
  const waiting = new AbortController();
  lease.abort.signal.addEventListener("abort", () => waiting.abort(), { once: true });
  await Promise.allSettled(
    [...new Set(candidates)].map((name) =>
      locks.request(name, { signal: waiting.signal }, async () => {
        if (lease.ended || lease.granted) return;
        lease.granted = true;
        waiting.abort();
        await holdLease(locks, name, lease);
      }),
    ),
  );
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
    staggerTimer: undefined,
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
