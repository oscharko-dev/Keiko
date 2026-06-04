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

describe("Workspace card connections", () => {
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

    render(
      <Workspace
        ws={ws}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );

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
