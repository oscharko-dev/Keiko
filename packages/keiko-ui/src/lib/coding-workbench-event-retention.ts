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
export const CODING_WORKBENCH_EVENT_STREAM_STALE_MS = 35_000;

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

export interface CodingWorkbenchRuntimeStreamSessionOptions {
  readonly staleAfterMs?: number | undefined;
  readonly createEventSource?: ((runId: string, cursor?: string) => EventSource) | undefined;
}

export interface CodingWorkbenchRuntimeStreamSession {
  readonly close: () => void;
}

interface RuntimeEventSourceBinding {
  readonly source: EventSource;
  readonly receive: EventListener;
  readonly reset: EventListener;
  readonly heartbeat: EventListener;
}

class RuntimeEventStreamSession implements CodingWorkbenchRuntimeStreamSession {
  private source: EventSource | undefined;
  private sourceBinding: RuntimeEventSourceBinding | undefined;
  private pending: CodingWorkbenchRuntimeSseEvent[] = [];
  private pendingResnapshot = false;
  private latestCursor = "";
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  public constructor(
    private readonly runId: string,
    private readonly handlers: CodingWorkbenchRuntimeStreamHandlers,
    private readonly staleAfterMs: number,
    private readonly createEventSource: (runId: string, cursor?: string) => EventSource,
  ) {
    this.connect();
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachSource();
    if (this.batchTimer !== undefined) clearTimeout(this.batchTimer);
    if (this.watchdogTimer !== undefined) clearTimeout(this.watchdogTimer);
    this.pending = [];
    this.pendingResnapshot = false;
  }

  private connect(): void {
    this.detachSource();
    const source = this.createEventSource(
      this.runId,
      this.latestCursor.length === 0 ? undefined : this.latestCursor,
    );
    this.source = source;
    source.onopen = (): void => {
      if (this.source !== source) return;
      this.armWatchdog();
      this.handlers.onOpen();
    };
    source.onerror = (): void => {
      if (this.source !== source) return;
      this.handlers.onError(new Error("The runtime event stream is reconnecting."));
    };
    const receive: EventListener = (event) => {
      if (this.source === source) this.receive(event as MessageEvent<string>);
    };
    const reset: EventListener = () => {
      if (this.source === source) this.handleReset();
    };
    const heartbeat: EventListener = () => {
      if (this.source === source) this.handleHeartbeat();
    };
    this.sourceBinding = { source, receive, reset, heartbeat };
    source.addEventListener("status", receive);
    source.addEventListener("runtime-event", receive);
    source.addEventListener("reset", reset);
    source.addEventListener("heartbeat", heartbeat);
    this.armWatchdog();
  }

  private detachSource(): void {
    const binding = this.sourceBinding;
    this.source = undefined;
    this.sourceBinding = undefined;
    if (binding === undefined) return;
    binding.source.onopen = null;
    binding.source.onerror = null;
    binding.source.removeEventListener("status", binding.receive);
    binding.source.removeEventListener("runtime-event", binding.receive);
    binding.source.removeEventListener("reset", binding.reset);
    binding.source.removeEventListener("heartbeat", binding.heartbeat);
    binding.source.close();
  }

  private readonly receive = (message: MessageEvent<string>): void => {
    this.armWatchdog();
    try {
      const event = parseCodingWorkbenchRuntimeEvent(message.data);
      if (event.runId !== this.runId) return;
      this.latestCursor = event.cursor;
      if (event.kind === "runtime-event" && event.eventKind === "observation-streamed") {
        this.pending.push(event);
        this.batchTimer ??= setTimeout(() => {
          this.batchTimer = undefined;
          this.flush();
        }, CODING_WORKBENCH_OBSERVATION_BATCH_MS);
        return;
      }
      if (this.pending.length > 0) {
        this.pending.push(event);
        this.pendingResnapshot = true;
        return;
      }
      this.handlers.onEvents([event], event.cursor, true);
    } catch (error) {
      this.handlers.onError(error);
    }
  };

  private readonly handleReset = (): void => {
    this.close();
    void this.handlers.onReset();
  };

  private readonly handleHeartbeat = (): void => {
    this.armWatchdog();
  };

  private flush(): void {
    if (this.batchTimer !== undefined) clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    if (this.pending.length === 0) return;
    const events = this.pending;
    const resnapshot = this.pendingResnapshot;
    this.pending = [];
    this.pendingResnapshot = false;
    this.handlers.onEvents(events, this.latestCursor, resnapshot);
  }

  private armWatchdog(): void {
    if (this.closed) return;
    if (this.watchdogTimer !== undefined) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = undefined;
      this.reconnectStaleStream();
    }, this.staleAfterMs);
  }

  private reconnectStaleStream(): void {
    if (this.closed) return;
    try {
      this.flush();
      this.connect();
    } catch (error) {
      this.handlers.onError(error);
      this.armWatchdog();
    }
  }
}

export function createCodingWorkbenchRuntimeStreamSession(
  runId: string,
  handlers: CodingWorkbenchRuntimeStreamHandlers,
  options: CodingWorkbenchRuntimeStreamSessionOptions = {},
): CodingWorkbenchRuntimeStreamSession {
  const staleAfterMs =
    Number.isFinite(options.staleAfterMs) && (options.staleAfterMs ?? 0) > 0
      ? (options.staleAfterMs ?? CODING_WORKBENCH_EVENT_STREAM_STALE_MS)
      : CODING_WORKBENCH_EVENT_STREAM_STALE_MS;
  return new RuntimeEventStreamSession(
    runId,
    handlers,
    staleAfterMs,
    options.createEventSource ?? createCodingWorkbenchRuntimeEventSource,
  );
}

export function useCodingWorkbenchRuntimeEventStream(
  runId: string | undefined,
  epoch: number,
  handlers: CodingWorkbenchRuntimeStreamHandlers,
  staleAfterMs = CODING_WORKBENCH_EVENT_STREAM_STALE_MS,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    if (runId === undefined) return;
    const releaseCapacity = reserveInteractiveBrowserStreamCapacity();
    let session: CodingWorkbenchRuntimeStreamSession;
    try {
      session = createCodingWorkbenchRuntimeStreamSession(
        runId,
        {
          onOpen: () => handlersRef.current.onOpen(),
          onEvents: (events, cursor, resnapshot) =>
            handlersRef.current.onEvents(events, cursor, resnapshot),
          onError: (error) => handlersRef.current.onError(error),
          onReset: () => handlersRef.current.onReset(),
        },
        { staleAfterMs },
      );
    } catch (error) {
      releaseCapacity();
      handlersRef.current.onError(error);
      return;
    }
    return (): void => {
      session.close();
      releaseCapacity();
    };
  }, [epoch, runId, staleAfterMs]);
}
