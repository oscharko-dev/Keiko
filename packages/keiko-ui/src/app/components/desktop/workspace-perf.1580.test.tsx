/**
 * Issue #1580 — performance regression guards for the workspace canvas.
 *
 * These tests lock in the memoization contract introduced to stop the per-frame
 * re-render storm reported when several windows are open:
 *  - a pan/zoom frame (only `view` changes) must re-render ZERO window bodies;
 *  - dragging one window must re-render ONLY that window;
 *  - a change to the cross-window link context (a connection, or any window's cfg)
 *    MUST re-render the dependent windows, so memoization never serves stale
 *    linked* context (the correctness counterpart to the optimization).
 * They also pin the two enablers: a referentially stable `api` and the
 * `api.currentView()` accessor that replaced the per-frame `view` prop.
 */
import { createRef } from "react";
import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "./Workspace";
import { useWorkspace } from "./hooks/useWorkspace";
import { registerWindowRender } from "./windows/WindowsRegistry";
import type { UseWorkspaceResult, WorkspaceApi } from "./hooks/useWorkspace.types";
import type { AppWindow, Connection, View } from "./windows/types";

vi.mock("./WorkspaceShader", () => ({ WorkspaceShader: () => null }));

function makeApi(view: View): WorkspaceApi {
  return {
    add: vi.fn(() => null),
    openEditorFile: vi.fn(() => ({ ok: false as const, message: "x" })),
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
    linkedFilesContext: vi.fn(() => null),
    linkedAllFilesRoots: vi.fn(() => []),
    linkedConnectorCapsuleIds: vi.fn(() => []),
    linkedConnectorCapsuleSetIds: vi.fn(() => []),
    linkedFigmaSnapshotRunIds: vi.fn(() => []),
    currentFilesContext: vi.fn(() => null),
    zoomTo: vi.fn(),
    fitView: vi.fn(),
    resetView: vi.fn(),
    panBy: vi.fn(),
    rect: vi.fn(() => null),
    currentView: () => view,
  };
}

function appWindow(patch: Partial<AppWindow> & Pick<AppWindow, "id" | "type">): AppWindow {
  return { x: 40, y: 40, w: 480, h: 420, z: 1, cfg: {}, max: false, zoom: 1, ...patch };
}

function workspace(api: WorkspaceApi, partial: Partial<UseWorkspaceResult>): UseWorkspaceResult {
  const wins = partial.wins ?? [];
  return {
    wins,
    winsById: new Map(wins.map((win) => [win.id, win])),
    snapPrev: null,
    palOpen: false,
    setPalOpen: vi.fn(),
    conns: [],
    connecting: null,
    view: { x: 0, y: 0, zoom: 1 },
    api,
    ...partial,
  };
}

