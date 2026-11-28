import type { CodingSafeActivityFeed } from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchSafeActivityStatus } from "@/lib/useCodingWorkbenchSafeActivity";

function feedIsComplete(
  feed: CodingSafeActivityFeed & { readonly availability: "available" },
): boolean {
  return (
    !feed.truncated && feed.droppedEventCount === 0 && feed.turns.every((turn) => !turn.truncated)
  );
}

/**
 * Whether the run's activity record shows any tool call. `undefined` means the record cannot say,
 * and the recovery card then keeps its fail-safe wording that the last action may have gone through.
 * Only a channel that is live or in recovery speaks: every other status (loading, disconnected,
 * offline, error, unavailable, ended) may hold the feed from before the drop. A shortened feed or a
 * shortened turn lost calls, and a denied call may still have done partial work, so it counts as
 * started. `false` is what the record shows, not proof: a start event can be lost with the sidecar.
 */
export function anyToolStarted(
  status: CodingWorkbenchSafeActivityStatus,
  feed: CodingSafeActivityFeed | null,
  runId: string | undefined,
): boolean | undefined {
  if (status !== "live" && status !== "recovery") return undefined;
  if (feed?.availability !== "available" || runId === undefined || feed.runId !== runId)
    return undefined;
  if (feed.turns.some((turn) => turn.tools.length > 0)) return true;
  return feedIsComplete(feed) ? false : undefined;
}
