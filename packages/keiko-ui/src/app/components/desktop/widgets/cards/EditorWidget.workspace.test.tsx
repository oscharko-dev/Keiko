import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// GEN-PERF-EDITOR-003 — tab-drag target resolution is rAF-coalesced (one layout pass per
// frame, last-event-wins), so drag-feedback assertions must let the pending frame apply.
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { EditorRuntimeWidgetProps } from "./EditorRuntimeWidget";
import { EditorWidget } from "./EditorWidget";

const probeState = vi.hoisted(() => ({
  runtimeProps: null as EditorRuntimeWidgetProps | null,
  dragModeStarts: [] as Array<{ readonly paneId: string; readonly path: string }>,
  // GEN-PERF-EDITOR-003 — the latest props each pane received, keyed by paneId, so a test
  // can compare a non-dragged pane's prop bundle (esp. renderTabHandle identity) across a
  // hold-state change on a different pane and prove React.memo would bail it out.
  propsByPane: new Map<string, EditorRuntimeWidgetProps>(),
}));

vi.mock("next/dynamic", () => ({
  default: () => {
    function RuntimeProbe(props: EditorRuntimeWidgetProps): ReactNode {
      const externalSaveRequest = props.externalSaveRequest;
      probeState.runtimeProps = props;
      probeState.propsByPane.set(props.paneId ?? "pane", props);
      return (
        <div data-testid="runtime-probe">
          <span data-testid="runtime-pane">{props.paneId ?? ""}</span>
          <span data-testid="runtime-root">{props.root ?? ""}</span>
          <span data-testid="runtime-file">{props.file ?? ""}</span>
          <span data-testid="runtime-open-files">{(props.openFiles ?? []).join("|")}</span>
          <span data-testid="runtime-dirty-files">{(props.dirtyFiles ?? []).join("|")}</span>
          {(props.openFiles ?? []).map((path) => {
            const handleProps = props.renderTabHandle?.(
              path,
              path === props.file,
              props.dirtyFiles?.includes(path) ?? false,
              {
                onDragModeStart: () =>
                  probeState.dragModeStarts.push({ paneId: props.paneId ?? "pane", path }),
              },
            );
            return (
              <button
                key={`${props.paneId ?? "pane"}-${path}`}
                type="button"
                aria-label={`Tab handle ${props.paneId ?? "pane"} ${path}`}
                {...handleProps}
                onClick={() => props.onSelectOpenFile?.(path)}
              >
                {path}
              </button>
            );
          })}
          {props.toolbarExtras}
          <button type="button" onClick={() => props.onSelectOpenFile?.("src/b.ts")}>
            Select b
          </button>
          <button type="button" onClick={() => props.onSelectOpenFile?.(props.file ?? "")}>
            Select current {props.paneId ?? "pane"}
          </button>
          <button type="button" onClick={() => props.onSelectOpenFile?.("")}>
            Select empty
          </button>
          <button type="button" onClick={() => props.onCloseOpenFile?.("src/a.ts")}>
            Close a
          </button>
          <button type="button" onClick={() => props.onCloseOpenFile?.("src/b.ts")}>
            Close b
          </button>
          <button type="button" onClick={() => props.onDirtyChange?.(props.file ?? "", true)}>
            Mark dirty {props.paneId ?? "pane"}
          </button>
          <button type="button" onClick={() => props.onDirtyChange?.(props.file ?? "", false)}>
            Mark clean {props.paneId ?? "pane"}
          </button>
          <button
            type="button"
            onClick={() =>
              props.onOutlineStateChange?.(props.paneId ?? "pane", {
                filePath: props.file,
                symbols: [
                  {
                    name: "Workspace",
                    kind: "class",
                    range: { start: { line: 0, column: 0 }, end: { line: 4, column: 1 } },
                  },
                ],
                cursor: { line: 1, column: 2 },
                enabled: true,
                loading: false,
              })
            }
          >
            Publish outline {props.paneId ?? "pane"}
          </button>
          {externalSaveRequest !== undefined ? (
            <>
              <button
                type="button"
                onClick={() =>
                  props.onExternalSaveComplete?.(
                    externalSaveRequest.id,
                    externalSaveRequest.paneId,
                    externalSaveRequest.file,
                    true,
                  )
                }
              >
                Complete save {externalSaveRequest.file}
              </button>
              <button
                type="button"
                onClick={() =>
                  props.onExternalSaveComplete?.(
                    externalSaveRequest.id,
                    externalSaveRequest.paneId,
                    externalSaveRequest.file,
                    false,
                  )
                }
              >
                Fail save {externalSaveRequest.file}
              </button>
            </>
          ) : null}
        </div>
      );
    }
    return RuntimeProbe;
  },
}));

vi.mock("./FilesWidget", () => ({
  FilesWidget: ({
    root,
    activeFilePath,
    onOpenFile,
    onRootChange,
  }: {
    readonly root?: string;
    readonly activeFilePath?: string;
    readonly onOpenFile: (root: string, path: string) => void;
    readonly onRootChange: (root: string) => void;
  }) => (
    <div data-testid="files-probe">
      <span data-testid="files-root">{root ?? ""}</span>
      <span data-testid="files-active">{activeFilePath ?? ""}</span>
      <button type="button" onClick={() => onOpenFile("/repo", "package.json")}>
        Open package
      </button>
      <button type="button" onClick={() => onOpenFile("/repo", "")}>
        Open empty file
      </button>
      <button type="button" onClick={() => onOpenFile("", "package.json")}>
        Open file without root
      </button>
      <button type="button" onClick={() => onOpenFile("/repo", "/other/project/main.py")}>
        Open absolute file outside root
      </button>
      <button type="button" onClick={() => onRootChange("/next")}>
        Open next root
      </button>
      <button type="button" onClick={() => onRootChange("   ")}>
        Open empty root
      </button>
    </div>
  ),
}));

const hotExitState = vi.hoisted(() => ({ deletes: [] as Array<readonly [string, string]> }));

vi.mock("./editorHotExitStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./editorHotExitStore")>();
  return {
    ...actual,
    deleteEditorHotExitSnapshot: vi.fn((root: string, path: string) => {
      hotExitState.deletes.push([root, path]);
      return Promise.resolve();
    }),
  };
});

afterEach(() => {
  probeState.runtimeProps = null;
  probeState.dragModeStarts = [];
  probeState.propsByPane.clear();
  vi.clearAllMocks();
});

