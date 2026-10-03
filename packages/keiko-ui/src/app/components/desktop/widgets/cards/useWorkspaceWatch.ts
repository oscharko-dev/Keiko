"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { EditorM7WatchEvent, EditorM7WatchHealth } from "@oscharko-dev/keiko-contracts";
import {
  parseEditorM7WatchEvent,
  parseEditorM7WatchSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/editor-m7";
import { refreshSharedEventSource, subscribeSharedEventSource } from "./sharedEventSource";

export interface WorkspaceWatchClientState {
  readonly refresh: () => void;
  readonly health: EditorM7WatchHealth;
  readonly sequence: number;
  readonly degradedReason: string | null;
  readonly snapshotRequired: boolean;
}

const WATCH_EVENT_TYPES = Object.freeze([
  "editor-watch:created",
  "editor-watch:changed",
  "editor-watch:deleted",
  "editor-watch:renamed",
  "editor-watch:rescan",
  "editor-watch:overflow",
  "editor-watch:snapshot",
  "editor-watch:snapshot-required",
  "ready",
] as const);

type WatchState = Omit<WorkspaceWatchClientState, "refresh">;

const INITIAL_STATE: WatchState = {
  health: "healthy",
  sequence: 0,
  degradedReason: null,
  snapshotRequired: false,
};

function watchEventsUrl(root: string): string {
  return `/api/editor/workspace-watch/events?root=${encodeURIComponent(root)}`;
}

function snapshotEvent(type: string): boolean {
  return type === "editor-watch:snapshot" || type === "editor-watch:snapshot-required";
}

function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

export function useWorkspaceWatch(
  root: string | undefined,
  onEvent: (event: EditorM7WatchEvent) => void,
): WorkspaceWatchClientState {
  const onEventRef = useRef(onEvent);
  const [state, setState] = useState<WatchState>(INITIAL_STATE);
  onEventRef.current = onEvent;

  const refresh = useCallback((): void => {
    if (root === undefined || root.length === 0) return;
    refreshSharedEventSource(watchEventsUrl(root));
  }, [root]);

  useEffect(() => {
    setState(INITIAL_STATE);
    if (root === undefined || root.length === 0) return;
    return subscribeSharedEventSource(watchEventsUrl(root), WATCH_EVENT_TYPES, (event) => {
      const parsed = watchStateFrom(event);
      if (parsed === null) return;
      setState((current) =>
        parsed.event !== undefined && parsed.event.sequence <= current.sequence
          ? current
          : parsed.state,
      );
      if (parsed.event !== undefined) onEventRef.current(parsed.event);
    });
  }, [root]);

  return { ...state, refresh };
}

function watchStateFrom(event: MessageEvent<string>): {
  readonly state: WatchState;
  readonly event?: EditorM7WatchEvent;
} | null {
  if (event.type === "ready") return null;
  const data = parseEventData(event.data);
  if (data === null) return null;
  if (snapshotEvent(event.type)) {
    const parsed = parseEditorM7WatchSnapshot(data);
    if (!parsed.ok) return null;
    return {
      state: {
        health: parsed.value.health,
        sequence: parsed.value.sequence,
        degradedReason: parsed.value.degradedReasons[0] ?? null,
        snapshotRequired: event.type === "editor-watch:snapshot-required",
      },
    };
  }
  const parsed = parseEditorM7WatchEvent(data);
  if (!parsed.ok) return null;
  return {
    state: {
      health: parsed.value.health ?? "healthy",
      sequence: parsed.value.sequence,
      degradedReason: parsed.value.reason ?? null,
      snapshotRequired: parsed.value.kind === "rescan" || parsed.value.kind === "overflow",
    },
    event: parsed.value,
  };
}
