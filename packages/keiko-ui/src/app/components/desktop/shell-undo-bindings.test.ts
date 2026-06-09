// Epic #518 / Issue #527 — shell-level undo apply dispatcher + shortcut
// binding integration tests.
//
// These pin the AppShell wiring:
//   - applyShellUndoAction delegates a ui.panel.toggle action to
//     api.toggleTool with the recorded panel id.
//   - applyShellUndoAction is a no-op for action kinds not yet wired.
//   - The shell-level shortcut binding table claims exactly two chords
//     (Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z = redo) and neither collides
//     with the existing Cmd+K palette toggle.
//   - The binding table contains no browser-reserved chords (verified by
//     re-running detectReservedBindings from the keyboard substrate).
//   - The binding table contains no internal conflict.

import { describe, expect, it, vi } from "vitest";
import { workspaceChordKey, type WorkspaceUiAction } from "@oscharko-dev/keiko-contracts";
import { applyShellUndoAction, SHELL_SHORTCUT_BINDINGS } from "./shell-undo-bindings";
import { detectReservedBindings, detectShortcutConflicts } from "./hooks/useKeyboardShortcuts";
import type { WorkspaceApi } from "./hooks/useWorkspace.types";

function fakeApi(overrides: Partial<WorkspaceApi> = {}): WorkspaceApi {
  return {
    add: vi.fn(() => null),
    toggleTool: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
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
    connect: vi.fn(),
    linkedFilesRoot: vi.fn(() => null),
    linkedAllFilesRoots: vi.fn(() => []),
    linkedConnectorCapsuleIds: vi.fn(() => []),
    linkedFilesContext: vi.fn(() => null),
    currentFilesContext: vi.fn(() => null),
    zoomTo: vi.fn(),
    resetView: vi.fn(),
    panBy: vi.fn(),
    rect: vi.fn(() => null),
    ...overrides,
  };
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
    applyShellUndoAction(api, action);
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
    applyShellUndoAction(api, action);
    expect(api.toggleTool).not.toHaveBeenCalled();
  });

  it("is a no-op for action kinds the shell does not yet wire (forward-compatible)", () => {
    const api = fakeApi();
    const action: WorkspaceUiAction = {
      kind: "ui.workspace.pan",
      before: { zoom: 1, x: 0, y: 0 },
      after: { zoom: 1, x: 10, y: 20 },
    };
    applyShellUndoAction(api, action);
    expect(api.toggleTool).not.toHaveBeenCalled();
    expect(api.panBy).not.toHaveBeenCalled();
  });
});

describe("SHELL_SHORTCUT_BINDINGS — keyboard binding table", () => {
  it("claims undo, redo, and footer-status focus chords", () => {
    expect(SHELL_SHORTCUT_BINDINGS).toHaveLength(3);
    const ids = SHELL_SHORTCUT_BINDINGS.map((b) => b.commandId);
    expect(ids).toEqual(["undo", "redo", "focus-status"]);
  });

  it("uses Cmd+Z, Cmd+Shift+Z, and Alt+S", () => {
    const map = new Map(SHELL_SHORTCUT_BINDINGS.map((b) => [b.commandId, b.chord]));
    expect(map.get("undo")).toEqual({ key: "z", mod: ["cmd"] });
    expect(map.get("redo")).toEqual({ key: "z", mod: ["cmd", "shift"] });
    expect(map.get("focus-status")).toEqual({ key: "s", mod: ["alt"] });
  });

  it("does NOT claim the Cmd+K chord that the inline palette handler owns", () => {
    const cmdK = workspaceChordKey({ key: "k", mod: ["cmd"] });
    const claimed = SHELL_SHORTCUT_BINDINGS.map((b) => workspaceChordKey(b.chord));
    expect(claimed).not.toContain(cmdK);
  });

  it("contains no browser-reserved chord", () => {
    expect(detectReservedBindings(SHELL_SHORTCUT_BINDINGS)).toEqual([]);
  });

  it("contains no internal chord conflict", () => {
    expect(detectShortcutConflicts(SHELL_SHORTCUT_BINDINGS)).toEqual([]);
  });
});
