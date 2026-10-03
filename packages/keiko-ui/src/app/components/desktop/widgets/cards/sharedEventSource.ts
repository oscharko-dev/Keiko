"use client";

import {
  createSameOriginApiEventSource,
  sameOriginApiEventSourceUrl,
} from "../../../../../lib/safe-event-source";
import {
  acquirePersistentBrowserStreamCapacity,
  backgroundBrowserStreamsSuspended,
  subscribeBrowserStreamCapacity,
} from "../../../../../lib/browser-stream-capacity";
import { secureRandomInt } from "../../../../../lib/secure-random";
import {
  reportClientDiagnostic,
  sseStreamErrorDiagnostic,
} from "../../../../../lib/client-diagnostics";
import { newClientCorrelationId } from "../../../../../lib/bff-correlation";
import {
  repairLocalCodingAppSessionForStream,
  reportStreamSessionRecovered,
} from "../../../../../lib/coding-app-session-client";

type SharedEventListener = (event: MessageEvent<string>) => void;

interface SharedEventSourceEntry {
  readonly url: string;
  source: EventSource | null;
  capacityLease: (() => void) | undefined;
  readonly subscribersByType: Map<string, Set<SharedEventListener>>;
  readonly dispatchersByType: Map<string, EventListener>;
  refCount: number;
  essentialRefCount: number;
  lastEventId: number | undefined;
  reconnectAttempts: number;
  reconnectTimer: number | undefined;
  sourceGeneration: number;
  // Set once an `onerror` in the current failure streak has a session repair in flight OR
  // SUCCEEDED, so a streak of reconnect failures repairs at most once IN FLIGHT instead of
  // hammering the local pairing endpoint on every attempt. A FAILED repair clears it again so the
  // next `onerror` in the same streak gets its own attempt instead of being permanently locked out
  // for the rest of the streak (#3557 review: the first repair can race a restarting BFF and
  // legitimately fail). Also reset to `false` by a successful open (`onopen`), which starts a new
  // streak.
  sessionRepairAttempted: boolean;
  // The client-minted id of the current failure streak (#3557 review). An EventSource exposes no
  // request id, so the streak's error diagnostics and its session-repair outcomes share this one.
  // A successful open ends the streak.
  failureStreakCorrelationId: string | undefined;
  // The streak's acknowledged repair, reported as recovered only once the stream opens again: an
  // acknowledgement alone does not say a session cookie was issued (#3557 review).
  acknowledgedRepairCorrelationId: string | undefined;
}

const sourcesByUrl = new Map<string, SharedEventSourceEntry>();
const sourceGenerationByEvent = new WeakMap<Event, number>();
const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_JITTER_MS = 500;
let visibilityListenerInstalled = false;
let capacityUnsubscribe: (() => void) | undefined;
let nextSourceGeneration = 0;
// Leave connections for finite reads, diagnostics, the run stream and development HMR.
const MAX_SHARED_CONNECTIONS = 3;
const STREAM_LEASE_MS = 5_000;
let budgetTimer: number | undefined;
const budgetCursors = { essential: 0, background: 0 };

export interface SharedEventSourceOptions {
  readonly priority?: "essential" | "background";
}

function removeSourceListener(source: EventSource, type: string, dispatcher: EventListener): void {
  const removable = source as EventSource & {
    removeEventListener?: EventSource["removeEventListener"] | undefined;
  };
  removable.removeEventListener?.(type, dispatcher);
}

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function clearReconnectTimer(entry: SharedEventSourceEntry): void {
  if (entry.reconnectTimer === undefined) return;
  window.clearTimeout(entry.reconnectTimer);
  entry.reconnectTimer = undefined;
}

function reconnectDelay(entry: SharedEventSourceEntry): number {
  const base = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_INITIAL_DELAY_MS * 2 ** entry.reconnectAttempts,
  );
  entry.reconnectAttempts += 1;
  return base + secureRandomInt(RECONNECT_JITTER_MS);
}

