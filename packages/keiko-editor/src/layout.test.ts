import { describe, expect, it } from "vitest";
import {
  createEditorLayoutStateV2,
  editorLayoutOpenFiles,
  editorLayoutPaneIds,
  editorLayoutReducer,
  serializeEditorLayoutStateV2,
  type EditorLayoutStateV2,
} from "./layout.js";

function layout(layoutJson?: string): EditorLayoutStateV2 {
  return createEditorLayoutStateV2({
    root: "/repo",
    file: "src/a.ts",
    openFiles: ["src/a.ts", "src/b.ts"],
    layoutJson,
    defaultSidebarWidth: 260,
    minSidebarWidth: 180,
    maxSidebarWidth: 440,
  });
}

describe("EditorLayoutStateV2", () => {
  it("migrates a v1 two-pane layout to a recursive v2 split tree", () => {
    const migrated = layout(
      JSON.stringify({
        version: 1,
        panes: [
          { id: "pane-1", file: "src/a.ts", openFiles: ["src/a.ts"] },
          { id: "pane-2", file: "src/b.ts", openFiles: ["src/b.ts"] },
        ],
        activePaneId: "pane-2",
        direction: "column",
        splitRatio: 64,
        sidebarWidth: 320,
        sidebarCollapsed: true,
      }),
    );

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.activePaneId).toBe("pane-2");
    expect(migrated.tree).toMatchObject({ type: "split", direction: "column", ratio: 64 });
    expect(migrated.panes["pane-1"]?.activeFile).toBe("src/a.ts");
    expect(migrated.panes["pane-2"]?.tabOrder).toEqual(["src/b.ts"]);
    expect(JSON.parse(serializeEditorLayoutStateV2(migrated))).toMatchObject({
      schemaVersion: 2,
    });
  });

  it("reorders and moves tabs without mutating file contents", () => {
    const base = layout();
    const reordered = editorLayoutReducer(base, {
      type: "reorder-tab",
      paneId: "pane-1",
      file: "src/b.ts",
      targetIndex: 0,
    });
    expect(reordered.panes["pane-1"]?.tabOrder).toEqual(["src/b.ts", "src/a.ts"]);

    const split = editorLayoutReducer(reordered, {
      type: "split-pane",
      paneId: "pane-1",
      direction: "row",
      file: "src/a.ts",
    });
    const moved = editorLayoutReducer(split, {
      type: "move-tab",
      fromPaneId: "pane-1",
      toPaneId: "pane-2",
      file: "src/b.ts",
    });

    expect(moved.panes["pane-1"]?.openFiles).toEqual(["src/a.ts"]);
    expect(moved.panes["pane-2"]?.openFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(editorLayoutOpenFiles(moved)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("collapses an empty pane and its redundant split parent", () => {
    const split = editorLayoutReducer(layout(), {
      type: "split-pane",
      paneId: "pane-1",
      direction: "row",
      file: "src/a.ts",
    });
    const closed = editorLayoutReducer(split, {
      type: "close-pane",
      paneId: "pane-2",
    });

    expect(editorLayoutPaneIds(closed)).toEqual(["pane-1"]);
    expect(closed.tree).toEqual({ type: "pane", paneId: "pane-1" });
  });
});
