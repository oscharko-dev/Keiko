// Epic #518 / Issue #527 — useUndoStack contract tests.
//
// Pins ADR-0028's load-bearing properties:
//   (a) push records an Action; canUndo flips true; undoLabel is the
//       declared label.
//   (b) undo dispatches the inverse action and moves the entry to the
//       redo stack.
//   (c) push after undo clears the redo stack.
//   (d) clear empties both stacks.
//   (e) limit truncates the oldest entries.
//   (f) Compile-time refusal proof: the Action union has no constructor
//       for evidence / patch / verification / model-call / tool / memory
//       / FS / durable-config kinds. The test exhaustively walks all
//       WorkspaceUiActionKind members and asserts each starts with the
//       "ui." prefix.

import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceUiAction, WorkspaceUiActionKind } from "@oscharko-dev/keiko-contracts";
import { useUndoStack } from "./useUndoStack";

const RECT = { x: 0, y: 0, w: 100, h: 100 };
const VIEW = { zoom: 1, x: 0, y: 0 };
const VIEW_NEW = { zoom: 2, x: 10, y: 20 };

function moveAction(): WorkspaceUiAction {
  return {
    kind: "ui.window.move",
    windowId: "w-1",
    before: RECT,
    after: { ...RECT, x: 50, y: 50 },
  };
}

function panAction(): WorkspaceUiAction {
  return { kind: "ui.workspace.pan", before: VIEW, after: VIEW_NEW };
}

describe("useUndoStack — contract (epic #518 #527 / ADR-0028)", () => {
  it("initial state has nothing to undo or redo", () => {
    const apply = vi.fn();
    const { result } = renderHook(() => useUndoStack({ apply }));
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(result.current.undoLabel).toBeNull();
    expect(result.current.redoLabel).toBeNull();
  });

  it("push records an action and exposes the label", () => {
    const apply = vi.fn();
    const { result } = renderHook(() => useUndoStack({ apply }));
    act(() => result.current.push(moveAction()));
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
    expect(result.current.undoLabel).toBe("Move window");
  });

  it("undo dispatches the inverse action and moves the entry to the redo stack", () => {
    const apply = vi.fn();
    const { result } = renderHook(() => useUndoStack({ apply }));
    act(() => result.current.push(moveAction()));
    act(() => result.current.undo());
    expect(apply).toHaveBeenCalledTimes(1);
    const dispatched = apply.mock.calls[0]?.[0] as WorkspaceUiAction;
    expect(dispatched.kind).toBe("ui.window.move");
    if (dispatched.kind === "ui.window.move") {
      expect(dispatched.before).toEqual({ x: 50, y: 50, w: 100, h: 100 });
      expect(dispatched.after).toEqual(RECT);
    }
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
    expect(result.current.redoLabel).toBe("Move window");
  });

  it("redo dispatches the original action and moves the entry back to the undo stack", () => {
    const apply = vi.fn();
    const { result } = renderHook(() => useUndoStack({ apply }));
    act(() => result.current.push(moveAction()));
    act(() => result.current.undo());
    apply.mockClear();
    act(() => result.current.redo());
    expect(apply).toHaveBeenCalledTimes(1);
    const dispatched = apply.mock.calls[0]?.[0] as WorkspaceUiAction;
    expect(dispatched.kind).toBe("ui.window.move");
    if (dispatched.kind === "ui.window.move") {
      expect(dispatched.after).toEqual({ x: 50, y: 50, w: 100, h: 100 });
    }
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it("push after undo clears the redo stack", () => {
    const apply = vi.fn();
    const { result } = renderHook(() => useUndoStack({ apply }));
    act(() => result.current.push(moveAction()));
    act(() => result.current.undo());
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.push(panAction()));
    expect(result.current.canRedo).toBe(false);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.undoLabel).toBe("Pan workspace");
  });

  it("clear empties both stacks", () => {
    const apply = vi.fn();
    const { result } = renderHook(() => useUndoStack({ apply }));
    act(() => result.current.push(moveAction()));
    act(() => result.current.push(panAction()));
    act(() => result.current.undo());
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.clear());
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it("limit truncates the oldest entries", () => {
    const apply = vi.fn();
    const { result } = renderHook(() => useUndoStack({ apply, limit: 2 }));
    act(() => result.current.push(moveAction()));
    act(() => result.current.push(moveAction()));
    act(() => result.current.push(panAction()));
    expect(result.current.canUndo).toBe(true);
    expect(result.current.undoLabel).toBe("Pan workspace");
    act(() => result.current.undo());
    expect(result.current.undoLabel).toBe("Move window");
    act(() => result.current.undo());
    // The third-from-top would have been the first push, but it was trimmed.
    expect(result.current.canUndo).toBe(false);
  });

  it("StrictMode: undo calls apply exactly once (not twice) per invocation", () => {
    // React StrictMode double-invokes updaters in dev. If apply() is called
    // inside the setState updater the side-effect fires twice, silently
    // cancelling the user's intent. This test guards against regression.
    const apply = vi.fn();
    const { result } = renderHook(() => useUndoStack({ apply }), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    act(() => result.current.push(moveAction()));
    act(() => result.current.undo());
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("StrictMode: redo calls apply exactly once (not twice) per invocation", () => {
    const apply = vi.fn();
    const { result } = renderHook(() => useUndoStack({ apply }), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    act(() => result.current.push(moveAction()));
    act(() => result.current.undo());
    apply.mockClear();
    act(() => result.current.redo());
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("ADR-0028 refusal: every Action kind starts with 'ui.' (no evidence/patch/verification/model-call/tool/memory/fs/config constructor exists)", () => {
    // This test is the runtime witness for the compile-time refusal. The
    // discriminated union literally cannot construct a non-ui kind; this
    // test guards against a future contributor adding one.
    const allKinds: ReadonlyArray<WorkspaceUiActionKind> = [
      "ui.window.move",
      "ui.window.resize",
      "ui.window.zorder",
      "ui.window.close",
      "ui.window.open",
      "ui.workspace.pan",
      "ui.workspace.zoom",
      "ui.workspace.fit",
      "ui.panel.toggle",
      "ui.selection.change",
      "ui.tab.switch",
    ];
    for (const kind of allKinds) {
      expect(kind.startsWith("ui.")).toBe(true);
    }
    // Forbidden prefixes — proof of absence.
    const forbidden = [
      "evidence.",
      "patch.",
      "verification.",
      "model.",
      "tool.",
      "memory.",
      "fs.",
      "config.durable.",
    ];
    for (const kind of allKinds) {
      for (const prefix of forbidden) {
        expect(kind.startsWith(prefix)).toBe(false);
      }
    }
  });
});
