// GEN-UI-A11Y-015 — the remove-connection badge arms on the first click and, if not confirmed,
// silently auto-disarms after a timeout. A screen-reader user gets no signal that the connection was
// NOT removed. One shared polite live region in the badge layer now announces the auto-cancellation,
// and ONLY the timeout revert path drives it (a user-initiated confirm/blur disarm stays silent).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsLayer } from "./ConnectionsLayer";
import type { AppWindow, Connection } from "./types";
import type { WorkspaceApi } from "../hooks/useWorkspace.types";

function appWindow(patch: Partial<AppWindow> & Pick<AppWindow, "id" | "type">): AppWindow {
  return {
    x: 0,
    y: 0,
    w: 100,
    h: 100,
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
    currentView: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
    ...patch,
  };
}

// Two windows far enough apart that the edge-midpoint badge does not land under either window rect,
// so the badge renders and is clickable.
const wins: readonly AppWindow[] = [
  appWindow({ id: "chat-1", type: "chat", x: 0, y: 0 }),
  appWindow({ id: "files-1", type: "files", x: 1000, y: 0 }),
];
const conns: readonly Connection[] = [{ id: "c-1", a: "chat-1", b: "files-1" }];

function removeBadge(): HTMLElement {
  return screen.getByRole("button", { name: /remove connection/i });
}

describe("ConnectionsLayer — GEN-UI-A11Y-015 auto-disarm announcement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders one shared polite status region in the badge layer", () => {
    render(<ConnectionsLayer wins={wins} conns={conns} connecting={null} api={api()} />);
    const statuses = document.querySelectorAll('[role="status"][aria-live="polite"]');
    expect(statuses).toHaveLength(1);
    // Empty until an auto-disarm fires.
    expect(statuses[0]?.textContent).toBe("");
  });

  it("announces when an armed removal silently auto-disarms", () => {
    render(<ConnectionsLayer wins={wins} conns={conns} connecting={null} api={api()} />);

    // Arm the removal (first click) but never confirm.
    act(() => {
      fireEvent.click(removeBadge());
    });
    const status = document.querySelector('[role="status"][aria-live="polite"]');
    expect(status?.textContent).toBe("");

    // Advance past the arm timeout so the silent revert fires.
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(status?.textContent).toContain("Removal cancelled");
    expect(status?.textContent).toContain("the connection was not removed");
  });

  it("does not announce on a user-initiated (confirm) disarm — the removal actually happened", () => {
    const value = api();
    render(<ConnectionsLayer wins={wins} conns={conns} connecting={null} api={value} />);

    // The badge element is reused across the arm→confirm re-render (stable React key), so a single
    // captured reference stays valid even though the accessible name flips to "Confirm removal …".
    const badge = removeBadge();
    // First click arms, second click within the window confirms (user-initiated disarm + remove).
    act(() => {
      fireEvent.click(badge);
    });
    act(() => {
      fireEvent.click(badge);
    });

    expect(value.removeConn).toHaveBeenCalledWith("c-1");
    const status = document.querySelector('[role="status"][aria-live="polite"]');
    expect(status?.textContent).toBe("");

    // Advancing time must not resurrect a stale "cancelled" announcement for the confirmed removal.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(status?.textContent).toBe("");
  });
});
