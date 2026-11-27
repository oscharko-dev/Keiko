import type { ProjectWithAvailability } from "@oscharko-dev/keiko-contracts/bff-wire";

/**
 * The folder a window may start in when the person has chosen none: the chat session's project,
 * but only while it exists and the read surface lets the person use it. A project the server marks
 * `readable: false` stays listed and can be chosen, but is never the starting project (#4371).
 */
export function startingProjectRoot(project: ProjectWithAvailability | null): string | null {
  return project?.available === true && project.readable !== false ? project.path : null;
}

/** The listed projects a window may start in, in list order; a refused one stays out of the defaults. */
export function startingProjects(
  projects: readonly ProjectWithAvailability[],
): readonly ProjectWithAvailability[] {
  return projects.filter((project) => startingProjectRoot(project) !== null);
}

/** The paths of {@link startingProjects}, in list order. */
export function startingProjectPaths(
  projects: readonly ProjectWithAvailability[],
): readonly string[] {
  return startingProjects(projects).map((project) => project.path);
}

/** A task's managed worktree: an internal run detail that Git never shows as repository truth. */
export function isManagedTaskWorktreePath(root: string): boolean {
  const normalized = root.replaceAll("\\", "/");
  return normalized.includes("/.keiko/") && normalized.includes("/task-workspaces/");
}

/** Why a remembered Git repository was not reopened; a closed vocabulary, never a path. */
export type GitReopenFallbackReason =
  "remembered-unavailable" | "remembered-unreadable" | "remembered-managed-worktree";

export interface GitReopenDecision {
  readonly root: string | undefined;
  /** Set only when a remembered repository existed and was passed over. */
  readonly fallbackReason?: GitReopenFallbackReason;
}

/**
 * The repository a Git window opens on when the rail opens it fresh (W-4). The rule, in order:
 *
 * 1. the repository the person last chose in a Git window (`remembered`), unless it is a managed
 *    task worktree or the project list lists it as gone or refused (unavailable, or `readable:
 *    false`). A path the list does not carry yet is kept: the Git window reads it through its own,
 *    fresher list and refuses it visibly, without any repository operation, when it is truly gone,
 *    so a repository just opened from the Git window is not lost to a stale shell list;
 * 2. otherwise the starting project (`fallback`: the chat session's project that the read surface
 *    allows), which stands for the active workspace's repository. A managed task worktree is never
 *    used: Git shows repository truth, not run internals.
 *
 * `root` is `undefined` when neither applies, so the window opens on its own empty state.
 */
export function decideGitReopen(
  remembered: string | undefined,
  projects: readonly ProjectWithAvailability[],
  fallback: string | undefined,
): GitReopenDecision {
  if (remembered === undefined) return { root: fallback };
  if (isManagedTaskWorktreePath(remembered)) {
    return { root: fallback, fallbackReason: "remembered-managed-worktree" };
  }
  const listed = projects.find((project) => project.path === remembered);
  if (listed === undefined || startingProjectRoot(listed) !== null) return { root: remembered };
  return {
    root: fallback,
    fallbackReason: listed.available === true ? "remembered-unreadable" : "remembered-unavailable",
  };
}
