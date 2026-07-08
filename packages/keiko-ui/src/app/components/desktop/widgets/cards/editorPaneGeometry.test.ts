// @vitest-environment jsdom
// GEN-MAINT-COMPLEXITY-002 — unit coverage for the pure tab/pane/drag-geometry helpers extracted
// from EditorWidget. The layout/file normalizers are pure; the pointer/drag helpers
// (paneIdFromPoint / tabInsertionTargetFromPoint / draggedTabFromEvent) are pure functions of their
// args that read the live DOM, so this suite runs under jsdom.

import { afterEach, describe, expect, it } from "vitest";
import type { DragEvent as ReactDragEvent } from "react";
import {
  EDITOR_LAYOUT_SCHEMA_VERSION,
  type EditorLayoutStateV2,
  type EditorPaneStateV2,
} from "@oscharko-dev/keiko-contracts";
import {
  allDirtyFiles,
  clampNumber,
  createInitialLayout,
  createSinglePresetLayout,
  dedupeLayoutFilesByActivePane,
  dirtyFilesForPane,
  draggedTabFromEvent,
  EDITOR_TAB_DRAG_MIME,
  layoutHasClonedPanes,
  layoutHasDuplicateFiles,
  normalizeEditorFile,
  normalizeEditorLayoutStructure,
  normalizeEditorOpenFiles,
  openFilesPatchValue,
  paneIdFromPoint,
  paneNode,
  presetTree,
  remapDirtyFilesToPresetPanes,
  sameStringList,
  splitNode,
  tabInsertionTargetFromPoint,
  tabOrderWithInsertion,
  type PointerTabDrag,
} from "./editorPaneGeometry";

const ROOT = "/repo";

function pane(
  id: string,
  openFiles: readonly string[],
  activeFile = openFiles[0] ?? "",
): EditorPaneStateV2 {
  return { id, openFiles, activeFile, tabOrder: openFiles };
}

function layout(
  panes: readonly EditorPaneStateV2[],
  activePaneId = panes[0]?.id ?? "",
): EditorLayoutStateV2 {
  const tree = panes.length >= 2 ? presetTree("row") : paneNode(panes[0]?.id ?? "pane-1");
  return {
    schemaVersion: EDITOR_LAYOUT_SCHEMA_VERSION,
    root: ROOT,
    activePaneId,
    tree,
    panes: Object.fromEntries(panes.map((p) => [p.id, p])),
    sidebarWidth: 260,
    sidebarCollapsed: false,
    outlinePanelVisible: true,
  };
}

describe("clampNumber", () => {
  it("clamps to the inclusive range", () => {
    expect(clampNumber(5, 0, 10)).toBe(5);
    expect(clampNumber(-3, 0, 10)).toBe(0);
    expect(clampNumber(42, 0, 10)).toBe(10);
  });
});

describe("normalizeEditorFile / normalizeEditorOpenFiles", () => {
  it("keeps a root-relative file and drops one outside the root", () => {
    expect(normalizeEditorFile(ROOT, "src/a.ts")).toBe("src/a.ts");
    expect(normalizeEditorFile(ROOT, "/elsewhere/b.ts")).toBe("");
  });

  it("dedupes and appends the active file to the open-file set", () => {
    expect(
      normalizeEditorOpenFiles(ROOT, "src/a.ts", ["src/a.ts", "src/b.ts", "src/a.ts"]),
    ).toEqual(["src/a.ts", "src/b.ts"]);
    expect(normalizeEditorOpenFiles(ROOT, "src/c.ts", ["src/a.ts"])).toEqual([
      "src/a.ts",
      "src/c.ts",
    ]);
  });
});

