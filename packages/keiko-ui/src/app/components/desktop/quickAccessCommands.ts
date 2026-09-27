import type { MessageKey } from "@/lib/i18n-messages.en";
import { availablePaletteCommands, type EditorPaletteHost } from "./widgets/cards/editorCommands";
import type { Command, QuickAccessCommand, QuickAccessShortcutLabels } from "./quickAccessRegistry";

// `translate` is REQUIRED, not optional. It used to be optional with an English literal fallback for
// the two group names below, which is exactly how the quick-access palette stayed English for a user
// who selected Deutsch: nothing failed, the fallback just rendered. A required translate makes the
// locale a compile-time obligation of every caller.
export function buildUnifiedQuickAccessCommands(
  appCommands: readonly Command[],
  editorHost: EditorPaletteHost | null,
  translate: (key: MessageKey) => string,
  shortcutLabels?: QuickAccessShortcutLabels,
): readonly QuickAccessCommand[] {
  const out: QuickAccessCommand[] = appCommands.map((command) => ({
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
