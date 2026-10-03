/**
 * Editor command-action descriptors and keybinding catalogue for the VS Code-feeling UX (Issue #1205).
 *
 * Editor-intrinsic commands (find, format, accept/reject inline suggestion, command palette,
 * accessibility help) already ship with Monaco. Their built-in action ids are listed in
 * {@link MONACO_BUILTIN_ACTION_IDS} so the UX spec, status bar, and tests reference one source of
 * truth; the editor never re-implements them.
 * Host-owned rename commands are registered through the separate rename descriptor.
 */
import type { EditorCommandId } from "../command-types.js";

/**
 * Monaco's built-in action ids backing the editor-intrinsic #1205 commands. These actions are
 * enabled by the editor construction options (find, inline-suggest) or by a registered provider
 * (format requires a document-formatting provider, #1201); registering them again would clutter the
 * palette, so they are referenced, not redeclared.
 */
export const MONACO_BUILTIN_ACTION_IDS = {
  find: "actions.find",
  format: "editor.action.formatDocument",
  acceptInlineCompletion: "editor.action.inlineSuggest.commit",
  rejectInlineCompletion: "editor.action.inlineSuggest.hide",
  commandPalette: "editor.action.quickCommand",
  accessibilityHelp: "editor.action.accessibilityHelp",
} as const satisfies Readonly<Record<string, string>>;

/** Platform-specific display label for a command's default keybinding (mac / non-mac). */
export interface KeybindingDisplay {
  readonly mac: string;
  readonly pc: string;
}

/**
 * Display labels for each surfaced #1205 command's default keybinding. Used by the UX specification,
 * the status bar's command hint, and tests — not by Monaco (Monaco renders its own labels from the
 * registered keybinding integers). Mirrors Monaco's defaults plus the Keiko-registered chords.
 */
export const EDITOR_COMMAND_KEYBINDINGS: Readonly<
  Partial<Record<EditorCommandId, KeybindingDisplay>>
> = {
  "editor.save": { mac: "⌘S", pc: "Ctrl+S" },
  "editor.find": { mac: "⌘F", pc: "Ctrl+F" },
  "editor.format": { mac: "⇧⌥F", pc: "Shift+Alt+F" },
  "editor.acceptInlineCompletion": { mac: "Tab", pc: "Tab" },
  "editor.rejectInlineCompletion": { mac: "Esc", pc: "Esc" },
  "editor.renameSymbol": { mac: "F2", pc: "F2" },
  "editor.debugContinue": { mac: "F5", pc: "F5" },
  "editor.debugPause": { mac: "F6", pc: "F6" },
  "editor.debugStepOver": { mac: "F10", pc: "F10" },
  "editor.debugStepInto": { mac: "F11", pc: "F11" },
  "editor.debugStepOut": { mac: "⇧F11", pc: "Shift+F11" },
  "editor.debugStop": { mac: "⇧F5", pc: "Shift+F5" },
};
