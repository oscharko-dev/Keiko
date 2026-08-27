import { describe, expect, it } from "vitest";

import type { EditorM7CommandDefinition } from "@oscharko-dev/keiko-contracts";
import { EDITOR_M7_COMMAND_REGISTRY } from "@oscharko-dev/keiko-contracts/runtime/editor-m7";
import {
  isWorkspaceDispatchableChord,
  isWorkspaceReservedChord,
  workspaceChordClaimKeys,
  workspaceChordKey,
} from "@oscharko-dev/keiko-contracts/runtime/workspace-ui";
import {
  bindingFromKeyboardEvent,
  bindingToWorkspaceChord,
  dispatchableWorkspaceShortcutsForContext,
  projectDispatchableWorkspaceShortcuts,
  removeKeyboardShortcutOverride,
  resolveEffectiveKeyboardShortcuts,
  shortcutLabel,
  updateKeyboardShortcutOverride,
  type EffectiveKeyboardShortcut,
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

  // 0.3.0 release audit (#2802): `CtrlOrMeta`, `Ctrl` and `Meta` collapse into the same two-value
  // chord vocabulary, so ANY two of them produce a chord the matcher cannot express. Only the
  // `CtrlOrMeta`+X pairs were refused; `Ctrl+Meta` produced mod ["ctrl","cmd"] and dispatched as
  // plain Ctrl off macOS.
  it.each([
    "Ctrl+Meta+T",
    "Meta+Ctrl+T",
    "ctrl+meta+t",
    "Ctrl+Meta+Alt+ArrowLeft",
    "CtrlOrMeta+Meta+O",
  ])("refuses the inexpressible ctrl+cmd chord %s", (binding) => {
    expect(bindingToWorkspaceChord(binding)).toBeNull();
  });

  it("keeps every single-side spelling projectable", () => {
    expect(bindingToWorkspaceChord("Ctrl+T")).toEqual({ key: "t", mod: ["ctrl"] });
    expect(bindingToWorkspaceChord("Meta+T")).toEqual({ key: "t", mod: ["cmd"] });
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
        const chordKeys = shortcuts.flatMap((entry) => workspaceChordClaimKeys(entry.chord));

        expect(shortcuts.filter((entry) => isWorkspaceReservedChord(entry.chord))).toEqual([]);
        expect(shortcuts.filter((entry) => !isWorkspaceDispatchableChord(entry.chord))).toEqual([]);
        expect(new Set(chordKeys).size).toBe(chordKeys.length);
      }
    }
  });
});

// The projection is the ONE fail-closed point for persisted data (ADR-0028 §4 amendment), and the
// refusal it reports is what keeps a drop from being a silent failure. The M7 parser in front of it
// is all-or-nothing and strictly stricter today, so these cases drive the projection directly — it
// is a public entry point that must hold on its own, and it is what a per-record parser would meet.
describe("projectDispatchableWorkspaceShortcuts — a refusal is reported, never silent", () => {
  function commandDefinition(id: string): EditorM7CommandDefinition {
    const command = EDITOR_M7_COMMAND_REGISTRY.find((entry) => entry.id === id);
    if (command === undefined) throw new TypeError(`unknown command ${id}`);
    return command;
  }

  function shortcut(args: {
    readonly id: string;
    readonly binding: string | null;
    readonly modified: boolean;
  }): EffectiveKeyboardShortcut {
    const command = commandDefinition(args.id);
    return {
      command,
      binding: args.binding,
      defaultBinding: command.defaultBindings[0] ?? null,
      source: args.modified ? "user" : "default",
      modified: args.modified,
      conflictCommandIds: [],
    };
  }

  function project(
    commands: readonly EffectiveKeyboardShortcut[],
  ): ReturnType<typeof projectDispatchableWorkspaceShortcuts> {
    return projectDispatchableWorkspaceShortcuts(
      { commands, activeBindings: [], status: { kind: "ready" } },
      "global",
    );
  }

  it.each([
    ["CtrlOrMeta+T", "RESERVED_KEYBINDING"],
    ["Ctrl+T", "RESERVED_KEYBINDING"],
    ["Ctrl+Meta+T", "INVALID_INPUT"],
    ["CtrlOrMeta", "INVALID_INPUT"],
  ])("refuses the override %s as %s and keeps the command's own default", (binding, reasonCode) => {
    const result = project([shortcut({ id: "undo", binding, modified: true })]);

    expect(result.refusals).toEqual([{ commandId: "undo", reasonCode }]);
    expect(result.shortcuts.map((entry) => workspaceChordKey(entry.chord))).toEqual(["cmd|z"]);
  });

  it("refuses an override that collides on the platform-collapsed chord", () => {
    const result = project([
      shortcut({ id: "undo", binding: "CtrlOrMeta+Z", modified: false }),
      shortcut({ id: "focus-status", binding: "Ctrl+Z", modified: true }),
    ]);
    const byId = new Map(
      result.shortcuts.map((entry) => [entry.commandId, workspaceChordKey(entry.chord)]),
    );

    expect(result.refusals).toEqual([
      { commandId: "focus-status", reasonCode: "KEYBINDING_COLLISION" },
    ]);
    expect(byId.get("undo")).toBe("cmd|z");
    expect(byId.get("focus-status")).toBe("alt|s");
  });

  it("reports no refusal when an override applies cleanly", () => {
    const result = project([
      shortcut({ id: "undo", binding: "CtrlOrMeta+Z", modified: false }),
      shortcut({ id: "quick-access.files", binding: "CtrlOrMeta+Shift+O", modified: true }),
    ]);

    expect(result.refusals).toEqual([]);
    expect(result.shortcuts).toHaveLength(2);
  });

  it("frees the default a command vacates so another command may still claim it", () => {
    const result = project([
      shortcut({ id: "quick-access.files", binding: "CtrlOrMeta+Shift+O", modified: true }),
      shortcut({ id: "undo", binding: "CtrlOrMeta+P", modified: true }),
    ]);
    const byId = new Map(
      result.shortcuts.map((entry) => [entry.commandId, workspaceChordKey(entry.chord)]),
    );

    expect(result.refusals).toEqual([]);
    expect(byId.get("quick-access.files")).toBe("cmd+shift|o");
    expect(byId.get("undo")).toBe("cmd|p");
  });
});
