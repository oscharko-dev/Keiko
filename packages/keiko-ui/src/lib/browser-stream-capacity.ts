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
// behind streams until its own deadline expires (U-37). The reservation covers the EventSource and
// fetch-event streams admitted here. A chat turn streams over its own fetch (`sendDesktopChatStream`)
// outside this pool, and every open chat window may run one, so the two reserved connections are
// shared with concurrent chat turns: with more than two turns running at once a finite read can
// still queue until a turn ends. The ceiling is enforced at admission by an
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
 * keep their slot while their document is visible. `background` streams (relationship activity,
 * Browser) give theirs up to a waiter a person can see (never to another background stream or to a
 * hidden document's waiter), and an
 * essential stream that opted in (`replayRank`) gives its slot up to an essential stream of a
 * visible document while its own document is hidden, so a forgotten tab never starves the tab a
 * person is looking at.
 */
export type DirectStreamPriority = "essential" | "background";

export interface DirectStreamOptions {
  readonly priority?: DirectStreamPriority;
  /** The stream lost its slot to a more urgent one: close the connection. */
  readonly onYield?: () => void;
  /**
   * Essential only: the stream reopens losslessly from a fresh snapshot, so it may give its slot up.
   * It yields to an essential waiter of a visible document while its own document is hidden, and to
   * a visible non-replayable waiter in any case, lowest rank first (a lower rank yields before a
   * higher one). It asks again when its document becomes visible. Needs `onYield`.
   */
  readonly replayRank?: number;
  /**
   * Essential only: the server keeps no replay for this stream (the editor verification stream and
   * the editor agent bridge), so it never yields, and a waiting one makes replayable streams yield.
   */
  readonly nonReplayable?: boolean;
  /** The stream is mid-action: a yield is postponed to the next check while this returns false. */
  readonly canYield?: () => boolean;
  /**
   * Essential only: `true` once the wait for a slot passed {@link STREAM_WAITING_THRESHOLD_MS}, so
   * the surface can say the stream waits for a connection another tab uses; `false` once the
   * stream is admitted or released.
   */
  readonly onWaiting?: (waiting: boolean, heldByAnotherDocument?: boolean) => void;
  readonly correlationId?: string;
}

const DIRECT_RETRY_INITIAL_MS = 1_000;
const DIRECT_RETRY_MAX_MS = 30_000;
const HAND_ON_RETRY_MS = 250;
/** How long an essential stream waits silently before the surface is told it is waiting. */
export const STREAM_WAITING_THRESHOLD_MS = 10_000;

function directRetryDelay(attempt: number): number {
  return Math.min(DIRECT_RETRY_MAX_MS, DIRECT_RETRY_INITIAL_MS * 2 ** attempt);
}

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

interface DirectSlotRequest {
  readonly admit: () => void;
  readonly lose: (reason: PersistentReleaseReason) => void;
  readonly options: DirectStreamOptions;
  /** The unavailable diagnostic was already reported in this wait episode. */
  readonly quiet: boolean;
}

function directLeaseOptions(request: DirectSlotRequest): PersistentCapacityOptions {
  const { options } = request;
  const background = options.priority === "background";
  return {
    yieldable: background,
    essential: !background,
    slots: PERSISTENT_STREAM_CONNECTION_CEILING,
    ...(!background && options.replayRank !== undefined ? { replayRank: options.replayRank } : {}),
    ...(!background && options.nonReplayable === true ? { nonReplayable: true } : {}),
    ...(options.canYield === undefined ? {} : { canYield: options.canYield }),
    ...(request.quiet ? { quietUnavailable: true } : {}),
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
  };
}

function requestDirectSlot(request: DirectSlotRequest): () => void {
  if (typeof navigator === "undefined" || navigator.locks === undefined) {
    if (admittedDirectStreams >= PERSISTENT_STREAM_CONNECTION_CEILING) {
      request.lose("unavailable");
    } else {
      reportUnsupportedCapacity();
      request.admit();
    }
    return () => undefined;
  }
  return acquirePersistentBrowserStreamCapacity(
    request.admit,
    (reason) => {
      if (reason !== "cancelled") request.lose(reason);
    },
    directLeaseOptions(request),
  );
}

interface DirectStreamState {
  settled: boolean;
  admitted: boolean;
  attempt: number;
  retryTimer: number | undefined;
  waitTimer: number | undefined;
  waiting: boolean;
  waitStartedAt: number;
  waitAttempts: number;
  unavailableReported: boolean;
  releaseLease: () => void;
  stopVisibilityWatch: () => void;
}

function newDirectStreamState(): DirectStreamState {
  return {
    settled: false,
    admitted: false,
    attempt: 0,
    retryTimer: undefined,
    waitTimer: undefined,
    waiting: false,
    waitStartedAt: 0,
    waitAttempts: 0,
    unavailableReported: false,
    releaseLease: () => undefined,
    stopVisibilityWatch: () => undefined,
  };
}

function setDirectAdmitted(state: DirectStreamState, value: boolean): void {
  if (state.admitted === value) return;
  state.admitted = value;
  admittedDirectStreams = Math.max(0, admittedDirectStreams + (value ? 1 : -1));
}

function streamPriority(options: DirectStreamOptions): DirectStreamPriority {
  return options.priority === "background" ? "background" : "essential";
}

// An essential stream that waits is reported once per wait episode, after the threshold. The episode
// ends when the stream is admitted or released; an admission after a reported wait records the
// length and the attempts once.
function startWaitEpisode(state: DirectStreamState, options: DirectStreamOptions): void {
  if (streamPriority(options) !== "essential" || state.waitTimer !== undefined) return;
  if (state.admitted || state.settled) return;
  state.waitStartedAt = Date.now();
  state.waitTimer = window.setTimeout(() => {
    state.waitTimer = undefined;
    if (state.settled || state.admitted) return;
    state.waiting = true;
    reportClientDiagnostic(
      "[keiko] persistent stream waiting for origin capacity (priority=essential)",
      { correlationId: options.correlationId, errorKind: "timeout" },
    );
    void heldByAnotherDocument().then((elsewhere) => {
      if (state.settled || state.admitted || !state.waiting) return;
      options.onWaiting?.(true, elsewhere);
    });
  }, STREAM_WAITING_THRESHOLD_MS);
}

// More persistent connections are held origin-wide than this document holds itself. The count is
// read from the lock manager that already coordinates the slots; no new cross-tab signal exists.
async function heldByAnotherDocument(): Promise<boolean> {
  if (typeof navigator === "undefined" || navigator.locks === undefined) return false;
  try {
    const snapshot = await navigator.locks.query();
    const held = (snapshot.held ?? []).filter((lock) =>
      /^keiko:persistent-stream:\d+$/u.test(lock.name ?? ""),
    );
    return held.length > localHeldLeases;
  } catch {
    // The hint is optional: without it the plain waiting status is shown. Once per wait episode.
    reportClientDiagnostic("[keiko] persistent stream contention query unavailable", {
      errorKind: "unavailable",
    });
    return false;
  }
}

function endWaitEpisode(
  state: DirectStreamState,
  options: DirectStreamOptions,
  outcome: "admitted" | "released",
): void {
  window.clearTimeout(state.waitTimer);
  state.waitTimer = undefined;
  const attempts = state.waitAttempts;
  state.waitAttempts = 0;
  if (!state.waiting) return;
  state.waiting = false;
  options.onWaiting?.(false);
  if (outcome === "released") return;
  const seconds = Math.round((Date.now() - state.waitStartedAt) / 1_000);
  reportClientDiagnostic(
    `[keiko] persistent stream admitted after waiting for origin capacity (waitSeconds=${String(seconds)}, attempts=${String(attempts)})`, // i18n-exempt: developer diagnostic for the activity log, never rendered to a person
    { correlationId: options.correlationId },
  );
}

function releaseDirectStream(state: DirectStreamState, options: DirectStreamOptions): void {
  if (state.settled) return;
  state.settled = true;
  window.clearTimeout(state.retryTimer);
  endWaitEpisode(state, options, "released");
  state.stopVisibilityWatch();
  setDirectAdmitted(state, false);
  directStreams = Math.max(0, directStreams - 1);
  notifyCapacityChange();
  state.releaseLease();
}

// A slot was lost: an admitted stream is told to close, and the request is repeated on a backoff.
function loseDirectSlot(
  state: DirectStreamState,
  options: DirectStreamOptions,
  reason: PersistentReleaseReason,
  request: () => void,
): void {
  if (state.settled) return;
  if (reason === "unavailable") state.unavailableReported = true;
  if (state.admitted) {
    setDirectAdmitted(state, false);
    reportClientDiagnostic(
      `[keiko] persistent stream yielded origin capacity (priority=${streamPriority(options)})`, // i18n-exempt: developer diagnostic for the activity log, never rendered to a person
      { correlationId: options.correlationId },
    );
    options.onYield?.();
  }
  state.waitAttempts += 1;
  // A slot passed on to a visible waiter is asked for again at once (a short pause only keeps two
  // waiters from spinning on one slot), never behind the growing backoff of a failed request.
  const handedOn = reason === "handed-on";
  state.retryTimer = window.setTimeout(
    () => {
      state.retryTimer = undefined;
      request();
    },
    handedOn ? HAND_ON_RETRY_MS : directRetryDelay(state.attempt),
  );
  if (!handedOn) state.attempt += 1;
}

// A document that yielded while hidden asks again the moment a person looks at it.
function watchVisibilityRetry(state: DirectStreamState, request: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const onChange = (): void => {
    if (documentHidden() || state.settled || state.admitted || state.retryTimer === undefined) {
      return;
    }
    window.clearTimeout(state.retryTimer);
    state.retryTimer = undefined;
    state.attempt = 0;
    request();
  };
  document.addEventListener("visibilitychange", onChange);
  return (): void => {
    document.removeEventListener("visibilitychange", onChange);
  };
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
 * stream that yielded its slot (`onYield`) asks for one again, so `onAdmitted` may run several
 * times. An essential stream keeps its place in the queue while it waits and tells `onWaiting` when
 * the wait is long. The shared pool gives up its slots at once while a direct stream is pending or
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
  const state = newDirectStreamState();
  const request = (): void => {
    if (state.settled) return;
    startWaitEpisode(state, options);
    state.releaseLease = requestDirectSlot({
      admit: () => {
        if (state.settled) return;
        state.attempt = 0;
        state.unavailableReported = false;
        endWaitEpisode(state, options, "admitted");
        setDirectAdmitted(state, true);
        onAdmitted();
      },
      lose: (reason) => {
        loseDirectSlot(state, options, reason, request);
      },
      options,
      quiet: state.unavailableReported,
    });
  };
  if (options.replayRank !== undefined) {
    state.stopVisibilityWatch = watchVisibilityRetry(state, request);
  }
  request();
  return {
    get active(): boolean {
      return !state.settled;
    },
    release: (): void => {
      releaseDirectStream(state, options);
    },
  };
}

/**
 * Promise form of {@link admitDirectBrowserStream} for an essential stream a caller awaits: it
 * resolves with the release callback once a slot admits the stream, or with `null` when the signal
 * aborted first. `onYield` runs when the slot is later given up (see `replayRank`); the caller
 * then closes its connection, releases, and admits again.
 */
export function admitDirectBrowserStreamAsync(
  signal: AbortSignal,
  options: DirectStreamOptions = {},
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
    signal.addEventListener("abort", cancel, { once: true });
    admission = admitDirectBrowserStream(() => {
      signal.removeEventListener("abort", cancel);
      resolve(() => admission?.release());
    }, options);
  });
}

