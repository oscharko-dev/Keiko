import { createRef, type RefObject } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceApi } from "../hooks/useWorkspace.types";
import { WindowFrame } from "./WindowFrame";
import type { AppWindow } from "./types";
import { WIN_TYPES } from "./WindowsRegistry";

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

const windowControlCases = (Object.keys(WIN_TYPES) as AppWindow["type"][]).map(
  (type) => [type, WIN_TYPES[type]] as const,
);

function domRect(patch: Partial<DOMRect> = {}): DOMRect {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({}),
    ...patch,
  } as DOMRect;
}

function workspaceRef(rect: DOMRect = domRect()): RefObject<HTMLElement> {
  const element = document.createElement("div");
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
  return { current: element };
}

describe("WindowFrame content zoom controls", () => {
  it.each(windowControlCases)(
    "orders %s window controls as minimize, maximize, close",
    (type, def) => {
      const { unmount } = render(
        <WindowFrame
          win={appWindow({ type })}
          top
          connState={null}
          view={{ x: 0, y: 0, zoom: 1 }}
          api={api()}
          wsRef={createRef<HTMLElement>()}
        />,
      );

      const controls = screen.getByRole("group", { name: `${def.title} window controls` });
      const buttons = Array.from(controls.querySelectorAll("button"));

      expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
        `Minimize ${def.title} window`,
        `Maximize ${def.title} window`,
        `Close ${def.title} window`,
      ]);

      unmount();
    },
  );

  it("minimizes through the minimize window control", async () => {
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

  it("drags a window inside the workspace and commits the active snap preview", () => {
    const focus = vi.fn();
    const update = vi.fn();
    const setSnap = vi.fn();
    const commitSnap = vi.fn();
    const { container } = render(
      <WindowFrame
        win={appWindow()}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api({ focus, update, setSnap, commitSnap })}
        wsRef={workspaceRef(domRect())}
      />,
    );

    const header = container.querySelector<HTMLElement>(".win-head");
    expect(header).not.toBeNull();

    fireEvent.pointerDown(header as HTMLElement, { button: 0, clientX: 100, clientY: 90 });
    expect(document.body.style.cursor).toBe("grabbing");

    fireEvent.pointerMove(window, { clientX: 790, clientY: 20 });
    fireEvent.pointerUp(window);

    expect(focus).toHaveBeenCalledWith("agents-1");
    expect(update).toHaveBeenLastCalledWith("agents-1", { x: 680, y: -0 });
    expect(setSnap).toHaveBeenLastCalledWith("tr");
    expect(commitSnap).toHaveBeenCalledWith("agents-1");
    expect(document.body.style.cursor).toBe("");
  });

  it("restores maximized geometry before starting a header drag", () => {
    const update = vi.fn();
    const { container } = render(
      <WindowFrame
        win={appWindow({ max: true, prev: { x: 20, y: 25, w: 520, h: 360 } })}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api({ update })}
        wsRef={workspaceRef(domRect())}
      />,
    );

    const header = container.querySelector<HTMLElement>(".win-head");
    expect(header).not.toBeNull();

    fireEvent.pointerDown(header as HTMLElement, { button: 0, clientX: 400, clientY: 16 });

    expect(update).toHaveBeenCalledWith("agents-1", { max: false, w: 520, h: 360 });
    fireEvent.pointerUp(window);
  });

  it("resizes from the south-east handle with viewport zoom applied", () => {
    const focus = vi.fn();
    const update = vi.fn();
    const { container } = render(
      <WindowFrame
        win={appWindow()}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 2 }}
        api={api({ focus, update })}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    const handle = container.querySelector<HTMLElement>(".wz-se");
    expect(handle).not.toBeNull();

    fireEvent.pointerDown(handle as HTMLElement, { clientX: 100, clientY: 100 });
    expect(document.body.style.cursor).toBe("nwse-resize");

    fireEvent.pointerMove(window, { clientX: 160, clientY: 140 });
    fireEvent.pointerUp(window);

    expect(focus).toHaveBeenCalledWith("agents-1");
    expect(update).toHaveBeenLastCalledWith("agents-1", {
      x: 40,
      y: 40,
      w: 450,
      h: 340,
      max: false,
    });
    expect(document.body.style.cursor).toBe("");
  });

  it("keeps north-west resize within the registered minimum size", () => {
    const update = vi.fn();
    const { container } = render(
      <WindowFrame
        win={appWindow({ w: 260, h: 170 })}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api({ update })}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    const handle = container.querySelector<HTMLElement>(".wz-nw");
    expect(handle).not.toBeNull();

    fireEvent.pointerDown(handle as HTMLElement, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 260, clientY: 250 });
    fireEvent.pointerUp(window);

    expect(update).toHaveBeenLastCalledWith("agents-1", {
      x: 150,
      y: 100,
      w: 150,
      h: 110,
      max: false,
    });
  });

  it("starts a connection from pointer and keyboard port gestures", () => {
    const startConnect = vi.fn();
    const { container } = render(
      <WindowFrame
        win={appWindow()}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api({ startConnect })}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    const rightPort = container.querySelector<HTMLElement>(".wp-r");
    expect(rightPort).not.toBeNull();
    vi.spyOn(rightPort as HTMLElement, "getBoundingClientRect").mockReturnValue(
      domRect({ left: 450, top: 190, width: 12, height: 12, right: 462, bottom: 202 }),
    );

    fireEvent.pointerDown(rightPort as HTMLElement, { clientX: 460, clientY: 200 });
    fireEvent.keyDown(rightPort as HTMLElement, { key: "Enter" });
    fireEvent.keyDown(rightPort as HTMLElement, { key: "Escape" });

    expect(startConnect).toHaveBeenCalledTimes(2);
    expect(startConnect).toHaveBeenNthCalledWith(1, "agents-1", expect.any(Object));
    expect(startConnect).toHaveBeenNthCalledWith(
      2,
      "agents-1",
      expect.objectContaining({ clientX: 456, clientY: 196 }),
    );
  });

  it("confirms an in-flight valid connection instead of starting a new one", () => {
    const confirmConnect = vi.fn();
    const startConnect = vi.fn();
    const { container } = render(
      <WindowFrame
        win={appWindow()}
        top
        connState="valid"
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api({ confirmConnect, startConnect })}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    const rightPort = container.querySelector<HTMLElement>(".wp-r");
    expect(rightPort).not.toBeNull();

    fireEvent.keyDown(rightPort as HTMLElement, { key: " " });
    fireEvent.pointerDown(container.querySelector<HTMLElement>(".window") as HTMLElement);

    expect(confirmConnect).toHaveBeenCalledTimes(2);
    expect(confirmConnect).toHaveBeenNthCalledWith(1, "agents-1", expect.any(Object));
    expect(confirmConnect).toHaveBeenNthCalledWith(2, "agents-1", expect.any(Object));
    expect(startConnect).not.toHaveBeenCalled();
  });

  it("renders the compact too-small state instead of mounting unusable content", () => {
    render(
      <WindowFrame
        win={appWindow({ type: "files", id: "files-1", w: 120, h: 90 })}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api()}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    expect(screen.getByText("Too small to show Files")).toBeInTheDocument();
    expect(screen.getByText("Enlarge the window or zoom its content out")).toBeInTheDocument();
    expect(screen.getByText("Too small to show Files").closest(".win-body")).toHaveAttribute(
      "data-mode",
      "tiny",
    );
  });
});
