// When the Git window re-reads the selected repository's status: Keiko's own repository-state
// invalidation, a workspace file mutation (an Editor save, or a Coding run's changes read with
// `agent` provenance, #4103 F3), or the page regaining focus after a change made outside Keiko's
// windows, as the Files window does. The events name roots; only the selected repository or its
// canonical repository root refreshes this window.

import { useEffect } from "react";
import {
  GIT_REPOSITORY_STATE_INVALIDATED_EVENT,
  gitRepositoryStateInvalidationRoots,
} from "../git-repository-state-events";
import { WORKSPACE_FILE_MUTATED_EVENT, workspaceFileMutationRoots } from "../workspace-file-events";

type RootsOfEvent = (event: Event) => readonly string[];

const REPOSITORY_ROOT_EVENTS: readonly (readonly [string, RootsOfEvent])[] = [
  [GIT_REPOSITORY_STATE_INVALIDATED_EVENT, gitRepositoryStateInvalidationRoots],
  [WORKSPACE_FILE_MUTATED_EVENT, workspaceFileMutationRoots],
];

export function useRepositoryStatusRefresh(
  selectedPath: string | null,
  repositoryRoot: string | null | undefined,
  refresh: () => void,
): void {
  useEffect((): (() => void) => {
    const canonicalRoot = repositoryRoot ?? null;
    const namesThisRepository = (roots: readonly string[]): boolean =>
      roots.some(
        (root): boolean =>
          root === selectedPath || (canonicalRoot !== null && root === canonicalRoot),
      );
    const listeners = REPOSITORY_ROOT_EVENTS.map(
      ([name, rootsOf]): readonly [string, (event: Event) => void] => {
        const listener = (event: Event): void => {
          if (namesThisRepository(rootsOf(event))) refresh();
        };
        window.addEventListener(name, listener);
        return [name, listener] as const;
      },
    );
    return (): void => {
      for (const [name, listener] of listeners) window.removeEventListener(name, listener);
    };
  }, [refresh, repositoryRoot, selectedPath]);

  useEffect((): (() => void) | undefined => {
    if (selectedPath === null) return undefined;
    window.addEventListener("focus", refresh);
    return (): void => window.removeEventListener("focus", refresh);
  }, [refresh, selectedPath]);
}
