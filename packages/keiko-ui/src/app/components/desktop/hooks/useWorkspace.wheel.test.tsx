import { useRef } from "react";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "./useWorkspace";
import type { AppWindow } from "../windows/types";

const WORKSPACE_STORAGE_KEY = "keiko.workspace.v4";

function appWindow(patch: Partial<AppWindow> = {}): AppWindow {
  return {
    id: "files-1",
    type: "files",
    x: 40,
    y: 40,
    w: 360,
    h: 320,
    z: 1,
    cfg: { root: "/repo" },
    max: false,
    zoom: 1,
    ...patch,
  };
}

function Harness({
  cameraSmoothness = 0,
}: {
  readonly cameraSmoothness?: number;
}): ReactElement {
  const wsRef = useRef<HTMLDivElement>(null);
  const ws = useWorkspace(wsRef, { cameraSmoothness });
  const files = ws.wins?.find((win) => win.id === "files-1");

  return (
    <main ref={wsRef} data-testid="workspace" className="workspace">
      <section className="window" data-window-id="files-1">
        <div data-testid="window-target" />
      </section>
      <output data-testid="files-zoom">{files?.zoom ?? "missing"}</output>
      <output data-testid="view-zoom">{ws.view.zoom}</output>
      <output data-testid="view-x">{ws.view.x}</output>
      <output data-testid="view-y">{ws.view.y}</output>
      <button type="button" onClick={ws.api.fitView}>
        Fit
      </button>
    </main>
  );
}