describe("sameStringList", () => {
  it("treats undefined as an empty list", () => {
    expect(sameStringList(undefined, [])).toBe(true);
    expect(sameStringList(undefined, ["a"])).toBe(false);
  });
  it("compares order-sensitively", () => {
    expect(sameStringList(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameStringList(["a", "b"], ["b", "a"])).toBe(false);
  });
});

describe("openFilesPatchValue", () => {
  it("returns undefined for an empty list and the list otherwise", () => {
    expect(openFilesPatchValue([])).toBeUndefined();
    expect(openFilesPatchValue(["a"])).toEqual(["a"]);
  });
});

describe("layoutHasDuplicateFiles / layoutHasClonedPanes", () => {
  it("detects a file open in two panes", () => {
    const l = layout([pane("pane-1", ["a.ts"]), pane("pane-2", ["a.ts", "b.ts"])]);
    expect(layoutHasDuplicateFiles(l)).toBe(true);
  });
  it("detects two panes with an identical open set", () => {
    const l = layout([pane("pane-1", ["a.ts", "b.ts"]), pane("pane-2", ["a.ts", "b.ts"])]);
    expect(layoutHasClonedPanes(l)).toBe(true);
    expect(layoutHasClonedPanes(layout([pane("pane-1", ["a.ts"])]))).toBe(false);
  });
});

describe("createInitialLayout / normalizeEditorLayoutStructure", () => {
  it("produces a single-pane layout for a single file", () => {
    const l = createInitialLayout({
      root: ROOT,
      file: "src/a.ts",
      openFiles: ["src/a.ts"],
      layoutJson: undefined,
    });
    expect(l.root).toBe(ROOT);
    expect(Object.keys(l.panes)).toHaveLength(1);
  });

  it("distributes duplicated files across preset panes", () => {
    const cloned = layout([
      pane("pane-1", ["a.ts", "b.ts"], "a.ts"),
      pane("pane-2", ["a.ts", "b.ts"], "a.ts"),
    ]);
    const normalized = normalizeEditorLayoutStructure(ROOT, cloned);
    expect(layoutHasDuplicateFiles(normalized)).toBe(false);
  });
});

describe("createSinglePresetLayout / dedupeLayoutFilesByActivePane", () => {
  it("collapses to a single pane holding every file", () => {
    const l = createSinglePresetLayout(layout([pane("pane-1", ["a.ts"])]), ROOT, "a.ts", [
      "a.ts",
      "b.ts",
    ]);
    expect(Object.keys(l.panes)).toEqual(["pane-1"]);
    expect(l.panes["pane-1"]?.openFiles).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps a duplicated file only in the active pane", () => {
    const l = layout(
      [pane("pane-1", ["a.ts", "b.ts"], "a.ts"), pane("pane-2", ["a.ts"], "a.ts")],
      "pane-1",
    );
    const deduped = dedupeLayoutFilesByActivePane(l, ROOT);
    expect(deduped.panes["pane-1"]?.openFiles).toContain("a.ts");
    expect(deduped.panes["pane-2"]?.openFiles).not.toContain("a.ts");
  });
});

describe("splitNode / presetTree", () => {
  it("builds a 50/50 split of two preset panes", () => {
    const tree = presetTree("column");
    expect(tree.type).toBe("split");
    expect(tree.ratio).toBe(50);
    expect(tree.direction).toBe("column");
    const custom = splitNode("s2", "row", paneNode("p1"), paneNode("p2"));
    expect(custom.first).toEqual({ type: "pane", paneId: "p1" });
  });
});

describe("dirtyFilesForPane / allDirtyFiles", () => {
  const dirtyByPane = {
    "pane-1": { "a.ts": true as const, "b.ts": true as const },
    "pane-2": { "c.ts": true as const },
  };
  it("filters a pane's files to the dirty ones", () => {
    expect(dirtyFilesForPane(dirtyByPane, "pane-1", ["a.ts", "x.ts", "b.ts"])).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(dirtyFilesForPane(dirtyByPane, "missing", ["a.ts"])).toEqual([]);
  });
  it("collects the union of dirty files across panes", () => {
    expect([...allDirtyFiles(dirtyByPane)].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(allDirtyFiles({})).toEqual([]);
  });
});

describe("remapDirtyFilesToPresetPanes", () => {
  it("moves each dirty file to the pane that holds it", () => {
    const l = layout([pane("pane-1", ["a.ts"]), pane("pane-2", ["b.ts"])]);
    const remapped = remapDirtyFilesToPresetPanes({ "old-pane": { "b.ts": true } }, l);
    expect(remapped["pane-2"]).toEqual({ "b.ts": true });
    expect(remapped["pane-1"]).toBeUndefined();
  });
  it("returns an empty map when nothing is dirty", () => {
    expect(remapDirtyFilesToPresetPanes({}, layout([pane("pane-1", ["a.ts"])]))).toEqual({});
  });
});

describe("tabOrderWithInsertion", () => {
  it("moves a file to the clamped target index", () => {
    expect(tabOrderWithInsertion(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(tabOrderWithInsertion(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(tabOrderWithInsertion(["a", "b"], "a", 99)).toEqual(["b", "a"]);
  });
});

describe("draggedTabFromEvent", () => {
  function dragEventWith(data: string): ReactDragEvent<HTMLElement> {
    return {
      dataTransfer: { getData: (mime: string) => (mime === EDITOR_TAB_DRAG_MIME ? data : "") },
    } as unknown as ReactDragEvent<HTMLElement>;
  }

  it("parses a well-formed editor-tab payload", () => {
    expect(
      draggedTabFromEvent(dragEventWith(JSON.stringify({ paneId: "pane-1", file: "a.ts" }))),
    ).toEqual({ paneId: "pane-1", file: "a.ts" });
  });

  it("returns null for empty, malformed, or foreign payloads", () => {
    expect(draggedTabFromEvent(dragEventWith(""))).toBeNull();
    expect(draggedTabFromEvent(dragEventWith("not json"))).toBeNull();
    expect(
      draggedTabFromEvent(dragEventWith(JSON.stringify({ paneId: "", file: "a.ts" }))),
    ).toBeNull();
    expect(draggedTabFromEvent(dragEventWith(JSON.stringify({ foo: 1 })))).toBeNull();
  });
});

describe("paneIdFromPoint (DOM)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    // Restore the stubbed elementFromPoint.
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("reads the enclosing .ed-pane's paneId at a point", () => {
    document.body.innerHTML = `<div class="ed-pane" data-pane-id="pane-7"><span id="hit"></span></div>`;
    const hit = document.getElementById("hit");
    (
      document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }
    ).elementFromPoint = () => hit;
    expect(paneIdFromPoint(10, 10)).toBe("pane-7");
  });

  it("returns null when the point is not inside a pane", () => {
    (
      document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }
    ).elementFromPoint = () => null;
    expect(paneIdFromPoint(0, 0)).toBeNull();
  });
});

describe("tabInsertionTargetFromPoint (DOM)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  });

  function stubTab(paneId: string, file: string, left: number, width: number): HTMLElement {
    const el = document.createElement("button");
    el.className = "ed-tab";
    el.dataset.paneId = paneId;
    el.dataset.tabFile = file;
    el.getBoundingClientRect = () =>
      ({
        left,
        right: left + width,
        top: 0,
        bottom: 30,
        width,
        height: 30,
        x: left,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    return el;
  }

  it("targets the tab under the pointer and picks the near edge", () => {
    const paneEl = document.createElement("div");
    paneEl.className = "ed-pane";
    paneEl.dataset.paneId = "pane-1";
    const tabA = stubTab("pane-1", "a.ts", 0, 100);
    const tabB = stubTab("pane-1", "b.ts", 100, 100);
    paneEl.append(tabA, tabB);
    document.body.append(paneEl);
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () =>
      paneEl;

    // Drag a tab in FROM another pane so the same-pane no-op guard does not apply.
    const drag: PointerTabDrag = {
      paneId: "pane-2",
      file: "c.ts",
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0,
      width: 100,
      dragging: true,
    };
    const l = layout([pane("pane-1", ["a.ts", "b.ts"], "a.ts")]);
    // Pointer near the left of tab B -> insert before b.ts.
    const target = tabInsertionTargetFromPoint(drag, 110, 15, l);
    expect(target?.file).toBe("b.ts");
    expect(target?.edge).toBe("before");
  });

  it("returns null when the drag would not change the order in its own pane", () => {
    const paneEl = document.createElement("div");
    paneEl.className = "ed-pane";
    paneEl.dataset.paneId = "pane-1";
    const tabA = stubTab("pane-1", "a.ts", 0, 100);
    paneEl.append(tabA);
    document.body.append(paneEl);
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () =>
      paneEl;

    const drag: PointerTabDrag = {
      paneId: "pane-1",
      file: "a.ts",
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0,
      width: 100,
      dragging: true,
    };
    const l = layout([pane("pane-1", ["a.ts"], "a.ts")]);
    // Only tab is the dragged file itself -> no valid target.
    expect(tabInsertionTargetFromPoint(drag, 50, 15, l)).toBeNull();
  });
});
