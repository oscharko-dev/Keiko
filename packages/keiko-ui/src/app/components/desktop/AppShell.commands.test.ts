// Epic #518 / Issue #526–#527 — AppShell command list integration test.
//
// Pins the AppShell-level command palette contract:
//   - Card / Tool / Layout / View commands present per the existing
//     workspace product.
//   - Undo and Redo commands wired from the substrate (#527 / ADR-0028).
//   - Undo/Redo labels reflect the typed undoLabel/redoLabel from the
//     undo stack and fall back to the boundary tooltip when the stack
//     is empty.
//   - Running the Undo command delegates to the undo stack's undo();
//     the Redo command delegates to redo().

import { describe, expect, it, vi } from "vitest";
import type { WorkspaceUndoStackApi } from "@oscharko-dev/keiko-contracts";
import { buildAppShellCommands } from "./AppShell";
import type { WorkspaceApi } from "./hooks/useWorkspace.types";

function fakeApi(): WorkspaceApi {
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
    linkedFilesContext: vi.fn(() => null),
    currentFilesContext: vi.fn(() => null),
    zoomTo: vi.fn(),
    resetView: vi.fn(),
    panBy: vi.fn(),
    rect: vi.fn(() => null),
  };
}

function fakeUndoStack(overrides: Partial<WorkspaceUndoStackApi> = {}): WorkspaceUndoStackApi {
  return {
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    push: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  };
}

describe("buildAppShellCommands — command palette contract (epic #518 #526 #527)", () => {
  it("includes a New <card-type> command for every CARD_TYPES entry", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    const newCommands = commands.filter((c) => c.id.startsWith("new-"));
    expect(newCommands.length).toBeGreaterThanOrEqual(8);
    expect(newCommands.find((c) => c.id === "new-chat")).toBeDefined();
    expect(newCommands.find((c) => c.id === "new-files")).toBeDefined();
    expect(newCommands.find((c) => c.id === "new-review")).toBeDefined();
  });

  it("includes Tile / Split / Cascade / Theme commands", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    const ids = new Set(commands.map((c) => c.id));
    expect(ids.has("tile")).toBe(true);
    expect(ids.has("split")).toBe(true);
    expect(ids.has("cascade")).toBe(true);
    expect(ids.has("theme")).toBe(true);
  });

  it("surfaces Undo and Redo commands from the substrate", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    expect(commands.find((c) => c.id === "undo")).toBeDefined();
    expect(commands.find((c) => c.id === "redo")).toBeDefined();
  });

  it("falls back to the boundary tooltip when the undo stack is empty", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    const undo = commands.find((c) => c.id === "undo");
    expect(undo?.label).toBe("Undo (window and panel changes only)");
    const redo = commands.find((c) => c.id === "redo");
    expect(redo?.label).toBe("Redo (window and panel changes only)");
  });

  it("renders the typed action label when the undo stack has an entry", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack({ canUndo: true, undoLabel: "Toggle project panel" }),
    );
    const undo = commands.find((c) => c.id === "undo");
    expect(undo?.label).toBe("Undo: Toggle project panel");
  });

  it("running the Undo command delegates to the undo stack", () => {
    const stack = fakeUndoStack();
    const commands = buildAppShellCommands(fakeApi(), vi.fn(), vi.fn(), "dark", vi.fn(), stack);
    const undo = commands.find((c) => c.id === "undo");
    undo?.run();
    expect(stack.undo).toHaveBeenCalledTimes(1);
  });

  it("running the Redo command delegates to the undo stack", () => {
    const stack = fakeUndoStack();
    const commands = buildAppShellCommands(fakeApi(), vi.fn(), vi.fn(), "dark", vi.fn(), stack);
    const redo = commands.find((c) => c.id === "redo");
    redo?.run();
    expect(stack.redo).toHaveBeenCalledTimes(1);
  });

  it("Edit group commands (undo/redo) are categorised under 'Edit'", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    const undo = commands.find((c) => c.id === "undo");
    const redo = commands.find((c) => c.id === "redo");
    expect(undo?.group).toBe("Edit");
    expect(redo?.group).toBe("Edit");
  });

  it("routes tool commands through the shared toggle handler so undo instrumentation stays intact", () => {
    const onTool = vi.fn();
    const commands = buildAppShellCommands(
      fakeApi(),
      onTool,
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    const project = commands.find((c) => c.id === "open-project");
    project?.run();
    expect(onTool).toHaveBeenCalledWith("project");
  });
});
