"use client";

import { useEffect, useRef } from "react";
import type {
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import {
  createCodingWorkbenchRuntimeEventSource,
  parseCodingWorkbenchRuntimeEvent,
} from "./coding-workbench-runtime-api";
import { reserveInteractiveBrowserStreamCapacity } from "./browser-stream-capacity";

export const CODING_WORKBENCH_EVENT_RETENTION_LIMIT = 500;
export const CODING_WORKBENCH_OBSERVATION_BATCH_MS = 100;

const TERMINAL_STATES = new Set<CodingWorkbenchRuntimeStateName>([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
] as const);

/** Approval, terminal, and recovery containment facts outlive ordinary observations when bounded. */
export function isPinnedCodingWorkbenchRuntimeEvent(
  event: CodingWorkbenchRuntimeSseEvent,
): boolean {
  if (event.state === "awaiting-approval" || event.state === "recovery-required") return true;
  if (TERMINAL_STATES.has(event.state)) return true;
  return event.kind === "runtime-event" && event.eventKind === "permission-requested";
}

function uniqueByCursor(
  events: readonly CodingWorkbenchRuntimeSseEvent[],
): readonly CodingWorkbenchRuntimeSseEvent[] {
  const byCursor = new Map<string, CodingWorkbenchRuntimeSseEvent>();
  for (const event of events) byCursor.set(`${event.runId}\u0000${event.cursor}`, event);
  return [...byCursor.values()].sort((left, right) => left.sequence - right.sequence);
}

export function retainCodingWorkbenchRuntimeEvents(
  current: readonly CodingWorkbenchRuntimeSseEvent[],
  incoming: readonly CodingWorkbenchRuntimeSseEvent[],
  limit = CODING_WORKBENCH_EVENT_RETENTION_LIMIT,
): readonly CodingWorkbenchRuntimeSseEvent[] {
  if (!Number.isSafeInteger(limit) || limit < 1) return [];
  const merged = uniqueByCursor([...current, ...incoming]);
  if (merged.length <= limit) return merged;
  const pinned = merged.filter(isPinnedCodingWorkbenchRuntimeEvent);
  if (pinned.length >= limit) return pinned.slice(-limit);
  const ordinary = merged.filter((event) => !isPinnedCodingWorkbenchRuntimeEvent(event));
  const kept = [...ordinary.slice(-(limit - pinned.length)), ...pinned];
  return kept.sort((left, right) => left.sequence - right.sequence);
}

export interface CodingWorkbenchRuntimeStreamHandlers {
  readonly onOpen: () => void;
  readonly onEvents: (
    events: readonly CodingWorkbenchRuntimeSseEvent[],
    cursor: string,
    resnapshot: boolean,
  ) => void;
  readonly onError: (error: unknown) => void;
  readonly onReset: () => Promise<void>;
}

export function useCodingWorkbenchRuntimeEventStream(
  runId: string | undefined,
  epoch: number,
  handlers: CodingWorkbenchRuntimeStreamHandlers,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    if (runId === undefined) return;
    const releaseCapacity = reserveInteractiveBrowserStreamCapacity();
    let source: EventSource;
    try {
      source = createCodingWorkbenchRuntimeEventSource(runId);
    } catch (error) {
      releaseCapacity();
      handlersRef.current.onError(error);
      return;
    }
    let pending: CodingWorkbenchRuntimeSseEvent[] = [];
    let latestCursor = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
      if (pending.length === 0) return;
      const events = pending;
      pending = [];
      handlersRef.current.onEvents(events, latestCursor, false);
    };
    const receive = (message: MessageEvent<string>): void => {
      try {
        const event = parseCodingWorkbenchRuntimeEvent(message.data);
        if (event.runId !== runId) return;
        latestCursor = event.cursor;
        if (event.kind === "runtime-event" && event.eventKind === "observation-streamed") {
          pending.push(event);
          timer ??= setTimeout(() => {
            timer = undefined;
            flush();
          }, CODING_WORKBENCH_OBSERVATION_BATCH_MS);
          return;
        }
        handlersRef.current.onEvents([event], event.cursor, true);
      } catch (error) {
        handlersRef.current.onError(error);
      }
    };
    source.onopen = handlersRef.current.onOpen;
    source.onerror = () =>
      handlersRef.current.onError(new Error("The runtime event stream is reconnecting."));
    source.addEventListener("status", receive as EventListener);
    source.addEventListener("runtime-event", receive as EventListener);
    source.addEventListener("reset", () => {
      source.close();
      void handlersRef.current.onReset();
    });
    return (): void => {
      source.close();
      releaseCapacity();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [epoch, runId]);
}
