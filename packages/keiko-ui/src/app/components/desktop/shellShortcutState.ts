"use client";

import type { WorkspaceKeyboardShortcutBinding } from "@oscharko-dev/keiko-contracts";
import {
  activeGlobalWorkspaceBindings,
  detectKeyboardShortcutPlatform,
  resolveGlobalKeyboardShortcuts,
  shortcutLabel,
} from "./globalKeyboardShortcuts";
import { subscribeEditorShortcutOverrides } from "./useEditorShortcutOverrides";

export type ShellShortcutState = {
  readonly labels: ReadonlyMap<string, string>;
  readonly bindings: ReadonlyArray<WorkspaceKeyboardShortcutBinding>;
};

export function resolveShellShortcutState(overrides: readonly string[]): ShellShortcutState {
  const registry = resolveGlobalKeyboardShortcuts(overrides);
  const platform = detectKeyboardShortcutPlatform();
  return {
    labels: new Map(
      registry.commands.map((entry) => [entry.command.id, shortcutLabel(entry.binding, platform)]),
    ),
    bindings: activeGlobalWorkspaceBindings(registry),
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
