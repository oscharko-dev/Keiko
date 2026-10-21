import { useRef, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import { useWorkspace } from "./useWorkspace";
import type { UseWorkspaceResult } from "./useWorkspace.types";
import type { AppWindow } from "../windows/types";
import { WIN_TYPES } from "../windows/WindowsRegistry";

const WS_LS = "keiko.workspace.v4";
let latest: UseWorkspaceResult | undefined;
const diagnostic = vi.fn();

function remoteWindows(): AppWindow[] {
  const floating: AppWindow = {
    id: "agents-floating",
    type: "agents",
    x: 40,
    y: 50,
    w: 600,
    h: 450,
    z: 1,
    max: false,
    zoom: 1,
    cfg: { title: "Private window canary" },
  };
  return [
    {
      ...floating,
      id: "agents-max",
      max: true,
      x: 0,
      y: 0,
      w: 1236,
      h: 1194,
      prev: { x: 40, y: 50, w: 600, h: 450 },
    },
    floating,
  ];
}

function Harness(): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  latest = useWorkspace(ref);
  return <main ref={ref} />;
}

function emitStorage(): void {
  const event = new Event("storage");
  Object.defineProperties(event, {
    key: { value: WS_LS },
    storageArea: { value: window.localStorage },
  });
  window.dispatchEvent(event);
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  Object.defineProperty(navigator, "webdriver", { configurable: true, value: true });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1280, 720),
  );
  diagnostic.mockClear();
  setClientDiagnosticWriter(diagnostic);
  latest = undefined;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetClientDiagnosticWriter();
  Object.defineProperty(navigator, "webdriver", { configurable: true, value: true });
});

function expectLocalGeometry(): void {
  expect(latest?.wins?.[0]).toMatchObject({ x: -0, y: -0, w: 1280, h: 720, max: true });
  expect(latest?.wins?.[0]?.prev).toEqual(remoteWindows()[0]?.prev);
  expect(latest?.wins?.[1]).toEqual({ ...remoteWindows()[1], cfg: {} });
  expect(diagnostic).toHaveBeenCalledWith(
    "Workspace maximized geometry fitted to local viewport.",
    {
      composerActivity: "workspace-viewport-fitted",
    },
  );
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("Private window canary");
}

