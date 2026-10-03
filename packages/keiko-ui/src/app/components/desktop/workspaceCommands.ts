"use client";

import type { IconName } from "./Icons";
import type { WindowType } from "./windows/WindowsRegistry";
import type { EditorPaletteCommand } from "./widgets/cards/editorCommands";

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly group?: string;
  readonly icon: IconName;
  // Optional keyboard chord rendered as a .kbd chip in the row (shortcut discoverability).
  readonly shortcut?: string;
  readonly run: () => void;
}

export const WINDOW_LAUNCHER_TYPES: readonly WindowType[] = [
  "chat",
  "connector",
  "files",
  "editor",
  "agents",
  "docbrowser",
];

export const COMMAND_TOOL_TYPES: readonly WindowType[] = [
  "chatHistory",
  "codingHistory",
  "memoria",
  "settings",
  "workspaceTrust",
  "automations",
  "mobile",
  "inspector",
  "activity",
  "notifications",
  "resources",
  "localKnowledge",
  "integ",
  "governedGit",
  // Issue #2476 — Code task reachability. The Coding Workbench is a `singleton: true, tool: true`
  // window, so it belongs on the command list (the idempotent `toggleTool` seam the Left Rail
  // already uses), NOT the card list (which mints a new-window config flow) and NOT `TYPE_ORDER`
  // (the launcher-grid order the palette does not source its commands from — the known wrong-list trap).
  "coding",
  "editor",
  "figma",
  "quality",
  "promptEnhancer",
  "relationships",
];

export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly shortcut?: string | undefined;
  readonly run: () => void;
}

export type CommandShortcutLabels = ReadonlyMap<string, string>;

export function commandIdsForEvidence(
  appCommands: readonly Command[],
  editorCommands: readonly EditorPaletteCommand[],
): readonly string[] {
  return [
    ...appCommands.map((command) => command.id),
    ...editorCommands.map((command) => command.id),
  ];
}

export function appCommandWindowTypes(): {
  readonly cards: readonly WindowType[];
  readonly tools: readonly WindowType[];
} {
  return { cards: WINDOW_LAUNCHER_TYPES, tools: COMMAND_TOOL_TYPES };
}
