// Epic #518 / Issue #527 — useKeyboardShortcuts contract tests.
//
// Pins ADR-0028's keyboard substrate properties:
//   (a) Conflict-at-startup: two bindings claiming the same chord throw
//       WorkspaceShortcutConflictError.
//   (b) Reserved-chord refusal: bindings claiming a browser-reserved
//       chord throw WorkspaceShortcutReservedError.
//   (c) Platform normalization: "cmd" maps to metaKey on mac, ctrlKey
//       on other platforms.
//   (d) Modifier matching is exact: Ctrl+K does NOT match Ctrl+Shift+K.

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceKeyboardShortcutBinding } from "@oscharko-dev/keiko-contracts";
import {
  detectReservedBindings,
  detectShortcutConflicts,
  useKeyboardShortcuts,
  WorkspaceShortcutConflictError,
  WorkspaceShortcutReservedError,
} from "./useKeyboardShortcuts";

function bind(id: string, key: string, mod: string[] = []): WorkspaceKeyboardShortcutBinding {
  return {
    commandId: id,
    chord: { key, mod: mod as never },
  };
}

describe("useKeyboardShortcuts — pure helpers", () => {
  it("detectShortcutConflicts surfaces two bindings claiming the same chord", () => {
    const conflicts = detectShortcutConflicts([bind("a", "k", ["ctrl"]), bind("b", "k", ["ctrl"])]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.commandIds).toEqual(["a", "b"]);
  });

  it("detectShortcutConflicts returns empty when chords differ by modifier", () => {
    const conflicts = detectShortcutConflicts([
      bind("a", "k", ["ctrl"]),
      bind("b", "k", ["ctrl", "shift"]),
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it("detectReservedBindings flags Cmd+T as reserved", () => {
    const reserved = detectReservedBindings([
      bind("newTab", "t", ["cmd"]),
      bind("ok", "k", ["cmd"]),
    ]);
    expect(reserved).toHaveLength(1);
    expect(reserved[0]?.commandId).toBe("newTab");
  });

  it("detectReservedBindings flags Ctrl+R as reserved", () => {
    const reserved = detectReservedBindings([bind("reload", "r", ["ctrl"])]);
    expect(reserved).toHaveLength(1);
  });
});

describe("useKeyboardShortcuts — substrate contract", () => {
  it("throws WorkspaceShortcutConflictError when two bindings share a chord", () => {
    const dispatch = vi.fn();
    expect(() =>
      renderHook(() =>
        useKeyboardShortcuts({
          bindings: [bind("a", "k", ["ctrl"]), bind("b", "k", ["ctrl"])],
          dispatch,
        }),
      ),
    ).toThrow(WorkspaceShortcutConflictError);
  });

  it("throws WorkspaceShortcutReservedError on browser-reserved chord", () => {
    const dispatch = vi.fn();
    expect(() =>
      renderHook(() =>
        useKeyboardShortcuts({
          bindings: [bind("newTab", "t", ["cmd"])],
          dispatch,
        }),
      ),
    ).toThrow(WorkspaceShortcutReservedError);
  });

  it("dispatches the bound command when a matching keydown fires (cmd → meta on mac)", () => {
    const dispatch = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        bindings: [bind("palette", "k", ["cmd"])],
        dispatch,
        platform: "mac",
      }),
    );
    const event = new KeyboardEvent("keydown", { key: "k", metaKey: true });
    window.dispatchEvent(event);
    expect(dispatch).toHaveBeenCalledWith("palette");
  });

  it("dispatches the bound command when a matching keydown fires (cmd → ctrl on non-mac)", () => {
    const dispatch = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        bindings: [bind("palette", "k", ["cmd"])],
        dispatch,
        platform: "other",
      }),
    );
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true });
    window.dispatchEvent(event);
    expect(dispatch).toHaveBeenCalledWith("palette");
  });

  it("does NOT dispatch when modifiers do not exactly match (Ctrl+K vs Ctrl+Shift+K)", () => {
    const dispatch = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        bindings: [bind("palette", "k", ["ctrl"])],
        dispatch,
        platform: "other",
      }),
    );
    const event = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      shiftKey: true,
    });
    window.dispatchEvent(event);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does NOT dispatch when the keydown originates from an editable field", () => {
    const dispatch = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        bindings: [bind("undo", "z", ["cmd"])],
        dispatch,
        platform: "other",
      }),
    );
    const input = document.createElement("input");
    document.body.appendChild(input);
    const event = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
    });
    input.dispatchEvent(event);
    expect(dispatch).not.toHaveBeenCalled();
    input.remove();
  });

  it("returns the bindings, no conflicts, no reserved entries on a clean config", () => {
    const dispatch = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardShortcuts({
        bindings: [bind("palette", "k", ["ctrl"]), bind("close", "w", ["ctrl"])],
        dispatch,
        platform: "other",
      }),
    );
    expect(result.current.conflicts).toHaveLength(0);
    expect(result.current.reserved).toHaveLength(0);
    expect(result.current.bindings).toHaveLength(2);
  });
});