function mockWorkspaceRect(): void {
  const workspace = screen.getByTestId("workspace");
  vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({
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

describe("useWorkspace wheel zoom routing", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("routes Ctrl/Command wheel over a window to that window's content zoom", async () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness />);
    mockWorkspaceRect();

    await waitFor(() => expect(screen.getByTestId("files-zoom")).toHaveTextContent("1"));

    fireEvent.wheel(screen.getByTestId("window-target"), {
      bubbles: true,
      cancelable: true,
      clientX: 200,
      clientY: 200,
      ctrlKey: true,
      deltaY: -100,
    });

    await waitFor(() => expect(screen.getByTestId("files-zoom")).toHaveTextContent("1.2"));
    expect(screen.getByTestId("view-zoom")).toHaveTextContent("1");
  });

  it("keeps Ctrl/Command wheel over free workspace routed to workspace zoom", async () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness />);
    mockWorkspaceRect();

    await waitFor(() => expect(screen.getByTestId("files-zoom")).toHaveTextContent("1"));

    fireEvent.wheel(screen.getByTestId("workspace"), {
      bubbles: true,
      cancelable: true,
      clientX: 500,
      clientY: 400,
      metaKey: true,
      deltaY: -100,
    });

    await waitFor(() =>
      expect(Number(screen.getByTestId("view-zoom").textContent)).toBeGreaterThan(1),
    );
    expect(screen.getByTestId("files-zoom")).toHaveTextContent("1");
  });

  it("fits the workspace view around visible windows", async () => {
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify([
        appWindow({ id: "a", x: 0, y: 0, w: 100, h: 100 }),
        appWindow({ id: "b", x: 200, y: 100, w: 100, h: 100 }),
      ]),
    );
    render(<Harness />);
    mockWorkspaceRect();

    await waitFor(() => expect(screen.getByTestId("files-zoom")).toHaveTextContent("missing"));

    fireEvent.click(screen.getByRole("button", { name: "Fit" }));

    await waitFor(() => {
      expect(screen.getByTestId("view-zoom")).toHaveTextContent("1");
      expect(screen.getByTestId("view-x")).toHaveTextContent("350");
      expect(screen.getByTestId("view-y")).toHaveTextContent("300");
    });
  });

  it("coalesces repeated free-workspace wheel pan events into one animation-frame view update", async () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback): number => {
        callbacks.push(callback);
        return callbacks.length;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness />);
    mockWorkspaceRect();

    await waitFor(() => expect(screen.getByTestId("view-x")).toHaveTextContent("0"));

    fireEvent.wheel(screen.getByTestId("workspace"), {
      bubbles: true,
      cancelable: true,
      deltaX: 10,
      deltaY: 20,
    });
    fireEvent.wheel(screen.getByTestId("workspace"), {
      bubbles: true,
      cancelable: true,
      deltaX: 5,
      deltaY: 15,
    });

    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("view-x")).toHaveTextContent("0");

    callbacks[0]?.(1);

    await waitFor(() => {
      expect(screen.getByTestId("view-x")).toHaveTextContent("-15");
      expect(screen.getByTestId("view-y")).toHaveTextContent("-35");
    });
  });

  it("eases free-workspace pan updates when smooth camera animation is selected", async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(performance, "now").mockReturnValue(0);
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback): number => {
        callbacks.push(callback);
        return callbacks.length;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(window, "matchMedia").mockImplementation(
      () =>
        ({
          matches: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness cameraSmoothness={100} />);
    mockWorkspaceRect();

    await waitFor(() => expect(screen.getByTestId("view-x")).toHaveTextContent("0"));

    fireEvent.wheel(screen.getByTestId("workspace"), {
      bubbles: true,
      cancelable: true,
      deltaX: 20,
      deltaY: 40,
    });

    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
    callbacks[0]?.(0);
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("view-x")).toHaveTextContent("0");

    callbacks[1]?.(140);

    await waitFor(() => {
      const x = Number(screen.getByTestId("view-x").textContent);
      const y = Number(screen.getByTestId("view-y").textContent);
      expect(x).toBeLessThan(0);
      expect(x).toBeGreaterThan(-20);
      expect(y).toBeLessThan(0);
      expect(y).toBeGreaterThan(-40);
    });

    callbacks[2]?.(280);

    await waitFor(() => {
      expect(screen.getByTestId("view-x")).toHaveTextContent("-20");
      expect(screen.getByTestId("view-y")).toHaveTextContent("-40");
    });
  });

  it("keeps low free-workspace pan smoothness close to immediate movement", async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback): number => {
        callbacks.push(callback);
        return callbacks.length;
      },
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(window, "matchMedia").mockImplementation(
      () =>
        ({
          matches: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness cameraSmoothness={8} />);
    mockWorkspaceRect();

    await waitFor(() => expect(screen.getByTestId("view-x")).toHaveTextContent("0"));

    fireEvent.wheel(screen.getByTestId("workspace"), {
      bubbles: true,
      cancelable: true,
      deltaX: 20,
      deltaY: 40,
    });

    callbacks[0]?.(0);
    callbacks[1]?.(140);

    await waitFor(() => {
      expect(screen.getByTestId("view-x")).toHaveTextContent("-20");
      expect(screen.getByTestId("view-y")).toHaveTextContent("-40");
    });
  });

  it("settles workspace camera animation before routing Ctrl wheel inside a window", async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback): number => {
        callbacks.push(callback);
        return callbacks.length;
      },
    );
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    vi.spyOn(window, "matchMedia").mockImplementation(
      () =>
        ({
          matches: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness cameraSmoothness={100} />);
    mockWorkspaceRect();

    await waitFor(() => expect(screen.getByTestId("view-x")).toHaveTextContent("0"));

    fireEvent.wheel(screen.getByTestId("workspace"), {
      bubbles: true,
      cancelable: true,
      deltaX: 20,
      deltaY: 40,
    });
    callbacks[0]?.(0);

    fireEvent.wheel(screen.getByTestId("window-target"), {
      bubbles: true,
      cancelable: true,
      clientX: 200,
      clientY: 200,
      ctrlKey: true,
      deltaY: -100,
    });

    expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(2);
    await waitFor(() => {
      expect(screen.getByTestId("files-zoom")).toHaveTextContent("1.2");
      expect(screen.getByTestId("view-x")).toHaveTextContent("-20");
      expect(screen.getByTestId("view-y")).toHaveTextContent("-40");
    });
  });

  it("uses immediate updates for smooth mode when reduced motion is requested", async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback): number => {
        callbacks.push(callback);
        return callbacks.length;
      },
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(window, "matchMedia").mockImplementation(
      () =>
        ({
          matches: true,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness cameraSmoothness={100} />);
    mockWorkspaceRect();

    await waitFor(() => expect(screen.getByTestId("view-x")).toHaveTextContent("0"));

    fireEvent.wheel(screen.getByTestId("workspace"), {
      bubbles: true,
      cancelable: true,
      deltaX: 20,
      deltaY: 40,
    });

    callbacks[0]?.(0);

    await waitFor(() => {
      expect(screen.getByTestId("view-x")).toHaveTextContent("-20");
      expect(screen.getByTestId("view-y")).toHaveTextContent("-40");
    });
  });
});
