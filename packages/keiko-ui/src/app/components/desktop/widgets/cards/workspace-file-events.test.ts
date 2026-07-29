import { describe, expect, it, vi } from "vitest";

import {
  WORKSPACE_FILE_MUTATED_EVENT,
  notifyWorkspaceFileMutated,
  workspaceFileMutationDetail,
  workspaceFileMutationRoot,
  workspaceFileMutationRoots,
} from "./workspace-file-events";

describe("workspace file mutation events", () => {
  it("carries content-free mutation metadata for requested and canonical roots", (): void => {
    const listener = vi.fn<(event: Event) => void>();
    window.addEventListener(WORKSPACE_FILE_MUTATED_EVENT, listener);

    try {
      notifyWorkspaceFileMutated("/repo/alias", {
        kind: "changed",
        provenance: "local",
        relativePath: "src/app.ts",
        repositoryRoot: "/repo",
        sequence: 42,
      });

      expect(listener).toHaveBeenCalledOnce();
      const event = listener.mock.calls[0]?.[0] ?? new Event("missing");
      expect(workspaceFileMutationRoot(event)).toBe("/repo/alias");
      expect(workspaceFileMutationRoots(event)).toEqual(["/repo/alias", "/repo"]);
      expect(workspaceFileMutationDetail(event)).toEqual({
        root: "/repo/alias",
        repositoryRoot: "/repo",
        kind: "changed",
        provenance: "local",
        relativePath: "src/app.ts",
        sequence: 42,
      });
    } finally {
      window.removeEventListener(WORKSPACE_FILE_MUTATED_EVENT, listener);
    }
  });

  it("rejects malformed and empty event details", (): void => {
    expect(workspaceFileMutationRoot(new Event(WORKSPACE_FILE_MUTATED_EVENT))).toBeNull();
    expect(
      workspaceFileMutationRoot(new CustomEvent(WORKSPACE_FILE_MUTATED_EVENT, { detail: {} })),
    ).toBeNull();
    expect(workspaceFileMutationRoots(new Event(WORKSPACE_FILE_MUTATED_EVENT))).toEqual([]);
    expect(
      workspaceFileMutationRoots(
        new CustomEvent(WORKSPACE_FILE_MUTATED_EVENT, {
          detail: { root: "/repo", repositoryRoot: "" },
        }),
      ),
    ).toEqual(["/repo"]);
  });
});
