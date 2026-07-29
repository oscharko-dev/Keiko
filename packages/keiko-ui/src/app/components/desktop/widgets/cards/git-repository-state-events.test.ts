import { describe, expect, it, vi } from "vitest";

import {
  GIT_REPOSITORY_STATE_INVALIDATED_EVENT,
  gitRepositoryStateInvalidationRoot,
  gitRepositoryStateInvalidationRoots,
  notifyGitRepositoryStateInvalidated,
} from "./git-repository-state-events";

describe("Git repository state invalidation events", () => {
  it("carries the requested and canonical repository roots that must be refreshed", () => {
    const listener = vi.fn<(event: Event) => void>();
    window.addEventListener(GIT_REPOSITORY_STATE_INVALIDATED_EVENT, listener);

    notifyGitRepositoryStateInvalidated("/repo/project", "/repo");

    expect(listener).toHaveBeenCalledOnce();
    const event = listener.mock.calls[0]?.[0] ?? new Event("missing");
    expect(gitRepositoryStateInvalidationRoot(event)).toBe("/repo/project");
    expect(gitRepositoryStateInvalidationRoots(event)).toEqual(["/repo/project", "/repo"]);
    expect((event as CustomEvent<unknown>).detail).toEqual({
      root: "/repo/project",
      repositoryRoot: "/repo",
    });
    window.removeEventListener(GIT_REPOSITORY_STATE_INVALIDATED_EVENT, listener);
  });

  it("rejects malformed and empty event details without publishing empty roots", () => {
    const listener = vi.fn<(event: Event) => void>();
    window.addEventListener(GIT_REPOSITORY_STATE_INVALIDATED_EVENT, listener);

    notifyGitRepositoryStateInvalidated("");

    expect(listener).not.toHaveBeenCalled();
    expect(
      gitRepositoryStateInvalidationRoot(new Event(GIT_REPOSITORY_STATE_INVALIDATED_EVENT)),
    ).toBeNull();
    expect(
      gitRepositoryStateInvalidationRoot(
        new CustomEvent(GIT_REPOSITORY_STATE_INVALIDATED_EVENT, { detail: {} }),
      ),
    ).toBeNull();
    expect(
      gitRepositoryStateInvalidationRoots(new Event(GIT_REPOSITORY_STATE_INVALIDATED_EVENT)),
    ).toEqual([]);
    window.removeEventListener(GIT_REPOSITORY_STATE_INVALIDATED_EVENT, listener);
  });
});
