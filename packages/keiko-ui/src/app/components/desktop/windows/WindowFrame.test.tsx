import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceApi } from "../hooks/useWorkspace.types";
import { WindowFrame } from "./WindowFrame";
import type { AppWindow } from "./types";

function appWindow(patch: Partial<AppWindow> = {}): AppWindow {
  return {
    id: "agents-1",
    type: "agents",
    x: 40,
    y: 40,
    w: 420,
    h: 320,
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
    resetView: vi.fn(),
    panBy: vi.fn(),
    rect: vi.fn(() => null),
    ...patch,
  };
}

describe("WindowFrame content zoom controls", () => {
  it("minimizes through the yellow traffic-light control", async () => {
    const minimize = vi.fn();
    const close = vi.fn();
    const user = userEvent.setup();

    render(
      <WindowFrame
        win={appWindow()}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api({ minimize, close })}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Minimize Agents window" }));

    expect(minimize).toHaveBeenCalledWith("agents-1");
    expect(close).not.toHaveBeenCalled();
  });

  it("does not bubble a double click on content zoom controls to header maximize", async () => {
    const update = vi.fn();
    const maximize = vi.fn();
    const user = userEvent.setup();

    render(
      <WindowFrame
        win={appWindow()}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api({ update, maximize })}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    await user.dblClick(screen.getByRole("button", { name: "Zoom Agents content in" }));

    expect(update).toHaveBeenCalled();
    expect(maximize).not.toHaveBeenCalled();
  });

  it("ignores header double clicks in the right-side control gutter", () => {
    const maximize = vi.fn();
    const { container } = render(
      <WindowFrame
        win={appWindow()}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api({ maximize })}
        wsRef={createRef<HTMLElement>()}
      />,
    );
    const header = container.querySelector<HTMLElement>(".win-head");
    expect(header).not.toBeNull();
    vi.spyOn(header as HTMLElement, "getBoundingClientRect").mockReturnValue({
      x: 40,
      y: 40,
      left: 40,
      top: 40,
      right: 460,
      bottom: 78,
      width: 420,
      height: 38,
      toJSON: () => ({}),
    });

    fireEvent.doubleClick(header as HTMLElement, { clientX: 430 });

    expect(maximize).not.toHaveBeenCalled();
  });

  it("keeps title-area header double click as the maximize gesture", () => {
    const maximize = vi.fn();
    const { container } = render(
      <WindowFrame
        win={appWindow()}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api({ maximize })}
        wsRef={createRef<HTMLElement>()}
      />,
    );
    const header = container.querySelector<HTMLElement>(".win-head");
    expect(header).not.toBeNull();
    vi.spyOn(header as HTMLElement, "getBoundingClientRect").mockReturnValue({
      x: 40,
      y: 40,
      left: 40,
      top: 40,
      right: 460,
      bottom: 78,
      width: 420,
      height: 38,
      toJSON: () => ({}),
    });

    fireEvent.doubleClick(header as HTMLElement, { clientX: 120 });

    expect(maximize).toHaveBeenCalledTimes(1);
  });
});
