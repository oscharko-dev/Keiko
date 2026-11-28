import type { CodingSafeActivityFeed } from "@oscharko-dev/keiko-contracts";

/**
 * Whether any tool call of this run had started, read from the run's own activity feed. `undefined`
 * means the feed cannot say (absent, another run's, or shortened), and the recovery card then keeps
 * its fail-safe wording that the last action may have gone through. A denied call never ran.
 */
export function anyToolStarted(
  feed: CodingSafeActivityFeed | null,
  runId: string | undefined,
): boolean | undefined {
  if (feed?.availability !== "available" || runId === undefined || feed.runId !== runId)
    return undefined;
  const started = feed.turns.some((turn) => turn.tools.some((tool) => tool.state !== "denied"));
  if (started) return true;
  return feed.truncated || feed.droppedEventCount > 0 ? undefined : false;
}
