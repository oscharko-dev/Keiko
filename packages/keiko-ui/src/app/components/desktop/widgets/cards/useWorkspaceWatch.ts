"use client";

import { useEffect, useRef, useState } from "react";

import {
  parseEditorM7WatchEvent,
  parseEditorM7WatchSnapshot,
  type EditorM7WatchEvent,
  type EditorM7WatchHealth,
} from "@oscharko-dev/keiko-contracts";
import { subscribeSharedEventSource } from "./sharedEventSource";

export interface WorkspaceWatchClientState {
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

const INITIAL_STATE: WorkspaceWatchClientState = {
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
  const [state, setState] = useState<WorkspaceWatchClientState>(INITIAL_STATE);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (root === undefined || root.length === 0) {
      setState(INITIAL_STATE);
      return;
    }
    return subscribeSharedEventSource(watchEventsUrl(root), WATCH_EVENT_TYPES, (event) => {
      if (event.type === "ready") return;
      const data = parseEventData(event.data);
      if (data === null) return;
      if (snapshotEvent(event.type)) {
        const parsed = parseEditorM7WatchSnapshot(data);
        if (!parsed.ok) return;
        setState({
          health: parsed.value.health,
          sequence: parsed.value.sequence,
          degradedReason: parsed.value.degradedReasons[0] ?? null,
          snapshotRequired: event.type === "editor-watch:snapshot-required",
        });
        return;
      }
      const parsed = parseEditorM7WatchEvent(data);
      if (!parsed.ok) return;
      setState({
        health: parsed.value.health ?? "healthy",
        sequence: parsed.value.sequence,
        degradedReason: parsed.value.reason ?? null,
        snapshotRequired: parsed.value.kind === "rescan" || parsed.value.kind === "overflow",
      });
      onEventRef.current(parsed.value);
    });
  }, [root]);

  return state;
}
