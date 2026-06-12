import { createRef } from "react";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Workspace, workspaceDropPointToWindowOrigin } from "./Workspace";
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
    const { container } = render(
      <Workspace
        ws={workspace({ wins: [] })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    expect(screen.getByText("Empty workspace")).toBeInTheDocument();
    // Both the empty-state button and the FAB carry aria-label="New window".
    // Query the empty-state-specific button via its class to avoid ambiguity.
    expect(container.querySelector(".ws-empty-btn")).not.toBeNull();
  });

  it("calls openPalette when the empty-state New window button is clicked", async () => {
    const openPalette = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <Workspace
        ws={workspace({ wins: [] })}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={openPalette}
      />,
    );
    const emptyBtn = container.querySelector<HTMLButtonElement>(".ws-empty-btn");
    expect(emptyBtn).not.toBeNull();
    await user.click(emptyBtn as HTMLButtonElement);
    // Both the empty-state button and the FAB call openPalette — at least 1 call is expected.
    expect(openPalette).toHaveBeenCalled();
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

    expect(screen.queryByRole("button", { name: "Connect Local Knowledge from top edge" })).toBeNull();
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

    // uiux-fix F031 C297 — control labels are window-scoped now ("Maximize Files
    // window"), so the files-1 target is addressable by name directly.
    const targetMaximizeButton = screen.getByRole("button", { name: "Maximize Files window" });
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

  it("scales the scene with CSS zoom so widget content re-rasterizes (#305)", () => {
    // `transform: scale()` would rasterize the scene once at its natural size
    // and upscale the bitmap, blurring text/SVG inside widgets at zoom > 1.
    // The scene must use CSS `zoom` to trigger a layout pass and re-rasterize.
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
    expect(style.transform).toBe("translate(12px, 34px)");
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
