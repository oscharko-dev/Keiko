import { useRef } from "react";
import type { ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function Harness({ cameraSmoothness = 0 }: { readonly cameraSmoothness?: number }): ReactElement {
  const wsRef = useRef<HTMLDivElement>(null);
  const ws = useWorkspace(wsRef, { cameraSmoothness });
  const files = ws.wins?.find((win) => win.id === "files-1");
  // Issue #2402 — observable `wins` identity: a snapped no-op content-zoom step
  // must not flip the array identity (that identity drives persistence scheduling,
  // connection pruning, and selection normalization downstream).
  const lastWinsRef = useRef<readonly AppWindow[] | null>(null);
  const winsIdentityChangesRef = useRef(0);
  if (ws.wins !== lastWinsRef.current) {
    lastWinsRef.current = ws.wins;
    winsIdentityChangesRef.current += 1;
  }

  return (
    <main ref={wsRef} data-testid="workspace" className="workspace">
      <section className="window" data-window-id="files-1">
        <div data-testid="window-target" />
        <div data-testid="scroll-target" style={{ overflowY: "auto", width: 100, height: 80 }}>
          <div style={{ width: 100, height: 300 }} />
        </div>
      </section>
      <output data-testid="files-zoom">{files?.zoom ?? "missing"}</output>
      <output data-testid="view-zoom">{ws.view.zoom}</output>
      <output data-testid="view-x">{ws.view.x}</output>
      <output data-testid="view-y">{ws.view.y}</output>
      <output data-testid="selected-window-ids">{ws.selection.selectedWindowIds.join(",")}</output>
      <output data-testid="wins-identity-changes">{winsIdentityChangesRef.current}</output>
      <button type="button" onClick={() => ws.api.activateWindow("files-1")}>
        Activate files
      </button>
      <button type="button" onClick={() => ws.api.toggleTool("governedGit")}>
        Toggle Git
      </button>
      <button type="button" onClick={() => ws.api.add("governedGit")}>
        Add Git
      </button>
      <button type="button" onClick={ws.api.tileAll}>
        Tile all
      </button>
      <button type="button" onClick={ws.api.splitFront}>
        Split front
      </button>
      <button type="button" onClick={ws.api.cascade}>
        Cascade
      </button>
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

function setScrollableGeometry(
  element: HTMLElement,
  geometry: {
    readonly clientHeight: number;
    readonly scrollHeight: number;
    readonly scrollTop: number;
  },
): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: geometry.clientHeight },
    scrollHeight: { configurable: true, value: geometry.scrollHeight },
  });
  element.scrollTop = geometry.scrollTop;
}

