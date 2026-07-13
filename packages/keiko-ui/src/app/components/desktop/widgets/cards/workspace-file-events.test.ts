import { describe, expect, it, vi } from "vitest";

import {
  WORKSPACE_FILE_MUTATED_EVENT,
  notifyWorkspaceFileMutated,
  workspaceFileMutationDetail,
  workspaceFileMutationRoot,
} from "./workspace-file-events";

describe("workspace file mutation events", () => {
  it("carries content-free mutation metadata for the bound workspace root", () => {
    const listener = vi.fn<(event: Event) => void>();
    window.addEventListener(WORKSPACE_FILE_MUTATED_EVENT, listener);

    notifyWorkspaceFileMutated("/repo", {
      kind: "changed",
      provenance: "local",
      relativePath: "src/app.ts",
      sequence: 42,
    });

    expect(listener).toHaveBeenCalledOnce();
    const event = listener.mock.calls[0]?.[0] ?? new Event("missing");
    expect(workspaceFileMutationRoot(event)).toBe("/repo");
    expect(workspaceFileMutationDetail(event)).toEqual({
      root: "/repo",
      kind: "changed",
      provenance: "local",
      relativePath: "src/app.ts",
      sequence: 42,
    });
    window.removeEventListener(WORKSPACE_FILE_MUTATED_EVENT, listener);
  });

  it("rejects malformed and empty event details", () => {
    expect(workspaceFileMutationRoot(new Event(WORKSPACE_FILE_MUTATED_EVENT))).toBeNull();
    expect(
      workspaceFileMutationRoot(new CustomEvent(WORKSPACE_FILE_MUTATED_EVENT, { detail: {} })),
    ).toBeNull();
  });
});
