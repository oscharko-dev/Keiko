"use client";

import type {
  EditorM7CommandContext,
  EditorM7CommandDefinition,
  WorkspaceKeyboardShortcutBinding,
} from "@oscharko-dev/keiko-contracts";
import {
  activeGlobalWorkspaceBindings,
  resolveGlobalKeyboardShortcuts,
} from "./globalKeyboardShortcuts";
import { detectKeyboardShortcutPlatform, shortcutLabelForPlatform } from "./keyboardShortcutLabels";
import { resolveEffectiveKeyboardShortcuts } from "./keyboardShortcutsRegistry";
import { subscribeEditorShortcutOverrides } from "./useEditorShortcutOverrides";

export type ShellShortcutState = {
  readonly labels: ReadonlyMap<string, string>;
  readonly bindings: ReadonlyArray<WorkspaceKeyboardShortcutBinding>;
};

// Audit — the quick-access palette's chord hints came from a label map built over the SIX global
// commands only, so every editor command (`view.splitRight`, `tab.next`, `files.saveAll`, …) fell
// back to the hardcoded display string in `editorCommands.ts`: rebinding one in Settings never
// reached the palette, which kept advertising a chord that no longer did anything. Labels are now
// derived for EVERY command in the live registry — the same `resolveEffectiveKeyboardShortcuts`
// source Settings writes and the editor dispatches from — so a rebind shows up everywhere at once.
//
// An UNBOUND command contributes no entry at all. `shortcutLabelForPlatform(null, …)` renders the
// "Unbound" wording the settings table wants, which is not a chord hint: leaving the entry out lets
// the palette row fall through to no chip instead of advertising a word as a keystroke.

// Nor may a BOUND command be advertised when nothing dispatches it — that is the same defect one
// command later. Keiko listens in the "global" context (AppShell → useKeyboardShortcuts) and the
// "editor" context (EditorWidget's capturing listener); Monaco-owned commands are dispatched by
// Monaco itself. No listener claims the "settings" context, so `open-editor-settings`
// (`CtrlOrMeta+,`) contributes no hint until one exists.
const KEIKO_DISPATCHED_CONTEXTS: ReadonlySet<EditorM7CommandContext> = new Set([
  "global",
  "editor",
  "monaco",
]);

function hasLiveDispatcher(command: EditorM7CommandDefinition): boolean {
  if (command.dispatchOwner === "monaco") return true;
  return command.contexts.some((context) => KEIKO_DISPATCHED_CONTEXTS.has(context));
}

function shortcutLabelsForOverrides(overrides: readonly string[]): ReadonlyMap<string, string> {
  const platform = detectKeyboardShortcutPlatform();
  const labels = new Map<string, string>();
  for (const entry of resolveEffectiveKeyboardShortcuts(overrides).commands) {
    if (entry.binding === null || !hasLiveDispatcher(entry.command)) continue;
    labels.set(entry.command.id, shortcutLabelForPlatform(entry.binding, platform));
  }
  return labels;
}

export function resolveShellShortcutState(overrides: readonly string[]): ShellShortcutState {
  return {
    labels: shortcutLabelsForOverrides(overrides),
    bindings: activeGlobalWorkspaceBindings(resolveGlobalKeyboardShortcuts(overrides)),
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
