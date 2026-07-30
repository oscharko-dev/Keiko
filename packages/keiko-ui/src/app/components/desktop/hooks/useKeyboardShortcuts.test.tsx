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
  SHELL_CHORD_BYPASS_ATTRIBUTE,
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

function withExpectedShortcutRenderError(assertion: () => void): void {
  const onError = (event: ErrorEvent): void => {
    const message = event.error instanceof Error ? event.error.message : event.message;
    if (message.includes("Workspace keyboard shortcut")) event.preventDefault();
  };
  window.addEventListener("error", onError);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    assertion();
  } finally {
    errorSpy.mockRestore();
    window.removeEventListener("error", onError);
  }
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

  it("detectReservedBindings flags Cmd+W as reserved (ADR-0028 §4 — closes tab)", () => {
    const reserved = detectReservedBindings([bind("closePanel", "w", ["cmd"])]);
    expect(reserved).toHaveLength(1);
    expect(reserved[0]?.commandId).toBe("closePanel");
  });

  it("detectReservedBindings flags Ctrl+W as reserved (ADR-0028 §4 — closes tab)", () => {
    const reserved = detectReservedBindings([bind("closePanel", "w", ["ctrl"])]);
    expect(reserved).toHaveLength(1);
    expect(reserved[0]?.commandId).toBe("closePanel");
  });
});

describe("useKeyboardShortcuts — substrate contract", () => {
  it("throws WorkspaceShortcutConflictError when two bindings share a chord", () => {
    const dispatch = vi.fn();
    withExpectedShortcutRenderError(() => {
      expect(() =>
        renderHook(() =>
          useKeyboardShortcuts({
            bindings: [bind("a", "k", ["ctrl"]), bind("b", "k", ["ctrl"])],
            dispatch,
          }),
        ),
      ).toThrow(WorkspaceShortcutConflictError);
    });
  });

  it("throws WorkspaceShortcutReservedError on browser-reserved chord", () => {
    const dispatch = vi.fn();
    withExpectedShortcutRenderError(() => {
      expect(() =>
        renderHook(() =>
          useKeyboardShortcuts({
            bindings: [bind("newTab", "t", ["cmd"])],
            dispatch,
          }),
        ),
      ).toThrow(WorkspaceShortcutReservedError);
    });
  });

  it("throws WorkspaceShortcutReservedError for Cmd+W (ADR-0028 §4 — closes tab)", () => {
    const dispatch = vi.fn();
    withExpectedShortcutRenderError(() => {
      expect(() =>
        renderHook(() =>
          useKeyboardShortcuts({
            bindings: [bind("closePanel", "w", ["cmd"])],
            dispatch,
          }),
        ),
      ).toThrow(WorkspaceShortcutReservedError);
    });
  });

  it("throws WorkspaceShortcutReservedError for Ctrl+W (ADR-0028 §4 — closes tab)", () => {
    const dispatch = vi.fn();
    withExpectedShortcutRenderError(() => {
      expect(() =>
        renderHook(() =>
          useKeyboardShortcuts({
            bindings: [bind("closePanel", "w", ["ctrl"])],
            dispatch,
          }),
        ),
      ).toThrow(WorkspaceShortcutReservedError);
    });
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

  it("dispatches an alt-letter chord when macOS Option-composition transforms event.key (C125)", () => {
    // On macOS, Option+S produces event.key "ß" while event.code stays "KeyS".
    // The chord { key: "s", mod: ["alt"] } (focus-status) must still match.
    const dispatch = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        bindings: [bind("focus-status", "s", ["alt"])],
        dispatch,
        platform: "mac",
      }),
    );
    const event = new KeyboardEvent("keydown", { key: "ß", code: "KeyS", altKey: true });
    window.dispatchEvent(event);
    expect(dispatch).toHaveBeenCalledWith("focus-status");
  });

  it("does NOT match an alt-letter chord against a different physical key", () => {
    const dispatch = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        bindings: [bind("focus-status", "s", ["alt"])],
        dispatch,
        platform: "mac",
      }),
    );
    // Option+D → "∂" on macOS; code KeyD must not match the "s" chord.
    const event = new KeyboardEvent("keydown", { key: "∂", code: "KeyD", altKey: true });
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
        bindings: [bind("palette", "k", ["ctrl"]), bind("jump", "j", ["ctrl"])],
        dispatch,
        platform: "other",
      }),
    );
    expect(result.current.conflicts).toHaveLength(0);
    expect(result.current.reserved).toHaveLength(0);
    expect(result.current.bindings).toHaveLength(2);
  });
});