describe("EditorWidget workspace session", () => {
  it("shows the project picker (not the runtime widget) while no workspace root is selected", () => {
    render(<EditorWidget />);

    // Unbound editor (e.g. toggled open from the left rail) offers the native folder picker so a
    // project can be chosen, rather than passing through to an empty, dead-end runtime widget.
    expect(screen.getByTestId("editor-empty-state")).toBeInTheDocument();
    expect(screen.getByTestId("editor-empty-browse")).toBeInTheDocument();
    expect(screen.queryByTestId("runtime-probe")).toBeNull();
    expect(screen.queryByTestId("files-probe")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resize project tree" })).toBeNull();
  });

  it("lets the empty editor pane fill the full editor area when no file is open", () => {
    render(<EditorWidget root="/repo" />);

    expect(screen.getByTestId("runtime-probe")).toBeInTheDocument();
    expect(screen.getByTestId("runtime-file")).toHaveTextContent("");
    const pane = screen.getByTestId("runtime-probe").closest(".ed-pane");
    expect(pane).not.toBeNull();
    expect(pane).toHaveAttribute("data-active", "true");
    expect(screen.queryByRole("separator", { name: "Resize editor split" })).toBeNull();
    expect(screen.getByTestId("runtime-probe").closest(".ed-panes")).toHaveClass("single");
  });

  it("persists the open tab list when a file is opened from the embedded project tree", async () => {
    const onWorkspaceChange = vi.fn();
    render(<EditorWidget root="/repo" file="src/a.ts" onWorkspaceChange={onWorkspaceChange} />);

    await waitFor(() => {
      expect(onWorkspaceChange).toHaveBeenCalledWith(
        expect.objectContaining({
          root: "/repo",
          file: "src/a.ts",
          openFiles: ["src/a.ts"],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Open package" }));

    expect(screen.getByTestId("runtime-file")).toHaveTextContent("package.json");
    expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/a.ts|package.json");
    expect(onWorkspaceChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        root: "/repo",
        file: "package.json",
        openFiles: ["src/a.ts", "package.json"],
      }),
    );
  });

  it("restores the first persisted tab when the active file is missing", () => {
    const onWorkspaceChange = vi.fn();
    render(
      <EditorWidget
        root="/repo"
        openFiles={["src/a.ts", "src/b.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );

    expect(screen.getByTestId("runtime-file")).toHaveTextContent("src/a.ts");
    expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/a.ts|src/b.ts");
    expect(onWorkspaceChange).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/repo",
        file: "src/a.ts",
        openFiles: ["src/a.ts", "src/b.ts"],
      }),
    );
  });

  it("promotes the neighboring tab when the active tab is closed", () => {
    const onWorkspaceChange = vi.fn();
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close a" }));

    expect(probeState.runtimeProps?.file).toBe("src/b.ts");
    expect(probeState.runtimeProps?.openFiles).toEqual(["src/b.ts"]);
    expect(onWorkspaceChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        root: "/repo",
        file: "src/b.ts",
        openFiles: ["src/b.ts"],
      }),
    );
  });

  it("does not split a single open file into a duplicate editor pane", () => {
    const onWorkspaceChange = vi.fn();
    render(<EditorWidget root="/repo" file="src/a.ts" onWorkspaceChange={onWorkspaceChange} />);

    const splitRight = screen.getByRole("button", { name: "Split src/a.ts right" });
    expect(splitRight).not.toHaveAttribute("data-tip");
    expect(splitRight).not.toHaveAttribute("title");
    onWorkspaceChange.mockClear();
    fireEvent.click(splitRight);

    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(1);
    expect(screen.queryByRole("separator", { name: "Resize editor split" })).toBeNull();
    expect(onWorkspaceChange).not.toHaveBeenCalled();
  });

  it("splits open files into two equal side-by-side editor panes", () => {
    const onWorkspaceChange = vi.fn();
    const { container } = render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", ".editorconfig"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );

    const splitRight = screen.getByRole("button", { name: "Split src/a.ts right" });
    expect(splitRight).not.toHaveAttribute("data-tip");
    expect(splitRight).not.toHaveAttribute("title");
    fireEvent.click(splitRight);

    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(2);
    expect(screen.getAllByTestId("runtime-file").map((node) => node.textContent)).toEqual([
      "src/b.ts",
      "src/a.ts",
    ]);
    expect(screen.getAllByTestId("runtime-open-files").map((node) => node.textContent)).toEqual([
      "src/b.ts|.editorconfig",
      "src/a.ts",
    ]);
    expect(screen.getByRole("separator", { name: "Resize editor split" })).toBeInTheDocument();
    expect(container.querySelector(".editor-workspace")).toHaveAttribute("data-pane-count", "2");
    const lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(lastPatch).toEqual(
      expect.objectContaining({
        root: "/repo",
        file: "src/a.ts",
        openFiles: ["src/b.ts", ".editorconfig", "src/a.ts"],
      }),
    );
    expect(JSON.parse(String(lastPatch?.layoutJson))).toEqual(
      expect.objectContaining({
        schemaVersion: 2,
        activePaneId: "pane-2",
        tree: expect.objectContaining({
          type: "split",
          direction: "row",
          ratio: 50,
        }),
        panes: expect.objectContaining({
          "pane-1": expect.objectContaining({
            id: "pane-1",
            activeFile: "src/b.ts",
            openFiles: ["src/b.ts", ".editorconfig"],
          }),
          "pane-2": expect.objectContaining({
            id: "pane-2",
            activeFile: "src/a.ts",
            openFiles: ["src/a.ts"],
          }),
        }),
      }),
    );
  });

  // GEN-PERF-EDITOR-003 — arming a tab hold on one pane must not change the prop bundle the
  // OTHER pane's editor host receives; specifically renderTabHandle must stay referentially
  // stable so React.memo(EditorRuntimeWidget) bails the non-dragged pane out. Before the fix
  // the inline renderTabHandle closure was rebuilt on every EditorWidget render, so any
  // hold-state change churned every pane's renderTabHandle identity.
  it("keeps the non-dragged pane's props (incl. renderTabHandle) stable when a hold arms on another pane", () => {
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", ".editorconfig"]}
        onWorkspaceChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));
    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(2);

    const beforePane1 = probeState.propsByPane.get("pane-1");
    expect(beforePane1).toBeDefined();
    const renderTabHandleBefore = beforePane1?.renderTabHandle;
    const onSelectBefore = beforePane1?.onSelectOpenFile;
    const onMoveTabBefore = beforePane1?.onMoveTab;
    // pane-1 is not held, so its held-tab scalar is undefined before AND after.
    expect(beforePane1?.heldTabFile).toBeUndefined();

    // Arm a pointer-drag hold on pane-2's tab (state-only change on pane-2).
    fireEvent.pointerDown(screen.getByRole("button", { name: "Tab handle pane-2 src/a.ts" }), {
      button: 0,
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    });

    const afterPane1 = probeState.propsByPane.get("pane-1");
    // renderTabHandle and the other bound callbacks are referentially identical (memoized
    // per pane), and the held-tab scalar for pane-1 is still undefined — so a real
    // React.memo shallow compare would bail pane-1 out entirely.
    expect(afterPane1?.renderTabHandle).toBe(renderTabHandleBefore);
    expect(afterPane1?.onSelectOpenFile).toBe(onSelectBefore);
    expect(afterPane1?.onMoveTab).toBe(onMoveTabBefore);
    expect(afterPane1?.heldTabFile).toBeUndefined();

    // Release the pointer so the window-level drag listeners installed by the hold are torn
    // down and do not leak into sibling tests. jsdom lacks elementFromPoint, which the
    // pointer-up path calls for drop hit-testing, so stub it for this teardown.
    const originalElementFromPoint = document.elementFromPoint;
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () =>
      null;
    try {
      fireEvent.pointerUp(window, { button: 0, pointerType: "mouse", clientX: 10, clientY: 10 });
    } finally {
      (
        document as unknown as { elementFromPoint: typeof originalElementFromPoint }
      ).elementFromPoint = originalElementFromPoint;
    }
  });

  it("activates an inactive pane when selecting its current file", () => {
    const onWorkspaceChange = vi.fn();
    const layoutJson = JSON.stringify({
      schemaVersion: 2,
      root: "/repo",
      activePaneId: "pane-1",
      sidebarWidth: 260,
      sidebarCollapsed: false,
      tree: {
        type: "split",
        id: "split-1",
        direction: "row",
        ratio: 50,
        first: { type: "pane", paneId: "pane-1" },
        second: { type: "pane", paneId: "pane-2" },
      },
      panes: {
        "pane-1": {
          id: "pane-1",
          activeFile: "src/a.ts",
          openFiles: ["src/a.ts", "src/b.ts"],
          tabOrder: ["src/a.ts", "src/b.ts"],
        },
        "pane-2": {
          id: "pane-2",
          activeFile: "src/c.ts",
          openFiles: ["src/c.ts", "src/d.ts"],
          tabOrder: ["src/c.ts", "src/d.ts"],
        },
      },
    });
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]}
        layoutJson={layoutJson}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    onWorkspaceChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Select current pane-2" }));

    const lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    const layout = JSON.parse(String(lastPatch?.layoutJson));
    expect(layout.activePaneId).toBe("pane-2");
    expect(layout.panes["pane-2"].activeFile).toBe("src/c.ts");
  });

  it("activates an inactive pane when focusing inside its editor surface", () => {
    const onWorkspaceChange = vi.fn();
    const layoutJson = JSON.stringify({
      schemaVersion: 2,
      root: "/repo",
      activePaneId: "pane-1",
      sidebarWidth: 260,
      sidebarCollapsed: false,
      tree: {
        type: "split",
        id: "split-1",
        direction: "column",
        ratio: 50,
        first: { type: "pane", paneId: "pane-1" },
        second: { type: "pane", paneId: "pane-2" },
      },
      panes: {
        "pane-1": {
          id: "pane-1",
          activeFile: "src/top.ts",
          openFiles: ["src/top.ts"],
          tabOrder: ["src/top.ts"],
        },
        "pane-2": {
          id: "pane-2",
          activeFile: "docs/bottom.md",
          openFiles: ["docs/bottom.md"],
          tabOrder: ["docs/bottom.md"],
        },
      },
    });
    render(
      <EditorWidget
        root="/repo"
        file="src/top.ts"
        openFiles={["src/top.ts", "docs/bottom.md"]}
        layoutJson={layoutJson}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    onWorkspaceChange.mockClear();

    const bottomPane = document.querySelector<HTMLElement>('[data-pane-id="pane-2"]');
    expect(bottomPane).not.toBeNull();
    fireEvent.pointerDown(bottomPane as HTMLElement);

    let lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    let layout = JSON.parse(String(lastPatch?.layoutJson));
    expect(lastPatch).toEqual(expect.objectContaining({ file: "docs/bottom.md" }));
    expect(layout.activePaneId).toBe("pane-2");

    onWorkspaceChange.mockClear();
    const topPane = document.querySelector<HTMLElement>('[data-pane-id="pane-1"]');
    expect(topPane).not.toBeNull();
    fireEvent.focus(topPane as HTMLElement);

    lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    layout = JSON.parse(String(lastPatch?.layoutJson));
    expect(lastPatch).toEqual(expect.objectContaining({ file: "src/top.ts" }));
    expect(layout.activePaneId).toBe("pane-1");
  });

  it("normalizes persisted duplicate split panes into distinct file ownership", () => {
    const onWorkspaceChange = vi.fn();
    const duplicateLayoutJson = JSON.stringify({
      schemaVersion: 2,
      root: "/repo",
      activePaneId: "pane-1",
      tree: {
        type: "split",
        id: "split-old",
        direction: "row",
        ratio: 50,
        first: { type: "pane", paneId: "pane-1" },
        second: { type: "pane", paneId: "pane-2" },
      },
      panes: {
        "pane-1": {
          id: "pane-1",
          activeFile: "src/a.ts",
          openFiles: ["src/a.ts", "src/b.ts"],
          tabOrder: ["src/a.ts", "src/b.ts"],
        },
        "pane-2": {
          id: "pane-2",
          activeFile: "src/a.ts",
          openFiles: ["src/a.ts", "src/b.ts"],
          tabOrder: ["src/a.ts", "src/b.ts"],
        },
      },
      sidebarWidth: 260,
      sidebarCollapsed: false,
    });
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts"]}
        layoutJson={duplicateLayoutJson}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );

    expect(screen.getAllByTestId("runtime-file").map((node) => node.textContent)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(screen.getAllByTestId("runtime-open-files").map((node) => node.textContent)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    const lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    const layout = JSON.parse(String(lastPatch?.layoutJson));
    expect(layout.panes["pane-1"].openFiles).toEqual(["src/a.ts"]);
    expect(layout.panes["pane-2"].openFiles).toEqual(["src/b.ts"]);
  });

  it("splits tabs without duplicating the active file and refuses single-tab clones", () => {
    const onWorkspaceChange = vi.fn();
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    const expectSplitLayout = (layout: unknown, direction: "row" | "column"): void => {
      expect(layout).toEqual(
        expect.objectContaining({
          activePaneId: "pane-2",
          tree: expect.objectContaining({
            type: "split",
            direction,
            ratio: 50,
          }),
          panes: expect.objectContaining({
            "pane-1": expect.objectContaining({
              activeFile: "src/b.ts",
              openFiles: ["src/b.ts", "src/c.ts"],
            }),
            "pane-2": expect.objectContaining({
              activeFile: "src/a.ts",
              openFiles: ["src/a.ts"],
            }),
          }),
        }),
      );
      expect(Object.keys((layout as { panes: Record<string, unknown> }).panes)).toHaveLength(2);
    };

    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));

    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(2);
    let lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expectSplitLayout(JSON.parse(String(lastPatch?.layoutJson)), "row");

    onWorkspaceChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts down" }));

    // The active tab is already alone in pane-2; splitting it again would create a clone.
    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(2);
    expect(onWorkspaceChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close split src/a.ts" }));

    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Split src/b.ts down" }));

    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(2);
    lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(lastPatch?.layoutJson))).toEqual(
      expect.objectContaining({
        activePaneId: "pane-2",
        tree: expect.objectContaining({ type: "split", direction: "column", ratio: 50 }),
        panes: expect.objectContaining({
          "pane-1": expect.objectContaining({
            activeFile: "src/c.ts",
            openFiles: ["src/c.ts"],
          }),
          "pane-2": expect.objectContaining({
            activeFile: "src/b.ts",
            openFiles: ["src/b.ts"],
          }),
        }),
      }),
    );
  });

  it("collapses and restores the embedded project tree", () => {
    const onWorkspaceChange = vi.fn();
    render(<EditorWidget root="/repo" file="src/a.ts" onWorkspaceChange={onWorkspaceChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide project tree" }));

    expect(screen.queryByTestId("files-probe")).toBeNull();
    expect(screen.getByRole("button", { name: "Show project tree" })).toBeInTheDocument();
    let lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(lastPatch?.layoutJson))).toEqual(
      expect.objectContaining({ sidebarCollapsed: true }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Show project tree" }));

    expect(screen.getByTestId("files-probe")).toBeInTheDocument();
    lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(lastPatch?.layoutJson))).toEqual(
      expect.objectContaining({ sidebarCollapsed: false }),
    );
  });

  it("persists outline panel visibility through the editor layout json", () => {
    const onWorkspaceChange = vi.fn();
    const { unmount } = render(
      <EditorWidget root="/repo" file="src/a.ts" onWorkspaceChange={onWorkspaceChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish outline pane-1" }));
    expect(screen.getByRole("treeitem", { name: /workspace class/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide outline panel" }));
    let lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    const hiddenLayoutJson = String(lastPatch?.layoutJson);
    expect(JSON.parse(hiddenLayoutJson)).toEqual(
      expect.objectContaining({ outlinePanelVisible: false }),
    );
    expect(screen.queryByRole("treeitem", { name: /workspace class/i })).toBeNull();

    unmount();
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        layoutJson={hiddenLayoutJson}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    expect(screen.getByRole("button", { name: "Show outline panel" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show outline panel" }));
    lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(lastPatch?.layoutJson))).toEqual(
      expect.objectContaining({ outlinePanelVisible: true }),
    );
  });

  it("normalizes absolute file paths before persisting the V2 layout", () => {
    const onWorkspaceChange = vi.fn();
    render(
      <EditorWidget
        root="/repo"
        file="/repo/src/a.ts"
        openFiles={["/repo/src/a.ts", "/repo/src/b.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );

    expect(screen.getByTestId("runtime-file")).toHaveTextContent("src/a.ts");
    expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/a.ts|src/b.ts");
    expect(onWorkspaceChange).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/repo",
        file: "src/a.ts",
        openFiles: ["src/a.ts", "src/b.ts"],
      }),
    );
  });

  it("treats opening the workspace root itself as an empty file selection", () => {
    const onWorkspaceChange = vi.fn();
    render(
      <EditorWidget
        root="/repo"
        file="/repo"
        openFiles={["/repo", "/repo/src/a.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );

    expect(screen.getByTestId("runtime-file")).toHaveTextContent("src/a.ts");
    expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/a.ts");
    expect(onWorkspaceChange).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/repo",
        file: "src/a.ts",
        openFiles: ["src/a.ts"],
      }),
    );
  });

  it("drops an absolute file outside the root to a non-blocking empty selection (#1374 AC1)", () => {
    // A persisted/aliased cfg.file that is absolute but does not live under the configured root
    // must never reach the BFF as an absolute path (which would 400 BAD_PATH). It resolves to no
    // active file so the editor renders its usable empty state instead of a failed load.
    const onWorkspaceChange = vi.fn();
    render(
      <EditorWidget
        root="/repo"
        file="/elsewhere/x.ts"
        openFiles={["/elsewhere/x.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );

    expect(screen.getByTestId("runtime-file")).toHaveTextContent("");
    expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("");
    expect(screen.getByTestId("runtime-root")).toHaveTextContent("/repo");
  });

  it("anchors a single absolute file outside the root to a containing root via openFile (#1374 AC3)", () => {
    // Exercises the editor's openFile single-file-target contract directly: handed an absolute file
    // that does not live under the current root, it selects the file's containing directory as the
    // root and opens the basename root-relative (AC3 "selects a containing root"). The pure
    // resolution is also covered by editor-workspace-path.test.ts (selectWorkspaceFileTarget).
    const onWorkspaceChange = vi.fn();
    render(<EditorWidget root="/repo" onWorkspaceChange={onWorkspaceChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Open absolute file outside root" }));

    expect(screen.getByTestId("runtime-root")).toHaveTextContent("/other/project");
    expect(screen.getByTestId("runtime-file")).toHaveTextContent("main.py");
    expect(onWorkspaceChange).toHaveBeenCalledWith(
      expect.objectContaining({ root: "/other/project", file: "main.py" }),
    );
  });

  it("remains mounted with the embedded tree after switching to a new root (#1374 AC4)", () => {
    const onWorkspaceChange = vi.fn();
    render(<EditorWidget root="/repo" file="src/a.ts" onWorkspaceChange={onWorkspaceChange} />);

    // A root change resets to an empty pane on the new root while keeping the embedded tree (its
    // sidebar) mounted, so the editor stays interactive. The genuine failed-root-load recovery
    // (error surfaced, app alive) lives in FilesWidget and is proven by the release-smoke e2e
    // ("arbitrary folder opening …": an unavailable root renders role="alert").
    fireEvent.click(screen.getByRole("button", { name: "Open next root" }));

    expect(screen.getByTestId("runtime-root")).toHaveTextContent("/next");
    expect(screen.getByTestId("files-probe")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open next root" })).toBeEnabled();
  });

  it("ignores empty root, file, and tab-selection intents from embedded controls", () => {
    const onWorkspaceChange = vi.fn();
    render(<EditorWidget root="/repo" file="src/a.ts" onWorkspaceChange={onWorkspaceChange} />);
    onWorkspaceChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Open empty file" }));
    fireEvent.click(screen.getByRole("button", { name: "Open file without root" }));
    fireEvent.click(screen.getByRole("button", { name: "Open empty root" }));
    fireEvent.click(screen.getByRole("button", { name: "Select empty" }));

    expect(screen.getByTestId("runtime-root")).toHaveTextContent("/repo");
    expect(screen.getByTestId("runtime-file")).toHaveTextContent("src/a.ts");
    expect(onWorkspaceChange).not.toHaveBeenCalled();
  });

  it("adds and removes the native beforeunload guard only while editor buffers are dirty", () => {
    render(<EditorWidget root="/repo" file="src/a.ts" />);

    fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-1" }));
    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Mark clean pane-1" }));
    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
  });

  it("cancels a dirty tab close without losing the open buffer", async () => {
    render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Close a" }));

    expect(await screen.findByRole("dialog", { name: "Unsaved editor changes" })).toHaveTextContent(
      "src/a.ts",
    );
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByTestId("runtime-file")).toHaveTextContent("src/a.ts");
    expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/a.ts|src/b.ts");
  });

  it("saves dirty files before applying a pending tab close", async () => {
    const onWorkspaceChange = vi.fn();
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Close a" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    fireEvent.click(await screen.findByRole("button", { name: "Complete save src/a.ts" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByTestId("runtime-file")).toHaveTextContent("src/b.ts");
    expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/b.ts");
    expect(onWorkspaceChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        file: "src/b.ts",
        openFiles: ["src/b.ts"],
      }),
    );
  });

  it("does not cancel a dirty-close save while the save is still pending", async () => {
    render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Close a" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByRole("dialog", { name: "Unsaved editor changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();

    fireEvent.click(await screen.findByRole("button", { name: "Complete save src/a.ts" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByTestId("runtime-file")).toHaveTextContent("src/b.ts");
  });

  it("keeps the dirty-close dialog open when an external save fails", async () => {
    render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Close a" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Fail save src/a.ts" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Save failed. The close action was not applied.",
    );
    expect(screen.getByRole("dialog", { name: "Unsaved editor changes" })).toBeInTheDocument();
    expect(screen.getByTestId("runtime-file")).toHaveTextContent("src/a.ts");
  });

  it("discards dirty files before changing the editor root", async () => {
    const onWorkspaceChange = vi.fn();
    render(<EditorWidget root="/repo" file="src/a.ts" onWorkspaceChange={onWorkspaceChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Open next root" }));

    expect(await screen.findByRole("dialog", { name: "Unsaved editor changes" })).toHaveTextContent(
      "src/a.ts",
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByTestId("runtime-root")).toHaveTextContent("/next");
    expect(screen.getByTestId("runtime-file")).toHaveTextContent("");
    expect(onWorkspaceChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        root: "/next",
        file: undefined,
        openFiles: undefined,
      }),
    );
  });

  it("routes dirty split-pane close through the dirty-close dialog", async () => {
    render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));
    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-2" }));
    fireEvent.click(screen.getByRole("button", { name: "Close split src/a.ts" }));

    expect(await screen.findByRole("dialog", { name: "Unsaved editor changes" })).toHaveTextContent(
      "src/a.ts",
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(screen.getAllByTestId("runtime-probe")).toHaveLength(1);
    });
    expect(screen.queryByRole("separator", { name: "Resize editor split" })).toBeNull();
  });

  it("deletes the hot-exit snapshot when a dirty tab close is discarded (AC5)", async () => {
    render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Close a" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    // An explicit Discard must remove the buffer's hot-exit snapshot from the EditorWidget side: the
    // runtime widget that normally deletes it has already unmounted with the closed tab.
    expect(hotExitState.deletes).toContainEqual(["/repo", "src/a.ts"]);
  });

  it("routes an in-app dirty close through the React dialog, never window.confirm (D4)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Close a" }));

    expect(
      await screen.findByRole("dialog", { name: "Unsaved editor changes" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("supports keyboard tab reordering within a pane", () => {
    const onWorkspaceChange = vi.fn();
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Tab handle pane-1 src/a.ts" }), {
      key: "ArrowRight",
      altKey: true,
    });

    expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/b.ts|src/a.ts");
    const lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(lastPatch?.layoutJson)).panes["pane-1"].tabOrder).toEqual([
      "src/b.ts",
      "src/a.ts",
    ]);
  });

  it("moves tabs to adjacent panes through the keyboard fallback", () => {
    const onWorkspaceChange = vi.fn();
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));

    fireEvent.keyDown(screen.getByRole("button", { name: "Tab handle pane-1 src/b.ts" }), {
      key: "ArrowRight",
      altKey: true,
      shiftKey: true,
    });

    expect(screen.getByRole("button", { name: "Tab handle pane-2 src/b.ts" })).toBeInTheDocument();
    let lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    const movedRight = JSON.parse(String(lastPatch?.layoutJson));
    expect(movedRight.panes["pane-1"].openFiles).toEqual(["src/c.ts"]);
    expect(movedRight.panes["pane-2"].openFiles).toEqual(["src/a.ts", "src/b.ts"]);

    onWorkspaceChange.mockClear();
    fireEvent.keyDown(screen.getByRole("button", { name: "Tab handle pane-1 src/c.ts" }), {
      key: "ArrowLeft",
      altKey: true,
      shiftKey: true,
    });
    expect(onWorkspaceChange).not.toHaveBeenCalled();
  });

  it("activates the next tab (not reorder) on a plain ArrowRight without the Alt modifier (GEN-UI-KEYBOARD-001)", () => {
    const onWorkspaceChange = vi.fn();
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    onWorkspaceChange.mockClear();

    fireEvent.keyDown(screen.getByRole("button", { name: "Tab handle pane-1 src/a.ts" }), {
      key: "ArrowRight",
    });

    // A plain (Alt-less) ArrowRight now roves the tab-stop to the next tab and activates it
    // (automatic activation, WCAG APG tablist) — it must NOT reorder the tabs.
    expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/a.ts|src/b.ts");
    expect(screen.getByTestId("runtime-file")).toHaveTextContent("src/b.ts");
    const lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(lastPatch?.file).toBe("src/b.ts");
    // Order preserved (activation, not reorder).
    expect(JSON.parse(String(lastPatch?.layoutJson)).panes["pane-1"].tabOrder).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("creates a split when a tab is dropped on a pane split zone", () => {
    const onWorkspaceChange = vi.fn();
    const { container } = render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    const dataTransfer = { effectAllowed: "", setData: vi.fn() };

    fireEvent.dragStart(screen.getByRole("button", { name: "Tab handle pane-1 src/b.ts" }), {
      dataTransfer,
    });
    const rightDropZone = container.querySelector(".ed-pane-drop-zone.right");
    expect(rightDropZone).not.toBeNull();
    fireEvent.dragOver(rightDropZone as Element);
    fireEvent.drop(rightDropZone as Element, { dataTransfer });

    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "src/b.ts");
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      "application/x-keiko-editor-tab",
      JSON.stringify({ paneId: "pane-1", file: "src/b.ts" }),
    );
    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(2);
    expect(screen.getAllByTestId("runtime-file").map((node) => node.textContent)).toContain(
      "src/b.ts",
    );
    const lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    const layout = JSON.parse(String(lastPatch?.layoutJson));
    expect(layout).toEqual(
      expect.objectContaining({
        activePaneId: "pane-2",
        tree: expect.objectContaining({ type: "split", direction: "row" }),
      }),
    );
    expect(layout.panes["pane-2"]).toEqual(
      expect.objectContaining({ activeFile: "src/b.ts", openFiles: ["src/b.ts"] }),
    );
  });

  it("creates a nested edge split while below the editor pane cap", () => {
    const onWorkspaceChange = vi.fn();
    const { container } = render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    const dataTransfer = { effectAllowed: "", setData: vi.fn() };

    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));

    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(2);
    onWorkspaceChange.mockClear();
    fireEvent.dragStart(screen.getByRole("button", { name: "Tab handle pane-1 src/b.ts" }), {
      dataTransfer,
    });
    const rightDropZone = container.querySelector(".ed-pane-drop-zone.right");
    expect(rightDropZone).not.toBeNull();
    fireEvent.drop(rightDropZone as Element, { dataTransfer });

    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Tab handle pane-3 src/b.ts" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tab handle pane-1 src/b.ts" })).toBeNull();
    const movedPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    const layout = JSON.parse(String(movedPatch?.layoutJson));
    expect(Object.keys(layout.panes)).toHaveLength(3);
    expect(layout.panes["pane-1"].openFiles).toEqual(["src/c.ts"]);
    expect(layout.panes["pane-2"].openFiles).toEqual(["src/a.ts"]);
    expect(layout.panes["pane-3"].openFiles).toEqual(["src/b.ts"]);
  });

  it("moves a dragged tab between pane centers and ignores stale drops", () => {
    const onWorkspaceChange = vi.fn();
    const { container } = render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));

    fireEvent.dragStart(screen.getByRole("button", { name: "Tab handle pane-1 src/b.ts" }), {
      dataTransfer: { effectAllowed: "", setData: vi.fn() },
    });
    const centerZones = container.querySelectorAll(".ed-pane-drop-zone.center");
    expect(centerZones).toHaveLength(2);
    fireEvent.drop(centerZones[1] as Element);

    expect(screen.getByRole("button", { name: "Tab handle pane-2 src/b.ts" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tab handle pane-1 src/b.ts" })).toBeNull();
    const movedPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(movedPatch?.layoutJson)).activePaneId).toBe("pane-2");

    onWorkspaceChange.mockClear();
    fireEvent.drop(centerZones[0] as Element);
    expect(onWorkspaceChange).not.toHaveBeenCalled();
  });

  it("moves a dropped tab from the serialized drag payload when drag state has not committed yet", () => {
    const onWorkspaceChange = vi.fn();
    const { container } = render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));
    onWorkspaceChange.mockClear();

    const centerZones = container.querySelectorAll(".ed-pane-drop-zone.center");
    fireEvent.drop(centerZones[1] as Element, {
      dataTransfer: {
        getData: (type: string) =>
          type === "application/x-keiko-editor-tab"
            ? JSON.stringify({ paneId: "pane-1", file: "src/b.ts" })
            : "",
      },
    });

    expect(screen.getByRole("button", { name: "Tab handle pane-2 src/b.ts" })).toBeInTheDocument();
    const movedPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    const layout = JSON.parse(String(movedPatch?.layoutJson));
    expect(layout.panes["pane-1"].openFiles).toEqual(["src/c.ts"]);
    expect(layout.panes["pane-2"].openFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("moves a pointer-dragged tab onto the pane currently under the cursor", async () => {
    const onWorkspaceChange = vi.fn();
    const previousBodyCursor = document.body.style.cursor;
    const previousBodyUserSelect = document.body.style.userSelect;
    const layoutJson = JSON.stringify({
      schemaVersion: 2,
      root: "/repo",
      activePaneId: "pane-1",
      tree: {
        type: "split",
        id: "split-1",
        direction: "row",
        ratio: 50,
        first: { type: "pane", paneId: "pane-1" },
        second: { type: "pane", paneId: "pane-2" },
      },
      panes: {
        "pane-1": {
          id: "pane-1",
          activeFile: "src/a.ts",
          openFiles: ["src/a.ts", "src/b.ts"],
          tabOrder: ["src/a.ts", "src/b.ts"],
        },
        "pane-2": {
          id: "pane-2",
          activeFile: "src/c.ts",
          openFiles: ["src/c.ts"],
          tabOrder: ["src/c.ts"],
        },
      },
      sidebarWidth: 260,
      sidebarCollapsed: false,
    });
    const { container } = render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts"]}
        layoutJson={layoutJson}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    onWorkspaceChange.mockClear();
    const targetPane = container.querySelector<HTMLElement>('[data-pane-id="pane-2"]');
    expect(targetPane).not.toBeNull();
    const previousElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => targetPane),
    });
    try {
      const sourceTab = screen.getByRole("button", { name: "Tab handle pane-1 src/a.ts" });
      sourceTab.getBoundingClientRect = vi.fn(
        () =>
          ({
            x: 5,
            y: 6,
            left: 5,
            top: 6,
            right: 185,
            bottom: 34,
            width: 180,
            height: 28,
            toJSON: () => ({}),
          }) as DOMRect,
      );

      fireEvent.pointerDown(sourceTab, {
        button: 0,
        clientX: 10,
        clientY: 10,
        pointerType: "mouse",
      });
      expect(sourceTab).toHaveAttribute("data-tab-held", "true");
      expect(document.querySelector(".ed-tab-drag-ghost")).toBeNull();
      expect(probeState.dragModeStarts).toEqual([]);
      fireEvent.pointerMove(window, { clientX: 40, clientY: 10, pointerType: "mouse" });
      // Drag ACTIVATION is synchronous (GEN-PERF-EDITOR-003 keeps it on the raw event)…
      expect(probeState.dragModeStarts).toEqual([{ paneId: "pane-1", path: "src/a.ts" }]);
      expect(document.body.style.cursor).toBe("grabbing");
      expect(sourceTab).toHaveAttribute("data-tab-held", "true");
      // …while target resolution and ghost positioning land on the next frame.
      await nextFrame();
      expect(targetPane).toHaveAttribute("data-tab-drop-target", "true");
      const dragGhost = document.querySelector<HTMLElement>(".ed-tab-drag-ghost");
      expect(dragGhost).toHaveTextContent("src/a.ts");
      expect(dragGhost?.style.getPropertyValue("--ed-tab-drag-x")).toBe("35px");
      expect(dragGhost?.style.getPropertyValue("--ed-tab-drag-y")).toBe("6px");
      expect(dragGhost?.style.getPropertyValue("--ed-tab-drag-width")).toBe("180px");
      const sidebarResizer = screen.getByRole("button", { name: "Resize project tree" });
      fireEvent.pointerMove(sidebarResizer, {
        pointerId: 1,
        buttons: 1,
        clientX: 320,
        clientY: 80,
      });
      expect(onWorkspaceChange).not.toHaveBeenCalled();
      const splitResizer = screen.getByRole("separator", { name: "Resize editor split" });
      fireEvent.pointerMove(splitResizer, {
        pointerId: 1,
        buttons: 1,
        clientX: 900,
        clientY: 20,
      });
      expect(onWorkspaceChange).not.toHaveBeenCalled();
      fireEvent.pointerUp(window, { clientX: 500, clientY: 20, pointerType: "mouse" });

      expect(
        screen.getByRole("button", { name: "Tab handle pane-2 src/a.ts" }),
      ).toBeInTheDocument();
      expect(document.body.style.cursor).toBe(previousBodyCursor);
      expect(document.body.style.userSelect).toBe(previousBodyUserSelect);
      expect(container.querySelector('[data-tab-held="true"]')).toBeNull();
      expect(document.querySelector(".ed-tab-drag-ghost")).toBeNull();
      expect(targetPane).toHaveAttribute("data-tab-drop-target", "false");
      const movedPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
      const layout = JSON.parse(String(movedPatch?.layoutJson));
      expect(Object.keys(layout.panes)).toHaveLength(2);
      expect(layout.panes["pane-1"].openFiles).toEqual(["src/b.ts"]);
      expect(layout.panes["pane-2"].openFiles).toEqual(["src/c.ts", "src/a.ts"]);
    } finally {
      if (previousElementFromPoint === undefined) {
        Reflect.deleteProperty(document, "elementFromPoint");
      } else {
        Object.defineProperty(document, "elementFromPoint", {
          configurable: true,
          value: previousElementFromPoint,
        });
      }
      document.body.style.cursor = previousBodyCursor;
      document.body.style.userSelect = previousBodyUserSelect;
    }
  });

  it("clears pane drag state when a tab drag ends without a drop", () => {
    const { container } = render(
      <EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />,
    );
    const tab = screen.getByRole("button", { name: "Tab handle pane-1 src/b.ts" });

    fireEvent.dragStart(tab, {
      dataTransfer: { effectAllowed: "", setData: vi.fn() },
    });
    expect(container.querySelector(".ed-pane")).toHaveAttribute("data-dragging", "true");

    fireEvent.dragEnd(tab);

    expect(container.querySelector(".ed-pane")).toHaveAttribute("data-dragging", "false");
  });

  it("reorders tabs by pointer drag within the same tab rail", async () => {
    const onWorkspaceChange = vi.fn();
    const previousElementFromPoint = document.elementFromPoint;
    const previousBodyCursor = document.body.style.cursor;
    const previousBodyUserSelect = document.body.style.userSelect;
    const { container } = render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    const sourceTab = screen.getByRole("button", { name: "Tab handle pane-1 src/a.ts" });
    const targetTab = screen.getByRole("button", { name: "Tab handle pane-1 src/b.ts" });
    sourceTab.getBoundingClientRect = vi.fn(
      () =>
        ({
          x: 20,
          y: 8,
          left: 20,
          top: 8,
          right: 140,
          bottom: 36,
          width: 120,
          height: 28,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    targetTab.getBoundingClientRect = vi.fn(
      () =>
        ({
          x: 160,
          y: 8,
          left: 160,
          top: 8,
          right: 280,
          bottom: 36,
          width: 120,
          height: 28,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => targetTab),
    });

    try {
      fireEvent.pointerDown(sourceTab, {
        button: 0,
        clientX: 24,
        clientY: 12,
        pointerType: "mouse",
      });
      fireEvent.pointerMove(window, { clientX: 260, clientY: 16, pointerType: "mouse" });
      // GEN-PERF-EDITOR-003 — insertion-target resolution lands on the next frame.
      await nextFrame();

      expect(probeState.runtimeProps?.tabInsertTarget).toEqual({
        file: "src/b.ts",
        edge: "after",
      });

      fireEvent.pointerUp(window, { clientX: 260, clientY: 16, pointerType: "mouse" });

      expect(container.querySelector('[data-tab-held="true"]')).toBeNull();
      expect(document.querySelector(".ed-tab-drag-ghost")).toBeNull();
      const movedPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
      const layout = JSON.parse(String(movedPatch?.layoutJson));
      expect(layout.panes["pane-1"].tabOrder).toEqual(["src/b.ts", "src/a.ts", "src/c.ts"]);
      expect(layout.panes["pane-1"].activeFile).toBe("src/a.ts");
    } finally {
      if (previousElementFromPoint === undefined) {
        Reflect.deleteProperty(document, "elementFromPoint");
      } else {
        Object.defineProperty(document, "elementFromPoint", {
          configurable: true,
          value: previousElementFromPoint,
        });
      }
      document.body.style.cursor = previousBodyCursor;
      document.body.style.userSelect = previousBodyUserSelect;
    }
  });

  it("keeps the next real tab click active after inserting a pointer-dragged tab", () => {
    const onWorkspaceChange = vi.fn();
    const previousElementFromPoint = document.elementFromPoint;
    const previousBodyCursor = document.body.style.cursor;
    const previousBodyUserSelect = document.body.style.userSelect;
    const { container } = render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    const sourceTab = screen.getByRole("button", { name: "Tab handle pane-1 src/a.ts" });
    const targetTab = screen.getByRole("button", { name: "Tab handle pane-1 src/b.ts" });
    const nextTab = screen.getByRole("button", { name: "Tab handle pane-1 src/c.ts" });
    sourceTab.getBoundingClientRect = vi.fn(
      () =>
        ({
          x: 20,
          y: 8,
          left: 20,
          top: 8,
          right: 140,
          bottom: 36,
          width: 120,
          height: 28,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    targetTab.getBoundingClientRect = vi.fn(
      () =>
        ({
          x: 160,
          y: 8,
          left: 160,
          top: 8,
          right: 280,
          bottom: 36,
          width: 120,
          height: 28,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => targetTab),
    });

    try {
      fireEvent.pointerDown(sourceTab, {
        button: 0,
        clientX: 24,
        clientY: 12,
        pointerType: "mouse",
      });
      fireEvent.pointerMove(window, { clientX: 260, clientY: 16, pointerType: "mouse" });
      fireEvent.pointerUp(window, { clientX: 260, clientY: 16, pointerType: "mouse" });

      onWorkspaceChange.mockClear();
      fireEvent.click(nextTab);

      const selectedPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
      const layout = JSON.parse(String(selectedPatch?.layoutJson));
      expect(layout.panes["pane-1"].activeFile).toBe("src/c.ts");
      expect(container.querySelector('[data-tab-held="true"]')).toBeNull();
    } finally {
      if (previousElementFromPoint === undefined) {
        Reflect.deleteProperty(document, "elementFromPoint");
      } else {
        Object.defineProperty(document, "elementFromPoint", {
          configurable: true,
          value: previousElementFromPoint,
        });
      }
      document.body.style.cursor = previousBodyCursor;
      document.body.style.userSelect = previousBodyUserSelect;
    }
  });

  it("resizes the sidebar and split panes through pointer and mouse controls", () => {
    const onWorkspaceChange = vi.fn();
    const { container } = render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    const workspace = container.querySelector(".editor-workspace") as HTMLElement;
    workspace.getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 10,
          top: 0,
          width: 800,
          height: 500,
          right: 810,
          bottom: 500,
          x: 10,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    const sidebarResizer = screen.getByRole("button", { name: "Resize project tree" });
    expect(sidebarResizer).not.toHaveClass("ui-tip");
    expect(sidebarResizer).not.toHaveAttribute("data-tip");
    expect(sidebarResizer).not.toHaveAttribute("title");
    sidebarResizer.setPointerCapture = vi.fn();
    sidebarResizer.hasPointerCapture = vi.fn(() => true);
    sidebarResizer.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(sidebarResizer, { pointerId: 1 });
    fireEvent.pointerMove(sidebarResizer, { pointerId: 1, buttons: 1, clientX: 350 });
    fireEvent.pointerUp(sidebarResizer, { pointerId: 1 });

    let lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(lastPatch?.layoutJson))).toEqual(
      expect.objectContaining({ sidebarWidth: 340 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));
    const splitRoot = container.querySelector(".ed-panes.row") as HTMLElement;
    splitRoot.getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 0,
          top: 0,
          width: 1000,
          height: 500,
          right: 1000,
          bottom: 500,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    const splitResizer = screen.getByRole("separator", { name: "Resize editor split" });
    expect(splitResizer).not.toHaveClass("ui-tip");
    expect(splitResizer).not.toHaveAttribute("data-tip");
    expect(splitResizer).not.toHaveAttribute("title");
    splitResizer.setPointerCapture = vi.fn();
    splitResizer.hasPointerCapture = vi.fn(() => true);
    splitResizer.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(splitResizer, { pointerId: 2 });
    fireEvent.pointerMove(splitResizer, { pointerId: 2, buttons: 1, clientX: 700, clientY: 20 });
    fireEvent.pointerUp(splitResizer, { pointerId: 2 });

    lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(lastPatch?.layoutJson)).tree.ratio).toBe(70);

    fireEvent.mouseDown(splitResizer);
    fireEvent.mouseMove(window, { clientX: 200, clientY: 20 });
    fireEvent.mouseUp(window);
    lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(lastPatch?.layoutJson)).tree.ratio).toBe(20);
  });

  it("resizes column splits vertically and ignores pointer movement without an active drag", () => {
    const onWorkspaceChange = vi.fn();
    const { container } = render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );

    const splitDown = screen.getByRole("button", { name: "Split src/a.ts down" });
    expect(splitDown).not.toHaveAttribute("data-tip");
    expect(splitDown).not.toHaveAttribute("title");
    fireEvent.click(splitDown);
    const splitRoot = container.querySelector(".ed-panes.column") as HTMLElement;
    splitRoot.getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 0,
          top: 20,
          width: 600,
          height: 400,
          right: 600,
          bottom: 420,
          x: 0,
          y: 20,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    const splitResizer = splitRoot.querySelector(".ed-pane-resizer") as HTMLButtonElement;
    expect(splitResizer).not.toHaveClass("ui-tip");
    expect(splitResizer).not.toHaveAttribute("data-tip");
    expect(splitResizer).not.toHaveAttribute("title");
    splitResizer.setPointerCapture = vi.fn();
    splitResizer.hasPointerCapture = vi.fn(() => false);
    splitResizer.releasePointerCapture = vi.fn();

    onWorkspaceChange.mockClear();
    fireEvent.pointerMove(splitResizer, { pointerId: 3, buttons: 0, clientX: 10, clientY: 350 });
    expect(onWorkspaceChange).not.toHaveBeenCalled();

    splitResizer.hasPointerCapture = vi.fn(() => true);
    fireEvent.pointerDown(splitResizer, { pointerId: 3 });
    fireEvent.pointerMove(splitResizer, { pointerId: 3, buttons: 1, clientX: 10, clientY: 340 });
    fireEvent.pointerCancel(splitResizer, { pointerId: 3 });

    const lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(lastPatch?.layoutJson)).tree.ratio).toBe(80);
    expect(splitResizer.releasePointerCapture).toHaveBeenCalledWith(3);
  });

  it("resizes the sidebar and editor split from keyboard arrows", () => {
    const onWorkspaceChange = vi.fn();
    const { container } = render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    const workspace = container.querySelector(".editor-workspace") as HTMLElement;
    workspace.getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 0,
          top: 0,
          width: 900,
          height: 600,
          right: 900,
          bottom: 600,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );

    const sidebarResizer = screen.getByRole("button", { name: "Resize project tree" });
    fireEvent.keyDown(sidebarResizer, { key: "ArrowRight" });
    let lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(lastPatch?.layoutJson))).toEqual(
      expect.objectContaining({ sidebarWidth: 272 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));
    const splitResizer = screen.getByRole("separator", { name: "Resize editor split" });
    fireEvent.keyDown(splitResizer, { key: "ArrowRight" });
    lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(lastPatch?.layoutJson)).tree.ratio).toBe(52);

    fireEvent.keyDown(splitResizer, { key: "ArrowDown" });
    expect(onWorkspaceChange.mock.calls.at(-1)?.[0]).toEqual(lastPatch);
  });
});

