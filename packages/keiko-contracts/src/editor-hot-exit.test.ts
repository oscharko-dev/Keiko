import { describe, expect, it } from "vitest";
import {
  EDITOR_HOT_EXIT_INDEX_SCHEMA_VERSION,
  isEditorHotExitIndexRecordV2,
} from "./editor-hot-exit.js";

const VALID_RECORD = {
  schemaVersion: EDITOR_HOT_EXIT_INDEX_SCHEMA_VERSION,
  locatorHash: "1".repeat(64),
  snapshotRef: `hot-exit:${"2".repeat(64)}`,
  baseVersion: { sizeBytes: 12, modifiedAt: 34, contentHash: "3".repeat(64) },
  contentHash: "4".repeat(64),
  savedContentHash: "5".repeat(64),
  contentSizeBytes: 56,
  updatedAt: 78,
  paneId: "pane-1",
  windowId: "window-1",
} as const;

describe("editor hot-exit contracts", () => {
  it("accepts index records with a server receipt timestamp", () => {
    expect(
      isEditorHotExitIndexRecordV2({
        ...VALID_RECORD,
        serverReceivedAt: 90,
      }),
    ).toBe(true);
  });

  it("accepts legacy index records without a server receipt timestamp", () => {
    expect(isEditorHotExitIndexRecordV2(VALID_RECORD)).toBe(true);
  });

  it("rejects invalid server receipt timestamps", () => {
    expect(
      isEditorHotExitIndexRecordV2({
        ...VALID_RECORD,
        serverReceivedAt: -1,
      }),
    ).toBe(false);
  });
});
