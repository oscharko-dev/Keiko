import { useRef, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import { useWorkspace } from "./useWorkspace";
import type { UseWorkspaceResult } from "./useWorkspace.types";
import type { AppWindow } from "../windows/types";

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
