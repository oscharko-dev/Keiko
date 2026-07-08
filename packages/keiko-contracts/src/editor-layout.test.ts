import { describe, expect, it } from "vitest";
import {
  EDITOR_LAYOUT_SCHEMA_VERSION,
  activeEditorPane,
  createEditorLayoutStateV2,
  editorLayoutOpenFiles,
  editorLayoutPaneIds,
  editorLayoutPanes,
  editorLayoutReducer,
  serializeEditorLayoutStateV2,
  type CreateEditorLayoutStateV2Input,
  type EditorLayoutStateV2,
} from "./editor-layout.js";

const DEFAULT_INPUT: CreateEditorLayoutStateV2Input = {
  root: "/repo",
  file: "src/a.ts",
  openFiles: ["src/a.ts", "src/b.ts"],
  defaultSidebarWidth: 260,
  minSidebarWidth: 180,
  maxSidebarWidth: 440,
};

function layout(overrides: Partial<CreateEditorLayoutStateV2Input> = {}): EditorLayoutStateV2 {
  return createEditorLayoutStateV2({ ...DEFAULT_INPUT, ...overrides });
}

describe("EditorLayoutStateV2 contracts", () => {
  it("creates and serializes a fresh single-pane layout with stable tab order", () => {
    const created = layout({
      file: "",
      openFiles: ["src/b.ts", "src/b.ts", "", "src/a.ts"],
    });

    expect(created).toEqual(
      expect.objectContaining({
        schemaVersion: EDITOR_LAYOUT_SCHEMA_VERSION,
        root: "/repo",
        activePaneId: "pane-1",
        sidebarWidth: 260,
        sidebarCollapsed: false,
        outlinePanelVisible: true,
      }),
    );
    expect(created.tree).toEqual({ type: "pane", paneId: "pane-1" });
    expect(created.panes["pane-1"]).toEqual({
      id: "pane-1",
      openFiles: ["src/b.ts", "src/a.ts"],
      activeFile: "src/b.ts",
      tabOrder: ["src/b.ts", "src/a.ts"],
    });
    expect(JSON.parse(serializeEditorLayoutStateV2({ ...created, sidebarWidth: 260.6 }))).toEqual(
      expect.objectContaining({
        schemaVersion: EDITOR_LAYOUT_SCHEMA_VERSION,
        sidebarWidth: 261,
        outlinePanelVisible: true,
      }),
    );
  });

  it("normalizes persisted V2 layout state and clamps unsafe persisted values", () => {
    const restored = layout({
      layoutJson: JSON.stringify({
        schemaVersion: "2",
        root: "/old",
        activePaneId: "missing-pane",
        tree: {
          type: "split",
          id: "",
          direction: "diagonal",
          ratio: 120,
          first: { type: "pane", paneId: "pane-a" },
          second: { type: "pane", paneId: "pane-b" },
        },
        panes: {
          "pane-a": {
            id: "",
            activeFile: "src/a.ts",
            openFiles: ["src/a.ts", "src/a.ts"],
            tabOrder: ["src/b.ts", "src/a.ts", "src/b.ts"],
          },
          "pane-b": { file: "src/c.ts", openFiles: ["src/c.ts"] },
          ignored: { activeFile: "", openFiles: [] },
        },
        sidebarWidth: 999,
        sidebarCollapsed: true,
      }),
    });

    expect(restored.root).toBe("/repo");
    expect(restored.activePaneId).toBe("pane-a");
    expect(restored.sidebarWidth).toBe(440);
    expect(restored.sidebarCollapsed).toBe(true);
    expect(restored.outlinePanelVisible).toBe(true);
    expect(restored.tree).toEqual({
      type: "split",
      id: "split-1",
      direction: "row",
      ratio: 85,
      first: { type: "pane", paneId: "pane-a" },
      second: { type: "pane", paneId: "pane-b" },
    });
    expect(Object.keys(restored.panes)).toEqual(["pane-a", "pane-b"]);
    expect(restored.panes["pane-a"]?.tabOrder).toEqual(["src/b.ts", "src/a.ts"]);
  });

  it("migrates legacy V1 layout state and falls back cleanly from invalid persistence", () => {
    const migrated = layout({
      layoutJson: JSON.stringify({
        version: 1,
        panes: [{ file: "src/legacy.ts", openFiles: ["src/legacy.ts"] }],
        activePaneId: "missing",
        direction: "column",
        splitRatio: Number.NaN,
        sidebarWidth: 120,
        sidebarCollapsed: true,
      }),
    });

    expect(migrated.tree).toEqual({ type: "pane", paneId: "pane-1" });
    expect(migrated.activePaneId).toBe("pane-1");
    expect(migrated.sidebarWidth).toBe(180);
    expect(migrated.sidebarCollapsed).toBe(true);
    expect(migrated.outlinePanelVisible).toBe(true);
    expect(migrated.panes["pane-1"]?.activeFile).toBe("src/legacy.ts");

    const fallback = layout({ layoutJson: "{not-json" });
    expect(fallback.tree).toEqual({ type: "pane", paneId: "pane-1" });
    expect(fallback.panes["pane-1"]?.openFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("persists outline panel visibility through the existing layout state", () => {
    const hidden = editorLayoutReducer(layout(), {
      type: "set-outline-panel",
      visible: false,
    });
    expect(hidden.outlinePanelVisible).toBe(false);
    const reloaded = layout({ layoutJson: serializeEditorLayoutStateV2(hidden) });
    expect(reloaded.outlinePanelVisible).toBe(false);
    expect(
      editorLayoutReducer(reloaded, { type: "set-outline-panel", visible: true })
        .outlinePanelVisible,
    ).toBe(true);
  });

  it("handles pane file actions and no-op pane ids without losing active state", () => {
    const base = layout();

    expect(editorLayoutReducer(base, { type: "open-file", paneId: "missing", file: "x.ts" })).toBe(
      base,
    );
    const opened = editorLayoutReducer(base, {
      type: "open-file",
      paneId: "pane-1",
      file: "src/c.ts",
    });
    expect(opened.panes["pane-1"]?.openFiles).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(opened.panes["pane-1"]?.activeFile).toBe("src/c.ts");

    const selected = editorLayoutReducer(opened, {
      type: "select-file",
      paneId: "pane-1",
      file: "src/a.ts",
    });
    expect(selected.activePaneId).toBe("pane-1");
    expect(selected.panes["pane-1"]?.activeFile).toBe("src/a.ts");

    const selectedMissingFile = editorLayoutReducer(selected, {
      type: "select-file",
      paneId: "pane-1",
      file: "src/missing.ts",
    });
    expect(selectedMissingFile.panes["pane-1"]?.activeFile).toBe("src/a.ts");
    expect(editorLayoutReducer(selected, { type: "set-active-pane", paneId: "missing" })).toBe(
      selected,
    );
    expect(
      editorLayoutReducer(selected, { type: "close-tab", paneId: "pane-1", file: "none" }),
    ).toBe(selected);
  });

  it("splits, moves, drops, resizes, and collapses recursive panes", () => {
    const split = editorLayoutReducer(layout({ openFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] }), {
      type: "split-pane",
      paneId: "pane-1",
      direction: "row",
      file: "src/a.ts",
    });
    expect(editorLayoutPaneIds(split)).toEqual(["pane-1", "pane-2"]);
    expect(activeEditorPane(split).id).toBe("pane-2");
    expect(split.panes["pane-1"]?.openFiles).toEqual(["src/b.ts", "src/c.ts"]);
    expect(split.panes["pane-2"]?.openFiles).toEqual(["src/a.ts"]);

    const moved = editorLayoutReducer(split, {
      type: "move-tab",
      fromPaneId: "pane-1",
      toPaneId: "pane-2",
      file: "src/b.ts",
      targetIndex: 0,
    });
    expect(moved.panes["pane-1"]?.openFiles).toEqual(["src/c.ts"]);
    expect(moved.panes["pane-2"]?.openFiles).toEqual(["src/b.ts", "src/a.ts"]);
    expect(editorLayoutOpenFiles(moved)).toEqual(["src/c.ts", "src/b.ts", "src/a.ts"]);

    const droppedLeft = editorLayoutReducer(moved, {
      type: "drop-tab",
      intent: {
        fromPaneId: "pane-2",
        toPaneId: "pane-2",
        file: "src/b.ts",
        zone: "left",
      },
    });
    expect(editorLayoutPaneIds(droppedLeft)).toEqual(["pane-1", "pane-3", "pane-2"]);
    expect(droppedLeft.tree).toMatchObject({
      type: "split",
      first: { type: "pane", paneId: "pane-1" },
      second: {
        type: "split",
        direction: "row",
        first: { type: "pane", paneId: "pane-3" },
        second: { type: "pane", paneId: "pane-2" },
      },
    });

    const nestedSplit = droppedLeft.tree.type === "split" ? droppedLeft.tree.second : null;
    expect(nestedSplit).toMatchObject({ type: "split" });
    const resized =
      nestedSplit !== null && nestedSplit.type === "split"
        ? editorLayoutReducer(droppedLeft, {
            type: "resize-split",
            splitId: nestedSplit.id,
            ratio: 5,
          })
        : droppedLeft;
    const resizedNested = resized.tree.type === "split" ? resized.tree.second : null;
    expect(resizedNested).toMatchObject({ type: "split", ratio: 15 });

    const collapsed = editorLayoutReducer(
      editorLayoutReducer(resized, { type: "close-pane", paneId: "pane-3" }),
      { type: "close-pane", paneId: "pane-2" },
    );
    expect(editorLayoutPaneIds(collapsed)).toEqual(["pane-1"]);
    expect(collapsed.tree).toEqual({ type: "pane", paneId: "pane-1" });
  });

  it("keeps empty and missing structural actions safe", () => {
    const empty = layout({ file: "", openFiles: [] });
    expect(activeEditorPane(empty)).toEqual({
      id: "pane-1",
      openFiles: [],
      activeFile: "",
      tabOrder: [],
    });
    expect(editorLayoutPanes(empty)).toEqual([empty.panes["pane-1"]]);
    expect(
      editorLayoutReducer(empty, { type: "split-pane", paneId: "pane-1", direction: "row" }),
    ).toBe(empty);
    expect(editorLayoutReducer(empty, { type: "close-pane", paneId: "pane-1" })).toBe(empty);

    const base = layout();
    expect(
      editorLayoutReducer(base, {
        type: "move-tab",
        fromPaneId: "pane-1",
        toPaneId: "missing",
        file: "src/a.ts",
      }),
    ).toEqual(
      expect.objectContaining({
        tree: { type: "pane", paneId: "pane-1" },
        activePaneId: "pane-1",
      }),
    );
    expect(
      editorLayoutReducer(base, { type: "split-pane", paneId: "missing", direction: "row" }),
    ).toBe(base);
    expect(
      editorLayoutReducer(base, {
        type: "set-sidebar",
        width: 320,
        collapsed: true,
      }),
    ).toEqual(expect.objectContaining({ sidebarWidth: 320, sidebarCollapsed: true }));
    expect(editorLayoutReducer(base, { type: "replace-root", root: "/next" })).toEqual(
      expect.objectContaining({
        root: "/next",
        activePaneId: "pane-1",
        sidebarWidth: base.sidebarWidth,
        sidebarCollapsed: false,
      }),
    );
  });

  it("preserves tab order, structure, and active state across a serialize-reload round trip", () => {
    const reordered = editorLayoutReducer(
      layout({ openFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] }),
      {
        type: "reorder-tab",
        paneId: "pane-1",
        file: "src/a.ts",
        targetIndex: 2,
      },
    );
    const split = editorLayoutReducer(reordered, {
      type: "split-pane",
      paneId: "pane-1",
      direction: "row",
      file: "src/c.ts",
    });
    const moved = editorLayoutReducer(split, {
      type: "move-tab",
      fromPaneId: "pane-1",
      toPaneId: "pane-2",
      file: "src/b.ts",
      targetIndex: 0,
    });
    const session = editorLayoutReducer(moved, {
      type: "resize-split",
      splitId: "split-1",
      ratio: 65,
    });

    const json = serializeEditorLayoutStateV2(session);
    const reloaded = createEditorLayoutStateV2({ ...DEFAULT_INPUT, layoutJson: json });

    for (const paneId of editorLayoutPaneIds(session)) {
      expect(reloaded.panes[paneId]?.tabOrder).toEqual(session.panes[paneId]?.tabOrder);
      expect(reloaded.panes[paneId]?.openFiles).toEqual(session.panes[paneId]?.openFiles);
      expect(reloaded.panes[paneId]?.activeFile).toBe(session.panes[paneId]?.activeFile);
    }
    expect(reloaded.tree).toEqual(session.tree);
    expect(reloaded.activePaneId).toBe(session.activePaneId);
    // The reload is a fixed point: re-serializing yields the same persisted state.
    expect(JSON.parse(serializeEditorLayoutStateV2(reloaded))).toEqual(JSON.parse(json));
  });

  it("rehomes a renamed file across every pane and keeps the active tab", () => {
    const split = editorLayoutReducer(
      layout({ openFiles: ["src/a.ts", "src/b.ts"], file: "src/a.ts" }),
      { type: "split-pane", paneId: "pane-1", direction: "row", file: "src/b.ts" },
    );
    // Open the file in the second pane too, so the rename must touch both panes.
    const both = editorLayoutReducer(split, {
      type: "open-file",
      paneId: "pane-2",
      file: "src/a.ts",
    });

    const renamed = editorLayoutReducer(both, {
      type: "rename-file",
      from: "src/a.ts",
      to: "src/renamed.ts",
    });

    for (const pane of editorLayoutPanes(renamed)) {
      expect(pane.openFiles).not.toContain("src/a.ts");
      expect(pane.tabOrder).not.toContain("src/a.ts");
    }
    expect(renamed.panes["pane-1"]?.openFiles).toContain("src/renamed.ts");
    expect(renamed.panes["pane-2"]?.openFiles).toContain("src/renamed.ts");
    // The pane that had it active follows the rename instead of going blank.
    expect(renamed.panes["pane-2"]?.activeFile).toBe("src/renamed.ts");
    expect(editorLayoutOpenFiles(renamed)).toContain("src/renamed.ts");
  });

  it("carries open descendants when a folder is renamed (prefix rename)", () => {
    const base = layout({
      openFiles: ["src/app.ts", "src/util/log.ts", "docs/readme.md"],
      file: "src/util/log.ts",
    });

    const renamed = editorLayoutReducer(base, { type: "rename-file", from: "src", to: "lib" });

    const pane = activeEditorPane(renamed);
    expect(pane.openFiles).toEqual(
      expect.arrayContaining(["lib/app.ts", "lib/util/log.ts", "docs/readme.md"]),
    );
    expect(pane.activeFile).toBe("lib/util/log.ts");
    // A sibling whose name merely shares the prefix is untouched (folder boundary is the slash).
    const withSibling = editorLayoutReducer(
      layout({ openFiles: ["src/a.ts", "srcgen/b.ts"], file: "src/a.ts" }),
      { type: "rename-file", from: "src", to: "lib" },
    );
    expect(activeEditorPane(withSibling).openFiles).toEqual(
      expect.arrayContaining(["lib/a.ts", "srcgen/b.ts"]),
    );
  });

  it("merges tabs when a rename collides with an already-open path", () => {
    const base = layout({ openFiles: ["src/a.ts", "src/b.ts"], file: "src/a.ts" });
    const renamed = editorLayoutReducer(base, {
      type: "rename-file",
      from: "src/a.ts",
      to: "src/b.ts",
    });
    const pane = activeEditorPane(renamed);
    expect(pane.openFiles).toEqual(["src/b.ts"]);
    expect(pane.activeFile).toBe("src/b.ts");
  });

  it("is a no-op when the renamed path is not open or when from === to", () => {
    const base = layout({ openFiles: ["src/a.ts", "src/b.ts"], file: "src/a.ts" });
    expect(
      editorLayoutReducer(base, { type: "rename-file", from: "src/x.ts", to: "src/y.ts" }),
    ).toBe(base);
    expect(
      editorLayoutReducer(base, { type: "rename-file", from: "src/a.ts", to: "src/a.ts" }),
    ).toBe(base);
  });

  it("closes a deleted file — and open descendants — across every pane", () => {
    const split = editorLayoutReducer(
      layout({ openFiles: ["src/a.ts", "src/b.ts"], file: "src/a.ts" }),
      { type: "split-pane", paneId: "pane-1", direction: "row", file: "src/b.ts" },
    );
    const both = editorLayoutReducer(split, {
      type: "open-file",
      paneId: "pane-2",
      file: "src/a.ts",
    });

    const removed = editorLayoutReducer(both, { type: "remove-file", file: "src/a.ts" });

    for (const pane of editorLayoutPanes(removed)) {
      expect(pane.openFiles).not.toContain("src/a.ts");
    }
    expect(editorLayoutOpenFiles(removed)).not.toContain("src/a.ts");

    // Deleting a folder closes every open file beneath it.
    const tree = layout({
      openFiles: ["src/app.ts", "src/util/log.ts", "docs/readme.md"],
      file: "docs/readme.md",
    });
    const folderRemoved = editorLayoutReducer(tree, { type: "remove-file", file: "src" });
    expect(editorLayoutOpenFiles(folderRemoved)).toEqual(["docs/readme.md"]);
  });

  it("does not split a single-tab pane into a duplicate view", () => {
    const single = layout({ openFiles: ["src/a.ts"], file: "src/a.ts" });
    expect(
      editorLayoutReducer(single, {
        type: "split-pane",
        paneId: "pane-1",
        direction: "row",
        file: "src/a.ts",
      }),
    ).toBe(single);
  });

  it("collapses a pane whose only tab is deleted", () => {
    const split = editorLayoutReducer(
      layout({ openFiles: ["src/a.ts", "src/b.ts"], file: "src/a.ts" }),
      {
        type: "split-pane",
        paneId: "pane-1",
        direction: "row",
        file: "src/a.ts",
      },
    );
    expect(editorLayoutPaneIds(split)).toHaveLength(2);
    // pane-2 holds only src/a.ts; deleting it removes that split and leaves pane-1 intact.
    const removed = editorLayoutReducer(split, { type: "remove-file", file: "src/a.ts" });
    expect(editorLayoutPaneIds(removed)).toHaveLength(1);
    expect(editorLayoutOpenFiles(removed)).toEqual(["src/b.ts"]);
  });
});