describe("workspace maximized viewport adaptation", () => {
  it("fits a restored maximized window without changing its restore geometry", () => {
    window.localStorage.setItem(WS_LS, JSON.stringify(remoteWindows()));
    render(<Harness />);
    expectLocalGeometry();
    act(() => latest?.api.maximize("agents-max"));
    expect(latest?.wins?.[0]).toMatchObject({ x: 40, y: 50, w: 600, h: 450, max: false });
  });

  it("fits a sibling-tab snapshot without a resize or a storage echo", async () => {
    render(<Harness />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    window.localStorage.setItem(WS_LS, JSON.stringify(remoteWindows()));
    const writes = vi.spyOn(Storage.prototype, "setItem");
    act(emitStorage);
    expectLocalGeometry();
    const applied = latest?.wins;
    act(emitStorage);
    expect(latest?.wins).toBe(applied);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(writes.mock.calls.filter(([key]) => key === WS_LS)).toEqual([]);
  });

  it("fits a server snapshot without echoing the local dimensions on poll or pagehide", async () => {
    Object.defineProperty(navigator, "webdriver", { configurable: true, value: false });
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(
          JSON.stringify({
            workspace: { revision: 7, windows: remoteWindows(), connections: [] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<Harness />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expectLocalGeometry();
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(
      fetcher.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "PUT"),
    ).toEqual([]);
  });
});

describe("fresh local window viewport adaptation", () => {
  function prepareResize(): () => void {
    let resize = (): void => undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    return (): void => {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
        new DOMRect(0, 0, 1280, 540),
      );
      act(resize);
    };
  }

  function codingWindow(): AppWindow {
    const window = latest?.wins?.find((entry) => entry.type === "coding");
    if (window === undefined) throw new Error("Expected coding window");
    return window;
  }

  function openCodingWindow(): void {
    render(<Harness />);
    act(() => latest?.api.toggleTool("coding"));
    expect(codingWindow().h).toBe(WIN_TYPES.coding.h);
  }

  it("keeps a fresh tool frame visible after a late work-area reduction", () => {
    const resize = prepareResize();
    openCodingWindow();
    resize();
    const fitted = codingWindow();
    expect(fitted.y + fitted.h).toBeLessThanOrEqual(540);
    expect(fitted.max).toBe(false);
    expect(diagnostic).toHaveBeenCalledWith("Workspace window fitted to available space.", {
      composerActivity: "workspace-viewport-fitted",
    });
  });

  it("retains automatic fitting through focus and configuration changes", () => {
    const resize = prepareResize();
    openCodingWindow();
    act(() => {
      latest?.api.focus("coding");
      latest?.api.update("coding", { cfg: { projectPath: "Private project canary" } });
    });
    resize();
    const fitted = codingWindow();
    expect(fitted.y + fitted.h).toBeLessThanOrEqual(540);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("Private project canary");
  });

  it("preserves a deliberate human resize", () => {
    const resize = prepareResize();
    openCodingWindow();
    act(() => latest?.api.update("coding", { w: 1000, h: 680 }));
    resize();
    expect(codingWindow()).toMatchObject({ w: 1000, h: 680, max: false });
  });

  it("preserves a deliberate human move", () => {
    const resize = prepareResize();
    openCodingWindow();
    act(() => latest?.api.update("coding", { x: 100, y: 50 }));
    resize();
    expect(codingWindow()).toMatchObject({ x: 100, y: 50, h: WIN_TYPES.coding.h });
  });

  it("keeps repeated viewport observations as identity-preserving no-ops", () => {
    const resize = prepareResize();
    openCodingWindow();
    resize();
    const fitted = latest?.wins;
    diagnostic.mockClear();
    resize();
    expect(latest?.wins).toBe(fitted);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it("preserves a saved floating layout", () => {
    const resize = prepareResize();
    window.localStorage.setItem(
      WS_LS,
      JSON.stringify([{ ...remoteWindows()[1], id: "coding", type: "coding", h: 680 }]),
    );
    render(<Harness />);
    resize();
    expect(codingWindow()).toMatchObject({ h: 680, max: false });
  });

  it("relinquishes automatic sizing when a sibling snapshot replaces equal geometry", () => {
    const resize = prepareResize();
    openCodingWindow();
    const previous = codingWindow();
    window.localStorage.setItem(WS_LS, JSON.stringify([{ ...previous, z: 200 }]));
    act(emitStorage);
    expect(codingWindow().z).toBe(200);
    expect(diagnostic).toHaveBeenCalledWith(
      "Workspace automatic sizing retired for restored layout.",
      { composerActivity: "workspace-window-sizing-retired" },
    );
    resize();
    expect(codingWindow()).toMatchObject({ w: previous.w, h: previous.h });
  });

  it.each([
    { external: false, label: "retains local fitting after an own server PUT acknowledgement" },
    { external: true, label: "relinquishes local fitting after an equal-geometry server snapshot" },
  ])("$label", async ({ external }) => {
    const resize = prepareResize();
    Object.defineProperty(navigator, "webdriver", { configurable: true, value: false });
    let revision = 0;
    let incoming: AppWindow[] = [];
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (init?.method === "PUT") {
          revision += 1;
          return new Response(JSON.stringify({ workspace: { revision } }));
        }
        return new Response(
          JSON.stringify({ workspace: { revision, windows: incoming, connections: [] } }),
        );
      },
    );
    vi.stubGlobal("fetch", fetcher);
    openCodingWindow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1);
    const previous = codingWindow();
    if (external) {
      incoming = [{ ...previous, z: 200 }];
      revision += 1;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
      expect(codingWindow().z).toBe(200);
    }
    resize();
    if (external) expect(codingWindow()).toMatchObject({ w: previous.w, h: previous.h });
    else expect(codingWindow().y + codingWindow().h).toBeLessThanOrEqual(540);
  });
});
