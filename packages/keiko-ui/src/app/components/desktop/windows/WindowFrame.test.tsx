import { createRef, type RefObject } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceApi } from "../hooks/useWorkspace.types";
import { WindowFrame } from "./WindowFrame";
import type { AppWindow } from "./types";
import { registerWindowRender, WIN_TYPES } from "./WindowsRegistry";

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

function figmaViewWindow(patch: Partial<AppWindow> = {}): AppWindow {
  const { cfg: patchCfg, ...windowPatch } = patch;
  const cfg = {
    snapshotRunId: "figma-run-1",
    selectedScreenIdsJson: JSON.stringify(["screen-1"]),
    selectedScreenName: "Frame 1",
    ...(patchCfg ?? {}),
  };
  return appWindow({
    id: "figma-view-1",
    type: "figmaView",
    w: 360,
    h: 320,
    ...windowPatch,
    cfg,
  });
}

function api(patch: Partial<WorkspaceApi> = {}): WorkspaceApi {
  return {
    add: vi.fn(() => null),
    openEditorFile: vi.fn(() => ({ ok: false as const, message: "Unable to open editor." })),
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

function installAnimationFrameQueue(): {
  readonly frames: Map<number, FrameRequestCallback>;
  readonly flushNextFrame: () => void;
  readonly restore: () => void;
} {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 0;
  const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextFrameId += 1;
    frames.set(nextFrameId, callback);
    return nextFrameId;
  });
  const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  return {
    frames,
    flushNextFrame: () => {
      const [frameId, callback] = Array.from(frames.entries())[0] ?? [];
      expect(frameId).toBeDefined();
      expect(callback).toBeDefined();
      frames.delete(frameId as number);
      callback?.(0);
    },
    restore: () => {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    },
  };
}

function installAutoGrowHarness(): {
  readonly fireResize: () => void;
  readonly flushAnimationFrame: () => void;
  readonly flushAllAnimationFrames: () => void;
  readonly observerCount: () => number;
  readonly restore: () => void;
} {
  const callbacks: ResizeObserverCallback[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;

  class MockResizeObserver implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback);
    }

    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: MockResizeObserver,
  });
  window.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
    const id = nextFrameId;
    nextFrameId += 1;
    frames.set(id, callback);
    return id;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number): void => {
    frames.delete(id);
  }) as typeof window.cancelAnimationFrame;

  const flushAnimationFrame = (): void => {
    const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (entry === undefined) return;
    const [id, callback] = entry;
    frames.delete(id);
    callback(0);
  };
  const flushAllAnimationFrames = (): void => {
    while (frames.size > 0) {
      flushAnimationFrame();
    }
  };

  return {
    fireResize: () => {
      callbacks.at(-1)?.([], {} as ResizeObserver);
      flushAnimationFrame();
    },
    flushAnimationFrame,
    flushAllAnimationFrames,
    observerCount: () => callbacks.length,
    restore: () => {
      if (originalResizeObserver === undefined) {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      } else {
        Object.defineProperty(globalThis, "ResizeObserver", {
          configurable: true,
          writable: true,
          value: originalResizeObserver,
        });
      }
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;
    },
  };
}

