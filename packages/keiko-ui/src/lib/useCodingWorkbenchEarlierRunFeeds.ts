"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityTool,
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

/**
 * The feeds of the runs before the shown one in the same task (`conversationId`), oldest first.
 * A feed is taken over when the shown run changes; one of another task is never returned.
 */
export function useCodingWorkbenchEarlierRunFeeds(input: {
  readonly runId: string | undefined;
  readonly conversationId: string | undefined;
  readonly feed: AvailableCodingSafeActivityFeed | null;
}): readonly AvailableCodingSafeActivityFeed[] {
  const { runId, conversationId, feed } = input;
  const [held, setHeld] = useState<readonly HeldFeed[]>([]);
  const lastRef = useRef<HeldFeed | null>(null);
  useEffect(() => {
    const last = lastRef.current;
    if (last !== null && last.feed.runId !== runId) {
      lastRef.current = null;
      setHeld((current) => retained(current, { ...last, feed: settledFeed(last.feed) }));
    }
    if (feed !== null && feed.runId === runId) lastRef.current = { conversationId, feed };
  }, [conversationId, feed, runId]);
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
