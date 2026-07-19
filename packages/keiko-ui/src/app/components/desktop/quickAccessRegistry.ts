"use client";

import type { IconName } from "./Icons";
import type { MessageKey } from "@/lib/i18n-messages.en";
import type { WindowType } from "./windows/WindowsRegistry";
import {
  availablePaletteCommands,
  type EditorPaletteCommand,
  type EditorPaletteHost,
} from "./widgets/cards/editorCommands";

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly group?: string;
  readonly icon: IconName;
  // Optional keyboard chord rendered as a .kbd chip in the row (shortcut discoverability).
  readonly shortcut?: string;
  readonly run: () => void;
}

export const QUICK_ACCESS_CARD_TYPES: readonly WindowType[] = [
  "chat",
  "connector",
  "files",
  "editor",
  "agents",
  "docbrowser",
];

export const QUICK_ACCESS_TOOL_TYPES: readonly WindowType[] = [
  "chatHistory",
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
  "governedGit",
  // Issue #2476 — Code task reachability. The Coding Workbench is a `singleton: true, tool: true`
  // window, so it belongs on the palette's tool list (the idempotent `toggleTool` seam the Left Rail
  // already uses), NOT the card list (which mints a new-window config flow) and NOT `TYPE_ORDER`
  // (the launcher-grid order the palette does not source its commands from — the known wrong-list trap).
  "coding",
  "editor",
  "figma",
  "quality",
  "promptEnhancer",
  "relationships",
];

export interface QuickAccessCommand {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly shortcut?: string | undefined;
  readonly run: () => void;
}

export type QuickAccessShortcutLabels = ReadonlyMap<string, string>;

export function commandIdsForEvidence(
  appCommands: readonly Command[],
  editorCommands: readonly EditorPaletteCommand[],
): readonly string[] {
  return [
    ...appCommands.map((command) => command.id),
    ...editorCommands.map((command) => command.id),
  ];
}

export function buildUnifiedQuickAccessCommands(
  appCommands: readonly Command[],
  editorHost: EditorPaletteHost | null,
  translate?: (key: MessageKey) => string,
  shortcutLabels?: QuickAccessShortcutLabels,
): readonly QuickAccessCommand[] {
  const out: QuickAccessCommand[] = appCommands.map((command) => ({
    id: command.id,
    label: command.label,
    group: command.group ?? "Commands",
    shortcut: shortcutLabels?.get(command.id) ?? command.shortcut,
    run: command.run,
  }));
  if (editorHost !== null) {
    for (const command of availablePaletteCommands(editorHost)) {
      out.push({
        id: command.id,
        label:
          command.titleKey === undefined || translate === undefined
            ? command.title
            : translate(command.titleKey),
        group: "Editor",
        shortcut: shortcutLabels?.get(command.id) ?? command.keybinding,
        run: () => command.run(editorHost),
      });
    }
  }
  return dedupeCommands(out);
}

function dedupeCommands(commands: readonly QuickAccessCommand[]): readonly QuickAccessCommand[] {
  const seen = new Set<string>();
  const out: QuickAccessCommand[] = [];
  for (const command of commands) {
    if (seen.has(command.id)) continue;
    seen.add(command.id);
    out.push(command);
  }
  return out;
}

export function paletteWindowOrder(): readonly WindowType[] {
  return QUICK_ACCESS_CARD_TYPES;
}

export function appCommandWindowTypes(): {
  readonly cards: readonly WindowType[];
  readonly tools: readonly WindowType[];
} {
  return { cards: QUICK_ACCESS_CARD_TYPES, tools: QUICK_ACCESS_TOOL_TYPES };
}
