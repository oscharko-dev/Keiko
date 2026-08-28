// Epic #518 / Issue #527 — shell-level undo apply dispatcher tests.
//
// These pin the AppShell wiring:
//   - applyShellUndoAction moves a ui.panel.toggle panel INTO the recorded
//     state, and is a no-op when the panel already holds it (audit: the old
//     state-dependent toggle diverged from the record).
//   - A Search open replays with its recorded workspace root.
//   - A Git open replays with its recorded project root.
//   - applyShellUndoAction is a no-op for action kinds not yet wired.
//   - shellPanelIsOpen is the single openness rule both sides of undo read.
//
// The shell's keyboard binding table is NOT pinned here: it lives in
// shellShortcutState.ts (the table AppShell actually dispatches), and its
// reserved/conflict pins live in shellShortcutState.test.ts next to it. The
// hardcoded copy that used to sit in shell-undo-bindings.ts was read by nothing.

import { describe, expect, it, vi } from "vitest";
import type { WorkspaceUiAction } from "@oscharko-dev/keiko-contracts";
import {
  applyShellUndoAction,
  shellPanelIsOpen,
  type ShellUndoTarget,
} from "./shell-undo-bindings";
import type { AppWindow } from "./windows/types";
import type { WorkspaceApi } from "./hooks/useWorkspace.types";
import { cutResult } from "../../../test-utils/workspace-clipboard-fixture";

function fakeApi(overrides: Partial<WorkspaceApi> = {}): WorkspaceApi {
  return {
    add: vi.fn(() => null),
    openEditorFile: vi.fn(() => ({ ok: false as const, message: "Unable to open editor." })),
    toggleTool: vi.fn(),
    focus: vi.fn(),
    currentSelection: vi.fn(() => ({ focusedWindowId: null, selectedWindowIds: [] })),
    replaceSelection: vi.fn(),
    toggleWindowSelection: vi.fn(),
    clearSelection: vi.fn(),
    moveSelectedWindowsBy: vi.fn(() => ({ dx: 0, dy: 0 })),
    copySelectedWindows: vi.fn(() => ({ captured: 0, skipped: 0, overflow: 0 })),
    cutSelectedWindows: vi.fn(() => cutResult({ captured: 0, skipped: 0, overflow: 0 })),
    pasteCopiedWindows: vi.fn(() => ({ pasted: 0, limitReached: false })),
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
    ...overrides,
  };
}

// `open` is the LIVE panel state the dispatcher compares the recorded state against.
function target(open: boolean, api: WorkspaceApi = fakeApi()): ShellUndoTarget {
  return { api, isPanelOpen: () => open };
}

function panelWindow(patch: Partial<AppWindow> & Pick<AppWindow, "id" | "type">): AppWindow {
  return { x: 0, y: 0, w: 400, h: 300, z: 1, cfg: {}, max: false, ...patch };
}

