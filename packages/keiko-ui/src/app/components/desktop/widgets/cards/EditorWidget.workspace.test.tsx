import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { EditorRuntimeWidgetProps } from "./EditorRuntimeWidget";
import { EditorWidget } from "./EditorWidget";

const probeState = vi.hoisted(() => ({
  runtimeProps: null as EditorRuntimeWidgetProps | null,
}));

vi.mock("next/dynamic", () => ({
  default: () => {
    function RuntimeProbe(props: EditorRuntimeWidgetProps): ReactNode {
      const externalSaveRequest = props.externalSaveRequest;
      probeState.runtimeProps = props;
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
            );
            return (
              <button
                key={`${props.paneId ?? "pane"}-${path}`}
                type="button"
                aria-label={`Tab handle ${props.paneId ?? "pane"} ${path}`}
                {...handleProps}
              >
                {path}
              </button>
            );
          })}
          {props.toolbarExtras}
          <button type="button" onClick={() => props.onSelectOpenFile?.("src/b.ts")}>
            Select b
          </button>
          <button type="button" onClick={() => props.onSelectOpenFile?.("")}>
            Select empty
          </button>
          <button type="button" onClick={() => props.onCloseOpenFile?.("src/a.ts")}>
            Close a
          </button>
          <button type="button" onClick={() => props.onDirtyChange?.("src/a.ts", true)}>
            Mark dirty {props.paneId ?? "pane"}
          </button>
          <button type="button" onClick={() => props.onDirtyChange?.("src/a.ts", false)}>
            Mark clean {props.paneId ?? "pane"}
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

afterEach(() => {
  probeState.runtimeProps = null;
  vi.clearAllMocks();
});

describe("EditorWidget workspace session", () => {
  it("passes through to the runtime widget while no workspace root is selected", () => {
    render(<EditorWidget />);

    expect(screen.getByTestId("runtime-probe")).toBeInTheDocument();
    expect(screen.getByTestId("runtime-root")).toHaveTextContent("");
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

  it("splits the active tab into a second resizable editor pane", () => {
    const onWorkspaceChange = vi.fn();
    render(<EditorWidget root="/repo" file="src/a.ts" onWorkspaceChange={onWorkspaceChange} />);

    const splitRight = screen.getByRole("button", { name: "Split src/a.ts right" });
    expect(splitRight).toHaveAttribute("data-tip", "Split right");
    expect(splitRight).not.toHaveAttribute("title");
    fireEvent.click(splitRight);

    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(2);
    expect(screen.getAllByTestId("runtime-file").map((node) => node.textContent)).toEqual([
      "src/a.ts",
      "src/a.ts",
    ]);
    expect(screen.getByRole("separator", { name: "Resize editor split" })).toBeInTheDocument();
    const lastPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(lastPatch).toEqual(
      expect.objectContaining({
        root: "/repo",
        file: "src/a.ts",
        openFiles: ["src/a.ts"],
      }),
    );
    expect(JSON.parse(String(lastPatch?.layoutJson))).toEqual(
      expect.objectContaining({
        schemaVersion: 2,
        activePaneId: "pane-2",
        tree: expect.objectContaining({
          type: "split",
          direction: "row",
        }),
        panes: expect.objectContaining({
          "pane-1": expect.objectContaining({ id: "pane-1", activeFile: "src/a.ts" }),
          "pane-2": expect.objectContaining({ id: "pane-2", activeFile: "src/a.ts" }),
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
    render(<EditorWidget root="/repo" file="src/a.ts" />);

    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));
    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-2" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Close split src/a.ts" })[1] as HTMLElement,
    );

    expect(await screen.findByRole("dialog", { name: "Unsaved editor changes" })).toHaveTextContent(
      "src/a.ts",
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(screen.getAllByTestId("runtime-probe")).toHaveLength(1);
    });
    expect(screen.queryByRole("separator", { name: "Resize editor split" })).toBeNull();
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
        openFiles={["src/a.ts", "src/b.ts"]}
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
    expect(JSON.parse(String(lastPatch?.layoutJson)).panes["pane-2"].openFiles).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);

    onWorkspaceChange.mockClear();
    fireEvent.keyDown(screen.getByRole("button", { name: "Tab handle pane-2 src/b.ts" }), {
      key: "ArrowRight",
      altKey: true,
      shiftKey: true,
    });
    expect(onWorkspaceChange).not.toHaveBeenCalled();
  });

  it("ignores keyboard tab movement when the Alt modifier is absent", () => {
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

    expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/a.ts|src/b.ts");
    expect(onWorkspaceChange).not.toHaveBeenCalled();
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

    expect(screen.queryByRole("button", { name: "Tab handle pane-1 src/b.ts" })).toBeNull();
    expect(screen.getByRole("button", { name: "Tab handle pane-2 src/b.ts" })).toBeInTheDocument();
    const movedPatch = onWorkspaceChange.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(movedPatch?.layoutJson)).activePaneId).toBe("pane-2");

    onWorkspaceChange.mockClear();
    fireEvent.drop(centerZones[0] as Element);
    expect(onWorkspaceChange).not.toHaveBeenCalled();
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

  it("resizes the sidebar and split panes through pointer and mouse controls", () => {
    const onWorkspaceChange = vi.fn();
    const { container } = render(
      <EditorWidget root="/repo" file="src/a.ts" onWorkspaceChange={onWorkspaceChange} />,
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
    expect(sidebarResizer).toHaveAttribute("data-tip", "Resize project tree");
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
    expect(splitResizer).toHaveAttribute("data-tip", "Resize editor split");
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
      <EditorWidget root="/repo" file="src/a.ts" onWorkspaceChange={onWorkspaceChange} />,
    );

    const splitDown = screen.getByRole("button", { name: "Split src/a.ts down" });
    expect(splitDown).toHaveAttribute("data-tip", "Split down");
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
    const splitResizer = screen.getByRole("separator", { name: "Resize editor split" });
    expect(splitResizer).toHaveAttribute("data-tip", "Resize editor split");
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
      <EditorWidget root="/repo" file="src/a.ts" onWorkspaceChange={onWorkspaceChange} />,
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
        openFiles={["src/a.ts", "src/b.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-1" }));
    expect(screen.getByTestId("runtime-dirty-files")).toHaveTextContent("src/a.ts");

    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Tab handle pane-1 src/a.ts" }), {
      key: "ArrowRight",
      altKey: true,
      shiftKey: true,
    });

    // The dirty file now lives in pane-2, which becomes the active pane and selection.
    expect(screen.getByRole("button", { name: "Tab handle pane-2 src/a.ts" })).toBeInTheDocument();
    const movedPatch = JSON.parse(String(onWorkspaceChange.mock.calls.at(-1)?.[0]?.layoutJson));
    expect(movedPatch.activePaneId).toBe("pane-2");
    expect(movedPatch.panes["pane-2"].activeFile).toBe("src/a.ts");
    for (const node of screen.getAllByTestId("runtime-dirty-files")) {
      expect(node).toHaveTextContent("src/a.ts");
    }

    // Cleaning the file in its NEW pane clears the marker everywhere: no orphaned entry
    // survives on the pane the tab left (the AC3 regression).
    fireEvent.click(screen.getByRole("button", { name: "Mark clean pane-2" }));
    for (const node of screen.getAllByTestId("runtime-dirty-files")) {
      expect(node).not.toHaveTextContent("src/a.ts");
    }
  });

  it("collapses an empty pane back to a single pane when its last tab closes (AC4)", async () => {
    render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));
    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(2);

    // pane-2 holds only a.ts; closing it leaves the pane empty and must collapse the split.
    const closeButtons = screen.getAllByRole("button", { name: "Close a" });
    fireEvent.click(closeButtons[closeButtons.length - 1] as HTMLElement);

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
