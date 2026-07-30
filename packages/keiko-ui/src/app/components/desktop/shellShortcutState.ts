"use client";

// The shell's global keyboard shortcuts resolve through the SAME parser the settings layer uses
// (keyboardShortcutsRegistry → parseEditorM7KeybindingOverrides in @oscharko-dev/keiko-contracts).
// It used to carry its own weaker copy in `globalKeyboardShortcuts.ts`, which re-declared the six
// global commands and validated only the record shape plus the binding→chord mapping — never the
// reserved-chord or collision rules. `useKeyboardShortcuts` fails closed by THROWING on either, in
// render, above no boundary: one hand-edited or imported `keybindingOverrides` line white-screened
// the whole desktop on every load. Persisted overrides are hostile input (AGENTS.md §7), so a
// rejected entry is IGNORED here and the command keeps its default binding — never thrown at render.
//
// Audit — the quick-access palette's chord hints came from a label map built over the SIX global
// commands only, so every editor command (`view.splitRight`, `tab.next`, `files.saveAll`, …) fell
// back to the hardcoded display string in `editorCommands.ts`: rebinding one in Settings never
// reached the palette, which kept advertising a chord that no longer did anything. Labels now cover
// every command something actually dispatches, so a rebind shows up everywhere at once.
//
// A label is always derived from the binding that REALLY fires, never from the binding the settings
// file asked for: for Keiko's own listeners that is the dispatch-safe projection (a refused override
// falls back to its default, and the palette must show that same default), and for Monaco-owned
// commands it is the effective binding Monaco itself receives.
//
// An UNBOUND command, and a BOUND command nothing dispatches, both contribute no entry at all.
// `shortcutLabel(null, …)` renders the "Unbound" wording the settings table wants, which is not a
// chord hint — leaving the entry out lets the palette row fall through to no chip instead of
// advertising a word as a keystroke. Keiko listens in the "global" context (AppShell →
// useKeyboardShortcuts) and the "editor" context (EditorWidget's capturing listener); no listener
// claims the "settings" context, so `open-editor-settings` (`CtrlOrMeta+,`) stays out until one
// exists. Advertising a chord nobody dispatches is the same defect one command later.

import type {
  EditorM7CommandContext,
  WorkspaceKeyboardShortcutBinding,
} from "@oscharko-dev/keiko-contracts";
import {
  detectKeyboardShortcutPlatform,
  dispatchableWorkspaceShortcutsForContext,
  resolveEffectiveKeyboardShortcuts,
  shortcutLabel,
  type EffectiveKeyboardShortcutRegistry,
} from "./keyboardShortcutsRegistry";
import { subscribeEditorShortcutOverrides } from "./useEditorShortcutOverrides";

export type ShellShortcutState = {
  readonly labels: ReadonlyMap<string, string>;
  readonly bindings: ReadonlyArray<WorkspaceKeyboardShortcutBinding>;
};

const KEIKO_DISPATCHED_CONTEXTS: readonly EditorM7CommandContext[] = ["global", "editor"];

// The binding each command is labelled from, keyed by command id. Monaco first, then Keiko's own
// contexts, so a command listed in both is labelled from the projection that refuses hostile input.
function labelledBindings(
  registry: EffectiveKeyboardShortcutRegistry,
): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>();
  for (const entry of registry.commands) {
    if (entry.command.dispatchOwner === "monaco" && entry.binding !== null) {
      bindings.set(entry.command.id, entry.binding);
    }
  }
  for (const context of KEIKO_DISPATCHED_CONTEXTS) {
    for (const entry of dispatchableWorkspaceShortcutsForContext(registry, context)) {
      bindings.set(entry.commandId, entry.binding);
    }
  }
  return bindings;
}

export function resolveShellShortcutState(overrides: readonly string[]): ShellShortcutState {
  const registry = resolveEffectiveKeyboardShortcuts(overrides);
  const platform = detectKeyboardShortcutPlatform();
  return {
    labels: new Map(
      [...labelledBindings(registry)].map(([commandId, binding]) => [
        commandId,
        shortcutLabel(binding, platform),
      ]),
    ),
    bindings: dispatchableWorkspaceShortcutsForContext(registry, "global").map((entry) => ({
      commandId: entry.commandId,
      chord: entry.chord,
    })),
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
