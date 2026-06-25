import { describe, expect, it } from "vitest";
import {
  createEditorDirtyCloseIntent,
  type EditorDirtyCloseDecision,
  type EditorDirtyCloseReason,
} from "./editor-dirty-close.js";

const ALL_REASONS: readonly EditorDirtyCloseReason[] = [
  "tab-close",
  "pane-close",
  "root-change",
  "window-close",
  "reload-file",
];

describe("createEditorDirtyCloseIntent", () => {
  it("preserves the pane id and reason verbatim", () => {
    const intent = createEditorDirtyCloseIntent({
      paneId: "pane-2",
      files: ["src/a.ts"],
      reason: "pane-close",
    });
    expect(intent.paneId).toBe("pane-2");
    expect(intent.reason).toBe("pane-close");
  });

  it("deduplicates repeated files while preserving first-seen order", () => {
    const intent = createEditorDirtyCloseIntent({
      paneId: "pane-1",
      files: ["src/b.ts", "src/a.ts", "src/b.ts", "src/c.ts", "src/a.ts"],
      reason: "tab-close",
    });
    expect(intent.files).toEqual(["src/b.ts", "src/a.ts", "src/c.ts"]);
  });

  it("drops empty-string file entries", () => {
    const intent = createEditorDirtyCloseIntent({
      paneId: "pane-1",
      files: ["", "src/a.ts", ""],
      reason: "root-change",
    });
    expect(intent.files).toEqual(["src/a.ts"]);
  });

  it("returns an empty file list when no non-empty files are supplied", () => {
    const intent = createEditorDirtyCloseIntent({
      paneId: "pane-1",
      files: ["", ""],
      reason: "window-close",
    });
    expect(intent.files).toEqual([]);
  });

  it("accepts every defined dirty-close reason", () => {
    for (const reason of ALL_REASONS) {
      const intent = createEditorDirtyCloseIntent({
        paneId: "pane-1",
        files: ["src/a.ts"],
        reason,
      });
      expect(intent.reason).toBe(reason);
    }
  });

  it("does not alias the caller's input array", () => {
    const files = ["src/a.ts"];
    const intent = createEditorDirtyCloseIntent({ paneId: "pane-1", files, reason: "tab-close" });
    expect(intent.files).not.toBe(files);
    files.push("src/b.ts");
    expect(intent.files).toEqual(["src/a.ts"]);
  });

  it("models the three resolution decisions", () => {
    const decisions: readonly EditorDirtyCloseDecision[] = ["save", "discard", "cancel"];
    expect(new Set(decisions).size).toBe(3);
  });
});
