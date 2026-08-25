"use client";

import type { CodingWorkbenchRuntimeSseEvent } from "@oscharko-dev/keiko-contracts";
import { useEffect, useReducer } from "react";

import type { MessageKey } from "@/lib/i18n-messages.en";

export type ActivityType =
  "step" | "approval" | "approved" | "rejected" | "stopped" | "open" | "run" | "delivery";

export interface ActivityEvent {
  id?: string;
  type: ActivityType;
  text?: string;
  labelKey?: MessageKey;
  agent?: string;
  tool?: string;
  time: number;
}

const STORE_KEY = "__keikoActivity";
const EVENT_NAME = "keiko-activity";
const MAX_EVENTS = 120;

type RuntimeEvent = Extract<CodingWorkbenchRuntimeSseEvent, { kind: "runtime-event" }>;

const RUNTIME_EVENT_PRESENTATION: Record<
  RuntimeEvent["eventKind"],
  { type: ActivityType; labelKey: MessageKey }
> = {
  "runtime-started": { type: "run", labelKey: "activity.event.runtimeStarted" },
  "runtime-stopped": { type: "stopped", labelKey: "activity.event.runtimeStopped" },
  "runtime-health": { type: "step", labelKey: "activity.event.runtimeHealth" },
  "task-submitted": { type: "run", labelKey: "activity.event.taskSubmitted" },
  "observation-streamed": { type: "step", labelKey: "activity.event.observationStreamed" },
  "permission-requested": { type: "approval", labelKey: "activity.event.permissionRequested" },
  "diff-summarized": { type: "step", labelKey: "activity.event.diffSummarized" },
  "verification-summarized": {
    type: "step",
    labelKey: "activity.event.verificationSummarized",
  },
  "artifact-produced": { type: "delivery", labelKey: "activity.event.artifactProduced" },
  "research-performed": { type: "step", labelKey: "activity.event.researchPerformed" },
  "skill-invoked": { type: "step", labelKey: "activity.event.skillInvoked" },
  "child-run-started": { type: "run", labelKey: "activity.event.childRunStarted" },
  "child-run-completed": { type: "step", labelKey: "activity.event.childRunCompleted" },
  "failure-redacted": { type: "rejected", labelKey: "activity.event.failureRedacted" },
};

declare global {
  interface Window {
    [STORE_KEY]?: ActivityEvent[];
  }
}

function notifyActivityChanged(): void {
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

function appendActivity(event: ActivityEvent): void {
  const current = window[STORE_KEY] ?? [];
  if (event.id !== undefined && current.some((candidate) => candidate.id === event.id)) return;
  window[STORE_KEY] = [event, ...current].slice(0, MAX_EVENTS);
  notifyActivityChanged();
}

export function logActivity(event: Omit<ActivityEvent, "time">): void {
  appendActivity({ ...event, time: Date.now() });
}

export function logRuntimeActivityEvents(events: readonly CodingWorkbenchRuntimeSseEvent[]): void {
  for (const event of events) {
    if (event.kind !== "runtime-event") continue;
    const presentation = RUNTIME_EVENT_PRESENTATION[event.eventKind];
    appendActivity({
      id: `${event.runId}:${event.cursor}`,
      type: presentation.type,
      labelKey: presentation.labelKey,
      agent: "runtime",
      time: Date.parse(event.occurredAt),
    });
  }
}

export function getActivity(): ActivityEvent[] {
  return typeof window === "undefined" ? [] : (window[STORE_KEY] ?? []);
}

export function useActivitySubscription(): ActivityEvent[] {
  const [, increment] = useReducer((value: number): number => value + 1, 0);
  useEffect(() => {
    window.addEventListener(EVENT_NAME, increment);
    return (): void => window.removeEventListener(EVENT_NAME, increment);
  }, []);
  return getActivity();
}
