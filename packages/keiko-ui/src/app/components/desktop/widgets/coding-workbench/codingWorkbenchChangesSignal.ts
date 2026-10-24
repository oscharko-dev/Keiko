import type { CodingWorkbenchRuntimeSseEvent } from "@oscharko-dev/keiko-contracts";

import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";

// Tools that only read or reach outside the workspace: settling one cannot change the run's
// changed files, so it is no reason to read the git status again. Anything else — the native edit,
// write, patch and shell tools, a subagent, an MCP or plugin tool — may have changed the worktree.
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "skill",
  "todo",
  "question",
  "webfetch",
  "websearch",
  "keiko_git_status",
  "keiko_repository_search",
  "keiko_workspace_discover",
  "keiko_workspace_read",
]);

function latestEventCursor(events: readonly CodingWorkbenchRuntimeSseEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "status" || event?.eventKind === "diff-summarized") return event.cursor;
  }
  return null;
}

/** Tool calls that finished and may have changed the worktree, counted over the live feed. */
function settledWorkspaceToolCount(feed: UseCodingWorkbenchSafeActivityResult["feed"]): number {
  let count = 0;
  for (const turn of feed?.turns ?? []) {
    for (const tool of turn.tools) {
      if (tool.state === "pending" || tool.state === "running") continue;
      if (!READ_ONLY_TOOLS.has(tool.tool)) count += 1;
    }
  }
  return count;
}

/**
 * The value the Changes list re-reads the git status on when it changes (the hook debounces it).
 *
 * A supervised native run changes files through OpenCode's own tools, which emit neither a status
 * nor a diff-summarized runtime event, so the settled tool rows of the safe-activity feed join the
 * newest of those events. Streamed answer text is deliberately absent: it grows on every delta and
 * changes no file. `null` means nothing has happened that could change the workspace yet.
 */
export function changesRefreshSignal(
  events: readonly CodingWorkbenchRuntimeSseEvent[],
  feed: UseCodingWorkbenchSafeActivityResult["feed"],
): string | null {
  const cursor = latestEventCursor(events);
  const settled = settledWorkspaceToolCount(feed);
  if (cursor === null && settled === 0) return null;
  return `${cursor ?? "-"}|${String(settled)}`;
}