// Audit — the editable-target guard above suppressed EVERY chord inside a text field, which left
// Cmd/Ctrl+P, Cmd/Ctrl+Shift+P and Cmd/Ctrl+Shift+F dead in the chat composer (the product's primary
// input). A field that carries SHELL_CHORD_BYPASS_ATTRIBUTE opts into the forwarding rule instead:
// Cmd/Ctrl chords reach the shell, but the chords the field's own text editing owns
// (Cmd/Ctrl+Z / +Shift+Z / +Y / +X / +C / +V / +A), Alt-composed chords and plain keys do not.
describe("useKeyboardShortcuts — opted-in text fields (SHELL_CHORD_BYPASS_ATTRIBUTE)", () => {
  function optedInField(): HTMLTextAreaElement {
    const field = document.createElement("textarea");
    field.setAttribute(SHELL_CHORD_BYPASS_ATTRIBUTE, "");
    document.body.appendChild(field);
    return field;
  }

  function fireFrom(field: HTMLElement, init: KeyboardEventInit): void {
    field.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
  }

  it("forwards the quick-access and workspace-search chords from an opted-in field", () => {
    const dispatch = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        bindings: [
          bind("quick-access.files", "p", ["cmd"]),
          bind("quick-access.commands", "p", ["cmd", "shift"]),
          bind("focus-workspace-search", "f", ["cmd", "shift"]),
        ],
        dispatch,
        platform: "mac",
      }),
    );
    const field = optedInField();

    fireFrom(field, { key: "p", metaKey: true });
    fireFrom(field, { key: "p", metaKey: true, shiftKey: true });
    fireFrom(field, { key: "f", metaKey: true, shiftKey: true });

    expect(dispatch.mock.calls.map(([id]) => id)).toEqual([
      "quick-access.files",
      "quick-access.commands",
      "focus-workspace-search",
    ]);
    field.remove();
  });

  it("keeps Cmd+Z and Cmd+Shift+Z with the field so they undo the user's typing", () => {
    const dispatch = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        bindings: [bind("undo", "z", ["cmd"]), bind("redo", "z", ["cmd", "shift"])],
        dispatch,
        platform: "mac",
      }),
    );
    const field = optedInField();

    fireFrom(field, { key: "z", metaKey: true });
    fireFrom(field, { key: "z", metaKey: true, shiftKey: true });

    expect(dispatch).not.toHaveBeenCalled();
    field.remove();
  });

  it("keeps an Alt chord with the field (Option composes characters in a text field)", () => {
    const dispatch = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        bindings: [bind("focus-status", "s", ["alt"])],
        dispatch,
        platform: "mac",
      }),
    );
    const field = optedInField();

    fireFrom(field, { key: "ß", code: "KeyS", altKey: true });

    expect(dispatch).not.toHaveBeenCalled();
    field.remove();
  });

  it("still suppresses the same chord in a text field that did NOT opt in", () => {
    const dispatch = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        bindings: [bind("quick-access.files", "p", ["cmd"])],
        dispatch,
        platform: "mac",
      }),
    );
    const field = document.createElement("textarea");
    document.body.appendChild(field);

    fireFrom(field, { key: "p", metaKey: true });

    expect(dispatch).not.toHaveBeenCalled();
    field.remove();
  });

  it("honours the marker on an ancestor of the focused field", () => {
    const dispatch = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        bindings: [bind("quick-access.files", "p", ["cmd"])],
        dispatch,
        platform: "mac",
      }),
    );
    const wrapper = document.createElement("div");
    wrapper.setAttribute(SHELL_CHORD_BYPASS_ATTRIBUTE, "");
    const field = document.createElement("input");
    wrapper.appendChild(field);
    document.body.appendChild(wrapper);

    fireFrom(field, { key: "p", metaKey: true });

    expect(dispatch).toHaveBeenCalledWith("quick-access.files");
    wrapper.remove();
  });
});
