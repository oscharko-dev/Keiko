"use client";

// The shell's global keyboard shortcuts resolve through the SAME parser the settings layer uses
// (keyboardShortcutsRegistry → parseEditorM7KeybindingOverrides in @oscharko-dev/keiko-contracts).
// It used to carry its own weaker copy in `globalKeyboardShortcuts.ts`, which re-declared the six
// global commands and validated only the record shape plus the binding→chord mapping — never the
// reserved-chord or collision rules. `useKeyboardShortcuts` fails closed by THROWING on either, in
// render, above no boundary: one hand-edited or imported `keybindingOverrides` line white-screened
// the whole desktop on every load. Persisted overrides are hostile input (AGENTS.md §7), so a
// rejected entry is IGNORED here and the command keeps its default binding — never thrown at render.

import type { WorkspaceKeyboardShortcutBinding } from "@oscharko-dev/keiko-contracts";
import {
  detectKeyboardShortcutPlatform,
  dispatchableWorkspaceShortcutsForContext,
  resolveEffectiveKeyboardShortcuts,
  shortcutLabel,
} from "./keyboardShortcutsRegistry";
import { subscribeEditorShortcutOverrides } from "./useEditorShortcutOverrides";

export type ShellShortcutState = {
  readonly labels: ReadonlyMap<string, string>;
  readonly bindings: ReadonlyArray<WorkspaceKeyboardShortcutBinding>;
};

export function resolveShellShortcutState(overrides: readonly string[]): ShellShortcutState {
  const registry = resolveEffectiveKeyboardShortcuts(overrides);
  const platform = detectKeyboardShortcutPlatform();
  const dispatchable = dispatchableWorkspaceShortcutsForContext(registry, "global");
  // Label what actually fires, not what the settings file asked for: a refused override falls back
  // to the default binding, and the palette must show that same chord.
  const bindingByCommand = new Map(dispatchable.map((entry) => [entry.commandId, entry.binding]));
  return {
    labels: new Map(
      registry.commands
        .filter((entry) => entry.command.contexts.includes("global"))
        .map((entry) => [
          entry.command.id,
          shortcutLabel(bindingByCommand.get(entry.command.id) ?? null, platform),
        ]),
    ),
    bindings: dispatchable.map((entry) => ({ commandId: entry.commandId, chord: entry.chord })),
  };
}

export function subscribeShellShortcutState(
  root: string | undefined,
  onChange: (state: ShellShortcutState) => void,
): () => void {
  onChange(resolveShellShortcutState([]));
  return subscribeEditorShortcutOverrides(root, (overrides) => {
    onChange(resolveShellShortcutState(overrides));
  });
}
