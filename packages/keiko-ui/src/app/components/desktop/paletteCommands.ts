import type { MessageKey } from "@/lib/i18n-messages.en";
import { availablePaletteCommands, type EditorPaletteHost } from "./widgets/cards/editorCommands";
import type { Command, PaletteCommand, CommandShortcutLabels } from "./workspaceCommands";

// `translate` is REQUIRED, not optional. It used to be optional with an English literal fallback for
// the two group names below, which is exactly how the command palette stayed English for a user
// who selected Deutsch: nothing failed, the fallback just rendered. A required translate makes the
// locale a compile-time obligation of every caller.
export function buildPaletteCommands(
  appCommands: readonly Command[],
  editorHost: EditorPaletteHost | null,
  translate: (key: MessageKey) => string,
  shortcutLabels?: CommandShortcutLabels,
): readonly PaletteCommand[] {
  const out: PaletteCommand[] = appCommands.map((command) => ({
    id: command.id,
    label: command.label,
    group: command.group ?? translate("command.group.commands"),
    shortcut: shortcutLabels?.get(command.id) ?? command.shortcut,
    run: command.run,
  }));
  if (editorHost !== null) {
    for (const command of availablePaletteCommands(editorHost)) {
      out.push({
        id: command.id,
        label: command.titleKey === undefined ? command.title : translate(command.titleKey),
        group: translate("command.group.editor"),
        shortcut: shortcutLabels?.get(command.id) ?? command.keybinding,
        run: () => command.run(editorHost),
      });
    }
  }
  return dedupeCommands(out);
}

function dedupeCommands(commands: readonly PaletteCommand[]): readonly PaletteCommand[] {
  const seen = new Set<string>();
  const out: PaletteCommand[] = [];
  for (const command of commands) {
    if (seen.has(command.id)) continue;
    seen.add(command.id);
    out.push(command);
  }
  return out;
}
