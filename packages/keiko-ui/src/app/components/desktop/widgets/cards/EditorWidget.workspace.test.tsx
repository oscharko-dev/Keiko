import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
import {
  EDITOR_VERIFICATION_KINDS,
  EDITOR_VERIFICATION_SCHEMA_VERSION,
  WORKSPACE_TRUST_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts";
import type { EditorRuntimeWidgetProps } from "./EditorRuntimeWidget";
import type { FilesMutationEvent } from "./FilesWidget";
import { EditorWidget } from "./EditorWidget";
import editorWidgetStyles from "./EditorWidget.module.css";
import { resetEditorVerificationRunStateForTests } from "./useEditorVerificationRun";
import { WORKSPACE_TRUST_CHANGED_EVENT } from "../../../../../lib/workspace-trust-api";
import { EditorQuickAccessTriggerProvider } from "../../EditorQuickAccessTriggerContext";
import { editorSidebarTrackWidth } from "../../editorSidebarSizing";

const createProjectMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../lib/api")>()),
  createProject: createProjectMock,
}));

function editorWidgetCssClass(name: keyof typeof editorWidgetStyles): string {
  const value = editorWidgetStyles[name];
  if (value === undefined) throw new TypeError(`missing EditorWidget CSS module class ${name}`);
  return value;
}

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

// Verdicts the tree received from the host's pre-flight ask, in order. The probe mirrors the real
// FilesWidget's sequence exactly — ask first, mutate only on `true`, report the mutation afterwards —
// so a host that fails to prompt or fails to veto is visible here. That the real widget actually
// follows that sequence is pinned separately in FilesWidget.test.tsx.
const filesProbeState = vi.hoisted(() => ({
  verdicts: [] as Array<{ readonly path: string; readonly allowed: boolean }>,
  // The real widget invokes both host callbacks through refs it refreshes on every render, so an
  // in-flight mutation always reaches the host's CURRENT handler. The probe mirrors that with
  // latest-value holders; capturing the props in a click closure instead would hand the host a stale
  // dirty snapshot and quietly hide a regression.
  onFilesMutated: undefined as ((event: FilesMutationEvent) => void) | undefined,
  onBeforeEntryMutation: undefined as ((path: string) => Promise<boolean>) | undefined,
}));

