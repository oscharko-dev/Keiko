import { useRef } from "react";
import type { ReactElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function Harness(): ReactElement {
  const wsRef = useRef<HTMLDivElement>(null);
  const ws = useWorkspace(wsRef);
  const files = ws.wins?.find((win) => win.id === "files-1");

  return (
    <main ref={wsRef} data-testid="workspace" className="workspace">
      <section className="window" data-window-id="files-1">
        <div data-testid="window-target" />
      </section>
      <output data-testid="files-zoom">{files?.zoom ?? "missing"}</output>
      <output data-testid="view-zoom">{ws.view.zoom}</output>
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
});
