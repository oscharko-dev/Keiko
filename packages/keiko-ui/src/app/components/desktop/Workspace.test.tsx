import { createRef, useRef, useState, type ReactNode } from "react";
import { createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { Workspace, workspaceDropPointToWindowOrigin } from "./Workspace";
import { makeMutations } from "./hooks/workspaceActions";
import type { UseWorkspaceResult, WorkspaceApi } from "./hooks/useWorkspace.types";
import type { AppWindow } from "./windows/types";
import {
  LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT,
  LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE,
  serializeLocalKnowledgeConnectorDrag,
} from "../../local-knowledge/connector-drag";

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
    toggleTool: vi.fn(),
    focus: vi.fn(),
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
    ...patch,
  };
}

function workspace(partial: Partial<UseWorkspaceResult>): UseWorkspaceResult {
  return {
    wins: [],
    snapPrev: null,
    palOpen: false,
    setPalOpen: vi.fn(),
    conns: [],
    connecting: null,
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

  it("exposes a semantic workspace outline with window actions and textual relationships", async () => {
    const restore = vi.fn();
    const minimize = vi.fn();
    const maximize = vi.fn();
    const close = vi.fn();
    const removeConn = vi.fn();
    const tileAll = vi.fn();
    const openPalette = vi.fn();
    const user = userEvent.setup();
    const workspaceApi = api({ restore, minimize, maximize, close, removeConn, tileAll });
    const wins = [
      appWindow({
        id: "chat-1",
        type: "chat",
        z: 2,
        cfg: { title: "Release review" },
      }),
      appWindow({
        id: "files-1",
        type: "files",
        x: 420,
        z: 1,
        cfg: { root: "/repo", activeFilePath: "src/app.ts" },
      }),
    ];

    render(
      <Workspace
        ws={workspace({
          wins,
          conns: [{ id: "conn-1", a: "chat-1", b: "files-1" }],
          api: workspaceApi,
        })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={openPalette}
      />,
    );

    const outline = screen.getByRole("region", { name: "Workspace outline" });
    // #1153: the outline content is inert/aria-hidden until the panel is opened,
    // so the inner headings and action buttons only enter the a11y tree once a
    // user reveals it via the toggle affordance.
    await user.click(within(outline).getByRole("button", { name: "Show workspace outline" }));
    expect(outline).toHaveTextContent("2 workspace windows, 1 relationship.");
    expect(
      screen.getByRole("heading", { name: "Chat: Release review", level: 4 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Files: /repo", level: 4 })).toBeInTheDocument();
    expect(outline).toHaveTextContent("Chat: Release review uses app.ts Files: /repo.");

    const outlineQueries = within(outline);
    await user.click(outlineQueries.getByRole("button", { name: "Tile all windows" }));
    await user.click(outlineQueries.getByRole("button", { name: "Open Chat: Release review" }));
    await user.click(outlineQueries.getByRole("button", { name: "Minimize Chat: Release review" }));
    await user.click(
      outlineQueries.getByRole("button", { name: "Full screen Chat: Release review" }),
    );
    await user.click(outlineQueries.getByRole("button", { name: "Close Chat: Release review" }));
    await user.click(
      outlineQueries.getByRole("button", {
        name: "Remove relationship between Chat: Release review and Files: /repo",
      }),
    );
    await user.click(outlineQueries.getByRole("button", { name: "New window" }));

    expect(tileAll).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith("chat-1");
    expect(minimize).toHaveBeenCalledWith("chat-1");
    expect(maximize).toHaveBeenCalledWith("chat-1");
    expect(close).toHaveBeenCalledWith("chat-1");
    expect(removeConn).toHaveBeenCalledWith("conn-1");
    expect(openPalette).toHaveBeenCalledTimes(1);
  });

  it("passes axe with the semantic workspace outline and a connected relationship", async () => {
    const wins = [
      appWindow({
        id: "chat-1",
        type: "chat",
        z: 2,
        cfg: { title: "Release review" },
      }),
      appWindow({
        id: "files-1",
        type: "files",
        x: 420,
        z: 1,
        cfg: { root: "/repo", activeFilePath: "src/app.ts" },
      }),
    ];

    const { container } = render(
      <Workspace
        ws={workspace({
          wins,
          conns: [{ id: "conn-1", a: "chat-1", b: "files-1" }],
        })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={vi.fn()}
      />,
    );

    expect(await axe(container)).toHaveNoViolations();
  });

  it("activates clicked canvas windows and updates the outline status", async () => {
    const user = userEvent.setup();

    function ActivationHarness() {
      const [wins, setWins] = useState<AppWindow[]>([
        appWindow({ id: "chat-1", type: "chat", z: 1 }),
        appWindow({ id: "files-1", type: "files", x: 420, z: 2, cfg: { root: "/repo" } }),
        appWindow({ id: "settings-1", type: "settings", x: 220, y: 220, z: 3 }),
      ]);

      return (
        <Workspace
          ws={workspace({
            wins,
            api: api({
              focus: (id: string) =>
                setWins((current) => {
                  const nextZ = Math.max(...current.map((win) => win.z)) + 1;
                  return current.map((win) => (win.id === id ? { ...win, z: nextZ } : win));
                }),
            }),
          })}
          wsRef={createRef<HTMLDivElement>()}
          openPalette={() => undefined}
        />
      );
    }

    const { container } = render(<ActivationHarness />);
    const outline = screen.getByRole("region", { name: "Workspace outline" });

    expect(outline).toHaveTextContent("Type: Chat. Status: background, open.");
    expect(outline).toHaveTextContent("Type: Files. Status: background, open.");
    expect(outline).toHaveTextContent("Type: Settings. Status: active, open.");

    await user.click(
      container.querySelector<HTMLElement>(
        '.window[data-window-id="chat-1"] .win-body',
      ) as HTMLElement,
    );
    expect(outline).toHaveTextContent("Type: Chat. Status: active, open.");
    expect(outline).toHaveTextContent("Type: Settings. Status: background, open.");

    await user.click(
      container.querySelector<HTMLElement>(
        '.window[data-window-id="files-1"] .win-body',
      ) as HTMLElement,
    );
    expect(outline).toHaveTextContent("Type: Files. Status: active, open.");
    expect(outline).toHaveTextContent("Type: Chat. Status: background, open.");
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

  it("marks the free workspace surface as actively panning while the middle button is held", () => {
    render(
      <Workspace
        ws={workspace({})}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });

    fireEvent.pointerDown(surface, { button: 1, clientX: 100, clientY: 100 });
    expect(surface).toHaveAttribute("data-panning", "true");

    fireEvent.pointerUp(window);
    expect(surface).not.toHaveAttribute("data-panning");
  });

  it("does not start background panning from the primary mouse button", () => {
    render(
      <Workspace
        ws={workspace({})}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });

    fireEvent.pointerDown(surface, { button: 0, clientX: 100, clientY: 100 });

    expect(surface).not.toHaveAttribute("data-panning");
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

// Regression for #1153. The outline panel was revealed only on :focus-within,
// so a collapsed panel kept its action buttons in the DOM + a11y tree under
// pointer-events:none — a pointer click fell through to the canvas and window
// state never changed. jsdom ignores pointer-events, so the browser-level fall
// through is covered by the Playwright @smoke test in tests/e2e. These RTL
// tests pin the DOM contract that keeps the two in sync: collapsed = inert and
// aria-hidden (no falsely-exposed controls), and an explicit pointer-operable
// toggle that opens the panel and drives REAL window-state mutations.
function RealOutlineHarness({ initial }: { readonly initial: readonly AppWindow[] }): ReactNode {
  const [wins, setWins] = useState<AppWindow[] | null>([...initial]);
  // Mirror useWorkspace: the z-counter starts at the highest persisted z so a
  // restore/focus bump lands a window above all others (becomes `top`/active).
  const zc = useRef(initial.reduce((max, win) => Math.max(max, win.z), 0));
  const mutations = useRef(
    makeMutations({ setWins, zc, worldVP: () => ({ x: 0, y: 0, w: 1000, h: 800 }) }),
  );
  const workspaceApi = api(mutations.current);
  return (
    <Workspace
      ws={workspace({ wins, api: workspaceApi })}
      wsRef={createRef<HTMLDivElement>()}
      openPalette={() => undefined}
    />
  );
}

describe("#1153 — pointer users can operate the workspace outline", () => {
  function twoWindows(): AppWindow[] {
    return [
      appWindow({ id: "bg-1", type: "agents", z: 1 }),
      appWindow({ id: "active-1", type: "files", x: 420, z: 5 }),
    ];
  }

  it("collapses the outline content as inert + aria-hidden until opened", () => {
    render(
      <Workspace
        ws={workspace({ wins: twoWindows() })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Show workspace outline" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    const outline = screen.getByRole("region", { name: "Workspace outline" });
    const content = outline.querySelector(".ws-outline-content");
    expect(content).not.toBeNull();
    expect(content).toHaveAttribute("aria-hidden", "true");
    expect(content).toHaveAttribute("inert");
    expect(outline).toHaveAttribute("data-open", "false");
  });

  it("reveals the outline and exposes operable buttons when the toggle is pressed", async () => {
    const user = userEvent.setup();
    render(
      <Workspace
        ws={workspace({ wins: twoWindows() })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show workspace outline" }));

    const toggle = screen.getByRole("button", { name: "Hide workspace outline" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const outline = screen.getByRole("region", { name: "Workspace outline" });
    expect(outline).toHaveAttribute("data-open", "true");
    const content = outline.querySelector(".ws-outline-content");
    expect(content).not.toHaveAttribute("aria-hidden");
    expect(content).not.toHaveAttribute("inert");
  });

  it("collapses immediately when Hide workspace outline is pressed", async () => {
    const user = userEvent.setup();
    render(
      <Workspace
        ws={workspace({ wins: twoWindows() })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show workspace outline" }));
    const outline = screen.getByRole("region", { name: "Workspace outline" });
    expect(outline).toHaveAttribute("data-open", "true");

    await user.click(screen.getByRole("button", { name: "Hide workspace outline" }));

    expect(screen.getByRole("button", { name: "Show workspace outline" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(outline).toHaveAttribute("data-open", "false");
    const content = outline.querySelector(".ws-outline-content");
    expect(content).toHaveAttribute("aria-hidden", "true");
    expect(content).toHaveAttribute("inert");
  });

  it("stays open when the pointer leaves but focus remains inside the outline", () => {
    render(
      <Workspace
        ws={workspace({ wins: twoWindows() })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    const outline = screen.getByRole("region", { name: "Workspace outline" });
    fireEvent.pointerEnter(outline);
    expect(outline).toHaveAttribute("data-open", "true");

    const newWindowButton = within(outline).getByRole("button", { name: "New window" });
    fireEvent.focus(newWindowButton);
    fireEvent.pointerLeave(outline);

    expect(outline).toHaveAttribute("data-open", "true");

    fireEvent.blur(newWindowButton, { relatedTarget: document.body });
    expect(outline).toHaveAttribute("data-open", "false");
  });

  it("opens via the toggle and a per-window Close button mutates real window state", async () => {
    const user = userEvent.setup();
    render(<RealOutlineHarness initial={twoWindows()} />);

    await user.click(screen.getByRole("button", { name: "Show workspace outline" }));

    const outline = screen.getByRole("region", { name: "Workspace outline" });
    expect(within(outline).getByRole("heading", { name: "Agents", level: 4 })).toBeInTheDocument();

    await user.click(within(outline).getByRole("button", { name: "Close Agents" }));

    expect(within(outline).queryByRole("heading", { name: "Agents", level: 4 })).toBeNull();
    expect(within(outline).getByRole("heading", { name: "Files", level: 4 })).toBeInTheDocument();
  });

  it("opens via the toggle and a per-window Minimize button mutates real window state", async () => {
    const user = userEvent.setup();
    render(<RealOutlineHarness initial={twoWindows()} />);

    await user.click(screen.getByRole("button", { name: "Show workspace outline" }));
    const outline = screen.getByRole("region", { name: "Workspace outline" });

    await user.click(within(outline).getByRole("button", { name: "Minimize Agents" }));

    expect(within(outline).getByRole("button", { name: "Restore Agents" })).toBeInTheDocument();
  });

  it("opens via the toggle and the Open button activates the background window (real state)", async () => {
    const user = userEvent.setup();
    // bg-1 (agents, z low) is background; active-1 (files, z high) is active/top.
    render(<RealOutlineHarness initial={twoWindows()} />);

    await user.click(screen.getByRole("button", { name: "Show workspace outline" }));
    const outline = screen.getByRole("region", { name: "Workspace outline" });

    const agentsArticle = within(outline)
      .getByRole("heading", { name: "Agents", level: 4 })
      .closest("article") as HTMLElement;
    const filesArticle = within(outline)
      .getByRole("heading", { name: "Files", level: 4 })
      .closest("article") as HTMLElement;
    expect(agentsArticle).toHaveTextContent("Status: background, open.");
    expect(filesArticle).toHaveTextContent("Status: active, open.");

    // "Open Agents" calls api.restore(bg-1), bumping it above active-1 — the
    // real topWindow() recompute must flip which window reads as active.
    await user.click(within(outline).getByRole("button", { name: "Open Agents" }));

    expect(agentsArticle).toHaveTextContent("Status: active, open.");
    expect(filesArticle).toHaveTextContent("Status: background, open.");
  });

  it("keeps the keyboard :focus-within path working — focusing a control opens the panel", () => {
    render(
      <Workspace
        ws={workspace({ wins: twoWindows() })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

    const outline = screen.getByRole("region", { name: "Workspace outline" });
    expect(outline).toHaveAttribute("data-open", "false");

    // Focusing any control inside the section fires onFocusCapture and reveals
    // the panel — the keyboard parity path for pointer hover (#1153). fireEvent
    // flushes the focusin synthetic event and state update inside act().
    const toggle = screen.getByRole("button", { name: "Show workspace outline" });
    fireEvent.focus(toggle);
    expect(outline).toHaveAttribute("data-open", "true");

    // Blurring out of the section (relatedTarget outside) clears `transient`
    // and collapses the panel — exercises the onBlurCapture contains() branch.
    fireEvent.blur(toggle, { relatedTarget: document.body });
    expect(outline).toHaveAttribute("data-open", "false");
  });
});
