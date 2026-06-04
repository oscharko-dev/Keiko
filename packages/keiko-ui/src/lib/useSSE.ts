"use client";

/**
 * Hook that opens an EventSource for a run's SSE stream (/api/runs/:runId/events).
 * Accumulates typed HarnessEvents, exposes {events, status, error}.
 * Supports Last-Event-ID resume and closes on terminal events.
 */

import { useEffect, useRef, useState } from "react";
import {
  ALL_SSE_EVENT_TYPES,
  TERMINAL_EVENT_TYPES,
  type HarnessEvent,
  type SseStatus,
} from "./types";

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

    // FIX D: Reset all accumulated state when runId changes so a new run view
    // does not inherit previous run's events or resume cursor. This runs
    // synchronously before the EventSource opens, giving the UI a clean slate.
    setEvents([]);
    setStatus("connecting");
    setError(null);
    lastSeqRef.current = -1;

    let es: EventSource | null = null;
    let cancelled = false;

    function openStream(): void {
      const url = `/api/runs/${encodeURIComponent(runId!)}/events`;
      // EventSource does not natively pass Last-Event-ID from JS; the browser sends it
      // automatically on reconnect when the server uses `id:` framing. We pass it explicitly
      // via a query param for the initial deep-link / late-subscribe case.
      const fullUrl =
        lastSeqRef.current >= 0 ? `${url}?lastEventId=${lastSeqRef.current.toString()}` : url;

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

      // FIX C: Register a listener for every named SSE event type the BFF can emit.
      // Per the SSE spec, `onmessage` only fires for unnamed events (no `event:` field).
      // Named events require an explicit addEventListener call for each type name.
      // ALL_SSE_EVENT_TYPES is the single source of truth for the full set — derived from
      // src/harness/types.ts, src/workflows/unit-tests/events.ts, and
      // src/workflows/bug-investigation/events.ts. Adding a new workflow event type to
      // that array is the only change required to cover it here.
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

        // FIX E: TERMINAL_EVENT_TYPES now includes workflow:completed/failed and
        // bug:completed/failed so workflow and bug runs reach terminal state properly.
        if (TERMINAL_EVENT_TYPES.has(parsed.type)) {
          setStatus("terminal");
          es?.close();
        }
      };

      for (const evType of ALL_SSE_EVENT_TYPES) {
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