function recordLastEventId(
  entry: SharedEventSourceEntry,
  event: Event,
  resetCursor: boolean,
): void {
  const raw = (event as MessageEvent<string>).lastEventId;
  if (!/^\d+$/u.test(raw)) return;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return;
  entry.lastEventId = resetCursor ? parsed : Math.max(entry.lastEventId ?? 0, parsed);
}

function resumeUrl(entry: SharedEventSourceEntry): string {
  if (entry.lastEventId === undefined || typeof window === "undefined") return entry.url;
  const parsed = new URL(entry.url, window.location.origin);
  parsed.searchParams.set("lastEventId", String(entry.lastEventId));
  return `${parsed.pathname}${parsed.search}`;
}

function dispatcherFor(entry: SharedEventSourceEntry, type: string): EventListener {
  let dispatcher = entry.dispatchersByType.get(type);
  if (dispatcher !== undefined) return dispatcher;
  dispatcher = (event: Event): void => {
    sourceGenerationByEvent.set(event, entry.sourceGeneration);
    recordLastEventId(
      entry,
      event,
      type === "editor-debug:snapshot-required" ||
        type === "editor-watch:snapshot" ||
        type === "editor-watch:snapshot-required",
    );
    const subscribers = entry.subscribersByType.get(type);
    if (subscribers === undefined || subscribers.size === 0) return;
    for (const subscriber of subscribers) {
      subscriber(event as MessageEvent<string>);
    }
  };
  entry.dispatchersByType.set(type, dispatcher);
  entry.source?.addEventListener(type, dispatcher);
  return dispatcher;
}

function closeEntrySource(entry: SharedEventSourceEntry): void {
  const release = entry.capacityLease;
  entry.capacityLease = undefined;
  release?.();
  if (entry.source === null) return;
  for (const [type, dispatcher] of entry.dispatchersByType) {
    removeSourceListener(entry.source, type, dispatcher);
  }
  entry.source.close();
  entry.source = null;
}

function scheduleReconnect(entry: SharedEventSourceEntry): void {
  if (
    entry.refCount === 0 ||
    entry.reconnectTimer !== undefined ||
    documentHidden() ||
    typeof EventSource === "undefined"
  ) {
    return;
  }
  entry.reconnectTimer = window.setTimeout(() => {
    entry.reconnectTimer = undefined;
    refreshStreamBudget();
  }, reconnectDelay(entry));
}

// Repairs a stale local app session at most once IN FLIGHT per failure streak (ADR-0141 D5): a
// restarted BFF invalidates its in-memory session, so every reconnect after that was denied again
// forever, with nothing ever re-establishing one. Fire-and-forget — the repair is a fast loopback
// POST that normally completes well before the reconnect timer's minimum 1s delay elapses, so the
// next attempt carries a valid cookie without slowing the existing backoff. A failed repair
// (single-flight `false`) re-arms the streak's attempt so the next `onerror` retries instead of
// leaving the stream permanently unrepaired.
function repairSessionOnce(entry: SharedEventSourceEntry, streakCorrelationId: string): void {
  if (entry.sessionRepairAttempted) return;
  entry.sessionRepairAttempted = true;
  void repairLocalCodingAppSessionForStream("shared-event-source", streakCorrelationId).then(
    (repair) => {
      // A streak that ended meanwhile keeps nothing.
      if (entry.failureStreakCorrelationId !== streakCorrelationId) return;
      if (repair.acknowledged) entry.acknowledgedRepairCorrelationId = repair.repairCorrelationId;
      else entry.sessionRepairAttempted = false;
    },
  );
}

// Forgets the failure streak and its repair. A stream resumed after a suspension starts a new
// streak, which must never find an old streak's repair latched (#3557 review).
function forgetFailureStreak(entry: SharedEventSourceEntry): void {
  entry.sessionRepairAttempted = false;
  entry.failureStreakCorrelationId = undefined;
  entry.acknowledgedRepairCorrelationId = undefined;
}