describe("useWorkspace wheel zoom routing", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("routes Ctrl/Command wheel over a window to workspace zoom", async () => {
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

    await waitFor(() =>
      expect(Number(screen.getByTestId("view-zoom").textContent)).toBeGreaterThan(1),
    );
    expect(screen.getByTestId("files-zoom")).toHaveTextContent("1");
  });

  it("keeps Ctrl/Command wheel inside the active window from zooming the workspace", async () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness />);
    mockWorkspaceRect();

    fireEvent.click(screen.getByRole("button", { name: "Activate files" }));
    await waitFor(() =>
      expect(screen.getByTestId("selected-window-ids")).toHaveTextContent("files-1"),
    );

    fireEvent.wheel(screen.getByTestId("window-target"), {
      bubbles: true,
      cancelable: true,
      clientX: 200,
      clientY: 200,
      ctrlKey: true,
      deltaY: -100,
    });

    expect(screen.getByTestId("view-zoom")).toHaveTextContent("1");
    expect(screen.getByTestId("files-zoom")).toHaveTextContent("1");
  });

  it("keeps trackpad pan over non-scrollable window chrome routed to the workspace view", async () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness />);
    mockWorkspaceRect();

    await waitFor(() => expect(screen.getByTestId("view-x")).toHaveTextContent("0"));

    fireEvent.wheel(screen.getByTestId("window-target"), {
      bubbles: true,
      cancelable: true,
      deltaX: 20,
      deltaY: 40,
    });

    await waitFor(() => {
      expect(screen.getByTestId("view-x")).toHaveTextContent("-20");
      expect(screen.getByTestId("view-y")).toHaveTextContent("-40");
    });
    expect(screen.getByTestId("files-zoom")).toHaveTextContent("1");
  });

  it("keeps two-finger wheel over scrollable unselected window content routed to workspace pan", async () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness />);
    mockWorkspaceRect();

    await waitFor(() => expect(screen.getByTestId("view-y")).toHaveTextContent("0"));
    const scrollTarget = screen.getByTestId("scroll-target");
    setScrollableGeometry(scrollTarget, { clientHeight: 80, scrollHeight: 300, scrollTop: 40 });

    fireEvent.wheel(scrollTarget, {
      bubbles: true,
      cancelable: true,
      deltaY: 40,
    });

    await waitFor(() => {
      expect(screen.getByTestId("view-y")).toHaveTextContent("-40");
    });
    expect(screen.getByTestId("files-zoom")).toHaveTextContent("1");
  });

  it("lets active scrollable window content consume two-finger wheel before workspace pan", async () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness />);
    mockWorkspaceRect();

    fireEvent.click(screen.getByRole("button", { name: "Activate files" }));
    await waitFor(() =>
      expect(screen.getByTestId("selected-window-ids")).toHaveTextContent("files-1"),
    );
    const scrollTarget = screen.getByTestId("scroll-target");
    setScrollableGeometry(scrollTarget, { clientHeight: 80, scrollHeight: 300, scrollTop: 40 });

    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 40,
    });
    scrollTarget.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByTestId("view-y")).toHaveTextContent("0");
    expect(screen.getByTestId("files-zoom")).toHaveTextContent("1");
  });

  it("keeps workspace fixed when active window content reaches its scroll edge", async () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness />);
    mockWorkspaceRect();

    fireEvent.click(screen.getByRole("button", { name: "Activate files" }));
    await waitFor(() =>
      expect(screen.getByTestId("selected-window-ids")).toHaveTextContent("files-1"),
    );
    await waitFor(() => expect(screen.getByTestId("view-y")).toHaveTextContent("0"));
    const scrollTarget = screen.getByTestId("scroll-target");
    setScrollableGeometry(scrollTarget, { clientHeight: 80, scrollHeight: 300, scrollTop: 220 });

    fireEvent.wheel(scrollTarget, {
      bubbles: true,
      cancelable: true,
      deltaY: 40,
    });

    expect(screen.getByTestId("view-y")).toHaveTextContent("0");
    expect(screen.getByTestId("files-zoom")).toHaveTextContent("1");
  });

  it("activates a tool window when opening it from the workspace rail", async () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness />);
    mockWorkspaceRect();

    fireEvent.click(screen.getByRole("button", { name: "Activate files" }));
    await waitFor(() =>
      expect(screen.getByTestId("selected-window-ids")).toHaveTextContent("files-1"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle Git" }));

    await waitFor(() =>
      expect(screen.getByTestId("selected-window-ids")).toHaveTextContent("governedGit"),
    );
  });

  it("activates a singleton window when adding it from a shell-bound open path", async () => {
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify([
        appWindow({ id: "files-1", type: "files", z: 1 }),
        appWindow({ id: "chat-1", type: "chat", cfg: {}, z: 2 }),
        appWindow({ id: "editor-1", type: "editor", cfg: {}, z: 3 }),
      ]),
    );
    render(<Harness />);
    mockWorkspaceRect();

    fireEvent.click(screen.getByRole("button", { name: "Activate files" }));
    await waitFor(() =>
      expect(screen.getByTestId("selected-window-ids")).toHaveTextContent("files-1"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Git" }));

    await waitFor(() =>
      expect(screen.getByTestId("selected-window-ids")).toHaveTextContent("governedGit"),
    );
  });

  it.each([
    { label: "Tile all", minimizedTop: true },
    { label: "Split front", minimizedTop: false },
    { label: "Cascade", minimizedTop: true },
  ])("activates a deterministic window owner after $label", async ({ label, minimizedTop }) => {
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify([
        appWindow({ id: "files-1", type: "files", z: 1 }),
        appWindow({ id: "chat-1", type: "chat", cfg: {}, z: 4, minimized: minimizedTop }),
        appWindow({ id: "editor-1", type: "editor", cfg: {}, z: 3 }),
      ]),
    );
    render(<Harness />);
    mockWorkspaceRect();

    await waitFor(() => expect(screen.getByTestId("selected-window-ids")).toHaveTextContent(""));
    fireEvent.click(screen.getByRole("button", { name: label }));

    await waitFor(() =>
      expect(screen.getByTestId("selected-window-ids")).toHaveTextContent("chat-1"),
    );
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

  it("keeps free-workspace pan direct even when smooth camera animation is selected", async () => {
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

    await waitFor(() => {
      expect(screen.getByTestId("view-x")).toHaveTextContent("-20");
      expect(screen.getByTestId("view-y")).toHaveTextContent("-40");
    });
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
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

    await waitFor(() => {
      expect(screen.getByTestId("view-x")).toHaveTextContent("-20");
      expect(screen.getByTestId("view-y")).toHaveTextContent("-40");
    });
  });

  it("routes Ctrl wheel over a window to workspace zoom after a direct workspace pan", async () => {
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

    await waitFor(() => {
      expect(screen.getByTestId("view-x")).toHaveTextContent("-20");
      expect(screen.getByTestId("view-y")).toHaveTextContent("-40");
    });

    fireEvent.wheel(screen.getByTestId("window-target"), {
      bubbles: true,
      cancelable: true,
      clientX: 200,
      clientY: 200,
      ctrlKey: true,
      deltaY: -100,
    });

    act(() => {
      callbacks.at(-1)?.(0);
      callbacks.at(-1)?.(500);
    });
    await waitFor(() => {
      expect(Number(screen.getByTestId("view-zoom").textContent)).toBeGreaterThan(1);
      expect(screen.getByTestId("files-zoom")).toHaveTextContent("1");
    });
    expect(cancelAnimationFrameSpy).not.toHaveBeenCalled();
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

describe("useWorkspace wheel zoom layout-read coalescing (GEN-PERF-WORKSPACE-005)", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("reads the workspace rect at most once per zoom-gesture settle window", async () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness />);
    const workspace = screen.getByTestId("workspace");
    const rectSpy = vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      toJSON: () => ({}),
    } as DOMRect);

    await waitFor(() => expect(screen.getByTestId("files-zoom")).toHaveTextContent("1"));
    rectSpy.mockClear(); // ignore mount/hydration reads

    // A trackpad pinch synthesizes ctrl-wheel at 60-120+Hz. The old code paid one
    // synchronous getBoundingClientRect per event; the gesture cache must collapse
    // a continuous burst to a single layout read within the 160ms settle window.
    for (let i = 0; i < 6; i += 1) {
      fireEvent.wheel(workspace, {
        bubbles: true,
        cancelable: true,
        clientX: 500,
        clientY: 400,
        ctrlKey: true,
        deltaY: -30,
      });
    }

    await waitFor(() =>
      expect(Number(screen.getByTestId("view-zoom").textContent)).toBeGreaterThan(1),
    );
    expect(rectSpy).toHaveBeenCalledTimes(1);
  });
});