function setBodyMetrics(
  element: HTMLElement,
  metrics: { readonly clientHeight: number; readonly scrollHeight: number },
): void {
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
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
        `Full screen ${def.title} window`,
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

  it("hides content zoom controls when Quality Intelligence is at its narrow width", () => {
    render(
      <WindowFrame
        win={appWindow({ type: "quality", id: "quality-1", w: 300, h: 420 })}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api()}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    expect(screen.getByRole("region", { name: "Quality Intelligence" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Zoom Quality Intelligence content out" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "100% — reset Quality Intelligence content zoom",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Zoom Quality Intelligence content in" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Quality Intelligence window controls" }),
    ).toBeInTheDocument();
  });

  it("requests connected Files context for Prompt Enhancer windows", () => {
    const linkedFilesRoot = vi.fn(() => "/repo");
    const linkedFilesContext = vi.fn(() => ({
      id: "files-1",
      root: "/repo",
      activeFilePath: "src/app.ts",
    }));
    const linkedAllFilesRoots = vi.fn(() => ["/repo", "/docs"]);

    render(
      <WindowFrame
        win={appWindow({
          id: "prompt-enhancer-1",
          type: "promptEnhancer",
          w: 860,
          h: 680,
        })}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api({ linkedFilesRoot, linkedFilesContext, linkedAllFilesRoots })}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    expect(screen.getByRole("region", { name: "Prompt Enhancer" })).toBeInTheDocument();
    expect(linkedFilesRoot).toHaveBeenCalledWith("prompt-enhancer-1");
    expect(linkedFilesContext).toHaveBeenCalledWith("prompt-enhancer-1");
    expect(linkedAllFilesRoots).toHaveBeenCalledWith("prompt-enhancer-1");
  });

  it("defers focus long enough for selectable text drags to start", () => {
    vi.useFakeTimers();
    registerWindowRender("promptEnhancer", () => (
      <pre data-text-selectable="true">Selectable prompt text</pre>
    ));
    const focus = vi.fn();

    render(
      <WindowFrame
        win={appWindow({
          id: "prompt-enhancer-1",
          type: "promptEnhancer",
          w: 860,
          h: 680,
        })}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api({ focus })}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    fireEvent.pointerDown(screen.getByText("Selectable prompt text"), { button: 0 });

    expect(focus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(179);
    expect(focus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(focus).toHaveBeenCalledWith("prompt-enhancer-1");
    vi.useRealTimers();
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

  it("drags the window from the header with the primary button", () => {
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
    const section = container.querySelector<HTMLElement>(".window");
    expect(section).not.toBeNull();

    fireEvent.pointerDown(header as HTMLElement, { button: 0, clientX: 100, clientY: 90 });
    fireEvent.pointerMove(window, { clientX: 790, clientY: 20 });
    fireEvent.pointerUp(window);

    expect(focus).toHaveBeenCalledWith("agents-1");
    expect(update).toHaveBeenLastCalledWith("agents-1", { x: 680, y: -0 });
    expect(setSnap).toHaveBeenLastCalledWith("tr");
    expect(commitSnap).toHaveBeenCalledWith("agents-1");
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(section).not.toHaveAttribute("data-dragging");
  });

  it("keeps middle-button header dragging available for mouse users", () => {
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

    fireEvent.pointerDown(header as HTMLElement, { button: 1, clientX: 100, clientY: 90 });
    fireEvent.pointerMove(window, { clientX: 790, clientY: 20 });
    fireEvent.pointerUp(window);

    expect(focus).toHaveBeenCalledWith("agents-1");
    expect(update).toHaveBeenLastCalledWith("agents-1", { x: 680, y: -0 });
    expect(setSnap).toHaveBeenLastCalledWith("tr");
    expect(commitSnap).toHaveBeenCalledWith("agents-1");
    expect(document.body.style.cursor).toBe("");
  });

  it("does not start header dragging from right click or macOS control click", () => {
    const focus = vi.fn();
    const update = vi.fn();
    const { container } = render(
      <WindowFrame
        win={appWindow()}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api({ focus, update })}
        wsRef={workspaceRef(domRect())}
      />,
    );

    const header = container.querySelector<HTMLElement>(".win-head");
    expect(header).not.toBeNull();

    fireEvent.pointerDown(header as HTMLElement, { button: 2, clientX: 100, clientY: 90 });
    fireEvent.pointerDown(header as HTMLElement, {
      button: 0,
      ctrlKey: true,
      clientX: 100,
      clientY: 90,
    });

    expect(focus).toHaveBeenCalledWith("agents-1");
    expect(update).not.toHaveBeenCalled();
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

    fireEvent.pointerDown(header as HTMLElement, { button: 1, clientX: 400, clientY: 16 });

    expect(update).toHaveBeenCalledWith("agents-1", { max: false, w: 520, h: 360 });
    fireEvent.pointerUp(window);
  });

  it("resizes from the south-east handle with viewport zoom applied", () => {
    const focus = vi.fn();
    const update = vi.fn();
    const frames = installAnimationFrameQueue();

    try {
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

      fireEvent.pointerMove(window, { buttons: 1, clientX: 160, clientY: 140 });
      expect(update).not.toHaveBeenCalled();
      frames.flushNextFrame();
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
    } finally {
      frames.restore();
    }
  });

  it("resizes from the south handle upward without moving the window origin", () => {
    const focus = vi.fn();
    const update = vi.fn();
    const frames = installAnimationFrameQueue();

    try {
      const { container } = render(
        <WindowFrame
          win={appWindow()}
          top
          connState={null}
          view={{ x: 0, y: 0, zoom: 1 }}
          api={api({ focus, update })}
          wsRef={createRef<HTMLElement>()}
        />,
      );

      const handle = container.querySelector<HTMLElement>(".wz-s");
      expect(handle).not.toBeNull();

      fireEvent.pointerDown(handle as HTMLElement, { clientX: 100, clientY: 100 });
      expect(document.body.style.cursor).toBe("ns-resize");
      fireEvent.pointerMove(window, { buttons: 1, clientX: 100, clientY: 60 });
      expect(update).not.toHaveBeenCalled();
      frames.flushNextFrame();
      fireEvent.pointerUp(window);

      expect(focus).toHaveBeenCalledWith("agents-1");
      expect(update).toHaveBeenLastCalledWith("agents-1", {
        x: 40,
        y: 40,
        w: 420,
        h: 280,
        max: false,
      });
      expect(document.body.style.cursor).toBe("");
    } finally {
      frames.restore();
    }
  });

  it("cleans up south resize listeners on pointer cancel and window blur", () => {
    const update = vi.fn();
    const { container } = render(
      <WindowFrame
        win={appWindow()}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api({ update })}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    const handle = container.querySelector<HTMLElement>(".wz-s");
    expect(handle).not.toBeNull();

    fireEvent.pointerDown(handle as HTMLElement, { clientX: 100, clientY: 100 });
    expect(document.body.style.cursor).toBe("ns-resize");
    fireEvent.pointerCancel(window);
    expect(document.body.style.cursor).toBe("");
    fireEvent.pointerMove(window, { buttons: 1, clientX: 100, clientY: 60 });
    expect(update).not.toHaveBeenCalled();

    fireEvent.pointerDown(handle as HTMLElement, { clientX: 100, clientY: 100 });
    expect(document.body.style.cursor).toBe("ns-resize");
    window.dispatchEvent(new Event("blur"));
    expect(document.body.style.cursor).toBe("");
    fireEvent.pointerMove(window, { buttons: 1, clientX: 100, clientY: 60 });
    expect(update).not.toHaveBeenCalled();
  });

  it("ignores duplicate resize pointer moves with unchanged geometry", () => {
    const update = vi.fn();
    const frames = installAnimationFrameQueue();

    try {
      const { container } = render(
        <WindowFrame
          win={appWindow()}
          top
          connState={null}
          view={{ x: 0, y: 0, zoom: 1 }}
          api={api({ update })}
          wsRef={createRef<HTMLElement>()}
        />,
      );

      const handle = container.querySelector<HTMLElement>(".wz-se");
      expect(handle).not.toBeNull();

      fireEvent.pointerDown(handle as HTMLElement, { clientX: 100, clientY: 100 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 140, clientY: 120 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 140, clientY: 120 });
      fireEvent.pointerUp(window);
      frames.flushNextFrame();

      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      frames.restore();
    }
  });

  it("batches rapid resize pointer moves into one animation-frame update", () => {
    const update = vi.fn();
    const frames = installAnimationFrameQueue();

    try {
      const { container } = render(
        <WindowFrame
          win={appWindow()}
          top
          connState={null}
          view={{ x: 0, y: 0, zoom: 1 }}
          api={api({ update })}
          wsRef={createRef<HTMLElement>()}
        />,
      );

      const handle = container.querySelector<HTMLElement>(".wz-se");
      expect(handle).not.toBeNull();

      fireEvent.pointerDown(handle as HTMLElement, { clientX: 100, clientY: 100 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 120, clientY: 110 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 140, clientY: 120 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 160, clientY: 140 });

      expect(update).not.toHaveBeenCalled();
      expect(frames.frames.size).toBe(1);
      frames.flushNextFrame();

      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenLastCalledWith("agents-1", {
        x: 40,
        y: 40,
        w: 480,
        h: 360,
        max: false,
      });

      fireEvent.pointerUp(window);

      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      frames.restore();
    }
  });

  it("auto-grows a Figma View window before a manual resize", async () => {
    registerWindowRender("figmaView", () => <div>Figma view fixture</div>);
    const harness = installAutoGrowHarness();
    const update = vi.fn();
    const { container } = render(
      <WindowFrame
        win={figmaViewWindow()}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api({ update })}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    try {
      const body = container.querySelector<HTMLElement>(".win-body");
      expect(body).not.toBeNull();
      setBodyMetrics(body as HTMLElement, { clientHeight: 280, scrollHeight: 340 });
      await waitFor(() => expect(harness.observerCount()).toBeGreaterThan(0));
      harness.fireResize();

      await waitFor(() => expect(update).toHaveBeenCalledWith("figma-view-1", { h: 380 }));
    } finally {
      harness.restore();
    }
  });

  it("suppresses Figma View auto-grow after manual resize until the content key changes", async () => {
    registerWindowRender("figmaView", () => <div>Figma view fixture</div>);
    const harness = installAutoGrowHarness();
    const update = vi.fn();
    const testApi = api({ update });
    const view = { x: 0, y: 0, zoom: 1 };
    const wsRef = createRef<HTMLElement>();
    const { container, rerender } = render(
      <WindowFrame
        win={figmaViewWindow({ h: 360 })}
        top
        connState={null}
        view={view}
        api={testApi}
        wsRef={wsRef}
      />,
    );

    try {
      const handle = container.querySelector<HTMLElement>(".wz-s");
      expect(handle).not.toBeNull();
      fireEvent.pointerDown(handle as HTMLElement, { clientX: 100, clientY: 100 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 100, clientY: 60 });
      harness.flushAllAnimationFrames();
      fireEvent.pointerUp(window);

      expect(update).toHaveBeenLastCalledWith("figma-view-1", {
        x: 40,
        y: 40,
        w: 360,
        h: 320,
        max: false,
      });

      update.mockClear();
      const body = container.querySelector<HTMLElement>(".win-body");
      expect(body).not.toBeNull();
      setBodyMetrics(body as HTMLElement, { clientHeight: 320, scrollHeight: 390 });
      await waitFor(() => expect(harness.observerCount()).toBeGreaterThan(0));
      harness.fireResize();
      expect(update).not.toHaveBeenCalled();

      const observerCountBeforeContentChange = harness.observerCount();
      rerender(
        <WindowFrame
          win={figmaViewWindow({
            h: 320,
            cfg: {
              snapshotRunId: "figma-run-1",
              selectedScreenIdsJson: JSON.stringify(["screen-2"]),
              selectedScreenName: "Frame 2",
            },
          })}
          top
          connState={null}
          view={view}
          api={testApi}
          wsRef={wsRef}
        />,
      );

      await waitFor(() =>
        expect(harness.observerCount()).toBeGreaterThan(observerCountBeforeContentChange),
      );
      harness.fireResize();
      await waitFor(() => expect(update).toHaveBeenCalledWith("figma-view-1", { h: 390 }));
    } finally {
      harness.restore();
    }
  });

  it("cleans up a stale resize session when moves arrive after button release", () => {
    const update = vi.fn();
    const frames = installAnimationFrameQueue();

    try {
      const { container } = render(
        <WindowFrame
          win={appWindow()}
          top
          connState={null}
          view={{ x: 0, y: 0, zoom: 1 }}
          api={api({ update })}
          wsRef={createRef<HTMLElement>()}
        />,
      );

      const handle = container.querySelector<HTMLElement>(".wz-se");
      expect(handle).not.toBeNull();

      fireEvent.pointerDown(handle as HTMLElement, { clientX: 100, clientY: 100 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 140, clientY: 120 });
      fireEvent.pointerMove(window, { buttons: 0, clientX: 180, clientY: 150 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 220, clientY: 180 });
      frames.flushNextFrame();

      expect(update).toHaveBeenCalledTimes(1);
      expect(document.body.style.cursor).toBe("");
    } finally {
      frames.restore();
    }
  });

  it("does not resize from right click or macOS control click on a resize handle", () => {
    const focus = vi.fn();
    const update = vi.fn();
    const { container } = render(
      <WindowFrame
        win={appWindow()}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api({ focus, update })}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    const handle = container.querySelector<HTMLElement>(".wz-se");
    expect(handle).not.toBeNull();

    fireEvent.pointerDown(handle as HTMLElement, { button: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerDown(handle as HTMLElement, {
      button: 0,
      ctrlKey: true,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(window, { clientX: 160, clientY: 140 });
    fireEvent.pointerUp(window);

    expect(focus).toHaveBeenCalledWith("agents-1");
    expect(update).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("");
  });

  it("keeps north-west resize within the registered minimum size", () => {
    const update = vi.fn();
    const frames = installAnimationFrameQueue();

    try {
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
      fireEvent.pointerMove(window, { buttons: 1, clientX: 260, clientY: 250 });
      fireEvent.pointerUp(window);
      frames.flushNextFrame();

      expect(update).toHaveBeenLastCalledWith("agents-1", {
        x: 150,
        y: 100,
        w: 150,
        h: 110,
        max: false,
      });
    } finally {
      frames.restore();
    }
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

  // #25, WCAG 2.1.1 — port controls must be natively keyboard-operable.
  // RED: ports are currently <div role="button"> — getByRole("button", { name: /connect/i })
  // resolves by role but `tagName` is "DIV", not "BUTTON".
  it("exposes port controls as native <button> elements (#25, WCAG 2.1.1)", () => {
    render(
      <WindowFrame
        win={appWindow()}
        top
        connState={null}
        view={{ x: 0, y: 0, zoom: 1 }}
        api={api()}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    // All 4 ports must be native buttons (getByRole finds by implicit role of <button>).
    const portButtons = screen.getAllByRole("button", { name: /connect agents from/iu });
    expect(portButtons).toHaveLength(4);
    for (const btn of portButtons) {
      expect(btn.tagName).toBe("BUTTON");
    }
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
