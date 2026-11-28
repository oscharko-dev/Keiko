"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityTool,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";

// U-11: a continuation starts a new run in the same task, and the server's projection holds one run
// at a time, so the feed of the run before it is replaced. Standalone OpenCode keeps every earlier
// turn's tool rows in the session view, a stopped turn's included, so the Workbench keeps the last
// feed it saw of each earlier run of the task it shows. It lives in the page only: Coding History
// keeps messages, not tool calls, and a reload has nothing more to restore than it ever had. The
// feed is the contract's own redacted projection, so keeping it keeps no reasoning that the feed
// does not already carry.
//
// The bound protects page memory. One feed is at most CODING_SAFE_ACTIVITY_MAX_UTF8_BYTES, so this
// many earlier runs stay far below a few megabytes; the oldest go first.
export const CODING_WORKBENCH_EARLIER_RUN_FEED_LIMIT = 32;

interface HeldFeed {
  readonly conversationId: string | undefined;
  readonly feed: AvailableCodingSafeActivityFeed;
  /** The run's state when its feed was last seen: only a terminal run is settled. */
  readonly runState: CodingWorkbenchRuntimeStateName | undefined;
}

/** A run in one of these states never carries on. */
export function terminalRunState(runState: CodingWorkbenchRuntimeStateName | undefined): boolean {
  return (
    runState === "succeeded" ||
    runState === "failed" ||
    runState === "cancelled" ||
    runState === "taken-over"
  );
}

const NO_FEEDS: readonly AvailableCodingSafeActivityFeed[] = [];

// A run that is over never carries on, so a call it left pending or running reads as cancelled.
function settledTool(tool: CodingSafeActivityTool): CodingSafeActivityTool {
  return tool.state === "pending" || tool.state === "running"
    ? { ...tool, state: "cancelled" }
    : tool;
}

/** The feed of a run that ended: no call is still shown as in flight, and no plan stays live. */
export function settledFeed(
  feed: AvailableCodingSafeActivityFeed,
): AvailableCodingSafeActivityFeed {
  const { plan: _plan, ...rest } = feed;
  return {
    ...rest,
    turns: feed.turns.map((turn) => ({ ...turn, tools: turn.tools.map(settledTool) })),
  };
}

function retained(held: readonly HeldFeed[], entry: HeldFeed): readonly HeldFeed[] {
  const others = held.filter((candidate) => candidate.feed.runId !== entry.feed.runId);
  return [...others, entry].slice(-CODING_WORKBENCH_EARLIER_RUN_FEED_LIMIT);
}

// A run that is not over keeps its rows as they were: nothing says its calls will not finish.
function carried(last: HeldFeed): HeldFeed {
  return terminalRunState(last.runState) ? { ...last, feed: settledFeed(last.feed) } : last;
}

/**
 * The feeds of the runs before the shown one in the same task (`conversationId`), oldest first.
 * A feed is taken over when the shown run changes; one of another task is never returned, and the
 * feeds of other tasks are dropped when the shown task changes. Without a task, none is kept.
 */
export function useCodingWorkbenchEarlierRunFeeds(input: {
  readonly runId: string | undefined;
  readonly runState?: CodingWorkbenchRuntimeStateName | undefined;
  readonly conversationId: string | undefined;
  readonly feed: AvailableCodingSafeActivityFeed | null;
}): readonly AvailableCodingSafeActivityFeed[] {
  const { runId, runState, conversationId, feed } = input;
  const [held, setHeld] = useState<readonly HeldFeed[]>([]);
  const lastRef = useRef<HeldFeed | null>(null);
  const conversationRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const last = lastRef.current;
    const leaving = last !== null && last.feed.runId !== runId ? last : null;
    if (leaving !== null) lastRef.current = null;
    const switched = conversationId !== undefined && conversationRef.current !== conversationId;
    if (conversationId !== undefined) conversationRef.current = conversationId;
    if (leaving !== null || switched) {
      setHeld((current) => {
        const next =
          leaving?.conversationId === undefined ? current : retained(current, carried(leaving));
        return conversationId === undefined
          ? next
          : next.filter((entry) => entry.conversationId === conversationId);
      });
    }
    if (feed !== null && feed.runId === runId) lastRef.current = { conversationId, feed, runState };
  }, [conversationId, feed, runId, runState]);
  return useMemo(
    () =>
      conversationId === undefined
        ? NO_FEEDS
        : held
            .filter(
              (entry) => entry.conversationId === conversationId && entry.feed.runId !== runId,
            )
            .map((entry) => entry.feed),
    [conversationId, held, runId],
  );
}