describe("EditorWidget — Issue #1375 layout regression hardening", () => {
  it("keeps tab order stable across a reload from persisted layout state (AC1)", () => {
    const onWorkspaceChange = vi.fn();
    const { unmount } = render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );

    // Reorder a.ts to the end of the strip with two keyboard moves.
    const reorder = (): void => {
      fireEvent.keyDown(screen.getByRole("button", { name: "Tab handle pane-1 src/a.ts" }), {
        key: "ArrowRight",
        altKey: true,
      });
    };
    reorder();
    reorder();

    const persisted = String(onWorkspaceChange.mock.calls.at(-1)?.[0]?.layoutJson);
    expect(JSON.parse(persisted).panes["pane-1"].tabOrder).toEqual([
      "src/b.ts",
      "src/c.ts",
      "src/a.ts",
    ]);
    unmount();

    // A reload re-creates the widget from the persisted layout JSON. The order must survive.
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts"]}
        layoutJson={persisted}
      />,
    );
    expect(screen.getByTestId("runtime-open-files")).toHaveTextContent(
      "src/b.ts|src/c.ts|src/a.ts",
    );
  });

  it("changes only layout, never dirty state, when a clean tab is dragged into a split (AC2)", () => {
    const { container } = render(
      <EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />,
    );

    fireEvent.dragStart(screen.getByRole("button", { name: "Tab handle pane-1 src/b.ts" }), {
      dataTransfer: { effectAllowed: "", setData: vi.fn() },
    });
    const rightZone = container.querySelector(".ed-pane-drop-zone.right");
    expect(rightZone).not.toBeNull();
    fireEvent.drop(rightZone as Element, { dataTransfer: { effectAllowed: "", setData: vi.fn() } });

    // The drag produced a split (layout change) but introduced no dirty marker.
    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(2);
    for (const node of screen.getAllByTestId("runtime-dirty-files")) {
      expect(node).not.toHaveTextContent("src/");
    }
  });

  it("re-homes the dirty marker and active selection when a dirty tab moves panes (AC3)", () => {
    const onWorkspaceChange = vi.fn();
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-1" }));
    expect(screen.getAllByTestId("runtime-dirty-files")[0]).toHaveTextContent("src/b.ts");

    fireEvent.keyDown(screen.getByRole("button", { name: "Tab handle pane-1 src/b.ts" }), {
      key: "ArrowRight",
      altKey: true,
      shiftKey: true,
    });

    // The dirty file now lives in pane-2, which becomes the active pane and selection.
    expect(screen.getByRole("button", { name: "Tab handle pane-2 src/b.ts" })).toBeInTheDocument();
    const movedPatch = JSON.parse(String(onWorkspaceChange.mock.calls.at(-1)?.[0]?.layoutJson));
    expect(movedPatch.activePaneId).toBe("pane-2");
    expect(movedPatch.panes["pane-2"].activeFile).toBe("src/b.ts");
    for (const node of screen.getAllByTestId("runtime-dirty-files")) {
      expect(node).toHaveTextContent("src/b.ts");
    }

    // Cleaning the file in its NEW pane clears the marker everywhere: no orphaned entry
    // survives on the pane the tab left (the AC3 regression).
    fireEvent.click(screen.getByRole("button", { name: "Mark clean pane-2" }));
    for (const node of screen.getAllByTestId("runtime-dirty-files")) {
      expect(node).not.toHaveTextContent("src/b.ts");
    }
  });

  it("does not raise a false unsaved-changes prompt on the pane a dirty tab left (AC3)", () => {
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts"]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-1" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Tab handle pane-1 src/b.ts" }), {
      key: "ArrowRight",
      altKey: true,
      shiftKey: true,
    });

    // b.ts is dirty and now lives only in pane-2. Closing the stale b.ts command from the pane it
    // LEFT (pane-1) must not consult an orphaned dirty flag and pop the unsaved-changes dialog.
    const closeFromPaneOne = screen.getAllByRole("button", { name: "Close b" })[0] as HTMLElement;
    fireEvent.click(closeFromPaneOne);

    expect(screen.queryByRole("dialog", { name: "Unsaved editor changes" })).toBeNull();
  });

  it("collapses an empty pane back to a single pane when its last tab closes (AC4)", async () => {
    render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));
    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(2);

    // pane-2 holds only a.ts; closing it leaves the pane empty and must collapse the split.
    const closeButtons = screen.getAllByRole("button", { name: "Close a" });
    fireEvent.click(closeButtons[1] as HTMLElement);

    await waitFor(() => {
      expect(screen.getAllByTestId("runtime-probe")).toHaveLength(1);
    });
    expect(screen.queryByRole("separator", { name: "Resize editor split" })).toBeNull();
  });

  it("exposes accessible split-resizer separator semantics that track the ratio (AC5)", () => {
    render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));
    const resizer = screen.getByRole("separator", { name: "Resize editor split" });
    expect(resizer).toHaveAttribute("aria-orientation", "vertical");
    expect(resizer).toHaveAttribute("aria-valuemin", "15");
    expect(resizer).toHaveAttribute("aria-valuemax", "85");
    expect(resizer).toHaveAttribute("aria-valuenow", "50");

    fireEvent.keyDown(resizer, { key: "ArrowRight" });
    expect(screen.getByRole("separator", { name: "Resize editor split" })).toHaveAttribute(
      "aria-valuenow",
      "52",
    );
  });
});