vi.mock("./FilesWidget", () => ({
  FilesWidget: ({
    root,
    activeFilePath,
    onOpenFile,
    onRootChange,
    onFilesMutated,
    onBeforeEntryMutation,
  }: {
    readonly root?: string;
    readonly activeFilePath?: string;
    readonly onOpenFile: (root: string, path: string) => void;
    readonly onRootChange: (root: string) => void;
    readonly onFilesMutated?: (event: FilesMutationEvent) => void;
    readonly onBeforeEntryMutation?: (path: string) => Promise<boolean>;
  }) => {
    filesProbeState.onFilesMutated = onFilesMutated;
    filesProbeState.onBeforeEntryMutation = onBeforeEntryMutation;
    const report = (event: FilesMutationEvent): void => {
      filesProbeState.onFilesMutated?.(event);
    };
    const mutate = async (path: string, event: FilesMutationEvent): Promise<void> => {
      const allowed = (await filesProbeState.onBeforeEntryMutation?.(path)) ?? true;
      filesProbeState.verdicts.push({ path, allowed });
      if (allowed) report(event);
    };
    return (
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
        <button
          type="button"
          onClick={() =>
            void mutate("src/a.ts", {
              op: "rename",
              mutation: {
                root: "/repo",
                path: "src/c.ts",
                previousPath: "src/a.ts",
                kind: "file",
              },
            })
          }
        >
          Rename a in tree
        </button>
        <button
          type="button"
          onClick={() =>
            void mutate("src", {
              op: "rename",
              mutation: { root: "/repo", path: "lib", previousPath: "src", kind: "directory" },
            })
          }
        >
          Rename src folder in tree
        </button>
        <button
          type="button"
          onClick={() =>
            void mutate("src/a.ts", {
              op: "delete",
              mutation: { root: "/repo", path: "src/a.ts", kind: "file" },
            })
          }
        >
          Delete a in tree
        </button>
        <button
          type="button"
          onClick={() =>
            report({
              op: "rename",
              mutation: {
                root: "/repo",
                path: "src/c.ts",
                previousPath: "src/a.ts",
                kind: "file",
              },
            })
          }
        >
          Report rename without asking
        </button>
        <button
          type="button"
          onClick={() =>
            report({
              op: "delete",
              mutation: { root: "/repo", path: "src/a.ts", kind: "file" },
            })
          }
        >
          Report delete without asking
        </button>
      </div>
    );
  },
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
  // Both recorders are module-scoped, so they have to be emptied between cases for a test to be able
  // to assert that NO snapshot was deleted and NO verdict was reached.
  hotExitState.deletes.length = 0;
  filesProbeState.verdicts.length = 0;
  filesProbeState.onFilesMutated = undefined;
  filesProbeState.onBeforeEntryMutation = undefined;
  vi.clearAllMocks();
});

// The pre-flight ask resolves through a promise chain; flushing microtasks inside act() lets the
// veto/allow verdict land without wrapping the (already act-wrapped) fireEvent click itself (S8980).
async function flushPreflight(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("EditorWidget workspace session", () => {
  it("shows the project picker (not the runtime widget) while no workspace root is selected", () => {
    render(<EditorWidget />);

    // Unbound editor (e.g. toggled open from the left rail) offers the native folder picker so a
    // project can be chosen, rather than passing through to an empty, dead-end runtime widget.
    expect(screen.getByTestId("editor-empty-state")).toBeInTheDocument();
    expect(screen.getByTestId("editor-empty-browse")).toBeInTheDocument();
    expect(screen.queryByTestId("runtime-probe")).toBeNull();
    expect(screen.queryByTestId("files-probe")).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize project tree" })).toBeNull();
  });

  it("keeps a project trust warning visible after the empty state opens the workspace", async () => {
    createProjectMock.mockResolvedValueOnce({
      project: { path: "/repo", workspaceAvailable: true },
      warning: {
        code: "PROJECT_TRUST_GRANT_FAILED",
        message: "The project was registered but remains restricted.",
        correlationId: "workspace-warning-correlation",
      },
    });
    render(<EditorWidget />);

    fireEvent.change(screen.getByLabelText("Project folder path"), {
      target: { value: "/repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(await screen.findByTestId("runtime-probe")).toBeInTheDocument();
    expect(screen.getByTestId("editor-workspace-registration-notice")).toHaveTextContent(
      "workspace-warning-correlation",
    );
    expect(screen.queryByTestId("editor-empty-state")).toBeNull();
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
    // typescript:S1874 (deprecated legacy attribute) regression pin: preventDefault()
    // alone is not reliably honored by every engine this product supports (older
    // Firefox/Safari, per packages/keiko-ui/package.json's browserslist floor), so the
    // handler also writes the legacy `event.returnValue` string. jsdom's plain Event
    // ties a `.returnValue` read back to `defaultPrevented` (spec's generic-Event
    // boolean semantics) rather than exposing BeforeUnloadEvent's DOMString override,
    // so this shadows the property with a spy to capture the exact write instead of
    // relying on jsdom's read-back. Do not remove the write without confirming every
    // supported browser floor no longer needs it.
    let capturedReturnValue: unknown;
    Object.defineProperty(dirtyEvent, "returnValue", {
      configurable: true,
      get: () => capturedReturnValue,
      set: (value: unknown) => {
        capturedReturnValue = value;
      },
    });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
    expect(capturedReturnValue).toBe("");

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

  it("traps Tab focus inside the dirty-close dialog instead of leaking to the editor behind it", async () => {
    render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Close a" }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved editor changes" });
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    const saveButton = within(dialog).getByRole("button", { name: "Save" });
    const cancelButton = within(dialog).getByRole("button", { name: "Cancel" });

    cancelButton.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(saveButton);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancelButton);
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

  // Renaming, moving or deleting an open DIRTY file from the Files tree used to be the one close path
  // in the product that skipped the dirty-close dialog: the tab was re-homed or removed, the unsaved
  // buffer was dropped by `reconcileEditorDirtyByPane`, AND the crash-recovery snapshot for the old
  // path was deleted — unrecoverable loss with no prompt. The tree now asks the host first, and the
  // host routes the answer through the same `requestDirtyClose` policy as every other close.
  describe("Files-tree mutations over unsaved buffers", () => {
    async function markDirtyAndTriggerTree(buttonName: string): Promise<void> {
      fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-1" }));
      fireEvent.click(screen.getByRole("button", { name: buttonName }));
      await flushPreflight();
    }

    it("prompts before a tree rename of a dirty file and keeps its recovery snapshot", async () => {
      render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

      await markDirtyAndTriggerTree("Rename a in tree");

      expect(
        await screen.findByRole("dialog", { name: "Unsaved editor changes" }),
      ).toHaveTextContent("src/a.ts");
      // Nothing is decided yet: the tree is still waiting, so no mutation has been reported.
      expect(filesProbeState.verdicts).toEqual([]);

      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      // Cancel is a veto, not a silent proceed: the tree learns the rename must not be sent.
      expect(filesProbeState.verdicts).toEqual([{ path: "src/a.ts", allowed: false }]);
      expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/a.ts|src/b.ts");
      expect(screen.getByTestId("runtime-dirty-files")).toHaveTextContent("src/a.ts");
      // The snapshot is the last copy of the unsaved buffer — it must survive.
      expect(hotExitState.deletes).toEqual([]);
    });

    it("prompts before a tree delete of a dirty file and keeps its recovery snapshot", async () => {
      render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

      await markDirtyAndTriggerTree("Delete a in tree");

      expect(
        await screen.findByRole("dialog", { name: "Unsaved editor changes" }),
      ).toHaveTextContent("src/a.ts");
      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(filesProbeState.verdicts).toEqual([{ path: "src/a.ts", allowed: false }]);
      expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/a.ts|src/b.ts");
      expect(hotExitState.deletes).toEqual([]);
    });

    it("prompts before renaming a DIRECTORY that contains a dirty file", async () => {
      render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

      await markDirtyAndTriggerTree("Rename src folder in tree");

      // The folder itself is never an open buffer; the dirty file *inside* it is what is at risk.
      expect(
        await screen.findByRole("dialog", { name: "Unsaved editor changes" }),
      ).toHaveTextContent("src/a.ts");
      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(filesProbeState.verdicts).toEqual([{ path: "src", allowed: false }]);
      expect(hotExitState.deletes).toEqual([]);
    });

    it("prompts when the mutated file is dirty only in a second pane", async () => {
      render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

      fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));
      expect(screen.getAllByTestId("runtime-probe")).toHaveLength(2);
      // Dirty in the split pane while pane-1 stays the intent's nominal pane: a pane-scoped lookup
      // would find nothing here and mutate straight through.
      fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-2" }));
      fireEvent.click(screen.getByRole("button", { name: "Rename a in tree" }));
      await flushPreflight();

      expect(
        await screen.findByRole("dialog", { name: "Unsaved editor changes" }),
      ).toHaveTextContent("src/a.ts");
      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(filesProbeState.verdicts).toEqual([{ path: "src/a.ts", allowed: false }]);
      expect(hotExitState.deletes).toEqual([]);
    });

    it("reports a veto when another close intent displaces the pending prompt", async () => {
      render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

      await markDirtyAndTriggerTree("Rename a in tree");
      await screen.findByRole("dialog", { name: "Unsaved editor changes" });
      // A tab close raised while the tree is still waiting replaces the dialog. The displaced ask can
      // never be answered, so it must come back as a veto rather than leaving the tree hanging.
      fireEvent.click(screen.getByRole("button", { name: "Close a" }));

      await waitFor(() => {
        expect(filesProbeState.verdicts).toEqual([{ path: "src/a.ts", allowed: false }]);
      });
      expect(hotExitState.deletes).toEqual([]);
    });

    it("re-homes the tab and drops the stale snapshot once the prompt is discarded", async () => {
      render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

      await markDirtyAndTriggerTree("Rename a in tree");
      fireEvent.click(await screen.findByRole("button", { name: "Discard" }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      // An explicit Discard is a decision, so the rename proceeds and the snapshot goes with it.
      expect(filesProbeState.verdicts).toEqual([{ path: "src/a.ts", allowed: true }]);
      await waitFor(() => {
        expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/c.ts|src/b.ts");
      });
      expect(hotExitState.deletes).toContainEqual(["/repo", "src/a.ts"]);
    });

    it("saves first, then applies the tree rename, when the prompt is answered with Save", async () => {
      render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

      await markDirtyAndTriggerTree("Rename a in tree");
      fireEvent.click(await screen.findByRole("button", { name: "Save" }));
      fireEvent.click(await screen.findByRole("button", { name: "Complete save src/a.ts" }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(filesProbeState.verdicts).toEqual([{ path: "src/a.ts", allowed: true }]);
      await waitFor(() => {
        expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/c.ts|src/b.ts");
      });
    });

    it("renames a CLEAN file with no prompt at all (happy path)", async () => {
      render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

      fireEvent.click(screen.getByRole("button", { name: "Rename a in tree" }));
      await flushPreflight();

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(filesProbeState.verdicts).toEqual([{ path: "src/a.ts", allowed: true }]);
      expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/c.ts|src/b.ts");
      // Nothing was unsaved, so the old path's stale snapshot is still cleaned up.
      expect(hotExitState.deletes).toContainEqual(["/repo", "src/a.ts"]);
    });

    it("deletes a CLEAN file with no prompt at all (happy path)", async () => {
      render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

      fireEvent.click(screen.getByRole("button", { name: "Delete a in tree" }));
      await flushPreflight();

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(filesProbeState.verdicts).toEqual([{ path: "src/a.ts", allowed: true }]);
      expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/b.ts");
      expect(hotExitState.deletes).toContainEqual(["/repo", "src/a.ts"]);
    });

    // Second line of defence: a mutation that reaches the host with the buffer still dirty (an
    // unguarded host, or a report from outside the guarded path) is too late to veto — but the
    // snapshot is then the only remaining copy of the unsaved work, so it must not be deleted.
    it("keeps the recovery snapshot when a rename is reported without the pre-flight ask", () => {
      render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

      fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-1" }));
      fireEvent.click(screen.getByRole("button", { name: "Report rename without asking" }));

      expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/c.ts|src/b.ts");
      expect(hotExitState.deletes).toEqual([]);
    });

    it("keeps the recovery snapshot when a delete is reported without the pre-flight ask", () => {
      render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);

      fireEvent.click(screen.getByRole("button", { name: "Mark dirty pane-1" }));
      fireEvent.click(screen.getByRole("button", { name: "Report delete without asking" }));

      expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/b.ts");
      expect(hotExitState.deletes).toEqual([]);
    });
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

  it("creates five recursively mixed row and column panes through edge drops", () => {
    const onWorkspaceChange = vi.fn();
    const { container } = render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts right" }));

    const dropFromFirstPane = (file: string, zone: "right" | "bottom"): void => {
      fireEvent.dragStart(screen.getByRole("button", { name: `Tab handle pane-1 ${file}` }), {
        dataTransfer: { effectAllowed: "", setData: vi.fn() },
      });
      const dropZone = container.querySelector(
        `[data-pane-id="pane-1"] > .ed-pane-drop-zones > .ed-pane-drop-zone.${zone}`,
      );
      expect(dropZone).not.toBeNull();
      fireEvent.drop(dropZone as Element);
    };

    dropFromFirstPane("src/b.ts", "bottom");
    dropFromFirstPane("src/c.ts", "right");
    dropFromFirstPane("src/d.ts", "bottom");

    expect(screen.getAllByTestId("runtime-probe")).toHaveLength(5);
    expect(container.querySelector(".editor-workspace")).toHaveAttribute("data-pane-count", "5");
    const separators = screen.getAllByRole("separator", { name: "Resize editor split" });
    const resizerClass = editorWidgetCssClass("paneResizer");
    const rowResizerClass = editorWidgetCssClass("paneResizerRow");
    const columnResizerClass = editorWidgetCssClass("paneResizerColumn");
    expect(separators).toHaveLength(4);
    for (const separator of separators) {
      expect(separator).toHaveClass(resizerClass);
      expect(separator).toHaveClass(
        separator.getAttribute("aria-orientation") === "vertical"
          ? rowResizerClass
          : columnResizerClass,
      );
    }
    expect(separators.map((separator) => separator.getAttribute("aria-orientation"))).toEqual(
      expect.arrayContaining(["horizontal", "vertical"]),
    );
    expect(
      container.querySelector(`.ed-panes.column .ed-panes.row > .${rowResizerClass}`),
    ).toHaveAttribute("aria-orientation", "vertical");
    expect(
      container.querySelector(`.ed-panes.row .ed-panes.column > .${columnResizerClass}`),
    ).toHaveAttribute("aria-orientation", "horizontal");
    const layout = JSON.parse(
      String(onWorkspaceChange.mock.calls.at(-1)?.[0]?.layoutJson),
    ) as Record<string, unknown>;
    expect(Object.keys(layout["panes"] as Record<string, unknown>)).toHaveLength(5);
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
      const sidebarResizer = screen.getByRole("separator", { name: "Resize project tree" });
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
    const sidebarResizer = screen.getByRole("separator", { name: "Resize project tree" });
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

  it("supports narrow and near-full sidebar widths under transformed window coordinates", () => {
    const onWorkspaceChange = vi.fn();
    const { container } = render(
      <EditorWidget root="/repo" file="src/a.ts" onWorkspaceChange={onWorkspaceChange} />,
    );
    const workspace = container.querySelector(".editor-workspace") as HTMLElement;
    Object.defineProperty(workspace, "offsetWidth", {
      configurable: true,
      value: 1_000,
    });
    workspace.getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 100,
          top: 0,
          width: 500,
          height: 300,
          right: 600,
          bottom: 300,
          x: 100,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    const sidebarResizer = screen.getByRole("separator", { name: "Resize project tree" });
    sidebarResizer.setPointerCapture = vi.fn();
    sidebarResizer.hasPointerCapture = vi.fn(() => true);
    sidebarResizer.releasePointerCapture = vi.fn();

    const dragTo = (clientX: number): void => {
      fireEvent.pointerDown(sidebarResizer, { pointerId: 1 });
      fireEvent.pointerMove(sidebarResizer, { pointerId: 1, buttons: 1, clientX });
      fireEvent.pointerUp(sidebarResizer, { pointerId: 1 });
    };

    dragTo(110);
    expect(workspace.style.getPropertyValue("--ed-sidebar-width")).toBe(
      editorSidebarTrackWidth(48),
    );
    expect(JSON.parse(String(onWorkspaceChange.mock.calls.at(-1)?.[0]?.layoutJson))).toEqual(
      expect.objectContaining({ sidebarWidth: 48 }),
    );

    // The workspace is rendered at transform:scale(.5): 450 screen pixels from its left edge
    // therefore mean 900 logical editor pixels.
    dragTo(550);
    expect(workspace.style.getPropertyValue("--ed-sidebar-width")).toBe(
      editorSidebarTrackWidth(900),
    );

    dragTo(600);
    expect(workspace.style.getPropertyValue("--ed-sidebar-width")).toBe(
      editorSidebarTrackWidth(950),
    );
    expect(JSON.parse(String(onWorkspaceChange.mock.calls.at(-1)?.[0]?.layoutJson))).toEqual(
      expect.objectContaining({ sidebarWidth: 950 }),
    );
  });

  it("keeps a committed sidebar width across semantically unchanged host props", () => {
    const firstWorkspaceChange = vi.fn();
    const { container, rerender } = render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts"]}
        onWorkspaceChange={firstWorkspaceChange}
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
    const sidebarResizer = screen.getByRole("separator", { name: "Resize project tree" });
    sidebarResizer.setPointerCapture = vi.fn();
    sidebarResizer.hasPointerCapture = vi.fn(() => true);
    sidebarResizer.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(sidebarResizer, { pointerId: 1 });
    fireEvent.pointerMove(sidebarResizer, { pointerId: 1, buttons: 1, clientX: 350 });
    fireEvent.pointerUp(sidebarResizer, { pointerId: 1 });
    expect(workspace.style.getPropertyValue("--ed-sidebar-width")).toBe(
      editorSidebarTrackWidth(340),
    );

    rerender(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts"]}
        onWorkspaceChange={vi.fn()}
      />,
    );

    expect(workspace.style.getPropertyValue("--ed-sidebar-width")).toBe(
      editorSidebarTrackWidth(340),
    );

    const committedLayout = JSON.parse(
      String(firstWorkspaceChange.mock.calls.at(-1)?.[0]?.layoutJson),
    );
    rerender(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts"]}
        layoutJson={JSON.stringify({ ...committedLayout, sidebarWidth: 400 })}
        onWorkspaceChange={vi.fn()}
      />,
    );
    expect(workspace.style.getPropertyValue("--ed-sidebar-width")).toBe(
      editorSidebarTrackWidth(400),
    );

    rerender(<EditorWidget root="/next" onWorkspaceChange={vi.fn()} />);
    expect(screen.getByTestId("runtime-root")).toHaveTextContent("/next");
    expect(workspace.style.getPropertyValue("--ed-sidebar-width")).toBe(
      editorSidebarTrackWidth(260),
    );
  });

  it("round-trips a resized, root-bound empty editor pane through controlled layout props", () => {
    const onWorkspaceChange = vi.fn();
    const { container, rerender } = render(
      <EditorWidget root="/repo" onWorkspaceChange={onWorkspaceChange} />,
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

    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize project tree" }), {
      key: "ArrowRight",
    });
    const committedLayoutJson = String(onWorkspaceChange.mock.calls.at(-1)?.[0]?.layoutJson ?? "");
    const committedLayout = JSON.parse(committedLayoutJson);
    expect(committedLayout).toEqual(expect.objectContaining({ sidebarWidth: 272 }));
    expect(committedLayout.panes["pane-1"]).toEqual({
      id: "pane-1",
      activeFile: "",
      openFiles: [],
      tabOrder: [],
    });

    rerender(
      <EditorWidget root="/repo" layoutJson={committedLayoutJson} onWorkspaceChange={vi.fn()} />,
    );

    expect(workspace.style.getPropertyValue("--ed-sidebar-width")).toBe(
      editorSidebarTrackWidth(272),
    );
    expect(screen.getByTestId("runtime-file")).toHaveTextContent("");
  });

  it("keeps a committed split ratio across semantically unchanged host props", () => {
    const { container, rerender } = render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts"]}
        onWorkspaceChange={vi.fn()}
      />,
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
    splitResizer.setPointerCapture = vi.fn();
    splitResizer.hasPointerCapture = vi.fn(() => true);
    splitResizer.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(splitResizer, { pointerId: 2 });
    fireEvent.pointerMove(splitResizer, {
      pointerId: 2,
      buttons: 1,
      clientX: 700,
      clientY: 20,
    });
    fireEvent.pointerUp(splitResizer, { pointerId: 2 });
    expect(splitRoot.style.getPropertyValue("--ed-split-ratio")).toBe("70%");

    rerender(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts"]}
        onWorkspaceChange={vi.fn()}
      />,
    );

    expect(container.querySelector(".ed-panes.row")).toBe(splitRoot);
    expect(splitRoot.style.getPropertyValue("--ed-split-ratio")).toBe("70%");
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

    const sidebarResizer = screen.getByRole("separator", { name: "Resize project tree" });
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

describe("EditorWidget — Cmd/Ctrl+P quick access while editing (Epic #2090 regression)", () => {
  // #2112 originally routed the Cmd/Ctrl+P chord for the editor-local Quick Open through the
  // shared useKeyboardShortcuts substrate, which bails out for any editable event target
  // (isEditableTarget) — including Monaco's own hidden textarea. That silently broke Cmd/Ctrl+P
  // while the cursor was inside a file, regressing pre-#2112 behavior and violating the epic's
  // own closure statement ("Cmd/Ctrl+P finds any file from anywhere"). The fix keeps this chord on
  // the editor's own capture-phase container listener, which fires before Monaco and is
  // unaffected by that guard.
  it("opens the unified quick-access palette in file mode from the editor's capturing listener", () => {
    const openFiles = vi.fn();
    const openCommands = vi.fn();
    const { container } = render(
      <EditorQuickAccessTriggerProvider value={{ openFiles, openCommands }}>
        <EditorWidget root="/repo" file="src/a.ts" />
      </EditorQuickAccessTriggerProvider>,
    );

    const workspace = container.querySelector(".editor-workspace");
    expect(workspace).not.toBeNull();
    fireEvent.keyDown(workspace as Element, { key: "p", metaKey: true });

    expect(openFiles).toHaveBeenCalledTimes(1);
    expect(openCommands).not.toHaveBeenCalled();
  });

  it("opens the unified quick-access palette in command mode on Cmd/Ctrl+Shift+P", () => {
    const openFiles = vi.fn();
    const openCommands = vi.fn();
    const { container } = render(
      <EditorQuickAccessTriggerProvider value={{ openFiles, openCommands }}>
        <EditorWidget root="/repo" file="src/a.ts" />
      </EditorQuickAccessTriggerProvider>,
    );

    const workspace = container.querySelector(".editor-workspace");
    fireEvent.keyDown(workspace as Element, { key: "p", metaKey: true, shiftKey: true });

    expect(openCommands).toHaveBeenCalledTimes(1);
    expect(openFiles).not.toHaveBeenCalled();
  });

  it("does not throw when no quick-access trigger is registered (defensive no-op)", () => {
    const { container } = render(<EditorWidget root="/repo" file="src/a.ts" />);
    const workspace = container.querySelector(".editor-workspace");
    expect(() =>
      fireEvent.keyDown(workspace as Element, { key: "p", metaKey: true }),
    ).not.toThrow();
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

// ─── Issue #2696 — deterministic post-trust readiness signal on the workspace root ───────────────
// `data-trust-settled` is the attribute browser regression harnesses settle on instead of racing
// the initial trust prompt with a timeout. `fetch` is stubbed PER TEST and unstubbed in a `finally`
// so the suite's other cases keep running against the unstubbed environment.

type CatalogOutcome = "trusted" | "restricted" | "unavailable";

const CATALOG_URL = "/api/editor/verification/catalog";

function catalogPayload(
  projectId: string,
  trust: "trusted" | "restricted",
): Record<string, unknown> {
  return {
    schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
    projectId,
    workspaceTrust: {
      kind: "workspace-trust-status",
      schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
      projectId,
      trust,
      decidedBy: "server",
      reason: trust === "trusted" ? "human-grant" : "human-revocation",
      revision: 1,
    },
    kinds: EDITOR_VERIFICATION_KINDS.map((kind) => ({
      kind,
      available: trust === "trusted",
      trustState: trust === "trusted" ? "trusted" : "approval-required",
    })),
  };
}

function jsonResponse(ok: boolean, body: Record<string, unknown>): Response {
  return { ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as Response;
}

// The hook rejects a catalog whose `projectId` differs from the requested root, so the stub has to
// echo back the root that was actually asked for — a hardcoded one would make every root but that
// one resolve as "unavailable".
function requestedProjectId(url: string): string {
  return new URL(url, "http://127.0.0.1").searchParams.get("projectId") ?? "";
}

function catalogResponse(projectId: string, outcome: CatalogOutcome): Response {
  return outcome === "unavailable"
    ? jsonResponse(false, {})
    : jsonResponse(true, catalogPayload(projectId, outcome));
}

function stubVerificationFetch(outcome: CatalogOutcome): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (!url.startsWith(CATALOG_URL)) return Promise.resolve(jsonResponse(false, {}));
      return Promise.resolve(catalogResponse(requestedProjectId(url), outcome));
    }),
  );
}

// Per-root catalog stub. A root mapped to a still-pending promise keeps its catalog in flight until
// the test releases it, so "is the NEW root settled yet?" has a deterministic window instead of
// racing an already-resolved promise. An unmapped root resolves as unavailable (fail closed).
function stubVerificationFetchByRoot(byRoot: ReadonlyMap<string, Promise<Response>>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (!url.startsWith(CATALOG_URL)) return Promise.resolve(jsonResponse(false, {}));
      return byRoot.get(requestedProjectId(url)) ?? Promise.resolve(jsonResponse(false, {}));
    }),
  );
}

interface DeferredCatalog {
  readonly promise: Promise<Response>;
  readonly resolve: (value: Response) => void;
}

function deferredCatalog(): DeferredCatalog {
  let settle: (value: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: Response): void => settle(value) };
}

function workspaceRootOf(container: HTMLElement): Element {
  const workspace = container.querySelector(".editor-workspace");
  if (workspace === null) throw new Error("editor workspace root was not rendered");
  return workspace;
}

interface SettledObservation {
  readonly settled: string | null;
  readonly promptMounted: boolean;
}

// Records the DOM as it stood immediately after each `data-trust-settled` change, so the test can
// prove the attribute never reported "true" in a commit that had not yet mounted the prompt.
function observeSettledTransitions(
  workspace: Element,
  log: SettledObservation[],
): MutationObserver {
  const observer = new MutationObserver(() => {
    log.push({
      settled: workspace.getAttribute("data-trust-settled"),
      promptMounted: document.querySelector("[role='alertdialog']") !== null,
    });
  });
  observer.observe(workspace, { attributes: true, attributeFilter: ["data-trust-settled"] });
  return observer;
}

describe("EditorWidget workspace-trust readiness signal (#2696)", () => {
  it("keeps managed-workspace enforcement server-side without mounting trust UI", async () => {
    stubVerificationFetch("restricted");
    try {
      const { container } = render(
        <EditorWidget
          root="/managed/task"
          file="src/a.ts"
          workspaceTrustUiAvailable={false}
          onOpenWorkspaceTrust={vi.fn()}
        />,
      );
      const workspace = workspaceRootOf(container);

      await waitFor(() => {
        expect(workspace).toHaveAttribute("data-trust-settled", "true");
      });

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(CATALOG_URL),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(screen.queryByTestId("workspace-trust-banner-editor")).toBeNull();
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(screen.queryByRole("button", { name: "Manage Workspace Trust" })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      resetEditorVerificationRunStateForTests();
    }
  });

  it("discards an open trust decision when a managed workspace takes over presentation", async () => {
    stubVerificationFetch("restricted");
    try {
      const { rerender } = render(<EditorWidget root="/repo" file="src/a.ts" />);

      expect(
        await screen.findByRole("alertdialog", { name: /Trust this workspace/iu }),
      ).toBeInTheDocument();

      rerender(
        <EditorWidget
          root="/repo"
          file="src/a.ts"
          workspaceTrustUiAvailable={false}
          onOpenWorkspaceTrust={vi.fn()}
        />,
      );
      expect(screen.queryByRole("alertdialog")).toBeNull();

      rerender(<EditorWidget root="/repo" file="src/a.ts" workspaceTrustUiAvailable />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByRole("alertdialog")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      resetEditorVerificationRunStateForTests();
    }
  });

  it("reports settled only in the commit that has already mounted the initial trust prompt", async () => {
    stubVerificationFetch("restricted");
    try {
      const { container } = render(<EditorWidget root="/repo" file="src/a.ts" />);
      const workspace = workspaceRootOf(container);
      // Before the trust status resolves the signal is explicitly "not settled" — never absent,
      // never optimistically true.
      expect(workspace).toHaveAttribute("data-trust-settled", "false");

      const observations: SettledObservation[] = [];
      const observer = observeSettledTransitions(workspace, observations);
      try {
        await waitFor(() => {
          expect(workspace).toHaveAttribute("data-trust-settled", "true");
        });
      } finally {
        observer.disconnect();
      }

      // The whole point of the signal: once it reads "true" the prompt is ALREADY in the DOM, so a
      // SYNCHRONOUS read resolves it. A `findBy*` here would re-introduce the race it removes.
      expect(
        screen.getByRole("alertdialog", { name: /Trust this workspace/iu }),
      ).toBeInTheDocument();
      expect(observations.some((entry) => entry.settled === "true")).toBe(true);
      expect(
        observations
          .filter((entry) => entry.settled === "true")
          .every((entry) => entry.promptMounted),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      resetEditorVerificationRunStateForTests();
    }
  });

  it("re-arms the signal on a root switch and re-prompts only from the NEW restricted root", async () => {
    const pendingB = deferredCatalog();
    stubVerificationFetchByRoot(
      new Map([
        ["/repo-a", Promise.resolve(catalogResponse("/repo-a", "restricted"))],
        ["/repo-b", pendingB.promise],
      ]),
    );
    try {
      const { container, rerender } = render(<EditorWidget root="/repo-a" file="src/a.ts" />);
      const workspace = workspaceRootOf(container);
      await waitFor(() => {
        expect(workspace).toHaveAttribute("data-trust-settled", "true");
      });
      expect(
        screen.getByRole("alertdialog", { name: /Trust this workspace/iu }),
      ).toBeInTheDocument();

      const observations: SettledObservation[] = [];
      const observer = observeSettledTransitions(workspace, observations);
      try {
        rerender(<EditorWidget root="/repo-b" file="src/a.ts" />);
        // A switch to an undecided root re-arms the signal: /repo-a's prompt is dismissed and
        // readiness drops back to "false" until /repo-b's own trust state resolves.
        await waitFor(() => {
          expect(workspace).toHaveAttribute("data-trust-settled", "false");
        });
        // The stale-catalog class (#2696): while /repo-b's catalog is still in flight the ONLY
        // trust state in the tree is /repo-a's. A prompt standing here could only have been raised
        // from the previous root's catalog — which is exactly the pairing the render-phase catalog
        // invalidation rules out. An effect-based invalidation raises it one commit after the
        // switch, before /repo-b has said anything at all.
        expect(screen.queryByRole("alertdialog")).toBeNull();

        await act(async () => {
          pendingB.resolve(catalogResponse("/repo-b", "restricted"));
        });
        await waitFor(() => {
          expect(workspace).toHaveAttribute("data-trust-settled", "true");
        });
      } finally {
        observer.disconnect();
      }

      // Re-settling is again a conjunction: the prompt for the NEW root is already mounted in the
      // commit that reports "true", so a synchronous read resolves it.
      expect(
        screen.getByRole("alertdialog", { name: /Trust this workspace/iu }),
      ).toBeInTheDocument();
      expect(observations.some((entry) => entry.settled === "false")).toBe(true);
      expect(observations.some((entry) => entry.settled === "true")).toBe(true);
      expect(
        observations
          .filter((entry) => entry.settled === "true")
          .every((entry) => entry.promptMounted),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      resetEditorVerificationRunStateForTests();
    }
  });

  it("settles without ever raising a trust prompt for an already-trusted workspace", async () => {
    stubVerificationFetch("trusted");
    try {
      const { container } = render(<EditorWidget root="/repo" file="src/a.ts" />);
      const workspace = workspaceRootOf(container);

      await waitFor(() => {
        expect(workspace).toHaveAttribute("data-trust-settled", "true");
      });
      expect(screen.queryByRole("alertdialog")).toBeNull();

      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByRole("alertdialog")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      resetEditorVerificationRunStateForTests();
    }
  });

  it("settles when the verification catalog is unavailable so an observer never waits forever", async () => {
    // An unregistered project makes the catalog request fail. No trust prompt can ever follow, so
    // a rejected catalog is a SETTLED outcome — treating it as pending would hang every observer.
    stubVerificationFetch("unavailable");
    try {
      const { container } = render(<EditorWidget root="/repo" file="src/a.ts" />);
      const workspace = workspaceRootOf(container);

      await waitFor(() => {
        expect(workspace).toHaveAttribute("data-trust-settled", "true");
      });
      expect(screen.queryByRole("alertdialog")).toBeNull();

      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByRole("alertdialog")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      resetEditorVerificationRunStateForTests();
    }
  });

  it("does not re-raise the initial prompt after the human revokes trust", async () => {
    // The initial prompt answers "this binding is opening on an untrusted root", once per binding.
    // The latch was only consumed when the FIRST resolved state was `restricted`, so opening on a
    // TRUSTED root left it unconsumed — and an explicit revocation then moved trust to `restricted`
    // and re-raised the first-open prompt, asking the human to grant back what they had just
    // deliberately revoked, flagged `initialPrompt`.
    let outcome: CatalogOutcome = "trusted";
    let catalogRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (!url.startsWith(CATALOG_URL)) return Promise.resolve(jsonResponse(false, {}));
        catalogRequests += 1;
        return Promise.resolve(catalogResponse(requestedProjectId(url), outcome));
      }),
    );
    try {
      const { container } = render(<EditorWidget root="/repo" file="src/a.ts" />);
      const workspace = workspaceRootOf(container);
      await waitFor(() => {
        expect(workspace).toHaveAttribute("data-trust-settled", "true");
      });
      // Opening on a trusted root raises nothing, which is what leaves the latch unconsumed.
      expect(screen.queryByRole("alertdialog")).toBeNull();

      // The human revokes: the catalog now reports restricted, exactly as the real revoke path
      // announces it.
      const requestsBeforeRevoke = catalogRequests;
      outcome = "restricted";
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(WORKSPACE_TRUST_CHANGED_EVENT, { detail: { projectId: "/repo" } }),
        );
        await Promise.resolve();
      });

      // Positive control: without a second catalog read the assertion below would hold vacuously.
      await waitFor(() => {
        expect(catalogRequests).toBeGreaterThan(requestsBeforeRevoke);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByRole("alertdialog", { name: /Trust this workspace/iu })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      resetEditorVerificationRunStateForTests();
    }
  });
});
