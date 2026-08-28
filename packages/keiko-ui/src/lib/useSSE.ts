"use client";

/**
 * Hook that consumes the desktop's shared run-event stream (/api/runs/events).
 * Accumulates typed HarnessEvents for one runId, exposes {events, status, error}.
 */

import { useEffect, useRef, useState } from "react";
import { reportClientDiagnostic, sseStreamErrorDiagnostic } from "./client-diagnostics";
import { createSameOriginApiEventSource } from "./safe-event-source";
import { secureRandomInt } from "./secure-random";
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
// User finding #2456 — the wake-up replay burst; #3305 — tracked per SUBSCRIBER, not per run.
// A run with more than one subscriber must resume from the MINIMUM seq any of its subscribers has
// observed, never a shared per-run maximum: subscribeRunEvents does not reopen an already-live
// shared stream when a second subscriber joins the same runId, so that subscriber can start with
// no cursor of its own while an earlier subscriber's cursor is already high. Resuming past the
// newer subscriber's minimum would permanently withhold events it still needs — including a
// terminal event, which would leave its hook stuck below "terminal" forever. Over-delivery to the
// other subscriber is safe (each hook de-dupes via its own lastSeqRef); under-delivery is not, so
// the run-level cursor always fails toward replaying more. Entries live exactly as long as their
// subscriber is subscribed (deleted in subscribeRunEvents' cleanup).
const lastSeqBySubscriber = new Map<RunEventSubscriber, number>();
// Sticky for the lifetime of one tracked session (cleared only when subscriberCount() returns to
// zero, alongside sharedEventSource/lastSeqBySubscriber, in subscribeRunEvents' cleanup): once ANY
// event has been delivered to a subscriber THIS session, every later (re)connect should name
// every currently-subscribed run in `resume` — even one with no cursor of its own right now (e.g.
// its last subscriber just unsubscribed and a fresh one re-subscribed before the next reconnect).
// Gating on "at least one CURRENTLY-known cursor" instead would fall back to the plain,
// no-`resume` URL in that gap, which is safe but reintroduces the exact
// full-replay-of-every-run-on-the-server burst #2456 exists to remove for every OTHER run the
// client no longer names.
let everObservedEvent = false;
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
  everObservedEvent = true;
  for (const subscriber of subscribers) {
    const known = lastSeqBySubscriber.get(subscriber);
    if (known === undefined || event.seq > known) {
      lastSeqBySubscriber.set(subscriber, event.seq);
    }
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
  return Math.floor(base / 2) + secureRandomInt(Math.ceil(base / 2));
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

// Marker for a subscribed run with no observed event yet. The server treats an unnamed run as
// live-only, so a subscribed-but-uncursored run MUST still be named — otherwise its buffered
// history is dropped instead of replayed (subscribing while hidden or inside a reconnect gap
// reaches exactly that state). The marker asks for the full replay such a run needs.
const RESUME_FULL_REPLAY = "*";

// The cursor to resume one run from: the MINIMUM seq across its CURRENT subscribers, so a
// subscriber that joined an already-live shared stream (and so has no cursor of its own yet, or
// simply lags a longer-subscribed one) never has its missing history withheld by a co-subscriber
// that is further ahead. Any subscriber with no cursor at all forces the full-replay marker for
// the whole run — see the lastSeqBySubscriber declaration above for why under-delivery must never
// be risked.
function resumeCursorForRun(runId: string): string {
  let minSeq: number | undefined;
  for (const subscriber of subscribersByRunId.get(runId) ?? []) {
    const seq = lastSeqBySubscriber.get(subscriber);
    if (seq === undefined) return RESUME_FULL_REPLAY;
    if (minSeq === undefined || seq < minSeq) minSeq = seq;
  }
  return minSeq === undefined ? RESUME_FULL_REPLAY : String(minSeq);
}

// The stream URL for (re)connecting: once any event has ever been observed (`everObservedEvent`),
// name EVERY currently-subscribed run in a `resume` parameter — `runId:seq` for a known cursor,
// `runId:*` for a run not yet seen by every one of its current subscribers — so the server
// replays only unseen events without ever withholding a subscribed run's history, AND treats
// every OTHER run it knows about as live-only instead of replaying it needlessly. RunId encoding
// keeps a reserved ":" or "," inside a runId from corrupting the pair framing. Before anything has
// ever been observed (true first load), the plain URL keeps today's full-replay behavior — there
// is no cursor state worth naming yet.
function runEventsUrl(): string {
  if (!everObservedEvent) return RUN_EVENTS_URL;
  const runIds = [...subscribersByRunId.keys()];
  const cursors = runIds.map(
    (runId) => `${encodeURIComponent(runId)}:${resumeCursorForRun(runId)}`,
  );
  return `${RUN_EVENTS_URL}?resume=${cursors.join(",")}`;
}

function openSharedEventSource(): void {
  if (subscriberCount() === 0 || documentHidden() || sharedEventSource !== null) return;
  closeSharedEventSource();
  sharedEventSource = createSameOriginApiEventSource(runEventsUrl());
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
    reportClientDiagnostic(sseStreamErrorDiagnostic("run-events", sharedEventSource?.readyState));
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
    lastSeqBySubscriber.delete(subscriber);
    if (current?.size === 0) {
      subscribersByRunId.delete(runId);
    }
    if (subscriberCount() === 0) {
      clearReconnectTimer();
      closeSharedEventSource();
      // The tracked session is over: nobody is subscribed to anything. The NEXT subscriber
      // starts a genuinely fresh session, so `everObservedEvent` must not carry a stale "we've
      // seen traffic before" signal into it (see its declaration for why sticky-within-a-session
      // is otherwise the correct behaviour).
      everObservedEvent = false;
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
