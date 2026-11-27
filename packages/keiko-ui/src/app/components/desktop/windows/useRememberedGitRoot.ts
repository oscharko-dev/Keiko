// The repository the person last chose in a Git window, kept for as long as the shell lives so that
// closing and reopening Git returns to it (W-4). The Git window persists its choice into its own
// cfg.projectPath, but a closed window's cfg is gone; this is the one place that outlives the window.
// It is browser-transient UI state under ADR-0027 (no new store); an open Git window's choice also
// survives a reload through the persisted layout.

import { useContext, useEffect, useRef, type RefObject } from "react";
import { WorkspaceStorageScopeContext } from "../hooks/workspace-storage";
import { isManagedTaskWorktreePath } from "./startingProjectRoot";
import type { AppWindow } from "./types";

/**
 * The repository a Git window currently shows: the frontmost one that names a repository. A managed
 * task worktree path is skipped: the window ignores it unless it is explicitly bound, so it is not
 * a repository the person chose and must not be replayed with a repository binding on reopen.
 */
export function frontmostGitRoot(wins: readonly AppWindow[] | null): string | undefined {
  if (wins === null) return undefined;
  let root: string | undefined;
  let z = Number.NEGATIVE_INFINITY;
  for (const win of wins) {
    if (win.type !== "governedGit" || win.z <= z) continue;
    const projectPath = win.cfg["projectPath"];
    if (
      typeof projectPath === "string" &&
      projectPath.trim().length > 0 &&
      !isManagedTaskWorktreePath(projectPath)
    ) {
      root = projectPath;
      z = win.z;
    }
  }
  return root;
}

/**
 * Tracks the repository chosen in the Git window; read `.current` when the rail opens Git. The memory
 * is keyed on the installation-scoped storage identity: a different identity starts empty.
 */
export function useRememberedGitRoot(
  wins: readonly AppWindow[] | null,
): RefObject<string | undefined> {
  const storageScope = useContext(WorkspaceStorageScopeContext);
  const remembered = useRef<string | undefined>(undefined);
  const rememberedScope = useRef<string | undefined>(storageScope);
  const current = frontmostGitRoot(wins);
  useEffect((): void => {
    if (rememberedScope.current !== storageScope) {
      rememberedScope.current = storageScope;
      remembered.current = undefined;
    }
    if (current !== undefined) remembered.current = current;
  }, [current, storageScope]);
  return remembered;
}
