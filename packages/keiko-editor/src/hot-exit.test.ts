import { describe, expect, it } from "vitest";
import {
  EDITOR_HOT_EXIT_SCHEMA_VERSION,
  EDITOR_HOT_EXIT_TTL_MS,
  editorHotExitSnapshotExpired,
  isEditorHotExitSnapshotV1,
} from "./hot-exit.js";

const HASH = "a".repeat(64);

describe("EditorHotExitSnapshotV1", () => {
  it("validates the persisted recovery snapshot shape", () => {
    expect(
      isEditorHotExitSnapshotV1({
        schemaVersion: EDITOR_HOT_EXIT_SCHEMA_VERSION,
        workspaceRoot: "/repo",
        relativePath: "src/a.ts",
        content: "unsaved",
        baseVersion: { sizeBytes: 7, modifiedAt: 1, contentHash: HASH },
        contentHash: HASH,
        savedContentHash: HASH,
        updatedAt: 100,
        paneId: "pane-1",
        windowId: "editor",
      }),
    ).toBe(true);
  });

  it("rejects malformed hashes and expires after the default TTL", () => {
    const snapshot = {
      schemaVersion: EDITOR_HOT_EXIT_SCHEMA_VERSION,
      workspaceRoot: "/repo",
      relativePath: "src/a.ts",
      content: "unsaved",
      baseVersion: null,
      contentHash: HASH,
      savedContentHash: null,
      updatedAt: 100,
      paneId: "pane-1",
      windowId: "editor",
    };
    expect(isEditorHotExitSnapshotV1({ ...snapshot, contentHash: "bad" })).toBe(false);
    expect(editorHotExitSnapshotExpired(snapshot, 100 + EDITOR_HOT_EXIT_TTL_MS)).toBe(false);
    expect(editorHotExitSnapshotExpired(snapshot, 101 + EDITOR_HOT_EXIT_TTL_MS)).toBe(true);
  });
});
