"use client";

import type { WorkspaceKeyChord, WorkspaceKeyChordModifier } from "@oscharko-dev/keiko-contracts";

export type GlobalKeyboardShortcutPlatform = "mac" | "other";

type GlobalCommandId =
  | "undo"
  | "redo"
  | "focus-status"
  | "focus-workspace-search"
  | "quick-access.files"
  | "quick-access.commands";

interface GlobalCommandDefinition {
  readonly id: GlobalCommandId;
  readonly defaultBinding: string;
}

export interface GlobalKeyboardShortcut {
  readonly command: GlobalCommandDefinition;
  readonly binding: string;
}

export interface GlobalKeyboardShortcutRegistry {
  readonly commands: readonly GlobalKeyboardShortcut[];
}

const OVERRIDE_VERSION = "1";
const OVERRIDE_SEPARATOR = "|";
const MODIFIER_SET = new Set(["CtrlOrMeta", "Ctrl", "Meta", "Alt", "Shift"]);

const GLOBAL_COMMANDS: readonly GlobalCommandDefinition[] = Object.freeze([
  { id: "undo", defaultBinding: "CtrlOrMeta+Z" },
  { id: "redo", defaultBinding: "CtrlOrMeta+Shift+Z" },
  { id: "focus-status", defaultBinding: "Alt+S" },
  { id: "focus-workspace-search", defaultBinding: "CtrlOrMeta+Shift+F" },
  { id: "quick-access.files", defaultBinding: "CtrlOrMeta+P" },
  { id: "quick-access.commands", defaultBinding: "CtrlOrMeta+Shift+P" },
]);

const GLOBAL_COMMAND_IDS = new Set<string>(GLOBAL_COMMANDS.map((command) => command.id));

function parseOverride(
  value: string,
): { readonly commandId: string; readonly binding: string } | null {
  const parts = value.split(OVERRIDE_SEPARATOR);
  if (parts.length !== 3 || parts[0] !== OVERRIDE_VERSION) return null;
  const [, commandId, binding] = parts as [string, string, string];
  return bindingToWorkspaceChord(binding) === null ? null : { commandId, binding };
}

export function resolveGlobalKeyboardShortcuts(
  rawOverrides: readonly string[],
): GlobalKeyboardShortcutRegistry {
  const overrideByCommand = new Map<string, string>();
  for (const raw of rawOverrides) {
    const parsed = parseOverride(raw);
    if (parsed === null || overrideByCommand.has(parsed.commandId)) {
      return defaultRegistry();
    }
    if (GLOBAL_COMMAND_IDS.has(parsed.commandId)) {
      overrideByCommand.set(parsed.commandId, parsed.binding);
    }
  }
  return {
    commands: GLOBAL_COMMANDS.map((command) => ({
      command,
      binding: overrideByCommand.get(command.id) ?? command.defaultBinding,
    })),
  };
}

function defaultRegistry(): GlobalKeyboardShortcutRegistry {
  return {
    commands: GLOBAL_COMMANDS.map((command) => ({
      command,
      binding: command.defaultBinding,
    })),
  };
}

export function activeGlobalWorkspaceBindings(
  registry: GlobalKeyboardShortcutRegistry,
): readonly { readonly commandId: string; readonly chord: WorkspaceKeyChord }[] {
  return registry.commands.flatMap((entry) => {
    const chord = bindingToWorkspaceChord(entry.binding);
    return chord === null ? [] : [{ commandId: entry.command.id, chord }];
  });
}

export function bindingToWorkspaceChord(binding: string): WorkspaceKeyChord | null {
  const parts = binding.split("+");
  const key = parts.at(-1);
  if (key === undefined || key.length === 0 || MODIFIER_SET.has(key)) return null;
  const mod = parts
    .slice(0, -1)
    .map((part): WorkspaceKeyChordModifier | null => {
      if (part === "CtrlOrMeta" || part === "Meta") return "cmd";
      if (part === "Ctrl") return "ctrl";
      if (part === "Alt") return "alt";
      if (part === "Shift") return "shift";
      return null;
    })
    .filter((part): part is WorkspaceKeyChordModifier => part !== null);
  return { key: keyForWorkspace(key), mod };
}

function keyForWorkspace(key: string): string {
  if (key.startsWith("Arrow")) return key.toLowerCase();
  return key.length === 1 ? key.toLowerCase() : key;
}

export function shortcutLabel(
  binding: string | null,
  platform: GlobalKeyboardShortcutPlatform,
): string {
  if (binding === null) return "Unbound";
  return binding
    .split("+")
    .map((part) => labelPart(part, platform))
    .join(platform === "mac" ? "" : "+");
}

function labelPart(part: string, platform: GlobalKeyboardShortcutPlatform): string {
  if (platform === "mac") {
    if (part === "CtrlOrMeta" || part === "Meta") return "⌘";
    if (part === "Ctrl") return "⌃";
    if (part === "Alt") return "⌥";
    if (part === "Shift") return "⇧";
  } else if (part === "CtrlOrMeta" || part === "Meta") {
    return "Ctrl";
  }
  if (part === "Alt") return platform === "mac" ? "⌥" : "Alt";
  if (part === "Shift") return platform === "mac" ? "⇧" : "Shift";
  return keyForWorkspaceLabel(part);
}

function keyForWorkspaceLabel(part: string): string {
  if (part.startsWith("Arrow")) return part.replace("Arrow", "");
  return part.length === 1 ? part.toUpperCase() : part;
}

export function detectKeyboardShortcutPlatform(): GlobalKeyboardShortcutPlatform {
  if (typeof navigator === "undefined") return "other";
  return /Mac|iPhone|iPad|iPod/iu.test(navigator.platform) ? "mac" : "other";
}