// A successful open ends the failure streak; after an acknowledged repair it is the recovery.
function endFailureStreak(entry: SharedEventSourceEntry): void {
  const streak = entry.failureStreakCorrelationId;
  const repair = entry.acknowledgedRepairCorrelationId;
  if (streak !== undefined && repair !== undefined) {
    reportStreamSessionRecovered("shared-event-source", streak, repair);
  }
  entry.reconnectAttempts = 0;
  forgetFailureStreak(entry);
}

// A suspension (hidden document, reserved capacity) closes the stream on purpose; its streak ends.
function suspendEntry(entry: SharedEventSourceEntry): void {
  clearReconnectTimer(entry);
  closeEntrySource(entry);
  forgetFailureStreak(entry);
}

function openEntrySource(entry: SharedEventSourceEntry): void {
  if (
    entry.refCount === 0 ||
    entry.source !== null ||
    entry.capacityLease !== undefined ||
    (entry.essentialRefCount === 0 && backgroundBrowserStreamsSuspended()) ||
    documentHidden() ||
    typeof EventSource === "undefined" ||
    sameOriginApiEventSourceUrl(entry.url) === null
  ) {
    return;
  }
  entry.failureStreakCorrelationId ??= newClientCorrelationId();
  entry.capacityLease = acquirePersistentBrowserStreamCapacity(
    () => connectEntrySource(entry),
    (reason) => {
      closeEntrySource(entry);
      if (reason === "unavailable") scheduleReconnect(entry);
      queueMicrotask(() => refreshStreamBudget());
    },
    {
      yieldable: replayableEntry(entry),
      correlationId: entry.failureStreakCorrelationId,
    },
  );
}

function connectEntrySource(entry: SharedEventSourceEntry): void {
  const source = createSameOriginApiEventSource(resumeUrl(entry));
  if (source === null) return;
  nextSourceGeneration += 1;
  entry.sourceGeneration = nextSourceGeneration;
  entry.source = source;
  source.onopen = () => {
    endFailureStreak(entry);
  };
  source.onerror = () => {
    const streak = (entry.failureStreakCorrelationId ??= newClientCorrelationId());
    reportClientDiagnostic(sseStreamErrorDiagnostic("shared-event-source", source.readyState), {
      correlationId: streak,
    });
    closeEntrySource(entry);
    repairSessionOnce(entry, streak);
    scheduleReconnect(entry);
    refreshStreamBudget();
  };
  for (const type of entry.subscribersByType.keys()) {
    source.addEventListener(type, dispatcherFor(entry, type));
  }
}

function clearBudgetTimer(): void {
  if (budgetTimer === undefined) return;
  window.clearInterval(budgetTimer);
  budgetTimer = undefined;
}

function eligibleEntries(): SharedEventSourceEntry[] {
  if (documentHidden()) return [];
  return [...sourcesByUrl.values()].filter(
    (entry) =>
      entry.refCount > 0 &&
      entry.reconnectTimer === undefined &&
      (entry.essentialRefCount > 0 || !backgroundBrowserStreamsSuspended()),
  );
}

function replayableEntry(entry: SharedEventSourceEntry): boolean {
  const path = entry.url.split("?")[0] ?? "";
  return (
    entry.essentialRefCount === 0 ||
    path.startsWith("/api/editor/workspace-watch/") ||
    path.startsWith("/api/editor/watch/") ||
    path.startsWith("/api/editor/debug/")
  );
}

function hasLease(entry: SharedEventSourceEntry): boolean {
  return entry.source !== null || entry.capacityLease !== undefined;
}

function rotateEntries(
  entries: readonly SharedEventSourceEntry[],
  slots: number,
  priority: "essential" | "background",
): SharedEventSourceEntry[] {
  if (entries.length === 0) return [];
  budgetCursors[priority] = (budgetCursors[priority] + slots) % entries.length;
  const offset = budgetCursors[priority];
  return [...entries.slice(offset), ...entries.slice(0, offset)];
}

