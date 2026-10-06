import { useMemo } from "react";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityMessage,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";
import type { ChatMessage, CodingHistoryDetail } from "@oscharko-dev/keiko-contracts/bff-wire";
import { CODING_SAFE_ACTIVITY_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
import { settledRunState } from "./codingWorkbenchRunFacts";

// #3873 live review: after a reload a settled run showed only "Previous conversation" and
// "0 changed files". The runtime event stream is opened for live runs only, the server drops a
// settled run's ordinary events and expires its activity projection, so the timeline had nothing to
// show — not even how the run ended, although the restored snapshot carries exactly that. These
// helpers rebuild the run's timeline from what the server does keep: the settled snapshot and the
// conversation Coding History captured from the run's display projection.

function settledRunId(snapshot: CodingWorkbenchRuntimeSnapshot | null): string | undefined {
  return snapshot !== null && settledRunState(snapshot.state) ? snapshot.runId : undefined;
}

function heldSettlement(events: readonly CodingWorkbenchRuntimeSseEvent[], runId: string): boolean {
  return events.some(
    (event) => event.runId === runId && event.kind === "status" && settledRunState(event.state),
  );
}

/**
 * The run's events, completed with its settlement when the Workbench holds none: the settled
 * snapshot is the server's own terminal state, revision and failure code, shown as the terminal
 * status row the live stream would have delivered. A run whose settlement was streamed is unchanged.
 */
export function eventsWithRestoredSettlement(
  events: readonly CodingWorkbenchRuntimeSseEvent[],
  snapshot: CodingWorkbenchRuntimeSnapshot | null,
): readonly CodingWorkbenchRuntimeSseEvent[] {
  const runId = settledRunId(snapshot);
  if (snapshot === null || runId === undefined || heldSettlement(events, runId)) return events;
  const sequence = events.reduce(
    (next, event) => (event.runId === runId ? Math.max(next, event.sequence + 1) : next),
    0,
  );
  return [
    ...events,
    {
      schemaVersion: snapshot.schemaVersion,
      cursor: `${runId}:settled`,
      sequence,
      occurredAt: snapshot.updatedAt,
      kind: "status",
      runId,
      state: snapshot.state,
      revision: snapshot.revision,
      ...(snapshot.failureCode === undefined ? {} : { failureCode: snapshot.failureCode }),
    },
  ];
}

function activityMessage(message: ChatMessage): CodingSafeActivityMessage | undefined {
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  if (message.content.trim().length === 0) return undefined;
  return {
    messageId: message.id,
    role: message.role,
    occurredAt: new Date(message.timestamp).toISOString(),
    segments: [{ kind: "text", text: message.content, truncated: false }],
    truncated: false,
  };
}

/**
 * The run's activity feed, or — when the server no longer holds one for a settled run — the
 * conversation Coding History captured for it. Only the restored run's own messages enter its
 * timeline; earlier runs of the same task stay in the previous conversation. Coding History keeps
 * no tool calls or verification results, so a restored timeline never invents them.
 */
export function feedWithRestoredConversation(
  feed: AvailableCodingSafeActivityFeed | null,
  snapshot: CodingWorkbenchRuntimeSnapshot | null,
  detail: CodingHistoryDetail | null,
): AvailableCodingSafeActivityFeed | null {
  const runId = settledRunId(snapshot);
  if (feed !== null || snapshot === null || runId === undefined || detail === null) return feed;
  const messages = detail.messages
    .filter((message) => message.runId === runId)
    .map(activityMessage)
    .filter((message): message is CodingSafeActivityMessage => message !== undefined);
  if (messages.length === 0) return feed;
  return {
    schemaVersion: CODING_SAFE_ACTIVITY_CONTRACT_VERSION,
    availability: "available",
    runId,
    updatedAt: snapshot.updatedAt,
    turns: [{ turnId: `${runId}:restored`, messages, tools: [], truncated: false }],
    truncated: false,
    droppedEventCount: 0,
  };
}

export interface RestoredRunTimeline {
  readonly events: readonly CodingWorkbenchRuntimeSseEvent[];
  readonly activity: UseCodingWorkbenchSafeActivityResult;
}

/** The timeline input for the shown run, restored from its snapshot and history after a reload. */
export function useRestoredRunTimeline(
  events: readonly CodingWorkbenchRuntimeSseEvent[],
  snapshot: CodingWorkbenchRuntimeSnapshot | null,
  activity: UseCodingWorkbenchSafeActivityResult,
  detail: CodingHistoryDetail | null,
): RestoredRunTimeline {
  const restoredEvents = useMemo(
    () => eventsWithRestoredSettlement(events, snapshot),
    [events, snapshot],
  );
  const feed = useMemo(
    () => feedWithRestoredConversation(activity.feed, snapshot, detail),
    [activity.feed, detail, snapshot],
  );
  return {
    events: restoredEvents,
    activity: feed === activity.feed ? activity : { ...activity, feed },
  };
}
