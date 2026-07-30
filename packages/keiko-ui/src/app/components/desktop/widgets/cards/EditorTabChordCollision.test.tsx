// Audit — Alt+Left / Alt+Right on an editor tab used to do TWO things per keypress.
//
// The editor tab strip reorders the tab (`handleAltArrowTabKey` in EditorWidget.tsx) and the
// workspace's window-level keydown dispatcher (`useKeyboardCtrls` in hooks/useWorkspace.ts) reads
// Alt+Arrow as "resize the focused window" — so one Alt+Left both moved the tab AND shrank the
// editor window a step, persisting the new geometry.
//
// Two suites each pinned one half and neither could see the other: EditorWidget.workspace.test.tsx
// asserts the reorder without a workspace mounted, and useWorkspace.keyboard.test.tsx fires its
// chords straight at `window` with nothing focused that could consume them. This suite mounts BOTH
// layers — the real EditorWidget inside a real `useWorkspace` window — so the reorder and the
// geometry are observed from one keypress.

import { useRef, type ReactElement, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorRuntimeWidgetProps } from "./EditorRuntimeWidget";
import { EditorWidget } from "./EditorWidget";
import { useWorkspace } from "../../hooks/useWorkspace";
import type { AppWindow } from "../../windows/types";

const WORKSPACE_STORAGE_KEY = "keiko.workspace.v4";
const CONNECTION_STORAGE_KEY = "keiko.conns.v1";
const EDITOR_WINDOW_ID = "editor-1";

vi.mock("next/dynamic", () => ({
  default: () => {
    function RuntimeProbe(props: EditorRuntimeWidgetProps): ReactNode {
      const openFiles = props.openFiles ?? [];
      return (
        <div data-testid="runtime-probe">
          <span data-testid="runtime-open-files">{openFiles.join("|")}</span>
          <div role="tablist" aria-label="Open documents">
            {openFiles.map((path) => {
              const active = path === props.file;
              const handle = props.renderTabHandle?.(
                path,
                active,
                props.dirtyFiles?.includes(path) ?? false,
              );
              return (
                <button
                  key={`${props.paneId ?? "pane"}-${path}`}
                  type="button"
                  role="tab"
                  aria-selected={active ? "true" : "false"}
                  aria-label={`Tab ${path}`}
                  tabIndex={active ? 0 : -1}
                  data-pane-id={props.paneId}
                  data-tab-file={path}
                  {...handle}
                >
                  {path}
                </button>
              );
            })}
          </div>
          {props.toolbarExtras}
        </div>
      );
    }
    return RuntimeProbe;
  },
}));

vi.mock("./FilesWidget", () => ({
  FilesWidget: ({ root }: { readonly root?: string }) => (
    <div data-testid="files-probe">{root ?? ""}</div>
  ),
}));

function editorWindow(): AppWindow {
  return {
    id: EDITOR_WINDOW_ID,
    type: "editor",
    x: 100,
    y: 120,
    w: 600,
    h: 420,
    z: 10,
    cfg: { root: "/repo", file: "src/a.ts", openFiles: ["src/a.ts", "src/b.ts"] },
    max: false,
    zoom: 1,
  };
}

// The workspace window the editor lives in — `useKeyboardCtrls` resolves its geometry chords from
// the nearest `.window[data-window-id]` ancestor of the focused element, which is what makes the
// tab strip and the window chord contend for the same keypress in the product.
function Harness(): ReactElement {
  const wsRef = useRef<HTMLDivElement>(null);
  const workspace = useWorkspace(wsRef);
  return (
    <main ref={wsRef} data-testid="workspace" className="workspace">
      <section
        className="window"
        data-window-id={EDITOR_WINDOW_ID}
        data-testid="editor-window"
        tabIndex={-1}
      >
        <EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />
      </section>
      <output data-testid="wins">{JSON.stringify(workspace.wins ?? [])}</output>
    </main>
  );
}

function readEditorWindow(): AppWindow | undefined {
  const wins = JSON.parse(screen.getByTestId("wins").textContent ?? "[]") as AppWindow[];
  return wins.find((win) => win.id === EDITOR_WINDOW_ID);
}

function mockWorkspaceRect(): void {
  vi.spyOn(screen.getByTestId("workspace"), "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 800,
    width: 1000,
    height: 800,
    toJSON: () => ({}),
  });
}

function tab(path: string): HTMLElement {
  return screen.getByRole("tab", { name: `Tab ${path}` });
}

describe("editor tab Alt+Arrow vs. workspace window chord (audit)", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("reorders the tab WITHOUT also resizing the editor window", async () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([editorWindow()]));
    window.localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify([]));
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readEditorWindow()).toBeDefined());
    const geometryBefore = readEditorWindow();

    const first = tab("src/a.ts");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight", code: "ArrowRight", altKey: true });

    // Half one: the tab moved.
    expect(screen.getByTestId("runtime-open-files")).toHaveTextContent("src/b.ts|src/a.ts");
    // Half two: the window did not.
    expect(readEditorWindow()).toMatchObject({
      x: geometryBefore?.x ?? 0,
      y: geometryBefore?.y ?? 0,
      w: geometryBefore?.w ?? 0,
      h: geometryBefore?.h ?? 0,
    });
  });

  it("moves the tab to the adjacent pane WITHOUT also resizing the editor window", async () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([editorWindow()]));
    window.localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify([]));
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readEditorWindow()).toBeDefined());
    const geometryBefore = readEditorWindow();

    const first = tab("src/a.ts");
    first.focus();
    fireEvent.keyDown(first, {
      key: "ArrowLeft",
      code: "ArrowLeft",
      altKey: true,
      shiftKey: true,
    });

    expect(readEditorWindow()).toMatchObject({
      x: geometryBefore?.x ?? 0,
      y: geometryBefore?.y ?? 0,
      w: geometryBefore?.w ?? 0,
      h: geometryBefore?.h ?? 0,
    });
  });

  // The guard must not disarm the chord where nothing consumed it: with focus on the window shell
  // (no tab strip in the path), Alt+Arrow is still the keyboard resize.
  it("still resizes the window when the focused surface does not claim the chord", async () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([editorWindow()]));
    window.localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify([]));
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readEditorWindow()).toBeDefined());

    screen.getByTestId("editor-window").focus();
    fireEvent.keyDown(window, { key: "ArrowDown", code: "ArrowDown", altKey: true });

    await waitFor(() => expect(readEditorWindow()?.h).toBe(436));
  });
});