function orderBudgetGroup(
  entries: readonly SharedEventSourceEntry[],
  slots: number,
  priority: "essential" | "background",
  rotate: boolean,
): SharedEventSourceEntry[] {
  return rotate
    ? rotateEntries(entries, slots, priority)
    : [...entries.filter(hasLease), ...entries.filter((entry) => !hasLease(entry))];
}

function selectBudgetEntries(
  entries: readonly SharedEventSourceEntry[],
  rotate: boolean,
): Set<SharedEventSourceEntry> {
  const pinned = entries.filter((entry) => !replayableEntry(entry) && hasLease(entry));
  const essential = entries.filter(
    (entry) => entry.essentialRefCount > 0 && !pinned.includes(entry),
  );
  const background = entries.filter((entry) => entry.essentialRefCount === 0);
  const essentialSlots = Math.min(MAX_SHARED_CONNECTIONS - pinned.length, essential.length);
  const backgroundSlots = MAX_SHARED_CONNECTIONS - pinned.length - essentialSlots;
  return new Set(
    [
      ...pinned,
      ...orderBudgetGroup(essential, essentialSlots, "essential", rotate),
      ...orderBudgetGroup(background, backgroundSlots, "background", rotate),
    ].slice(0, MAX_SHARED_CONNECTIONS),
  );
}

// Keep healthy leases stable between contention ticks. Essential streams precede recoverable
// background metadata; active streams without replay retain their connection until completion.
function refreshStreamBudget(rotate = false): void {
  const entries = eligibleEntries();
  const selected = selectBudgetEntries(entries, rotate);
  for (const entry of sourcesByUrl.values()) {
    if (!selected.has(entry) && hasLease(entry)) suspendEntry(entry);
  }
  for (const entry of selected) openEntrySource(entry);
  if (entries.length <= MAX_SHARED_CONNECTIONS) {
    clearBudgetTimer();
    return;
  }
  budgetTimer ??= window.setInterval(() => refreshStreamBudget(true), STREAM_LEASE_MS);
}

function reconcileCapacity(backgroundStreamsSuspended: boolean): void {
  if (backgroundStreamsSuspended) {
    budgetCursors.essential = 0;
    budgetCursors.background = 0;
  }
  refreshStreamBudget();
}

function handleVisibilityChange(): void {
  if (documentHidden()) {
    for (const entry of sourcesByUrl.values()) suspendEntry(entry);
    clearBudgetTimer();
    return;
  }
  refreshStreamBudget();
}

function ensureVisibilityListener(): void {
  if (visibilityListenerInstalled || typeof document === "undefined") return;
  document.addEventListener("visibilitychange", handleVisibilityChange);
  visibilityListenerInstalled = true;
  capacityUnsubscribe = subscribeBrowserStreamCapacity(reconcileCapacity);
}

function removeVisibilityListenerIfIdle(): void {
  if (!visibilityListenerInstalled || sourcesByUrl.size > 0 || typeof document === "undefined") {
    return;
  }
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  visibilityListenerInstalled = false;
  capacityUnsubscribe?.();
  capacityUnsubscribe = undefined;
}

function entryForUrl(url: string): SharedEventSourceEntry {
  const existing = sourcesByUrl.get(url);
  if (existing !== undefined) return existing;
  const entry: SharedEventSourceEntry = {
    url,
    source: null,
    capacityLease: undefined,
    subscribersByType: new Map(),
    dispatchersByType: new Map(),
    refCount: 0,
    essentialRefCount: 0,
    lastEventId: undefined,
    reconnectAttempts: 0,
    reconnectTimer: undefined,
    sourceGeneration: 0,
    sessionRepairAttempted: false,
    failureStreakCorrelationId: undefined,
    acknowledgedRepairCorrelationId: undefined,
  };
  sourcesByUrl.set(url, entry);
  ensureVisibilityListener();
  return entry;
}

