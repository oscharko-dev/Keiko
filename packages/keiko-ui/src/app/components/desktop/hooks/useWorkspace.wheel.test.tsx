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
      </section>
      <output data-testid="files-zoom">{files?.zoom ?? "missing"}</output>
      <output data-testid="view-zoom">{ws.view.zoom}</output>
      <output data-testid="view-x">{ws.view.x}</output>
      <output data-testid="view-y">{ws.view.y}</output>
      <output data-testid="wins-identity-changes">{winsIdentityChangesRef.current}</output>
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

  it("routes Ctrl wheel inside a window after a direct workspace pan", async () => {
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

    expect(cancelAnimationFrameSpy).not.toHaveBeenCalled();
    // Issue #2402 — content zoom now commits once per animation frame.
    callbacks.at(-1)?.(0);
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

// Issue #2402 — the ctrl/cmd-wheel CONTENT-zoom branch (pointer over a window)
// had none of the camera path's protections: one uncapped setWins commit per
// wheel event, a fresh wins array even for snapped no-op steps, and no
// data-view-active suppression for the wallpaper shader. A trackpad pinch
// synthesizes ctrl-wheel at 60-120+Hz, so each gap was a per-event cost.
describe("useWorkspace content-zoom wheel coalescing (issue #2402)", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  function mockAnimationFrames(): FrameRequestCallback[] {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback): number => {
        callbacks.push(callback);
        return callbacks.length;
      },
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    return callbacks;
  }

  function fireContentZoomWheel(deltaY: number): void {
    fireEvent.wheel(screen.getByTestId("window-target"), {
      bubbles: true,
      cancelable: true,
      clientX: 200,
      clientY: 200,
      ctrlKey: true,
      deltaY,
    });
  }

  it("coalesces a same-frame ctrl-wheel burst over a window into one commit", async () => {
    const callbacks = mockAnimationFrames();
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness />);
    mockWorkspaceRect();

    await waitFor(() => expect(screen.getByTestId("files-zoom")).toHaveTextContent("1"));
    const scheduledBefore = callbacks.length;

    fireContentZoomWheel(-100);
    fireContentZoomWheel(-100);

    // No synchronous per-event commit, and the whole burst holds ONE frame.
    expect(screen.getByTestId("files-zoom")).toHaveTextContent("1");
    expect(callbacks.length - scheduledBefore).toBe(1);

    callbacks[scheduledBefore]?.(0);

    // The coalesced commit replays each queued delta in order against the previous
    // step's SNAPPED zoom, exactly like two separate per-event commits would:
    // 1 -[deltaY -100]-> 1.2 -[deltaY -100]-> 1.4. (Summing the raw deltas first —
    // exp(0.0015 * 200) ≈ 1.35 → snapped 1.3 — would silently diverge from that.)
    await waitFor(() => expect(screen.getByTestId("files-zoom")).toHaveTextContent("1.4"));
  });

  it("replays a same-frame burst that crosses the max content-zoom bound like separate commits", async () => {
    // Regression for the clamp-boundary divergence: summing deltaY before clamping loses
    // the fact that the first step already saturated CONTENT_MAX_ZOOM (2.0), so a second,
    // smaller step in the same frame must ease back down FROM the clamped value (1.9), not
    // from a hypothetical higher unclamped total. Sequentially: 1.9 -[-300]-> 2.0 -[+40]->
    // 1.9. Summing first (-260 in one exp() call) never reaches the cap and lands on 2.0.
    const callbacks = mockAnimationFrames();
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow({ zoom: 1.9 })]));
    render(<Harness />);
    mockWorkspaceRect();

    await waitFor(() => expect(screen.getByTestId("files-zoom")).toHaveTextContent("1.9"));
    const scheduledBefore = callbacks.length;

    fireContentZoomWheel(-300);
    fireContentZoomWheel(40);

    expect(callbacks.length - scheduledBefore).toBe(1);
    callbacks[scheduledBefore]?.(0);

    await waitFor(() => expect(screen.getByTestId("files-zoom")).toHaveTextContent("1.9"));
  });

  it("preserves the wins identity when a content-zoom step does not change the snapped zoom", async () => {
    const callbacks = mockAnimationFrames();
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness />);
    mockWorkspaceRect();

    await waitFor(() => expect(screen.getByTestId("files-zoom")).toHaveTextContent("1"));
    const identityBefore = screen.getByTestId("wins-identity-changes").textContent;
    const scheduledBefore = callbacks.length;

    // Zero delta: exp(0) = 1, the snapped zoom cannot change.
    fireContentZoomWheel(0);
    callbacks[scheduledBefore]?.(0);

    expect(screen.getByTestId("files-zoom")).toHaveTextContent("1");
    expect(screen.getByTestId("wins-identity-changes")).toHaveTextContent(identityBefore ?? "");
  });

  it("marks the workspace view-active so the wallpaper shader pauses during content zoom", async () => {
    mockAnimationFrames();
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify([appWindow()]));
    render(<Harness />);
    mockWorkspaceRect();

    await waitFor(() => expect(screen.getByTestId("files-zoom")).toHaveTextContent("1"));
    expect(screen.getByTestId("workspace").dataset["viewActive"]).toBeUndefined();

    fireContentZoomWheel(-100);

    expect(screen.getByTestId("workspace").dataset["viewActive"]).toBe("true");
  });
});
