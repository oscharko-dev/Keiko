"use client";

import { createSameOriginApiEventSource } from "../../../../../lib/safe-event-source";

type SharedEventListener = (event: MessageEvent<string>) => void;

interface SharedEventSourceEntry {
  readonly url: string;
  source: EventSource | null;
  readonly subscribersByType: Map<string, Set<SharedEventListener>>;
  readonly dispatchersByType: Map<string, EventListener>;
  refCount: number;
  reconnectAttempts: number;
  reconnectTimer: number | undefined;
}

const sourcesByUrl = new Map<string, SharedEventSourceEntry>();
const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_JITTER_MS = 500;
let visibilityListenerInstalled = false;

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
  return base + Math.floor(Math.random() * RECONNECT_JITTER_MS);
}

function dispatcherFor(entry: SharedEventSourceEntry, type: string): EventListener {
  let dispatcher = entry.dispatchersByType.get(type);
  if (dispatcher !== undefined) return dispatcher;
  dispatcher = (event: Event): void => {
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
    documentHidden() ||
    typeof EventSource === "undefined"
  ) {
    return;
  }
  const source = createSameOriginApiEventSource(entry.url);
  if (source === null) return;
  entry.source = source;
  source.onopen = () => {
    entry.reconnectAttempts = 0;
  };
  source.onerror = () => {
    closeEntrySource(entry);
    scheduleReconnect(entry);
  };
  for (const type of entry.subscribersByType.keys()) {
    source.addEventListener(type, dispatcherFor(entry, type));
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
}

function removeVisibilityListenerIfIdle(): void {
  if (!visibilityListenerInstalled || sourcesByUrl.size > 0 || typeof document === "undefined") {
    return;
  }
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  visibilityListenerInstalled = false;
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
    reconnectAttempts: 0,
    reconnectTimer: undefined,
  };
  sourcesByUrl.set(url, entry);
  ensureVisibilityListener();
  openEntrySource(entry);
  return entry;
}

export function subscribeSharedEventSource(
  url: string,
  eventTypes: readonly string[],
  listener: SharedEventListener,
): () => void {
  const entry = entryForUrl(url);
  entry.refCount += 1;
  for (const type of eventTypes) {
    dispatcherFor(entry, type);
    const subscribers = entry.subscribersByType.get(type) ?? new Set<SharedEventListener>();
    subscribers.add(listener);
    entry.subscribersByType.set(type, subscribers);
  }
  openEntrySource(entry);
  return (): void => {
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
    if (entry.refCount > 0) return;
    clearReconnectTimer(entry);
    closeEntrySource(entry);
    sourcesByUrl.delete(url);
    removeVisibilityListenerIfIdle();
  };
}

export function resetSharedEventSourcesForTests(): void {
  for (const entry of sourcesByUrl.values()) {
    clearReconnectTimer(entry);
    closeEntrySource(entry);
  }
  sourcesByUrl.clear();
  removeVisibilityListenerIfIdle();
}