/**
 * How many connections the shared stream pool may hold now. It is zero while direct streams hold
 * or await the whole ceiling, so the pool yields its last slot instead of exceeding it.
 */
export function sharedStreamConnectionBudget(): number {
  return Math.max(
    1,
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
  localWaiters.clear();
  localMarkers.clear();
  localHolders.clear();
  localHeldLeases = 0;
  nextPersistentSlot = 0;
  unsupportedCapacityReported = false;
}

const PERSISTENT_STREAM_SLOTS = 3;
const PERSISTENT_STREAM_LEASE_MS = 5_000;
const STREAM_ACQUISITION_TIMEOUT_MS = 15_000;
let nextPersistentSlot = 0;
let unsupportedCapacityReported = false;

interface PersistentCapacityOptions {
  /** The holder gives its slot to a waiter (the shared pool and background streams). */
  readonly yieldable?: boolean;
  /** An essential direct stream: it queues on every slot, announces itself and never times out. */
  readonly essential?: boolean;
  readonly replayRank?: number;
  readonly nonReplayable?: boolean;
  readonly canYield?: () => boolean;
  readonly quietUnavailable?: boolean;
  readonly correlationId?: string;
  readonly slots?: number;
}

// `handed-on`: the slot was granted, then passed on at once to a waiter a person can see.
type PersistentReleaseReason = "expired" | "cancelled" | "unavailable" | "handed-on";

const localHolders = new Set<() => void>();
let localHeldLeases = 0;

interface PersistentLease {
  readonly abort: AbortController;
  readonly onGranted: () => void;
  readonly onReleased: (reason: PersistentReleaseReason) => void;
  readonly options: PersistentCapacityOptions;
  ended: boolean;
  granted: boolean;
  waiterQueryFailed: boolean;
  /** The waiter's document was visible when it last announced itself. */
  documentVisible: boolean;
  acquisitionTimer: number;
  leaseTimer: number | undefined;
  staggerTimer: number | undefined;
  finish: (() => void) | undefined;
  unregister: (() => void) | undefined;
}

function releaseLease(lease: PersistentLease, reason: PersistentReleaseReason): void {
  if (lease.ended) return;
  lease.ended = true;
  lease.abort.abort();
  window.clearTimeout(lease.acquisitionTimer);
  window.clearInterval(lease.leaseTimer);
  window.clearTimeout(lease.staggerTimer);
  if (reason === "unavailable" && lease.options.quietUnavailable !== true) {
    reportClientDiagnostic("[keiko] persistent stream origin capacity acquisition unavailable", {
      correlationId: lease.options.correlationId,
      errorKind: "timeout",
    });
  }
  lease.unregister?.();
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

// A waiter that someone can see (an essential stream, or a shared-pool consumer, of a visible
// document) holds one marker lock per slot it queues on. A holder reads the marker of its own slot,
// so it gives the slot up only to a waiter a person is waiting for: a hidden document's waiter never
// displaces a visible document's streams. The marker is origin-wide; the waiters of this document
// are also counted locally, so a hidden document's own background streams still give way to its
// own waiter.
const WAITING_MARKER_SUFFIX = ":waiting:visible";
const STRONG_MARKER_SUFFIX = ":nonreplayable";
const localWaiters = new Map<string, number>();
// Every marker this document's own waiters hold, by marker name: its own waiters count even while
// the document is hidden and holds no origin-wide marker.
const localMarkers = new Map<string, number>();

function waitingMarker(slot: string): string {
  return `${slot}${WAITING_MARKER_SUFFIX}`;
}

// The marker of a visible waiter whose stream the server cannot replay: replayable holders make way.
function strongMarker(slot: string): string {
  return `${waitingMarker(slot)}${STRONG_MARKER_SUFFIX}`;
}

function countLocalWaiter(
  counts: Map<string, number>,
  names: readonly string[],
  delta: 1 | -1,
): void {
  for (const name of names) {
    const next = (counts.get(name) ?? 0) + delta;
    if (next > 0) counts.set(name, next);
    else counts.delete(name);
  }
}

function markerPresent(snapshot: LockManagerSnapshot, marker: string): boolean {
  return lockPresent(snapshot, marker) || (localMarkers.get(marker) ?? 0) > 0;
}

function strongWaiterPresent(snapshot: LockManagerSnapshot, name: string): boolean {
  return markerPresent(snapshot, strongMarker(name));
}

// A replayable waiter holds a marker named after its rank: a holder of a LOWER rank makes way for
// it, one of an equal or higher rank never does, so streams of one rank cannot displace each other.
const MAX_REPLAY_RANK = 8;

function rankMarker(slot: string, rank: number): string {
  return `${waitingMarker(slot)}:rank:${String(rank)}`;
}

// What this lease's waiter announces besides the plain visible marker, if anything.
function extraMarker(options: PersistentCapacityOptions, slot: string): string | undefined {
  if (options.nonReplayable === true) return strongMarker(slot);
  return options.replayRank === undefined ? undefined : rankMarker(slot, options.replayRank);
}

function higherWaiterPresent(snapshot: LockManagerSnapshot, name: string, rank: number): boolean {
  if (strongWaiterPresent(snapshot, name)) return true;
  for (let higher = rank + 1; higher <= MAX_REPLAY_RANK; higher += 1) {
    if (markerPresent(snapshot, rankMarker(name, higher))) return true;
  }
  return false;
}

function lockPresent(snapshot: LockManagerSnapshot, name: string): boolean {
  return [...(snapshot.held ?? []), ...(snapshot.pending ?? [])].some((lock) => lock.name === name);
}

// Whether this lease's holder looks for waiters at all: the shared pool and background streams
// always do, an essential stream only when it opted in to yield while its document is hidden.
function leaseChecksWaiters(options: PersistentCapacityOptions): boolean {
  return options.essential === true
    ? options.replayRank !== undefined
    : options.yieldable !== false;
}

function holderShouldYield(
  snapshot: LockManagerSnapshot,
  name: string,
  options: PersistentCapacityOptions,
): boolean {
  // The shared pool rotates its three slots among its own consumers: any waiter makes it yield.
  if (options.slots === undefined) {
    return snapshot.pending?.some((pending) => pending.name === name) ?? false;
  }
  if (options.essential !== true) {
    return lockPresent(snapshot, waitingMarker(name)) || (localWaiters.get(name) ?? 0) > 0;
  }
  if (documentHidden() && lockPresent(snapshot, waitingMarker(name))) return true;
  return (
    options.replayRank !== undefined && higherWaiterPresent(snapshot, name, options.replayRank)
  );
}

// An essential holder looks for waiters only while its document is hidden.
function waiterCheckDue(lease: PersistentLease): boolean {
  if (lease.ended || !leaseChecksWaiters(lease.options)) return false;
  return (
    lease.options.essential !== true || documentHidden() || lease.options.replayRank !== undefined
  );
}

// A stream in the middle of an action keeps its slot until the next check.
function shouldGiveUpSlot(
  snapshot: LockManagerSnapshot,
  name: string,
  options: PersistentCapacityOptions,
): boolean {
  return holderShouldYield(snapshot, name, options) && options.canYield?.() !== false;
}

function reportWaiterQueryFailureOnce(lease: PersistentLease): void {
  if (lease.ended || lease.waiterQueryFailed) return;
  lease.waiterQueryFailed = true;
  reportClientDiagnostic("[keiko] persistent stream contention query unavailable", {
    correlationId: lease.options.correlationId,
    errorKind: "unavailable",
  });
}

// Replayable streams yield lowest rank first: a higher rank waits for the lower ones to act and
// keeps its slot if the waiter has been served meanwhile. The pause is longer than the whole stagger
// of the slots (a slot checks (index + 1) * 100 ms after the trigger), so a higher rank never reads
// the waiter before a lower rank on a later slot has had its turn and released.
const REPLAY_RANK_DELAY_MS = 300;
const REPLAY_RANK_BASE_DELAY_MS = 500;

async function lowerRankYieldedFirst(
  locks: LockManager,
  name: string,
  lease: PersistentLease,
): Promise<boolean> {
  const rank = lease.options.replayRank ?? 0;
  if (rank === 0) return false;
  await new Promise<void>((resolve) => {
    lease.staggerTimer = window.setTimeout(
      resolve,
      REPLAY_RANK_BASE_DELAY_MS + rank * REPLAY_RANK_DELAY_MS,
    );
  });
  if (lease.ended) return true;
  const snapshot = await locks.query();
  return !shouldGiveUpSlot(snapshot, name, lease.options);
}

async function checkLeaseWaiters(
  locks: LockManager,
  name: string,
  lease: PersistentLease,
): Promise<void> {
  if (!waiterCheckDue(lease)) return;
  try {
    // Direct streams are checked at staggered moments: one waiter pending on every slot would
    // otherwise make every holder yield in the same tick, though one slot serves it.
    if (lease.options.slots !== undefined) await staggerLeaseCheck(name, lease);
    if (lease.ended) return;
    const snapshot = await locks.query();
    lease.waiterQueryFailed = false;
    if (!shouldGiveUpSlot(snapshot, name, lease.options)) return;
    if (await lowerRankYieldedFirst(locks, name, lease)) return;
    releaseLease(lease, "expired");
  } catch {
    reportWaiterQueryFailureOnce(lease);
  }
}

// A stream that reaches the head of a slot's queue while a waiter a person can see needs that slot
// hands it straight on instead of opening a connection it would have to close again: a background
// stream gives way to any visible waiter, an essential stream of a hidden document to the visible
// waiter of another one, and a replayable stream to a non-replayable one. The shared pool and a
// visible document's non-replayable essential stream keep what they were granted.
function visibleWaiterNeedsSlot(
  snapshot: LockManagerSnapshot,
  name: string,
  lease: PersistentLease,
): boolean {
  const { options } = lease;
  if (options.essential !== true) {
    return options.yieldable !== false && lockPresent(snapshot, waitingMarker(name));
  }
  if (!lease.documentVisible && lockPresent(snapshot, waitingMarker(name))) return true;
  // A replayable stream that was granted a slot a non-replayable waiter needs passes it on.
  return (
    options.replayRank !== undefined &&
    options.nonReplayable !== true &&
    higherWaiterPresent(snapshot, name, options.replayRank)
  );
}

async function deferToVisibleWaiter(
  locks: LockManager,
  name: string,
  lease: PersistentLease,
): Promise<boolean> {
  if (lease.options.slots === undefined) return false;
  try {
    const snapshot = await locks.query();
    if (lease.ended) return true;
    if (!visibleWaiterNeedsSlot(snapshot, name, lease)) return false;
    releaseLease(lease, lease.options.essential === true ? "handed-on" : "expired");
    return true;
  } catch {
    // A failed contention query only skips the early hand-over; it is reported once per lease.
    reportWaiterQueryFailureOnce(lease);
    return lease.ended;
  }
}

async function holdLease(locks: LockManager, name: string, lease: PersistentLease): Promise<void> {
  if (await deferToVisibleWaiter(locks, name, lease)) return;
  const held = new Promise<void>((resolve) => {
    lease.finish = resolve;
  });
  localHeldLeases += 1;
  const recheck = (): void => {
    void checkLeaseWaiters(locks, name, lease);
  };
  if (leaseChecksWaiters(lease.options)) {
    lease.leaseTimer = window.setInterval(recheck, PERSISTENT_STREAM_LEASE_MS);
    localHolders.add(recheck);
  }
  lease.unregister = (): void => {
    localHolders.delete(recheck);
    localHeldLeases = Math.max(0, localHeldLeases - 1);
  };
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

// The shared pool's slots yield to a waiter, so queueing there always ends. A background direct
// stream also waits for the slot only direct streams use, because that slot may be the one that
// frees first; an essential direct stream waits on every slot, so whichever holder frees or yields
// first serves it. The first slot granted wins and the other requests are withdrawn.
function waitCandidates(
  options: PersistentCapacityOptions,
  names: readonly string[],
  yieldable: string,
): string[] {
  if (options.essential === true) return [...names];
  if (options.slots === undefined) return [yieldable];
  return [yieldable, ...names.slice(0, 1)];
}

// A marker is a lock held only to be seen: it ends when the waiter is served or gone. Failing to
// take one only costs this waiter its fast hand-over, never the slot it queues for.
function holdMarker(locks: LockManager, name: string, signal: AbortSignal): Promise<void> {
  return locks
    .request(name, { signal }, () => {
      return new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    })
    .then(
      () => undefined,
      () => undefined,
    );
}

// The marker exists only while the waiter's document is visible, and the lease remembers whether it
// is, so a granted hidden essential stream knows it must hand the slot on to a visible waiter.
function announceWaiter(
  locks: LockManager,
  names: readonly string[],
  lease: PersistentLease,
  waiting: AbortSignal,
): void {
  const extras = names.flatMap((name) => extraMarker(lease.options, name) ?? []);
  countLocalWaiter(localWaiters, names, 1);
  countLocalWaiter(localMarkers, extras, 1);
  let visible: AbortController | undefined;
  const sync = (): void => {
    if (waiting.aborted) return;
    lease.documentVisible = !documentHidden();
    if (documentHidden()) {
      visible?.abort();
      visible = undefined;
      return;
    }
    if (visible !== undefined) return;
    const own = new AbortController();
    visible = own;
    for (const name of names) {
      void holdMarker(locks, waitingMarker(name), own.signal);
      const extra = extraMarker(lease.options, name);
      if (extra !== undefined) void holdMarker(locks, extra, own.signal);
    }
  };
  sync();
  // The holders of this document look at once instead of at their next five-second check.
  for (const check of [...localHolders]) check();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", sync);
  waiting.addEventListener(
    "abort",
    () => {
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", sync);
      visible?.abort();
      countLocalWaiter(localWaiters, names, -1);
      countLocalWaiter(localMarkers, extras, -1);
    },
    { once: true },
  );
}

async function requestLease(locks: LockManager, lease: PersistentLease): Promise<void> {
  const names = leaseSlotNames(lease.options.slots);
  for (const name of names) if (await probeSlot(locks, name, lease)) return;
  if (lease.ended) return;
  const yieldable = await leastContendedSlot(locks, names.filter(yieldableSlotName));
  // The lease may have ended while the query ran: queueing now would leave a request nobody ever
  // withdraws, because the abort that ends the wait has already fired.
  if (lease.ended) return;
  const waiting = new AbortController();
  lease.abort.signal.addEventListener("abort", () => waiting.abort(), { once: true });
  const queued = new Set(waitCandidates(lease.options, names, yieldable));
  // Essential streams and shared-pool consumers are what a person waits for; a background direct
  // stream that queues announces nothing, so background streams never make each other yield.
  if (lease.options.essential === true || lease.options.slots === undefined) {
    announceWaiter(locks, [...queued], lease, waiting.signal);
  }
  await Promise.allSettled([
    ...[...queued].map((name) =>
      locks.request(name, { signal: waiting.signal }, async () => {
        if (lease.ended || lease.granted) return;
        lease.granted = true;
        waiting.abort();
        await holdLease(locks, name, lease);
      }),
    ),
  ]);
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
    documentVisible: !documentHidden(),
    acquisitionTimer: 0,
    leaseTimer: undefined,
    staggerTimer: undefined,
    finish: undefined,
    unregister: undefined,
  };
  // An essential stream keeps its place in the queue and reports a long wait instead of giving up
  // and queueing again behind everything that arrived meanwhile.
  if (options.essential !== true) {
    lease.acquisitionTimer = window.setTimeout(
      () => releaseLease(lease, "unavailable"),
      STREAM_ACQUISITION_TIMEOUT_MS,
    );
  }
  void requestLease(locks, lease).catch(() => releaseLease(lease, "unavailable"));
  return () => releaseLease(lease, "cancelled");
}

function reportUnsupportedCapacity(): void {
  if (unsupportedCapacityReported) return;
  unsupportedCapacityReported = true;
  reportClientDiagnostic("[keiko] persistent streams unavailable: origin capacity unsupported");
}
