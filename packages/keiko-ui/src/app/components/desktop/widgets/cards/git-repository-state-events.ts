export const GIT_REPOSITORY_STATE_INVALIDATED_EVENT = "keiko:git-repository-state-invalidated";

interface GitRepositoryStateInvalidationDetail {
  readonly root: string;
  readonly repositoryRoot?: string | undefined;
}

/**
 * Publishes a content-free signal that every Git-derived view for one repository must re-read.
 */
export function notifyGitRepositoryStateInvalidated(root: string, repositoryRoot?: string): void {
  if (root.length === 0) return;
  window.dispatchEvent(
    new CustomEvent<GitRepositoryStateInvalidationDetail>(GIT_REPOSITORY_STATE_INVALIDATED_EVENT, {
      detail: {
        root,
        ...(repositoryRoot !== undefined && repositoryRoot.length > 0 && repositoryRoot !== root
          ? { repositoryRoot }
          : {}),
      },
    }),
  );
}

/**
 * Returns the repository root carried by a valid invalidation event.
 */
export function gitRepositoryStateInvalidationRoot(event: Event): string | null {
  if (
    !(event instanceof CustomEvent) ||
    typeof event.detail !== "object" ||
    event.detail === null
  ) {
    return null;
  }
  const root = (event.detail as Record<string, unknown>).root;
  return typeof root === "string" && root.length > 0 ? root : null;
}

/**
 * Returns every requested and canonical root carried by a valid invalidation event.
 */
export function gitRepositoryStateInvalidationRoots(event: Event): readonly string[] {
  const root = gitRepositoryStateInvalidationRoot(event);
  if (root === null) return [];
  const repositoryRoot = (event as CustomEvent<Record<string, unknown>>).detail.repositoryRoot;
  if (
    typeof repositoryRoot !== "string" ||
    repositoryRoot.length === 0 ||
    repositoryRoot === root
  ) {
    return [root];
  }
  return [root, repositoryRoot];
}
