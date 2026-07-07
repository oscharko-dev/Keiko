/**
 * STEP 07 cluster B — GEN-PERF-WORKSPACE-003 + GEN-PERF-WORKSPACE-002.
 *
 *  - WORKSPACE-003: the four window-level drop-handler effects must bind their
 *    listeners ONCE and not tear down + re-add them on every pan/zoom view change
 *    (their add*Node callbacks now read `view` through a ref instead of closing over
 *    it, so they stay identity-stable across view frames).
 *  - WORKSPACE-002: the pdf-citation registry sync must NOT re-run on a geometry-only
 *    drag frame (wins identity churns) — only when window membership / a read field
 *    actually changes.
 */
import { createRef } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "./Workspace";
import type { UseWorkspaceResult, WorkspaceApi } from "./hooks/useWorkspace.types";
import type { AppWindow, View } from "./windows/types";

vi.mock("./WorkspaceShader", () => ({ WorkspaceShader: () => null }));

const syncSpy = vi.fn();
vi.mock("./widgets/cards/pdf-citation-preview-session", () => ({
  syncPdfCitationPreviewWindowRegistry: (wins: unknown) => syncSpy(wins),
}));

const DROP_EVENTS = [
  "keiko:local-knowledge-connector-drop",
  "keiko:figma-view-drop",
  "keiko:figma-json-drop",
  "keiko:figma-image-drop",
] as const;

function makeApi(view: View): WorkspaceApi {
  return {
    add: vi.fn(() => null),
    openEditorFile: vi.fn(() => ({ ok: false as const, message: "x" })),
    toggleTool: vi.fn(),
    focus: vi.fn(),
    currentSelection: vi.fn(() => ({ focusedWindowId: null, selectedWindowIds: [] })),
    replaceSelection: vi.fn(),
    toggleWindowSelection: vi.fn(),
    clearSelection: vi.fn(),
    moveSelectedWindowsBy: vi.fn(() => ({ dx: 0, dy: 0 })),
    copySelectedWindows: vi.fn(() => false),
    pasteCopiedWindows: vi.fn(() => false),
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
  } as unknown as WorkspaceApi;
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
    selection: { focusedWindowId: null, selectedWindowIds: [] },
    view: { x: 0, y: 0, zoom: 1 },
    api,
    ...partial,
  };
}

describe("Workspace drop-listener / registry perf (STEP 07 cluster B)", () => {
  beforeEach(() => {
    syncSpy.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("binds the four drop listeners once and does not re-add them on view changes (WORKSPACE-003)", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const api = makeApi({ x: 0, y: 0, zoom: 1 });
    const wins = [appWindow({ id: "agents-1", type: "agents" })];
    const ws = workspace(api, { wins });
    const wsRef = createRef<HTMLDivElement>();
    const { rerender } = render(<Workspace ws={ws} wsRef={wsRef} openPalette={() => undefined} />);

    const countAdds = (): number =>
      addSpy.mock.calls.filter(([type]) =>
        DROP_EVENTS.includes(type as (typeof DROP_EVENTS)[number]),
      ).length;
    const countRemoves = (): number =>
      removeSpy.mock.calls.filter(([type]) =>
        DROP_EVENTS.includes(type as (typeof DROP_EVENTS)[number]),
      ).length;

    const addsAfterMount = countAdds();
    expect(addsAfterMount).toBe(DROP_EVENTS.length);
    const removesAfterMount = countRemoves();

    // Several pan/zoom view frames: view identity changes each time.
    rerender(
      <Workspace
        ws={{ ...ws, view: { x: -40, y: -20, zoom: 1.2 } }}
        wsRef={wsRef}
        openPalette={() => undefined}
      />,
    );
    rerender(
      <Workspace
        ws={{ ...ws, view: { x: -80, y: -60, zoom: 1.5 } }}
        wsRef={wsRef}
        openPalette={() => undefined}
      />,
    );

    // The drop listeners must NOT have been re-added or torn down on view changes.
    expect(countAdds()).toBe(addsAfterMount);
    expect(countRemoves()).toBe(removesAfterMount);
  });

  it("does not re-sync the pdf registry on a geometry-only drag frame (WORKSPACE-002)", () => {
    const api = makeApi({ x: 0, y: 0, zoom: 1 });
    const win = appWindow({ id: "agents-1", type: "agents" });
    const ws = workspace(api, { wins: [win] });
    const wsRef = createRef<HTMLDivElement>();
    const { rerender } = render(<Workspace ws={ws} wsRef={wsRef} openPalette={() => undefined} />);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    syncSpy.mockClear();

    // Geometry-only drag: same id/type, moved x — new wins array identity.
    rerender(
      <Workspace
        ws={{ ...ws, wins: [{ ...win, x: 300 }] }}
        wsRef={wsRef}
        openPalette={() => undefined}
      />,
    );
    expect(syncSpy).not.toHaveBeenCalled();

    // Adding a window changes membership → the registry MUST re-sync exactly once.
    rerender(
      <Workspace
        ws={{ ...ws, wins: [win, appWindow({ id: "agents-2", type: "agents", x: 600 })] }}
        wsRef={wsRef}
        openPalette={() => undefined}
      />,
    );
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  it("accepts capsule-set connector drop events and creates connector windows", () => {
    const baseApi = makeApi({ x: 0, y: 0, zoom: 1 });
    const add = vi.fn<WorkspaceApi["add"]>(() => "connector-1");
    const update = vi.fn<WorkspaceApi["update"]>();
    const api: WorkspaceApi = { ...baseApi, add, update };
    const ws = workspace(api, { wins: [] });
    const wsRef = createRef<HTMLDivElement>();
    render(<Workspace ws={ws} wsRef={wsRef} openPalette={() => undefined} />);

    window.dispatchEvent(
      new CustomEvent("keiko:local-knowledge-connector-drop", {
        detail: {
          payload: {
            kind: "capsule-set",
            id: "set-release",
            label: "Release Readiness",
            lifecycleState: "degraded",
          },
          clientX: 0,
          clientY: 0,
        },
      }),
    );

    expect(add).toHaveBeenCalledWith("connector", {
      presentation: "node",
      selectedKind: "capsule-set",
      selectedId: "set-release",
      selectedLabel: "Release Readiness",
      selectedState: "degraded",
    });
    expect(update).toHaveBeenCalledWith("connector-1", expect.objectContaining({ w: 260, h: 220 }));
  });
});
