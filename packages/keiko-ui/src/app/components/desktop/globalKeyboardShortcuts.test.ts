import { describe, expect, it } from "vitest";

import {
  activeGlobalWorkspaceBindings,
  resolveGlobalKeyboardShortcuts,
  shortcutLabel,
} from "./globalKeyboardShortcuts";

describe("globalKeyboardShortcuts", () => {
  it("resolves the shell default shortcuts without loading the full editor registry", () => {
    const registry = resolveGlobalKeyboardShortcuts([]);
    expect(registry.commands.map((entry) => [entry.command.id, entry.binding])).toEqual([
      ["undo", "CtrlOrMeta+Z"],
      ["redo", "CtrlOrMeta+Shift+Z"],
      ["focus-status", "Alt+S"],
      ["focus-workspace-search", "CtrlOrMeta+Shift+F"],
      ["quick-access.files", "CtrlOrMeta+P"],
      ["quick-access.commands", "CtrlOrMeta+Shift+P"],
    ]);
    expect(activeGlobalWorkspaceBindings(registry)).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "p", mod: ["cmd"] },
    });
  });

  it("applies validated global overrides and ignores editor-only override records", () => {
    const registry = resolveGlobalKeyboardShortcuts([
      "1|quick-access.files|CtrlOrMeta+Shift+O",
      "1|view.splitRight|CtrlOrMeta+\\",
    ]);
    expect(
      registry.commands.find((entry) => entry.command.id === "quick-access.files"),
    ).toMatchObject({
      binding: "CtrlOrMeta+Shift+O",
    });
    expect(activeGlobalWorkspaceBindings(registry)).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "o", mod: ["cmd", "shift"] },
    });
  });

  it("falls back to defaults when shortcut overrides are malformed", () => {
    const registry = resolveGlobalKeyboardShortcuts(["not-a-valid-override"]);
    expect(
      registry.commands.find((entry) => entry.command.id === "quick-access.files"),
    ).toMatchObject({
      binding: "CtrlOrMeta+P",
    });
  });

  it("formats platform shortcut labels", () => {
    expect(shortcutLabel("CtrlOrMeta+Shift+P", "mac")).toBe("⌘⇧P");
    expect(shortcutLabel("CtrlOrMeta+Shift+P", "other")).toBe("Ctrl+Shift+P");
  });
});
