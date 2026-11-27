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

/** The native tool that creates a task branch and switches the checkout onto it. */
const BRANCH_MOVE_TOOL = "keiko_git_branch";

/**
 * How many branch create/switch calls of the live feed succeeded. The checkout stands on another
 * branch after each, so a change of this count is the moment the run's branch chip must be read
 * again; a failed, denied or still pending call moves nothing (#4491).
 */
export function succeededBranchMoveCount(
  feed: UseCodingWorkbenchSafeActivityResult["feed"],
): number {
  let count = 0;
  for (const turn of feed?.turns ?? []) {
    for (const tool of turn.tools) {
      if (tool.tool === BRANCH_MOVE_TOOL && tool.state === "succeeded") count += 1;
    }
  }
  return count;
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
  // A turn at its tool bound keeps a constant settled count while the server displaces its oldest
  // call for each new one; the feed's monotonic loss counter is what keeps advancing then.
  const displaced = feed?.droppedEventCount ?? 0;
  if (cursor === null && settled === 0 && displaced === 0) return null;
  const displacedSuffix = displaced === 0 ? "" : `|d${String(displaced)}`;
  return `${cursor ?? "-"}|${String(settled)}${displacedSuffix}`;
}

/**
 * The Changes signal joined with the undo state of the newest turn. An undo or restore puts files
 * back without a runtime event or a settled tool, so without this the list kept showing the undone
 * file as changed. `undoStaged` is `undefined` while the run offers no undo.
 */
export function changesSignalWithUndo(
  signal: string | null,
  undoStaged: boolean | undefined,
): string | null {
  if (undoStaged === undefined) return signal;
  return `${signal ?? "-"}|u${undoStaged ? "1" : "0"}`;
}
