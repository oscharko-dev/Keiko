"use client";

import { createSameOriginApiEventSource } from "../../../../../lib/safe-event-source";
import {
  backgroundBrowserStreamsSuspended,
  subscribeBrowserStreamCapacity,
} from "../../../../../lib/browser-stream-capacity";
import { secureRandomInt } from "../../../../../lib/secure-random";
import { reportClientDiagnostic } from "../../../../../lib/client-diagnostics";

// Duplicated identically across the four SSE-consuming modules (sharedEventSource.ts, useSSE.ts,
// coding-workbench-event-retention.ts, useRelationshipActivityStream.ts) rather than imported from
// `install-client-diagnostics.ts`, which owns the matching parser: that module installs the app's
// diagnostic transport as a side effect at import time (by design — see its own header), and none of
// these four modules' unit tests may pull that side effect (a real `fetch` attempt) into their own
// module graph. `install-client-diagnostics.ts`'s own test pins the exact convention below against
// all four call sites so the two ends cannot silently drift apart.
type SseStreamCloseReason = "connecting" | "closed" | "unknown";

function sseStreamCloseReason(readyState: number | undefined): SseStreamCloseReason {
  if (readyState === 0) return "connecting";
  if (readyState === 2) return "closed";
  return "unknown";
}

function sseStreamErrorDiagnostic(readyState: number | undefined): string {
  const readyStateText = readyState === undefined ? "unknown" : String(readyState);
  return `[keiko] shared-event-source sse stream error (kind=sse-error, readyState=${readyStateText}, reason=${sseStreamCloseReason(readyState)})`;
}

type SharedEventListener = (event: MessageEvent<string>) => void;

interface SharedEventSourceEntry {
  readonly url: string;
  source: EventSource | null;
  readonly subscribersByType: Map<string, Set<SharedEventListener>>;
  readonly dispatchersByType: Map<string, EventListener>;
  refCount: number;
  essentialRefCount: number;
  lastEventId: number | undefined;
  reconnectAttempts: number;
  reconnectTimer: number | undefined;
  sourceGeneration: number;
}

const sourcesByUrl = new Map<string, SharedEventSourceEntry>();
const sourceGenerationByEvent = new WeakMap<Event, number>();
const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_JITTER_MS = 500;
let visibilityListenerInstalled = false;
let capacityUnsubscribe: (() => void) | undefined;
let nextSourceGeneration = 0;

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
    recordLastEventId(entry, event, type === "editor-debug:snapshot-required");
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
    openEntrySource(entry);
  }, reconnectDelay(entry));
}

function openEntrySource(entry: SharedEventSourceEntry): void {
  if (
    entry.refCount === 0 ||
    entry.source !== null ||
    (entry.essentialRefCount === 0 && backgroundBrowserStreamsSuspended()) ||
    documentHidden() ||
    typeof EventSource === "undefined"
  ) {
    return;
  }
  const source = createSameOriginApiEventSource(resumeUrl(entry));
  if (source === null) return;
  nextSourceGeneration += 1;
  entry.sourceGeneration = nextSourceGeneration;
  entry.source = source;
  source.onopen = () => {
    entry.reconnectAttempts = 0;
  };
  source.onerror = () => {
    reportClientDiagnostic(sseStreamErrorDiagnostic(source.readyState));
    closeEntrySource(entry);
    scheduleReconnect(entry);
  };
  for (const type of entry.subscribersByType.keys()) {
    source.addEventListener(type, dispatcherFor(entry, type));
  }
}

function reconcileCapacity(backgroundStreamsSuspended: boolean): void {
  for (const entry of sourcesByUrl.values()) {
    if (entry.essentialRefCount > 0) {
      openEntrySource(entry);
    } else if (backgroundStreamsSuspended) {
      clearReconnectTimer(entry);
      closeEntrySource(entry);
    } else {
      openEntrySource(entry);
    }
  }
}

function handleVisibilityChange(): void {
  if (documentHidden()) {
    for (const entry of sourcesByUrl.values()) {
      clearReconnectTimer(entry);
      closeEntrySource(entry);
    }
    return;
  }
  for (const entry of sourcesByUrl.values()) {
    openEntrySource(entry);
  }
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
    subscribersByType: new Map(),
    dispatchersByType: new Map(),
    refCount: 0,
    essentialRefCount: 0,
    lastEventId: undefined,
    reconnectAttempts: 0,
    reconnectTimer: undefined,
    sourceGeneration: 0,
  };
  sourcesByUrl.set(url, entry);
  ensureVisibilityListener();
  return entry;
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
  openEntrySource(entry);
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
    if (
      entry.refCount > 0 &&
      entry.essentialRefCount === 0 &&
      backgroundBrowserStreamsSuspended()
    ) {
      clearReconnectTimer(entry);
      closeEntrySource(entry);
    }
    if (entry.refCount > 0) return;
    clearReconnectTimer(entry);
    closeEntrySource(entry);
    sourcesByUrl.delete(url);
    removeVisibilityListenerIfIdle();
  };
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
  nextSourceGeneration = 0;
  removeVisibilityListenerIfIdle();
}
