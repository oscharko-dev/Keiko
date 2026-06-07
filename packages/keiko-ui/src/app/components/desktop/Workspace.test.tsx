import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Workspace } from "./Workspace";
import type { UseWorkspaceResult, WorkspaceApi } from "./hooks/useWorkspace.types";
import type { AppWindow } from "./windows/types";

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
    connect: vi.fn(),
    linkedFilesRoot: vi.fn(() => null),
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

    const targetMaximizeButton = screen.getAllByRole("button", { name: "Maximize window" })[1];
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

    fireEvent.pointerDown(screen.getByRole("button", { name: /connect from top edge/i }), {
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

    const port = screen.getByRole("button", { name: /connect from top edge/i });
    port.focus();
    await user.keyboard("{Enter}");

    expect(startConnect).toHaveBeenCalledTimes(1);
    expect(startConnect).toHaveBeenCalledWith(
      "agents-1",
      expect.objectContaining({ clientX: expect.any(Number), clientY: expect.any(Number) }),
    );
  });
});
