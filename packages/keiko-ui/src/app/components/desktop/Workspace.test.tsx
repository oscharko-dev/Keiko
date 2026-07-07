import { createRef } from "react";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Workspace, workspaceDropPointToWindowOrigin } from "./Workspace";
import type { UseWorkspaceResult, WorkspaceApi } from "./hooks/useWorkspace.types";
import type { AppWindow } from "./windows/types";
import {
  FIGMA_VIEW_DRAG_TYPE,
  FIGMA_VIEW_DROP_EVENT,
  serializeFigmaViewDrag,
} from "./figma-view-drag";
import {
  FIGMA_JSON_DRAG_TYPE,
  FIGMA_JSON_DROP_EVENT,
  serializeFigmaJsonDrag,
} from "./figma-json-drag";
import {
  FIGMA_IMAGE_DRAG_TYPE,
  FIGMA_IMAGE_DROP_EVENT,
  serializeFigmaImageDrag,
} from "./figma-image-drag";
import {
  LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT,
  LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE,
  serializeLocalKnowledgeConnectorDrag,
} from "../../local-knowledge/connector-drag";

vi.mock("./WorkspaceShader", () => ({
  WorkspaceShader: () => null,
}));

function appWindow(patch: Partial<AppWindow> & Pick<AppWindow, "id" | "type">): AppWindow {
  return {
    x: 40,
    y: 40,
    w: 320,
    h: 260,
    z: 1,
    cfg: {},
    max: false,
    zoom: 1,
    ...patch,
  };
}

function api(patch: Partial<WorkspaceApi> = {}): WorkspaceApi {
  return {
    add: vi.fn(() => null),
    openEditorFile: vi.fn(() => ({ ok: false as const, message: "Unable to open editor." })),
    toggleTool: vi.fn(),
    focus: vi.fn(),
    currentSelection: vi.fn(() => ({ focusedWindowId: null, selectedWindowIds: [] })),
    replaceSelection: vi.fn(),
    toggleWindowSelection: vi.fn(),
    clearSelection: vi.fn(),
    moveSelectedWindowsBy: vi.fn(),
    close: vi.fn(),
    minimize: vi.fn(),
    restore: vi.fn(),
    maximize: vi.fn(),
    update: vi.fn(),
    setSnap: vi.fn(),
    commitSnap: vi.fn(),
    tileAll: vi.fn(),
    splitFront: vi.fn(),
    cascade: vi.fn(),
    startConnect: vi.fn(),
    confirmConnect: vi.fn(),
    cancelConnect: vi.fn(),
    removeConn: vi.fn(),
    updateConnBoundScope: vi.fn(),
    connect: vi.fn(),
    linkedFilesRoot: vi.fn(() => null),
    linkedAllFilesRoots: vi.fn(() => []),
    linkedConnectorCapsuleIds: vi.fn(() => []),
    linkedConnectorCapsuleSetIds: vi.fn(() => []),
    linkedFigmaSnapshotRunIds: vi.fn(() => []),
    linkedFilesContext: vi.fn(() => null),
    currentFilesContext: vi.fn(() => null),
    zoomTo: vi.fn(),
    fitView: vi.fn(),
    resetView: vi.fn(),
    panBy: vi.fn(),
    rect: vi.fn(() => null),
    currentView: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
    ...patch,
  };
}

function workspace(partial: Partial<UseWorkspaceResult>): UseWorkspaceResult {
  const wins = partial.wins ?? [];
  return {
    wins,
    winsById: new Map(wins.map((win) => [win.id, win])),
    snapPrev: null,
    palOpen: false,
    setPalOpen: vi.fn(),
    conns: [],
    connecting: null,
    selection: { focusedWindowId: null, selectedWindowIds: [] },
    view: { x: 0, y: 0, zoom: 1 },
    api: api(),
    ...partial,
  };
}

