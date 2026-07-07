"use client";

/**
 * Hook that consumes the desktop's shared run-event stream (/api/runs/events).
 * Accumulates typed HarnessEvents for one runId, exposes {events, status, error}.
 */

import { useEffect, useRef, useState } from "react";
import { createSameOriginApiEventSource } from "./safe-event-source";
import { TERMINAL_EVENT_TYPES, type HarnessEvent, type SseStatus } from "./types";

const MAX_VISIBLE_SSE_EVENTS = 500;
const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RUN_EVENTS_URL = "/api/runs/events";

export interface UseSSEResult {
  events: HarnessEvent[];
  status: SseStatus;
  error: string | null;
}

interface RunEventSubscriber {
  readonly onEvent: (event: HarnessEvent) => void;
  readonly onStatus: (status: SseStatus, error: string | null) => void;
}

const subscribersByRunId = new Map<string, Set<RunEventSubscriber>>();
let sharedEventSource: EventSource | null = null;
let sharedEventSourceLive = false;
let reconnectTimer: number | undefined;
let reconnectAttempts = 0;
let visibilityListenerInstalled = false;

function subscriberCount(): number {
  let count = 0;
  for (const subscribers of subscribersByRunId.values()) {
    count += subscribers.size;
  }
  return count;
}

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function notifyAll(status: SseStatus, error: string | null): void {
  for (const subscribers of subscribersByRunId.values()) {
    for (const subscriber of subscribers) {
      subscriber.onStatus(status, error);
    }
  }
}

function notifyRun(event: HarnessEvent): void {
  const subscribers = subscribersByRunId.get(event.runId);
  if (subscribers === undefined) return;
  for (const subscriber of subscribers) {
    subscriber.onEvent(event);
  }
}

function clearReconnectTimer(): void {
  if (reconnectTimer === undefined) return;
  window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
}

function closeSharedEventSource(): void {
  sharedEventSource?.close();
  sharedEventSource = null;
  sharedEventSourceLive = false;
}

function reconnectDelay(): number {
  const base = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_INITIAL_DELAY_MS * 2 ** reconnectAttempts,
  );
  reconnectAttempts += 1;
  // Equal-jitter ([base/2, base]) — same policy as the model-gateway retry backoff. The
  // previous fixed 0–500ms additive jitter clustered every stream consumer (all windows,
  // all tabs) into the same half-second wave after a BFF restart; spreading by half the
  // backoff keeps the herd apart at every attempt depth.
  return Math.floor(base / 2 + Math.random() * (base / 2));
}

function scheduleReconnect(): void {
  if (subscriberCount() === 0 || documentHidden() || reconnectTimer !== undefined) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    openSharedEventSource();
  }, reconnectDelay());
}

function handleVisibilityChange(): void {
  if (documentHidden()) {
    clearReconnectTimer();
    closeSharedEventSource();
    return;
  }
  if (subscriberCount() > 0) {
    notifyAll("connecting", null);
    openSharedEventSource();
  }
}

function ensureVisibilityListener(): void {
  if (visibilityListenerInstalled || typeof document === "undefined") return;
  document.addEventListener("visibilitychange", handleVisibilityChange);
  visibilityListenerInstalled = true;
}

function removeVisibilityListenerIfIdle(): void {
  if (!visibilityListenerInstalled || subscriberCount() > 0 || typeof document === "undefined") {
    return;
  }
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  visibilityListenerInstalled = false;
}

function openSharedEventSource(): void {
  if (subscriberCount() === 0 || documentHidden() || sharedEventSource !== null) return;
  closeSharedEventSource();
  sharedEventSource = createSameOriginApiEventSource(RUN_EVENTS_URL);
  if (sharedEventSource === null) return;

  sharedEventSource.onopen = () => {
    reconnectAttempts = 0;
    sharedEventSourceLive = true;
    notifyAll("live", null);
  };

  sharedEventSource.addEventListener("ready", () => {
    reconnectAttempts = 0;
    sharedEventSourceLive = true;
    notifyAll("live", null);
  });

  sharedEventSource.onerror = () => {
    notifyAll("error", "Stream disconnected. Attempting to reconnect…");
    closeSharedEventSource();
    scheduleReconnect();
  };

  sharedEventSource.onmessage = (ev: MessageEvent): void => {
    let parsed: HarnessEvent;
    try {
      parsed = JSON.parse(ev.data as string) as HarnessEvent;
    } catch {
      return;
    }
    notifyRun(parsed);
  };
}

