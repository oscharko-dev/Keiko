import { describe, expect, it } from "vitest";

import {
  activeWorkspaceBindingsForContext,
  bindingFromKeyboardEvent,
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
    expect(activeWorkspaceBindingsForContext(registry, "global")).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "o", mod: ["cmd", "shift"] },
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
});