describe("M1 — empty startup layout", () => {
  it("renders the empty-state affordance when wins is an empty array", () => {
    render(
      <Workspace
        ws={workspace({ wins: [] })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    expect(screen.getByText("Empty workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open a new window" })).toHaveClass(
      "empty-workspace-blob",
    );
  });

  it("calls openPalette when the empty-state blob button is clicked", async () => {
    const openPalette = vi.fn();
    const user = userEvent.setup();
    render(
      <Workspace
        ws={workspace({ wins: [] })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={openPalette}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open a new window" }));
    expect(openPalette).toHaveBeenCalledTimes(1);
  });

  it("does not render the empty-state when wins has at least one window", () => {
    // Use "agents" type — it renders without a full chat context in jsdom.
    const wins = [appWindow({ id: "agents-1", type: "agents" })];
    render(
      <Workspace
        ws={workspace({ wins })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    expect(screen.queryByText("Empty workspace")).toBeNull();
  });

  it("does not render minimized windows on the workspace surface", () => {
    const wins = [appWindow({ id: "agents-1", type: "agents", minimized: true })];
    const { container } = render(
      <Workspace
        ws={workspace({ wins })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    expect(container.querySelector('[data-window-id="agents-1"]')).toBeNull();
    expect(screen.queryByText("Empty workspace")).toBeNull();
  });
});

describe("Workspace card connections", () => {
  it("renders the workspace surface as a main landmark", () => {
    render(
      <Workspace
        ws={workspace({})}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    expect(screen.getByRole("main", { name: "Workspace surface" })).toBeInTheDocument();
  });

  it("renders canvas overlay children inside the workspace surface", () => {
    render(
      <Workspace
        ws={workspace({})}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      >
        <div data-testid="canvas-overlay-slot">Canvas overlay</div>
      </Workspace>,
    );

    expect(screen.getByTestId("canvas-overlay-slot").closest(".workspace")).toBe(
      screen.getByRole("main", { name: "Workspace surface" }),
    );
  });

  it("does not expose connection ports on the Local Knowledge management window", () => {
    const wins = [appWindow({ id: "localKnowledge", type: "localKnowledge", z: 1 })];
    render(
      <Workspace
        ws={workspace({ wins })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Connect Local Knowledge from top edge" }),
    ).toBeNull();
  });

  it("marks canvas overlays hidden when a visible window is maximized", () => {
    const wins = [appWindow({ id: "agents-1", type: "agents", max: true })];
    const { container } = render(
      <Workspace
        ws={workspace({ wins })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    expect(container.querySelector(".workspace")).toHaveAttribute(
      "data-canvas-overlays-hidden",
      "true",
    );
  });

  it("confirms a valid target even when a target child stops pointer bubbling", () => {
    const confirmConnect = vi.fn();
    const workspaceApi = api({ confirmConnect });
    const wins = [
      appWindow({ id: "agents-1", type: "agents", z: 1 }),
      appWindow({ id: "files-1", type: "files", x: 420, z: 2 }),
    ];
    const ws = workspace({
      wins,
      connecting: { from: "agents-1", x: 100, y: 100 },
      api: workspaceApi,
    });

    render(<Workspace ws={ws} wsRef={createRef<HTMLDivElement>()} openPalette={() => undefined} />);

    // uiux-fix F031 C297 — control labels are window-scoped now ("Full screen Files
    // window"), so the files-1 target is addressable by name directly.
    const targetMaximizeButton = screen.getByRole("button", { name: "Full screen Files window" });
    expect(targetMaximizeButton).toBeDefined();

    fireEvent.pointerDown(targetMaximizeButton as HTMLElement, { button: 0 });

    expect(confirmConnect).toHaveBeenCalledTimes(1);
    expect(confirmConnect).toHaveBeenCalledWith("files-1", expect.any(Object));
  });

  it("starts a connection from a port on pointer down", () => {
    const startConnect = vi.fn();
    const workspaceApi = api({ startConnect });
    const wins = [appWindow({ id: "agents-1", type: "agents", z: 1 })];

    render(
      <Workspace
        ws={workspace({ wins, api: workspaceApi })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /connect agents from top edge/i }), {
      button: 0,
      clientX: 112,
      clientY: 128,
    });

    expect(startConnect).toHaveBeenCalledTimes(1);
    expect(startConnect).toHaveBeenCalledWith(
      "agents-1",
      expect.objectContaining({ clientX: 112, clientY: 128 }),
    );
  });

  it("scales the scene with CSS zoom while preserving outer-pixel pan geometry (#305)", () => {
    // `transform: scale()` would rasterize the scene once at its natural size
    // and upscale the bitmap, blurring text/SVG inside widgets at zoom > 1.
    // The scene must use CSS `zoom` to trigger a layout pass and re-rasterize.
    // Chrome applies CSS zoom to transform translation too, so pan is divided by
    // zoom to keep maximized/window viewport math aligned with rendered pixels.
    const { container } = render(
      <Workspace
        ws={workspace({ view: { x: 12, y: 34, zoom: 1.75 } })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    const scene = container.querySelector(".ws-scene");
    expect(scene).not.toBeNull();
    const style = (scene as HTMLElement).style;
    expect(style.zoom).toBe("1.75");
    expect(style.transform).toBe("translate(6.857142857142857px, 19.428571428571427px)");
    expect(style.transform).not.toContain("scale(");
  });

  it("emits zoom 1 at the default view without a scale() transform (#305)", () => {
    const { container } = render(
      <Workspace
        ws={workspace({ view: { x: 0, y: 0, zoom: 1 } })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    const scene = container.querySelector(".ws-scene");
    expect(scene).not.toBeNull();
    const style = (scene as HTMLElement).style;
    expect(style.zoom).toBe("1");
    expect(style.transform).not.toContain("scale(");
  });

  it("creates a preselected connector card when a Local Knowledge capsule is dropped", () => {
    const add = vi.fn(() => "conn-1");
    const update = vi.fn();
    const workspaceApi = api({ add, update });
    render(
      <Workspace
        ws={workspace({
          wins: [],
          view: { x: 20, y: 30, zoom: 2 },
          api: workspaceApi,
        })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    const surface = screen.getByRole("main", { name: "Workspace surface" });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 12,
      right: 1010,
      bottom: 812,
      width: 1000,
      height: 800,
      x: 10,
      y: 12,
      toJSON: () => ({}),
    } as DOMRect);
    const dataTransfer = {
      types: [LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE],
      getData: vi.fn((type: string) =>
        type === LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE
          ? serializeLocalKnowledgeConnectorDrag({
              kind: "capsule",
              id: "cap-abc",
              label: "First KC",
              lifecycleState: "ready",
            })
          : "",
      ),
      dropEffect: "none",
    };

    const dropEvent = createEvent.drop(surface, { dataTransfer });
    Object.defineProperties(dropEvent, {
      clientX: { value: 450 },
      clientY: { value: 260 },
    });
    fireEvent(surface, dropEvent);

    expect(add).toHaveBeenCalledWith("connector", {
      presentation: "node",
      selectedKind: "capsule",
      selectedId: "cap-abc",
      selectedLabel: "First KC",
      selectedState: "ready",
    });
    expect(update).toHaveBeenCalledWith("conn-1", { x: 80, y: 81, w: 260, h: 220 });
  });

  it("creates the same connector node from the pointer drag-out event", () => {
    const add = vi.fn(() => "conn-1");
    const update = vi.fn();
    const workspaceApi = api({ add, update });
    render(
      <Workspace
        ws={workspace({
          wins: [],
          view: { x: 20, y: 30, zoom: 2 },
          api: workspaceApi,
        })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    const surface = screen.getByRole("main", { name: "Workspace surface" });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 12,
      right: 1010,
      bottom: 812,
      width: 1000,
      height: 800,
      x: 10,
      y: 12,
      toJSON: () => ({}),
    } as DOMRect);

    window.dispatchEvent(
      new CustomEvent(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, {
        detail: {
          payload: {
            kind: "capsule",
            id: "cap-abc",
            label: "First KC",
            lifecycleState: "ready",
          },
          clientX: 450,
          clientY: 260,
        },
      }),
    );

    expect(add).toHaveBeenCalledWith("connector", {
      presentation: "node",
      selectedKind: "capsule",
      selectedId: "cap-abc",
      selectedLabel: "First KC",
      selectedState: "ready",
    });
    expect(update).toHaveBeenCalledWith("conn-1", { x: 80, y: 81, w: 260, h: 220 });
  });

  it("creates a scoped Figma View card when a snapshot thumbnail is dropped", () => {
    const add = vi.fn(() => "figma-view-1");
    const update = vi.fn();
    const workspaceApi = api({ add, update });
    render(
      <Workspace
        ws={workspace({
          wins: [],
          view: { x: 20, y: 30, zoom: 2 },
          api: workspaceApi,
        })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    const surface = screen.getByRole("main", { name: "Workspace surface" });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 12,
      right: 1010,
      bottom: 812,
      width: 1000,
      height: 800,
      x: 10,
      y: 12,
      toJSON: () => ({}),
    } as DOMRect);
    const dataTransfer = {
      types: [FIGMA_VIEW_DRAG_TYPE],
      getData: vi.fn((type: string) =>
        type === FIGMA_VIEW_DRAG_TYPE
          ? serializeFigmaViewDrag({
              snapshotRunId: "fs-123",
              screenId: "1:102746",
              name: "Kontokorrentkredit hinzufügen",
            })
          : "",
      ),
      dropEffect: "none",
    };

    const dropEvent = createEvent.drop(surface, { dataTransfer });
    Object.defineProperties(dropEvent, {
      clientX: { value: 450 },
      clientY: { value: 260 },
    });
    fireEvent(surface, dropEvent);

    expect(add).toHaveBeenCalledWith("figmaView", {
      snapshotRunId: "fs-123",
      selectedScreenIdsJson: JSON.stringify(["1:102746"]),
      selectedScreenName: "Kontokorrentkredit hinzufügen",
    });
    expect(update).toHaveBeenCalledWith("figma-view-1", { x: 30, y: 81, w: 360, h: 360 });
  });

  it("creates the same scoped Figma View card from the pointer drag-out event", () => {
    const add = vi.fn(() => "figma-view-1");
    const update = vi.fn();
    const workspaceApi = api({ add, update });
    render(
      <Workspace
        ws={workspace({
          wins: [],
          view: { x: 20, y: 30, zoom: 2 },
          api: workspaceApi,
        })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    const surface = screen.getByRole("main", { name: "Workspace surface" });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 12,
      right: 1010,
      bottom: 812,
      width: 1000,
      height: 800,
      x: 10,
      y: 12,
      toJSON: () => ({}),
    } as DOMRect);

    window.dispatchEvent(
      new CustomEvent(FIGMA_VIEW_DROP_EVENT, {
        detail: {
          payload: {
            snapshotRunId: "fs-123",
            screenId: "1:102746",
            name: "Kontokorrentkredit hinzufügen",
          },
          clientX: 450,
          clientY: 260,
        },
      }),
    );

    expect(add).toHaveBeenCalledWith("figmaView", {
      snapshotRunId: "fs-123",
      selectedScreenIdsJson: JSON.stringify(["1:102746"]),
      selectedScreenName: "Kontokorrentkredit hinzufügen",
    });
    expect(update).toHaveBeenCalledWith("figma-view-1", { x: 30, y: 81, w: 360, h: 360 });
  });

  it("creates a scoped Figma JSON source window and migrates an existing QI edge", () => {
    vi.useFakeTimers();
    try {
      const add = vi.fn(() => "figma-json-1");
      const update = vi.fn();
      const removeConn = vi.fn();
      const connect = vi.fn();
      const workspaceApi = api({ add, update, removeConn, connect });
      const wins = [
        appWindow({
          id: "quality",
          type: "quality",
          z: 2,
        }),
        appWindow({
          id: "figma-view-1",
          type: "figmaView",
          x: 420,
          z: 1,
          cfg: {
            snapshotRunId: "fs-123",
            selectedScreenIdsJson: JSON.stringify(["1:102746"]),
            selectedScreenName: "Kontokorrentkredit hinzufügen",
          },
        }),
      ];
      render(
        <Workspace
          ws={workspace({
            wins,
            conns: [{ id: "quality~figma-view-1", a: "quality", b: "figma-view-1" }],
            view: { x: 20, y: 30, zoom: 2 },
            api: workspaceApi,
          })}
          wsRef={createRef<HTMLDivElement>()}
          openPalette={() => undefined}
        />,
      );

      const surface = screen.getByRole("main", { name: "Workspace surface" });
      vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
        left: 10,
        top: 12,
        right: 1010,
        bottom: 812,
        width: 1000,
        height: 800,
        x: 10,
        y: 12,
        toJSON: () => ({}),
      } as DOMRect);
      const dataTransfer = {
        types: [FIGMA_JSON_DRAG_TYPE],
        getData: vi.fn((type: string) =>
          type === FIGMA_JSON_DRAG_TYPE
            ? serializeFigmaJsonDrag({
                snapshotRunId: "fs-123",
                screenId: "1:102746",
                name: "Kontokorrentkredit hinzufügen",
                sourceWindowId: "figma-view-1",
              })
            : "",
        ),
        dropEffect: "none",
      };

      const dropEvent = createEvent.drop(surface, { dataTransfer });
      Object.defineProperties(dropEvent, {
        clientX: { value: 450 },
        clientY: { value: 260 },
      });
      fireEvent(surface, dropEvent);

      expect(add).toHaveBeenCalledWith("figmaJson", {
        snapshotRunId: "fs-123",
        screenId: "1:102746",
        selectedScreenIdsJson: JSON.stringify(["1:102746"]),
        selectedScreenName: "Kontokorrentkredit hinzufügen",
      });
      expect(update).toHaveBeenCalledWith("figma-json-1", {
        x: -50,
        y: 81,
        w: 520,
        h: 540,
      });
      expect(removeConn).toHaveBeenCalledWith("quality~figma-view-1");

      vi.runOnlyPendingTimers();

      expect(connect).toHaveBeenCalledWith("figma-json-1", "quality");
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates the same scoped Figma JSON source from the pointer drag-out event", () => {
    const add = vi.fn(() => "figma-json-1");
    const update = vi.fn();
    const workspaceApi = api({ add, update });
    render(
      <Workspace
        ws={workspace({
          wins: [],
          view: { x: 20, y: 30, zoom: 2 },
          api: workspaceApi,
        })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    const surface = screen.getByRole("main", { name: "Workspace surface" });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 12,
      right: 1010,
      bottom: 812,
      width: 1000,
      height: 800,
      x: 10,
      y: 12,
      toJSON: () => ({}),
    } as DOMRect);

    window.dispatchEvent(
      new CustomEvent(FIGMA_JSON_DROP_EVENT, {
        detail: {
          payload: {
            snapshotRunId: "fs-123",
            screenId: "1:102746",
            name: "Kontokorrentkredit hinzufügen",
          },
          clientX: 450,
          clientY: 260,
        },
      }),
    );

    expect(add).toHaveBeenCalledWith("figmaJson", {
      snapshotRunId: "fs-123",
      screenId: "1:102746",
      selectedScreenIdsJson: JSON.stringify(["1:102746"]),
      selectedScreenName: "Kontokorrentkredit hinzufügen",
    });
    expect(update).toHaveBeenCalledWith("figma-json-1", { x: -50, y: 81, w: 520, h: 540 });
  });

  it("creates a standalone Figma image source and migrates a QI edge from the source view", () => {
    vi.useFakeTimers();
    try {
      const add = vi.fn(() => "figma-image-1");
      const update = vi.fn();
      const removeConn = vi.fn();
      const connect = vi.fn();
      const workspaceApi = api({ add, update, removeConn, connect });
      const wins = [
        appWindow({ id: "quality", type: "quality", z: 2 }),
        appWindow({ id: "figma-view-1", type: "figmaView", x: 420, z: 1 }),
      ];
      render(
        <Workspace
          ws={workspace({
            wins,
            conns: [{ id: "quality~figma-view-1", a: "quality", b: "figma-view-1" }],
            view: { x: 20, y: 30, zoom: 2 },
            api: workspaceApi,
          })}
          wsRef={createRef<HTMLDivElement>()}
          openPalette={() => undefined}
        />,
      );

      const surface = screen.getByRole("main", { name: "Workspace surface" });
      vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
        left: 10,
        top: 12,
        right: 1010,
        bottom: 812,
        width: 1000,
        height: 800,
        x: 10,
        y: 12,
        toJSON: () => ({}),
      } as DOMRect);
      const payload = {
        snapshotRunId: "fs-123",
        screenId: "1:102746",
        name: "Kontokorrentkredit hinzufügen",
        imageSrc: "/api/figma/snapshots/fs-123/screens/1/image",
        sourceWindowId: "figma-view-1",
      };
      const dataTransfer = {
        types: [FIGMA_IMAGE_DRAG_TYPE],
        getData: vi.fn((type: string) =>
          type === FIGMA_IMAGE_DRAG_TYPE ? serializeFigmaImageDrag(payload) : "",
        ),
        dropEffect: "none",
      };

      const dropEvent = createEvent.drop(surface, { dataTransfer });
      Object.defineProperties(dropEvent, {
        clientX: { value: 450 },
        clientY: { value: 260 },
      });
      fireEvent(surface, dropEvent);

      expect(add).toHaveBeenCalledWith("figmaImage", {
        snapshotRunId: "fs-123",
        screenId: "1:102746",
        selectedScreenName: "Kontokorrentkredit hinzufügen",
        imageSrc: "/api/figma/snapshots/fs-123/screens/1/image",
      });
      expect(update).toHaveBeenCalledWith("figma-image-1", {
        x: -70,
        y: 81,
        w: 560,
        h: 420,
      });
      expect(removeConn).toHaveBeenCalledWith("quality~figma-view-1");

      vi.runOnlyPendingTimers();

      expect(connect).toHaveBeenCalledWith("figma-image-1", "quality");
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates the same standalone Figma image source from the pointer drag-out event", () => {
    const add = vi.fn(() => "figma-image-1");
    const update = vi.fn();
    const workspaceApi = api({ add, update });
    render(
      <Workspace
        ws={workspace({
          wins: [],
          view: { x: 20, y: 30, zoom: 2 },
          api: workspaceApi,
        })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    const surface = screen.getByRole("main", { name: "Workspace surface" });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 12,
      right: 1010,
      bottom: 812,
      width: 1000,
      height: 800,
      x: 10,
      y: 12,
      toJSON: () => ({}),
    } as DOMRect);

    window.dispatchEvent(
      new CustomEvent(FIGMA_IMAGE_DROP_EVENT, {
        detail: {
          payload: {
            snapshotRunId: "fs-123",
            screenId: "1:102746",
            name: "Kontokorrentkredit hinzufügen",
            imageSrc: "/api/figma/snapshots/fs-123/screens/1/image",
          },
          clientX: 450,
          clientY: 260,
        },
      }),
    );

    expect(add).toHaveBeenCalledWith("figmaImage", {
      snapshotRunId: "fs-123",
      screenId: "1:102746",
      selectedScreenName: "Kontokorrentkredit hinzufügen",
      imageSrc: "/api/figma/snapshots/fs-123/screens/1/image",
    });
    expect(update).toHaveBeenCalledWith("figma-image-1", { x: -70, y: 81, w: 560, h: 420 });
  });

  it("maps a workspace drop point through pan and zoom into connector window origin", () => {
    const origin = workspaceDropPointToWindowOrigin({
      clientX: 450,
      clientY: 260,
      rect: {
        left: 10,
        top: 12,
        right: 1010,
        bottom: 812,
        width: 1000,
        height: 800,
        x: 10,
        y: 12,
        toJSON: () => ({}),
      } as DOMRect,
      view: { x: 20, y: 30, zoom: 2 },
    });

    expect(origin).toEqual({ x: 80, y: 81 });
  });

  it("starts a connection from a port with Enter key activation", async () => {
    const startConnect = vi.fn();
    const workspaceApi = api({ startConnect });
    const wins = [appWindow({ id: "agents-1", type: "agents", z: 1 })];
    const user = userEvent.setup();

    render(
      <Workspace
        ws={workspace({ wins, api: workspaceApi })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    const port = screen.getByRole("button", { name: /connect agents from top edge/i });
    port.focus();
    await user.keyboard("{Enter}");

    expect(startConnect).toHaveBeenCalledTimes(1);
    expect(startConnect).toHaveBeenCalledWith(
      "agents-1",
      expect.objectContaining({ clientX: expect.any(Number), clientY: expect.any(Number) }),
    );
  });

  it("confirms an in-flight connection with Enter on a valid target's port (WCAG 2.1.1)", async () => {
    // Keyboard users can START a connect flow but previously had no keyboard
    // path to COMPLETE it — Enter on the target port must confirm, not start
    // a new flow from the target window (audit C004).
    const confirmConnect = vi.fn();
    const startConnect = vi.fn();
    const workspaceApi = api({ confirmConnect, startConnect });
    const wins = [
      appWindow({ id: "agents-1", type: "agents", z: 1 }),
      appWindow({ id: "files-1", type: "files", x: 420, z: 2 }),
    ];
    const user = userEvent.setup();

    render(
      <Workspace
        ws={workspace({
          wins,
          connecting: { from: "agents-1", x: 100, y: 100 },
          api: workspaceApi,
        })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    // uiux-fix F031 C297 — port labels are window-scoped, so the files-1 target
    // port is addressable by name directly.
    const targetPort = screen.getByRole("button", { name: /connect files from top edge/i });
    expect(targetPort).toBeDefined();
    (targetPort as HTMLElement).focus();
    await user.keyboard("{Enter}");

    expect(confirmConnect).toHaveBeenCalledTimes(1);
    expect(confirmConnect).toHaveBeenCalledWith("files-1", expect.any(Object));
    expect(startConnect).not.toHaveBeenCalled();
  });

  it("keeps Enter on an invalid target's port starting a new flow (pointer parity)", async () => {
    // agents↔agents is not connectable (canConnect rejects same types), so the
    // target stays an invalid drop target and Enter restarts the flow from it —
    // identical to today's pointer behaviour on invalid targets.
    const confirmConnect = vi.fn();
    const startConnect = vi.fn();
    const workspaceApi = api({ confirmConnect, startConnect });
    const wins = [
      appWindow({ id: "agents-1", type: "agents", z: 1 }),
      appWindow({ id: "agents-2", type: "agents", x: 420, z: 2 }),
    ];
    const user = userEvent.setup();

    render(
      <Workspace
        ws={workspace({
          wins,
          connecting: { from: "agents-1", x: 100, y: 100 },
          api: workspaceApi,
        })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    const targetPort = screen.getAllByRole("button", { name: /connect agents from top edge/i })[1];
    expect(targetPort).toBeDefined();
    (targetPort as HTMLElement).focus();
    await user.keyboard("{Enter}");

    expect(confirmConnect).not.toHaveBeenCalled();
    expect(startConnect).toHaveBeenCalledTimes(1);
    expect(startConnect).toHaveBeenCalledWith("agents-2", expect.any(Object));
  });

  it("announces the connect flow in a polite live region", () => {
    const wins = [
      appWindow({ id: "agents-1", type: "agents", z: 1 }),
      appWindow({ id: "files-1", type: "files", x: 420, z: 2 }),
    ];
    const { container } = render(
      <Workspace
        ws={workspace({ wins, connecting: { from: "agents-1", x: 100, y: 100 } })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toMatch(/connecting from/i);
    expect(live?.textContent).toMatch(/escape to cancel/i);
  });
});

describe("WC-01 — keyboard pan on the workspace surface (WCAG 2.1.1)", () => {
  it("workspace surface is keyboard-focusable (tabIndex=0)", () => {
    render(
      <Workspace
        ws={workspace({})}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });
    expect(surface.tabIndex).toBe(0);
  });

  it("uses primary-button empty-canvas drag for marquee selection, not panning", () => {
    const panBy = vi.fn();
    const replaceSelection = vi.fn();
    const workspaceApi = api({ panBy });
    render(
      <Workspace
        ws={workspace({ api: { ...workspaceApi, replaceSelection } })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });

    fireEvent.pointerDown(surface, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 130, clientY: 115 });
    expect(surface).toHaveAttribute("data-marquee", "true");
    fireEvent.pointerUp(window);

    expect(panBy).not.toHaveBeenCalled();
    expect(replaceSelection).toHaveBeenCalledWith([]);
    expect(surface).not.toHaveAttribute("data-marquee");
  });

  it("keeps middle-button workspace panning available for mouse users", () => {
    const panBy = vi.fn();
    render(
      <Workspace
        ws={workspace({ api: api({ panBy }) })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });

    fireEvent.pointerDown(surface, { button: 1, clientX: 100, clientY: 100 });
    expect(surface).toHaveAttribute("data-panning", "true");
    fireEvent.pointerMove(window, { clientX: 130, clientY: 115 });

    fireEvent.pointerUp(window);
    expect(panBy).toHaveBeenCalledWith(30, 15);
    expect(surface).not.toHaveAttribute("data-panning");
  });

  it("does not let Space plus primary drag over a window steal window interactions", () => {
    const focus = vi.fn();
    const panBy = vi.fn();
    const wins = [appWindow({ id: "agents-1", type: "agents" })];
    const workspaceApi = api({ focus, panBy });
    const { container } = render(
      <Workspace
        ws={workspace({ wins, api: workspaceApi })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });
    const windowEl = container.querySelector<HTMLElement>(".window");
    expect(windowEl).not.toBeNull();

    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(surface).toHaveAttribute("data-hand-tool", "true");

    fireEvent.pointerDown(windowEl as HTMLElement, { button: 0, clientX: 100, clientY: 100 });
    expect(surface).not.toHaveAttribute("data-panning");

    fireEvent.pointerMove(window, { clientX: 130, clientY: 115 });
    fireEvent.pointerUp(window);
    fireEvent.keyUp(window, { key: " ", code: "Space" });

    expect(panBy).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith("agents-1");
    expect(surface).not.toHaveAttribute("data-panning");
    expect(surface).not.toHaveAttribute("data-hand-tool");
  });

  it("pans the free board with Space plus primary drag", () => {
    const panBy = vi.fn();
    const workspaceApi = api({ panBy });
    render(
      <Workspace
        ws={workspace({ api: workspaceApi })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });

    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(surface).toHaveAttribute("data-hand-tool", "true");
    fireEvent.pointerDown(surface, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 130, clientY: 115 });
    fireEvent.pointerUp(window);
    fireEvent.keyUp(window, { key: " ", code: "Space" });

    expect(panBy).toHaveBeenCalledWith(30, 15);
    expect(surface).not.toHaveAttribute("data-panning");
    expect(surface).not.toHaveAttribute("data-hand-tool");
  });

  it("selects intersecting windows with a primary-button marquee on empty canvas", () => {
    const replaceSelection = vi.fn();
    const panBy = vi.fn();
    const wins = [
      appWindow({ id: "agents-1", type: "agents", x: 40, y: 40, w: 120, h: 90 }),
      appWindow({ id: "files-1", type: "files", x: 360, y: 80, w: 140, h: 120 }),
      appWindow({ id: "chat-1", type: "chat", x: 180, y: 260, w: 180, h: 120 }),
    ];
    render(
      <Workspace
        ws={workspace({ wins, api: api({ panBy, replaceSelection }) })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(surface, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 210, clientY: 170 });

    expect(screen.getByTestId("workspace-marquee")).toBeInTheDocument();
    expect(surface).toHaveAttribute("data-marquee", "true");
    expect(panBy).not.toHaveBeenCalled();

    fireEvent.pointerUp(window);

    expect(replaceSelection).toHaveBeenCalledWith(["agents-1"]);
    expect(surface).not.toHaveAttribute("data-marquee");
  });

  it("projects marquee hit-testing through the current pan and zoom", () => {
    const replaceSelection = vi.fn();
    const wins = [
      appWindow({ id: "agents-1", type: "agents", x: 40, y: 40, w: 120, h: 90 }),
      appWindow({ id: "files-1", type: "files", x: 220, y: 40, w: 120, h: 90 }),
    ];
    render(
      <Workspace
        ws={workspace({
          wins,
          view: { x: 100, y: 50, zoom: 2 },
          api: api({ replaceSelection }),
        })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 20,
      right: 810,
      bottom: 620,
      width: 800,
      height: 600,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(surface, { button: 0, clientX: 180, clientY: 140 });
    fireEvent.pointerMove(window, { clientX: 450, clientY: 340 });
    fireEvent.pointerUp(window);

    expect(replaceSelection).toHaveBeenCalledWith(["agents-1"]);
  });

  it("adds and toggles marquee hits with keyboard modifiers", () => {
    const replaceSelection = vi.fn();
    const wins = [
      appWindow({ id: "agents-1", type: "agents", x: 40, y: 40, w: 120, h: 90 }),
      appWindow({ id: "files-1", type: "files", x: 220, y: 40, w: 120, h: 90 }),
    ];
    const { rerender } = render(
      <Workspace
        ws={workspace({
          wins,
          selection: { focusedWindowId: "files-1", selectedWindowIds: ["files-1"] },
          api: api({ replaceSelection }),
        })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(surface, { button: 0, shiftKey: true, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 180, clientY: 150 });
    fireEvent.pointerUp(window);
    expect(replaceSelection).toHaveBeenLastCalledWith(["files-1", "agents-1"]);

    rerender(
      <Workspace
        ws={workspace({
          wins,
          selection: {
            focusedWindowId: "agents-1",
            selectedWindowIds: ["files-1", "agents-1"],
          },
          api: api({ replaceSelection }),
        })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    fireEvent.pointerDown(surface, { button: 0, metaKey: true, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 180, clientY: 150 });
    fireEvent.pointerUp(window);

    expect(replaceSelection).toHaveBeenLastCalledWith(["files-1"]);
  });

  it("cancels a marquee without changing selection", () => {
    const replaceSelection = vi.fn();
    const wins = [appWindow({ id: "agents-1", type: "agents", x: 40, y: 40, w: 120, h: 90 })];
    render(
      <Workspace
        ws={workspace({ wins, api: api({ replaceSelection }) })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(surface, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 180, clientY: 150 });
    expect(screen.getByTestId("workspace-marquee")).toBeInTheDocument();

    fireEvent.pointerCancel(window);

    expect(replaceSelection).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-marquee")).toBeNull();
  });

  it("clears selection when a replacement marquee hits no windows", () => {
    const replaceSelection = vi.fn();
    const wins = [appWindow({ id: "agents-1", type: "agents", x: 40, y: 40, w: 120, h: 90 })];
    render(
      <Workspace
        ws={workspace({
          wins,
          selection: { focusedWindowId: "agents-1", selectedWindowIds: ["agents-1"] },
          api: api({ replaceSelection }),
        })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(surface, { button: 0, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 440, clientY: 420 });
    fireEvent.pointerUp(window);

    expect(replaceSelection).toHaveBeenCalledWith([]);
  });

  it("does not start marquee selection from embedded window surfaces", () => {
    const replaceSelection = vi.fn();
    const panBy = vi.fn();
    const focus = vi.fn();
    const wins = [appWindow({ id: "agents-1", type: "agents" })];
    const { container } = render(
      <Workspace
        ws={workspace({ wins, api: api({ focus, panBy, replaceSelection }) })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const windowEl = container.querySelector<HTMLElement>(".window");
    expect(windowEl).not.toBeNull();

    fireEvent.pointerDown(windowEl as HTMLElement, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 180, clientY: 150 });
    fireEvent.pointerUp(window);

    expect(replaceSelection).not.toHaveBeenCalled();
    expect(panBy).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith("agents-1");
  });

  it("does not pan the board from right click or macOS control click", () => {
    render(
      <Workspace
        ws={workspace({})}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });

    fireEvent.pointerDown(surface, { button: 2, clientX: 100, clientY: 100 });
    expect(surface).not.toHaveAttribute("data-panning");

    fireEvent.pointerDown(surface, { button: 0, ctrlKey: true, clientX: 100, clientY: 100 });
    expect(surface).not.toHaveAttribute("data-panning");
  });

  it("does not arm the Space hand tool from an interactive control", () => {
    render(
      <Workspace
        ws={workspace({})}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });
    const button = document.querySelector<HTMLElement>(".ws-fab");
    if (button === null) throw new Error("missing workspace FAB");
    expect(button).toHaveClass("cmp-tip-end");
    const event = createEvent.keyDown(button, { key: " ", code: "Space" });

    fireEvent(button, event);

    expect(event.defaultPrevented).toBe(false);
    expect(surface).not.toHaveAttribute("data-hand-tool");
  });

  it("does not start background panning while a modal interaction lock is active", () => {
    document.documentElement.setAttribute("data-keiko-modal-open", "true");
    try {
      render(
        <Workspace
          ws={workspace({})}
          wsRef={createRef<HTMLDivElement>()}
          openPalette={() => undefined}
        />,
      );
      const surface = screen.getByRole("main", { name: "Workspace surface" });

      fireEvent.pointerDown(surface, { button: 1, clientX: 100, clientY: 100 });

      expect(surface).not.toHaveAttribute("data-panning");
      expect(document.body.style.userSelect).toBe("");
    } finally {
      document.documentElement.removeAttribute("data-keiko-modal-open");
    }
  });

  it("prevents text selection while the free workspace surface is actively panned", () => {
    render(
      <Workspace
        ws={workspace({})}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });

    fireEvent.pointerDown(surface, { button: 1, clientX: 100, clientY: 100 });
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerCancel(window);
    expect(document.body.style.userSelect).toBe("");
  });

  it("fits the workspace to visible windows from the zoom control strip", async () => {
    const fitView = vi.fn();
    const user = userEvent.setup();
    const wins = [appWindow({ id: "agents-1", type: "agents", z: 1 })];
    render(
      <Workspace
        ws={workspace({ wins, api: api({ fitView }) })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Fit workspace to windows" }));

    expect(fitView).toHaveBeenCalledTimes(1);
  });

  it("disables fit-to-windows when the workspace has no visible windows", () => {
    render(
      <Workspace
        ws={workspace({ wins: [] })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Fit workspace to windows" })).toBeDisabled();
  });

  it("ArrowLeft pans content right (panBy +step, 0)", () => {
    const panBy = vi.fn();
    const workspaceApi = api({ panBy });
    render(
      <Workspace
        ws={workspace({ api: workspaceApi })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });
    fireEvent.keyDown(surface, { key: "ArrowLeft", target: surface });
    expect(panBy).toHaveBeenCalledTimes(1);
    expect(panBy).toHaveBeenCalledWith(48, 0);
  });

  it("ArrowRight pans content left (panBy -step, 0)", () => {
    const panBy = vi.fn();
    const workspaceApi = api({ panBy });
    render(
      <Workspace
        ws={workspace({ api: workspaceApi })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });
    fireEvent.keyDown(surface, { key: "ArrowRight", target: surface });
    expect(panBy).toHaveBeenCalledTimes(1);
    expect(panBy).toHaveBeenCalledWith(-48, 0);
  });

  it("ArrowUp pans content down (panBy 0, +step)", () => {
    const panBy = vi.fn();
    const workspaceApi = api({ panBy });
    render(
      <Workspace
        ws={workspace({ api: workspaceApi })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });
    fireEvent.keyDown(surface, { key: "ArrowUp", target: surface });
    expect(panBy).toHaveBeenCalledTimes(1);
    expect(panBy).toHaveBeenCalledWith(0, 48);
  });

  it("ArrowDown pans content up (panBy 0, -step)", () => {
    const panBy = vi.fn();
    const workspaceApi = api({ panBy });
    render(
      <Workspace
        ws={workspace({ api: workspaceApi })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });
    fireEvent.keyDown(surface, { key: "ArrowDown", target: surface });
    expect(panBy).toHaveBeenCalledTimes(1);
    expect(panBy).toHaveBeenCalledWith(0, -48);
  });

  it("Shift+ArrowRight uses a larger step (4×)", () => {
    const panBy = vi.fn();
    const workspaceApi = api({ panBy });
    render(
      <Workspace
        ws={workspace({ api: workspaceApi })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });
    fireEvent.keyDown(surface, { key: "ArrowRight", shiftKey: true, target: surface });
    expect(panBy).toHaveBeenCalledTimes(1);
    expect(panBy).toHaveBeenCalledWith(-192, 0);
  });

  it("arrow keys call event.preventDefault()", () => {
    const panBy = vi.fn();
    const workspaceApi = api({ panBy });
    render(
      <Workspace
        ws={workspace({ api: workspaceApi })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });
    const event = createEvent.keyDown(surface, { key: "ArrowDown" });
    // Simulate target === currentTarget by firing directly on surface
    fireEvent(surface, event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("non-arrow key does not call panBy", () => {
    const panBy = vi.fn();
    const workspaceApi = api({ panBy });
    render(
      <Workspace
        ws={workspace({ api: workspaceApi })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });
    fireEvent.keyDown(surface, { key: "Tab", target: surface });
    fireEvent.keyDown(surface, { key: "Escape", target: surface });
    fireEvent.keyDown(surface, { key: " ", target: surface });
    expect(panBy).not.toHaveBeenCalled();
  });

  it("arrow key from a focused child window does not trigger panBy", () => {
    // Guard: event.target !== event.currentTarget when key bubbles from a child.
    const panBy = vi.fn();
    const workspaceApi = api({ panBy });
    const wins = [appWindow({ id: "agents-1", type: "agents", z: 1 })];
    const { container } = render(
      <Workspace
        ws={workspace({ wins, api: workspaceApi })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    // Find a child inside the workspace (e.g., the window element) and fire
    // keyDown from it — it bubbles to the surface but target !== currentTarget.
    const windowEl = container.querySelector<HTMLElement>(".window");
    expect(windowEl).not.toBeNull();
    // Dispatch on the child; the event bubbles but target stays the child.
    fireEvent.keyDown(windowEl as HTMLElement, { key: "ArrowLeft", bubbles: true });
    expect(panBy).not.toHaveBeenCalled();
  });
});