function subscribeRunEvents(runId: string, subscriber: RunEventSubscriber): () => void {
  let subscribers = subscribersByRunId.get(runId);
  if (subscribers === undefined) {
    subscribers = new Set();
    subscribersByRunId.set(runId, subscribers);
  }
  subscribers.add(subscriber);
  ensureVisibilityListener();
  if (sharedEventSourceLive) {
    subscriber.onStatus("live", null);
  } else {
    openSharedEventSource();
  }
  return (): void => {
    const current = subscribersByRunId.get(runId);
    current?.delete(subscriber);
    if (current?.size === 0) {
      subscribersByRunId.delete(runId);
    }
    if (subscriberCount() === 0) {
      clearReconnectTimer();
      closeSharedEventSource();
    }
    removeVisibilityListenerIfIdle();
  };
}

export function useSSE(runId: string | null): UseSSEResult {
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [status, setStatus] = useState<SseStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  // Track the last seq we've seen for resume
  const lastSeqRef = useRef<number>(-1);
  const terminalRef = useRef(false);

  useEffect(() => {
    if (runId === null) return;

    // FIX D: Reset all accumulated state when runId changes so a new run view
    // does not inherit previous run's events or resume cursor. This runs
    // synchronously before the EventSource opens, giving the UI a clean slate.
    setEvents([]);
    setStatus("connecting");
    setError(null);
    lastSeqRef.current = -1;
    terminalRef.current = false;

    // GEN-PERF-SSE-001 — coalesce event bursts, mirroring the chat token path
    // (GEN-PERF-CHAT-007). A verbose run emits reasoning/tool events in tight bursts;
    // one setEvents per event meant one React commit plus one O(length) array copy PER
    // EVENT, uncapped by frame rate — multiplied across every concurrently open run
    // window. Leading-edge flush: the first event of an idle window commits immediately
    // (single-event latency is unchanged), follow-up events arriving within the same
    // animation frame are batched into one trailing commit. Terminal events always
    // flush synchronously so the status transition keeps its pre-batching timing.
    const canRaf = typeof requestAnimationFrame === "function";
    let pending: HarnessEvent[] = [];
    let sawTerminal = false;
    let rafHandle: number | null = null;
    const flush = (): void => {
      if (pending.length > 0) {
        const batch = pending;
        pending = [];
        setEvents((prev) => {
          const merged = [...prev, ...batch];
          return merged.length > MAX_VISIBLE_SSE_EVENTS
            ? merged.slice(merged.length - MAX_VISIBLE_SSE_EVENTS)
            : merged;
        });
      }
      if (sawTerminal && !terminalRef.current) {
        // FIX E: TERMINAL_EVENT_TYPES now includes workflow:completed/failed and
        // bug:completed/failed so workflow and bug runs reach terminal state properly.
        terminalRef.current = true;
        setStatus("terminal");
        setError(null);
      }
    };
    const closeBatchWindow = (): void => {
      rafHandle = null;
      flush();
    };
    const unsubscribe = subscribeRunEvents(runId, {
      onStatus: (nextStatus, nextError): void => {
        if (terminalRef.current) return;
        setStatus(nextStatus);
        setError(nextError);
      },
      onEvent: (parsed): void => {
        if (parsed.seq <= lastSeqRef.current) return;
        lastSeqRef.current = parsed.seq;
        pending.push(parsed);
        if (TERMINAL_EVENT_TYPES.has(parsed.type)) sawTerminal = true;
        if (!canRaf || sawTerminal) {
          if (rafHandle !== null) {
            cancelAnimationFrame(rafHandle);
            rafHandle = null;
          }
          flush();
          return;
        }
        if (rafHandle === null) {
          // Idle window: commit this event now, then hold a one-frame window that
          // collects any burst arriving behind it.
          flush();
          rafHandle = requestAnimationFrame(closeBatchWindow);
        }
      },
    });
    return (): void => {
      // A pending frame must not flush into the next run's state (or after unmount).
      if (rafHandle !== null && canRaf) cancelAnimationFrame(rafHandle);
      unsubscribe();
    };
  }, [runId]);

  return { events, status, error };
}
