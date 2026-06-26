import { describe, expect, it } from "vitest";
import {
  createEditorLayoutStateV2,
  editorLayoutReducer,
  type CreateEditorLayoutStateV2Input,
  type EditorLayoutStateV2,
} from "@oscharko-dev/keiko-contracts";

import { reconcileEditorDirtyByPane, type EditorDirtyByPane } from "./editorDirtyState";

const INPUT: CreateEditorLayoutStateV2Input = {
  root: "/repo",
  file: "src/a.ts",
  openFiles: ["src/a.ts", "src/b.ts"],
  defaultSidebarWidth: 260,
  minSidebarWidth: 180,
  maxSidebarWidth: 440,
};

function baseLayout(): EditorLayoutStateV2 {
  return createEditorLayoutStateV2(INPUT);
}

/** Single-pane base split into two panes, then b.ts moved into the new pane. */
function twoPaneLayout(): EditorLayoutStateV2 {
  const split = editorLayoutReducer(baseLayout(), {
    type: "split-pane",
    paneId: "pane-1",
    direction: "row",
    file: "src/a.ts",
  });
  return split;
}

describe("reconcileEditorDirtyByPane", () => {
  it("returns the same reference when there are no dirty files", () => {
    const empty: EditorDirtyByPane = {};
    expect(reconcileEditorDirtyByPane(empty, baseLayout())).toBe(empty);
  });

  it("prunes empty inner records left behind after the last dirty file is saved", () => {
    const stale: EditorDirtyByPane = { "pane-1": {} };
    expect(reconcileEditorDirtyByPane(stale, baseLayout())).toEqual({});
  });

  it("re-homes a dirty flag onto the pane that now holds the moved file", () => {
    // b.ts is dirty in pane-1, then moved to pane-2 in the layout.
    const dirty: EditorDirtyByPane = { "pane-1": { "src/b.ts": true } };
    const moved = editorLayoutReducer(twoPaneLayout(), {
      type: "move-tab",
      fromPaneId: "pane-1",
      toPaneId: "pane-2",
      file: "src/b.ts",
    });

    const reconciled = reconcileEditorDirtyByPane(dirty, moved);

    expect(reconciled["pane-2"]).toEqual({ "src/b.ts": true });
    expect(reconciled["pane-1"]).toBeUndefined();
  });

  it("drops an orphaned dirty entry whose source pane was collapsed by the move", () => {
    // a.ts is the only file in pane-2; moving it back to pane-1 collapses pane-2.
    const split = twoPaneLayout(); // pane-2 active with a.ts only
    const dirty: EditorDirtyByPane = { "pane-2": { "src/a.ts": true } };
    const collapsed = editorLayoutReducer(split, {
      type: "move-tab",
      fromPaneId: "pane-2",
      toPaneId: "pane-1",
      file: "src/a.ts",
    });

    const reconciled = reconcileEditorDirtyByPane(dirty, collapsed);

    expect(Object.keys(reconciled)).toEqual(["pane-1"]);
    expect(reconciled["pane-1"]).toEqual({ "src/a.ts": true });
  });

  it("keeps a dirty flag on every pane that holds the same file (split view)", () => {
    // Open a.ts in both panes by splitting on the shared active file.
    const split = editorLayoutReducer(baseLayout(), {
      type: "split-pane",
      paneId: "pane-1",
      direction: "row",
      file: "src/b.ts",
    });
    const openInSecond = editorLayoutReducer(split, {
      type: "open-file",
      paneId: "pane-2",
      file: "src/a.ts",
    });
    const openInFirst = editorLayoutReducer(openInSecond, {
      type: "open-file",
      paneId: "pane-1",
      file: "src/a.ts",
    });
    const dirty: EditorDirtyByPane = { "pane-1": { "src/a.ts": true } };

    const reconciled = reconcileEditorDirtyByPane(dirty, openInFirst);

    expect(reconciled["pane-1"]).toEqual({ "src/a.ts": true });
    expect(reconciled["pane-2"]).toEqual({ "src/a.ts": true });
  });

  it("re-spreads a still-dirty shared file to every pane that holds it, by design (ADR-0064 D2)", () => {
    // The Monaco model is keyed by (root, file), so an unsaved buffer is unsaved in every pane that
    // shows it. Clearing the flag in only one pane of a split view is an inconsistent intermediate;
    // reconcile re-homes the still-dirty file onto both panes rather than trusting that stale state.
    const split = editorLayoutReducer(baseLayout(), {
      type: "split-pane",
      paneId: "pane-1",
      direction: "row",
      file: "src/b.ts",
    });
    const openInSecond = editorLayoutReducer(split, {
      type: "open-file",
      paneId: "pane-2",
      file: "src/a.ts",
    });
    const both = editorLayoutReducer(openInSecond, {
      type: "open-file",
      paneId: "pane-1",
      file: "src/a.ts",
    });
    const partiallyCleared: EditorDirtyByPane = { "pane-1": { "src/a.ts": true }, "pane-2": {} };

    const reconciled = reconcileEditorDirtyByPane(partiallyCleared, both);

    expect(reconciled["pane-1"]).toEqual({ "src/a.ts": true });
    expect(reconciled["pane-2"]).toEqual({ "src/a.ts": true });
  });

  it("drops a dirty flag for a file that is no longer open in any pane", () => {
    const dirty: EditorDirtyByPane = { "pane-1": { "src/gone.ts": true } };
    expect(reconcileEditorDirtyByPane(dirty, baseLayout())).toEqual({});
  });

  it("is idempotent and referentially stable once reconciled", () => {
    const dirty: EditorDirtyByPane = { "pane-1": { "src/b.ts": true } };
    const layout = baseLayout();
    const once = reconcileEditorDirtyByPane(dirty, layout);
    const twice = reconcileEditorDirtyByPane(once, layout);
    expect(twice).toBe(once);
  });

  it("returns the same reference when the layout already matches the index", () => {
    const dirty: EditorDirtyByPane = { "pane-1": { "src/a.ts": true } };
    expect(reconcileEditorDirtyByPane(dirty, baseLayout())).toBe(dirty);
  });
});
