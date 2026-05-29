"use client";

/**
 * Hook that opens an EventSource for a run's SSE stream (/api/runs/:runId/events).
 * Accumulates typed HarnessEvents, exposes {events, status, error}.
 * Supports Last-Event-ID resume and closes on terminal events.
 */

import { useEffect, useRef, useState } from "react";
import { TERMINAL_EVENT_TYPES, type HarnessEvent, type SseStatus } from "./types";

export interface UseSSEResult {
  events: HarnessEvent[];
  status: SseStatus;
  error: string | null;
}

export function useSSE(runId: string | null): UseSSEResult {
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [status, setStatus] = useState<SseStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  // Track the last seq we've seen for resume
  const lastSeqRef = useRef<number>(-1);

  useEffect(() => {
    if (runId === null) return;

    let es: EventSource | null = null;
    let cancelled = false;

    function openStream(): void {
      const url = `/api/runs/${encodeURIComponent(runId!)}/events`;
      // EventSource does not natively pass Last-Event-ID from JS; the browser sends it
      // automatically on reconnect when the server uses `id:` framing. We pass it explicitly
      // via a query param for the initial deep-link / late-subscribe case.
      const fullUrl =
        lastSeqRef.current >= 0
          ? `${url}?lastEventId=${lastSeqRef.current.toString()}`
          : url;

      es = new EventSource(fullUrl);

      es.onopen = () => {
        if (!cancelled) setStatus("live");
      };

      es.onerror = () => {
        if (cancelled) return;
        setStatus("error");
        setError("Stream disconnected. Attempting to reconnect…");
        // EventSource will reconnect automatically. If the run is terminal the server
        // closes permanently; the next open attempt will fail cleanly.
      };

      // Listen for all event types by routing through the generic message handler.
      // Per the SSE spec, named events require addEventListener; `onmessage` only fires
      // on unnamed messages. We register a wildcard handler pattern by overriding onerror
      // for now and using the built-in EventSource.
      //
      // Because SSE uses `event: <type>` framing, we must addEventListener per-type.
      // For a stable implementation we add a generic listener that handles any event type
      // the server sends by intercepting the raw MessageEvent.
      const handleEvent = (ev: MessageEvent): void => {
        if (cancelled) return;

        let parsed: HarnessEvent;
        try {
          parsed = JSON.parse(ev.data as string) as HarnessEvent;
        } catch {
          // malformed event — skip
          return;
        }

        lastSeqRef.current = parsed.seq;
        setEvents((prev) => [...prev, parsed]);

        if (TERMINAL_EVENT_TYPES.has(parsed.type)) {
          setStatus("terminal");
          es?.close();
        }
      };

      // The harness emits many event types. Rather than enumerate all of them here, we use a
      // catch-all by listening for the MessageEvent on the source. Named events still bubble as
      // MessageEvents on the source object. This is the standard EventSource pattern.
      //
      // NOTE: `addEventListener("message", ...)` catches UNNAMED events (no `event:` field).
      //       Named events need explicit listeners. We register named event listeners for all
      //       known HarnessEvent types.
      const EVENT_TYPES = [
        "run:started",
        "state:transition",
        "model:call:started",
        "model:call:completed",
        "model:call:failed",
        "tool:call:started",
        "tool:call:completed",
        "tool:call:failed",
        "reasoning:trace",
        "patch:proposed",
        "verification:result",
        "run:completed",
        "run:cancelled",
        "run:failed",
        "ready",
        // workflow events
        "started",
        "completed",
        "failed",
      ] as const;

      for (const evType of EVENT_TYPES) {
        es.addEventListener(evType, handleEvent as EventListenerOrEventListenerObject);
      }
    }

    openStream();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [runId]);

  return { events, status, error };
}