describe("applyShellUndoAction — AppShell undo wiring (epic #518 #527 / ADR-0028)", () => {
  it("delegates ui.panel.toggle to api.toggleTool with the recorded panel id", () => {
    const api = fakeApi();
    const action: WorkspaceUiAction = {
      kind: "ui.panel.toggle",
      panel: "project",
      before: false,
      after: true,
    };
    applyShellUndoAction(target(false, api), action);
    expect(api.toggleTool).toHaveBeenCalledTimes(1);
    expect(api.toggleTool).toHaveBeenCalledWith("project");
  });

  it("replays a Search open with its recorded workspace root", (): void => {
    const api = fakeApi();
    const action: WorkspaceUiAction = {
      kind: "ui.panel.toggle",
      panel: "search",
      before: false,
      after: true,
      searchRoot: "/repo/a",
    };

    applyShellUndoAction(target(false, api), action);

    expect(api.add).toHaveBeenCalledWith("search", { root: "/repo/a" });
    expect(api.toggleTool).not.toHaveBeenCalled();
  });

  it("uses the normal toggle when replaying a legacy rootless Search open", (): void => {
    const api = fakeApi();
    const action: WorkspaceUiAction = {
      kind: "ui.panel.toggle",
      panel: "search",
      before: false,
      after: true,
    };

    applyShellUndoAction(target(false, api), action);

    expect(api.toggleTool).toHaveBeenCalledWith("search");
    expect(api.add).not.toHaveBeenCalled();
  });

  it("replays an explicitly rootless Search open without inheriting a stale root", (): void => {
    const api = fakeApi();
    const action: WorkspaceUiAction = {
      kind: "ui.panel.toggle",
      panel: "search",
      before: false,
      after: true,
      searchRoot: undefined,
    };

    applyShellUndoAction(target(false, api), action);

    expect(api.add).toHaveBeenCalledWith("search", { root: undefined });
    expect(api.toggleTool).not.toHaveBeenCalled();
  });

  it("replays a Git open with its recorded project root", (): void => {
    const api = fakeApi();
    const action: WorkspaceUiAction = {
      kind: "ui.panel.toggle",
      panel: "governedGit",
      before: false,
      after: true,
      projectRoot: "/repo/a",
    };

    applyShellUndoAction(target(false, api), action);

    expect(api.add).toHaveBeenCalledWith("governedGit", {
      projectPath: "/repo/a",
      rootBinding: "coding-repository",
    });
    expect(api.toggleTool).not.toHaveBeenCalled();
  });

  it("replays an explicitly rootless Git open without inheriting a stale project", (): void => {
    const api = fakeApi();
    const action: WorkspaceUiAction = {
      kind: "ui.panel.toggle",
      panel: "governedGit",
      before: false,
      after: true,
      projectRoot: undefined,
    };

    applyShellUndoAction(target(false, api), action);

    expect(api.add).toHaveBeenCalledWith("governedGit", {
      projectPath: undefined,
      rootBinding: undefined,
    });
    expect(api.toggleTool).not.toHaveBeenCalled();
  });

  it("uses the normal toggle when undo closes a rooted Git window", (): void => {
    const api = fakeApi();
    const action: WorkspaceUiAction = {
      kind: "ui.panel.toggle",
      panel: "governedGit",
      before: true,
      after: false,
      projectRoot: "/repo/a",
    };

    applyShellUndoAction(target(true, api), action);

    expect(api.toggleTool).toHaveBeenCalledWith("governedGit");
    expect(api.add).not.toHaveBeenCalled();
  });

  it("uses the normal toggle when undo closes a rooted Search", (): void => {
    const api = fakeApi();
    const action: WorkspaceUiAction = {
      kind: "ui.panel.toggle",
      panel: "search",
      before: true,
      after: false,
      searchRoot: "/repo/a",
    };

    applyShellUndoAction(target(true, api), action);

    expect(api.toggleTool).toHaveBeenCalledWith("search");
    expect(api.add).not.toHaveBeenCalled();
  });

  // Audit — the regression the state-dependent toggle produced. Open the panel through the tool
  // seam (records before:false/after:true), then close it by hand: undo's inverse action records
  // "closed", the live panel is already closed, and the old unconditional toggleTool RE-OPENED it.
  it("is a no-op when the panel already holds the recorded CLOSED state", () => {
    const api = fakeApi();
    const inverseOfOpen: WorkspaceUiAction = {
      kind: "ui.panel.toggle",
      panel: "project",
      before: true,
      after: false,
    };

    applyShellUndoAction(target(false, api), inverseOfOpen);

    expect(api.toggleTool).not.toHaveBeenCalled();
    expect(api.add).not.toHaveBeenCalled();
  });

  // Mirror case on the redo side: undo closed the panel, the user re-opened it by hand, redo
  // records "open" — the old toggle CLOSED the panel the user had just opened.
  it("is a no-op when the panel already holds the recorded OPEN state", () => {
    const api = fakeApi();
    const redoOfOpen: WorkspaceUiAction = {
      kind: "ui.panel.toggle",
      panel: "project",
      before: false,
      after: true,
    };

    applyShellUndoAction(target(true, api), redoOfOpen);

    expect(api.toggleTool).not.toHaveBeenCalled();
    expect(api.add).not.toHaveBeenCalled();
  });

  it("does not re-add a rooted Search that is already open", () => {
    const api = fakeApi();
    const action: WorkspaceUiAction = {
      kind: "ui.panel.toggle",
      panel: "search",
      before: false,
      after: true,
      searchRoot: "/repo/a",
    };

    applyShellUndoAction(target(true, api), action);

    expect(api.add).not.toHaveBeenCalled();
    expect(api.toggleTool).not.toHaveBeenCalled();
  });

  it("closes a panel that is open while the record says closed", () => {
    const api = fakeApi();
    const action: WorkspaceUiAction = {
      kind: "ui.panel.toggle",
      panel: "project",
      before: true,
      after: false,
    };

    applyShellUndoAction(target(true, api), action);

    expect(api.toggleTool).toHaveBeenCalledTimes(1);
    expect(api.toggleTool).toHaveBeenCalledWith("project");
  });

  it("ignores ui.panel.toggle actions for unknown panel ids", () => {
    const api = fakeApi();
    const action: WorkspaceUiAction = {
      kind: "ui.panel.toggle",
      panel: "not-a-window-type",
      before: false,
      after: true,
    };
    applyShellUndoAction(target(false, api), action);
    expect(api.toggleTool).not.toHaveBeenCalled();
  });

  it("is a no-op for action kinds the shell does not yet wire (forward-compatible)", () => {
    const api = fakeApi();
    const action: WorkspaceUiAction = {
      kind: "ui.workspace.pan",
      before: { zoom: 1, x: 0, y: 0 },
      after: { zoom: 1, x: 10, y: 20 },
    };
    applyShellUndoAction(target(false, api), action);
    expect(api.toggleTool).not.toHaveBeenCalled();
    expect(api.panBy).not.toHaveBeenCalled();
  });
});

describe("shellPanelIsOpen — the one openness rule both sides of undo read", () => {
  it("reports open for a present, non-minimized panel window", () => {
    expect(shellPanelIsOpen([panelWindow({ id: "project", type: "project" })], "project")).toBe(
      true,
    );
  });

  it("reports closed for a minimized panel window (the tool seam restores it)", () => {
    expect(
      shellPanelIsOpen(
        [panelWindow({ id: "project", type: "project", minimized: true })],
        "project",
      ),
    ).toBe(false);
  });

  it("reports closed when no window of that type exists, and for an unhydrated workspace", () => {
    expect(shellPanelIsOpen([panelWindow({ id: "chat-1", type: "chat" })], "project")).toBe(false);
    expect(shellPanelIsOpen(null, "project")).toBe(false);
  });
});