function reconcileUnsubscription(entry: SharedEventSourceEntry, url: string): void {
  if (entry.refCount > 0 && entry.essentialRefCount === 0 && backgroundBrowserStreamsSuspended()) {
    suspendEntry(entry);
  }
  if (entry.refCount > 0) {
    refreshStreamBudget();
    return;
  }
  clearReconnectTimer(entry);
  closeEntrySource(entry);
  sourcesByUrl.delete(url);
  refreshStreamBudget();
  removeVisibilityListenerIfIdle();
}

export function subscribeSharedEventSource(
  url: string,
  eventTypes: readonly string[],
  listener: SharedEventListener,
  options: SharedEventSourceOptions = {},
): () => void {
  const entry = entryForUrl(url);
  const essential = options.priority !== "background";
  entry.refCount += 1;
  if (essential) entry.essentialRefCount += 1;
  for (const type of eventTypes) {
    const subscribers = entry.subscribersByType.get(type) ?? new Set<SharedEventListener>();
    subscribers.add(listener);
    entry.subscribersByType.set(type, subscribers);
    dispatcherFor(entry, type);
  }
  refreshStreamBudget();
  // React effect cleanups may run more than once; a second call must not double-decrement the
  // ref counts (an essential underflow would suspend streams that still have live subscribers).
  let unsubscribed = false;
  return (): void => {
    if (unsubscribed) return;
    unsubscribed = true;
    for (const type of eventTypes) {
      const subscribers = entry.subscribersByType.get(type);
      subscribers?.delete(listener);
      if (subscribers?.size === 0) {
        entry.subscribersByType.delete(type);
        const dispatcher = entry.dispatchersByType.get(type);
        if (dispatcher !== undefined) {
          if (entry.source !== null) removeSourceListener(entry.source, type, dispatcher);
        }
      }
    }
    entry.refCount -= 1;
    if (essential) entry.essentialRefCount -= 1;
    reconcileUnsubscription(entry, url);
  };
}

/** Wait for an actual open handshake on the shared source, with bounded cancellable cleanup. */
export function awaitSharedEventSourceOpen(url: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  if (sourcesByUrl.get(url)?.source?.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let ended = false;
    let unsubscribe = (): void => undefined;
    const finish = (error?: Error): void => {
      if (ended) return;
      ended = true;
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = (): void => finish(new DOMException("Cancelled", "AbortError"));
    const timer = window.setTimeout(
      () => finish(new DOMException("Stream unavailable", "TimeoutError")),
      15_000,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    unsubscribe = subscribeSharedEventSource(url, ["open", "error"], (event) => {
      queueMicrotask(() =>
        finish(event.type === "open" ? undefined : new TypeError("Stream unavailable")),
      );
    });
  });
}

/** Keep the execution callback subscribed before its POST and throughout its completion. */
export async function withSharedEventSourceOpen<T>(
  url: string,
  eventTypes: readonly string[],
  onMessage: SharedEventListener,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const unsubscribe = subscribeSharedEventSource(url, eventTypes, onMessage);
  signal?.addEventListener("abort", unsubscribe, { once: true });
  try {
    await awaitSharedEventSourceOpen(url, signal);
    return await run();
  } finally {
    signal?.removeEventListener("abort", unsubscribe);
    unsubscribe();
  }
}

/** Reopen one existing subscription so every consumer receives its fresh server snapshot. */
export function refreshSharedEventSource(url: string): void {
  const entry = sourcesByUrl.get(url);
  if (entry === undefined) return;
  suspendEntry(entry);
  refreshStreamBudget();
}

export function sharedEventSourceGeneration(event: MessageEvent<string>): number {
  return sourceGenerationByEvent.get(event) ?? 0;
}

export function resetSharedEventSourcesForTests(): void {
  for (const entry of sourcesByUrl.values()) {
    clearReconnectTimer(entry);
    closeEntrySource(entry);
  }
  sourcesByUrl.clear();
  clearBudgetTimer();
  budgetCursors.essential = 0;
  budgetCursors.background = 0;
  nextSourceGeneration = 0;
  removeVisibilityListenerIfIdle();
}