describe("Issue #1580 — workspace re-render performance", () => {
  let bodyRenders: string[];
  let capturedRoots: { id: string; root: string | null }[];

  beforeEach(() => {
    bodyRenders = [];
    capturedRoots = [];
    // The body render fn runs exactly once per WindowFrame BODY rebuild, so its
    // call log is a faithful proxy for "which window bodies actually rebuilt".
    registerWindowRender("agents", (_cfg, ctx) => {
      const id = String(ctx.windowId);
      bodyRenders.push(id);
      capturedRoots.push({ id, root: (ctx as { linkedRoot?: string | null }).linkedRoot ?? null });
      return null;
    });
  });

  function renderWorkspace(ws: UseWorkspaceResult) {
    const wsRef = createRef<HTMLDivElement>();
    const openPalette = (): void => undefined;
    const result = render(<Workspace ws={ws} wsRef={wsRef} openPalette={openPalette} />);
    // wsRef is a WindowFrame prop; reuse it across rerenders so it stays stable.
    const rerender = (next: UseWorkspaceResult): void => {
      result.rerender(<Workspace ws={next} wsRef={wsRef} openPalette={openPalette} />);
    };
    return { rerender };
  }

  it("does not re-render any window when only the view (pan/zoom) changes", () => {
    const api = makeApi({ x: 0, y: 0, zoom: 1 });
    const wins = [
      appWindow({ id: "agents-1", type: "agents" }),
      appWindow({ id: "agents-2", type: "agents", x: 600 }),
    ];
    const conns: Connection[] = [];
    const ws = workspace(api, { wins, conns });
    const { rerender } = renderWorkspace(ws);

    expect([...bodyRenders].sort()).toEqual(["agents-1", "agents-2"]);
    bodyRenders.length = 0;

    // A pan/zoom frame: only `view` changes; wins/conns/api keep their identity.
    rerender({ ...ws, view: { x: -120, y: -80, zoom: 1.4 } });

    expect(bodyRenders).toEqual([]);
  });

  it("rebuilds no window body when a window is dragged (geometry-only change)", () => {
    const api = makeApi({ x: 0, y: 0, zoom: 1 });
    const win1 = appWindow({ id: "agents-1", type: "agents" });
    const win2 = appWindow({ id: "agents-2", type: "agents", x: 600 });
    const ws = workspace(api, { wins: [win1, win2] });
    const { rerender } = renderWorkspace(ws);
    bodyRenders.length = 0;

    // Drag agents-1: a new object for the moved window, the other untouched. The
    // other window stays fully memoized AND the dragged window's body is memoized
    // on its content (cfg/size), not its position — so no body subtree rebuilds.
    rerender({ ...ws, wins: [{ ...win1, x: 99 }, win2] });

    expect(bodyRenders).toEqual([]);
  });

  it("rebuilds only the changed window's body when its cfg changes", () => {
    const api = makeApi({ x: 0, y: 0, zoom: 1 });
    const win1 = appWindow({ id: "agents-1", type: "agents" });
    const win2 = appWindow({ id: "agents-2", type: "agents", x: 600 });
    const ws = workspace(api, { wins: [win1, win2] });
    const { rerender } = renderWorkspace(ws);
    bodyRenders.length = 0;

    // Resize agents-1 (w changes → ew changes → body breakpoints may change) AND
    // change its cfg: its body rebuilds; agents-2 is untouched. (Note: a cfg change
    // bumps linkRevision, but agents-2's body inputs are unchanged so its body
    // memo still holds — only agents-1 rebuilds.)
    rerender({ ...ws, wins: [{ ...win1, cfg: { note: "x" } }, win2] });

    expect(bodyRenders).toEqual(["agents-1"]);
  });

  it("refreshes a window's linked context when ANOTHER window changes (no stale context)", () => {
    // Stateful linked resolver: agents-1 derives its grounding root from a connected
    // source, which we flip mid-flight. The api object stays referentially stable.
    let currentRoot: string | null = "root-A";
    const api: WorkspaceApi = {
      ...makeApi({ x: 0, y: 0, zoom: 1 }),
      linkedFilesRoot: vi.fn(() => currentRoot),
    };
    const win1 = appWindow({ id: "agents-1", type: "agents" });
    const win2 = appWindow({ id: "agents-2", type: "agents", x: 600 });
    const ws = workspace(api, { wins: [win1, win2] });
    const { rerender } = renderWorkspace(ws);

    expect(capturedRoots.filter((r) => r.id === "agents-1").pop()?.root).toBe("root-A");
    bodyRenders.length = 0;
    capturedRoots.length = 0;

    // Flip the linked root AND mutate agents-2's cfg (bumps linkRevision). agents-1
    // is otherwise untouched, yet its body MUST rebuild with the fresh "root-B" —
    // serving the memoized stale "root-A" would silently drop cross-window context.
    currentRoot = "root-B";
    rerender({ ...ws, wins: [win1, { ...win2, cfg: { note: "x" } }] });

    expect(bodyRenders).toContain("agents-1");
    expect(capturedRoots.filter((r) => r.id === "agents-1").pop()?.root).toBe("root-B");
  });
});

describe("Issue #1580 — stable api identity and currentView accessor", () => {
  beforeEach(() => {
    // Disable server sync so the hook does not fetch during the test.
    Object.defineProperty(navigator, "webdriver", { configurable: true, value: true });
  });

  it("keeps a referentially stable api across re-renders", () => {
    const wsRef = createRef<HTMLElement>();
    const { result, rerender } = renderHook(() => useWorkspace(wsRef));
    const firstApi = result.current.api;
    rerender();
    expect(result.current.api).toBe(firstApi);
  });

  it("exposes the live view through api.currentView()", () => {
    const wsRef = createRef<HTMLElement>();
    const { result } = renderHook(() => useWorkspace(wsRef));
    expect(result.current.api.currentView()).toEqual(result.current.view);
  });
});

describe("Issue #1580 — scene zoom rendering mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("composites with transform:scale during a zoom gesture, then snaps to crisp CSS zoom", () => {
    const api = makeApi({ x: 10, y: 20, zoom: 1 });
    const wins = [appWindow({ id: "agents-1", type: "agents" })];
    const ws = workspace(api, { wins, view: { x: 10, y: 20, zoom: 1 } });
    const wsRef = createRef<HTMLDivElement>();
    const openPalette = (): void => undefined;
    const { container, rerender } = render(
      <Workspace ws={ws} wsRef={wsRef} openPalette={openPalette} />,
    );
    const scene = (): HTMLElement => {
      const el = container.querySelector<HTMLElement>(".ws-scene");
      if (el === null) throw new Error("scene not found");
      return el;
    };

    // At rest: crisp CSS zoom, no scale().
    expect(scene().style.zoom).toBe("1");
    expect(scene().style.transform).not.toContain("scale(");

    // Zoom changes → gesture active → compositor transform:scale, CSS zoom dropped.
    act(() => {
      rerender(
        <Workspace
          ws={{ ...ws, view: { x: 10, y: 20, zoom: 1.4 } }}
          wsRef={wsRef}
          openPalette={openPalette}
        />,
      );
    });
    expect(scene().style.zoom).toBe("");
    expect(scene().style.transform).toContain("scale(1.4)");

    // ~160ms after the last zoom change → snap back to crisp CSS zoom.
    act(() => {
      vi.advanceTimersByTime(220);
    });
    expect(scene().style.zoom).toBe("1.4");
    expect(scene().style.transform).not.toContain("scale(");
  });
});
