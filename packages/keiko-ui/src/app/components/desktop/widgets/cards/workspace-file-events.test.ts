import { describe, expect, it, vi } from "vitest";

import {
  WORKSPACE_FILE_MUTATED_EVENT,
  notifyWorkspaceFileMutated,
  workspaceFileMutationRoot,
} from "./workspace-file-events";

describe("workspace file mutation events", () => {
  it("carries only the bound workspace root", () => {
    const listener = vi.fn<(event: Event) => void>();
    window.addEventListener(WORKSPACE_FILE_MUTATED_EVENT, listener);

    notifyWorkspaceFileMutated("/repo");

    expect(listener).toHaveBeenCalledOnce();
    expect(workspaceFileMutationRoot(listener.mock.calls[0]?.[0] ?? new Event("missing"))).toBe(
      "/repo",
    );
    window.removeEventListener(WORKSPACE_FILE_MUTATED_EVENT, listener);
  });

  it("rejects malformed and empty event details", () => {
    expect(workspaceFileMutationRoot(new Event(WORKSPACE_FILE_MUTATED_EVENT))).toBeNull();
    expect(
      workspaceFileMutationRoot(new CustomEvent(WORKSPACE_FILE_MUTATED_EVENT, { detail: {} })),
    ).toBeNull();
  });
});
