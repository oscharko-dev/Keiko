import { describe, expect, it } from "vitest";

import { isWorkspaceReservedChord, workspaceChordKey } from "@oscharko-dev/keiko-contracts";
import {
  bindingFromKeyboardEvent,
  bindingToWorkspaceChord,
  dispatchableWorkspaceShortcutsForContext,
  removeKeyboardShortcutOverride,
  resolveEffectiveKeyboardShortcuts,
  shortcutLabel,
  updateKeyboardShortcutOverride,
} from "./keyboardShortcutsRegistry";

describe("keyboardShortcutsRegistry", () => {
  it("builds one effective command model from defaults and M7 overrides", () => {
    const updated = updateKeyboardShortcutOverride({
      current: [],
      commandId: "quick-access.files",
      binding: "CtrlOrMeta+Shift+O",
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("expected override");

    const registry = resolveEffectiveKeyboardShortcuts(updated.value);
    const files = registry.commands.find((entry) => entry.command.id === "quick-access.files");

    expect(registry.status).toEqual({ kind: "ready" });
    expect(files).toMatchObject({
      binding: "CtrlOrMeta+Shift+O",
      source: "user",
      modified: true,
    });
    expect(dispatchableWorkspaceShortcutsForContext(registry, "global")).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "o", mod: ["cmd", "shift"] },
      binding: "CtrlOrMeta+Shift+O",
    });
  });

  it("fails closed for malformed, protected, reserved, modifier-only, and colliding overrides", () => {
    expect(
      resolveEffectiveKeyboardShortcuts(["99|quick-access.files|CtrlOrMeta+O"]).status,
    ).toEqual({ kind: "fallback", reasonCode: "SCHEMA_VERSION_UNSUPPORTED" });
    expect(
      updateKeyboardShortcutOverride({
        current: [],
        commandId: "editor.save",
        binding: "CtrlOrMeta+Shift+S",
      }),
    ).toMatchObject({ ok: false, reasonCode: "POLICY_LOCKED" });
    expect(
      updateKeyboardShortcutOverride({
        current: [],
        commandId: "quick-access.files",
        binding: "CtrlOrMeta+Q",
      }),
    ).toMatchObject({ ok: false, reasonCode: "RESERVED_KEYBINDING" });
    expect(
      updateKeyboardShortcutOverride({
        current: [],
        commandId: "quick-access.files",
        binding: "CtrlOrMeta+Shift",
      }),
    ).toMatchObject({ ok: false, reasonCode: "INVALID_INPUT" });
    expect(
      updateKeyboardShortcutOverride({
        current: [],
        commandId: "quick-access.files",
        binding: "CtrlOrMeta+Shift+P",
      }),
    ).toMatchObject({ ok: false, reasonCode: "KEYBINDING_COLLISION" });
  });

  it("removes overrides without dropping the last valid set on corrupt input", () => {
    const updated = updateKeyboardShortcutOverride({
      current: [],
      commandId: "quick-access.files",
      binding: "CtrlOrMeta+Shift+O",
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("expected override");

    expect(removeKeyboardShortcutOverride(updated.value, "quick-access.files")).toEqual([]);
    expect(removeKeyboardShortcutOverride(["bad-record"], "quick-access.files")).toEqual([]);
  });

  it("captures layout-safe bindings and renders platform labels", () => {
    const event = new KeyboardEvent("keydown", {
      altKey: true,
      code: "KeyS",
      key: "ß",
    });
    expect(bindingFromKeyboardEvent(event)).toBe("Alt+S");
    expect(shortcutLabel("CtrlOrMeta+Alt+R", "mac")).toBe("⌘⌥R");
    expect(shortcutLabel("CtrlOrMeta+Alt+R", "other")).toBe("Ctrl+Alt+R");
  });

  it("replaces overrides, maps workspace chords, and rejects unsupported key events", () => {
    const first = updateKeyboardShortcutOverride({
      current: [],
      commandId: "quick-access.files",
      binding: "Shift+CtrlOrMeta+O",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected first override");

    const replaced = updateKeyboardShortcutOverride({
      current: first.value,
      commandId: "quick-access.files",
      binding: "Alt+CtrlOrMeta+O",
    });

    expect(replaced).toMatchObject({ ok: true, value: ["1|quick-access.files|CtrlOrMeta+Alt+O"] });
    expect(bindingToWorkspaceChord("CtrlOrMeta+Alt+ArrowLeft")).toEqual({
      key: "arrowleft",
      mod: ["cmd", "alt"],
    });
    expect(bindingToWorkspaceChord("CtrlOrMeta")).toBeNull();
    expect(bindingFromKeyboardEvent(new KeyboardEvent("keydown", { key: "Control" }))).toBeNull();
    expect(bindingFromKeyboardEvent(new KeyboardEvent("keydown", { key: "Escape" }))).toBe("Esc");
    expect(bindingFromKeyboardEvent(new KeyboardEvent("keydown", { key: " " }))).toBe("Space");
    expect(bindingFromKeyboardEvent(new KeyboardEvent("keydown", { key: "F12" }))).toBe("F12");
    expect(bindingFromKeyboardEvent(new KeyboardEvent("keydown", { key: "😀" }))).toBeNull();
  });

  it("rejects unknown and duplicate modifiers when projecting workspace chords", () => {
    expect(bindingToWorkspaceChord("Foo+ArrowLeft")).toBeNull();
    expect(bindingToWorkspaceChord("Alt+Alt+ArrowLeft")).toBeNull();
    expect(bindingToWorkspaceChord("CtrlOrMeta+Ctrl+ArrowLeft")).toBeNull();
  });
});

// The dispatch-safe projection is the one place that decides which persisted binding reaches
// `useKeyboardShortcuts`, which fails closed by THROWING in render on a reserved or duplicated
// chord. Every case below is a persisted-settings shape that used to reach it.
describe("dispatchableWorkspaceShortcutsForContext", () => {
  function globalShortcuts(
    overrides: readonly string[],
  ): ReadonlyMap<string, { readonly chord: string; readonly binding: string }> {
    const registry = resolveEffectiveKeyboardShortcuts(overrides);
    return new Map(
      dispatchableWorkspaceShortcutsForContext(registry, "global").map((entry) => [
        entry.commandId,
        { chord: workspaceChordKey(entry.chord), binding: entry.binding },
      ]),
    );
  }

  it("keeps every default global binding and reports the binding it dispatches", () => {
    const shortcuts = globalShortcuts([]);

    expect(shortcuts.get("undo")).toEqual({ chord: "cmd|z", binding: "CtrlOrMeta+Z" });
    expect(shortcuts.get("focus-status")).toEqual({ chord: "alt|s", binding: "Alt+S" });
  });

  it("applies a validated override and reports its binding for labelling", () => {
    const shortcuts = globalShortcuts(["1|quick-access.files|CtrlOrMeta+Shift+O"]);

    expect(shortcuts.get("quick-access.files")).toEqual({
      chord: "cmd+shift|o",
      binding: "CtrlOrMeta+Shift+O",
    });
  });

  it.each([
    ["1|undo|CtrlOrMeta+T", "undo", "cmd|z"],
    ["1|focus-status|Ctrl+T", "focus-status", "alt|s"],
    ["1|focus-status|Meta+Z", "focus-status", "alt|s"],
    ["not-a-record", "undo", "cmd|z"],
  ])("ignores the refused override %s and falls back to the default", (override, id, chord) => {
    expect(globalShortcuts([override]).get(id)?.chord).toBe(chord);
  });

  it("never lets an override take a chord away from a command that did not ask for one", () => {
    const shortcuts = globalShortcuts(["1|focus-status|Meta+Z"]);

    expect(shortcuts.get("undo")?.chord).toBe("cmd|z");
    expect(shortcuts.size).toBe(6);
  });

  it("emits no reserved and no duplicated chord for any persisted input", () => {
    for (const overrides of [
      [],
      ["1|undo|CtrlOrMeta+T"],
      ["1|focus-status|Ctrl+T"],
      ["1|focus-status|Meta+Z"],
      ["1|undo|Meta+W", "1|redo|Ctrl+R"],
      ["", "1|", "1|undo|", "1|undo|CtrlOrMeta"],
    ]) {
      const registry = resolveEffectiveKeyboardShortcuts(overrides);
      for (const context of ["global", "editor", "settings", "explorer"] as const) {
        const shortcuts = dispatchableWorkspaceShortcutsForContext(registry, context);
        const chordKeys = shortcuts.map((entry) => workspaceChordKey(entry.chord));

        expect(shortcuts.filter((entry) => isWorkspaceReservedChord(entry.chord))).toEqual([]);
        expect(new Set(chordKeys).size).toBe(chordKeys.length);
      }
    }
  });
});
