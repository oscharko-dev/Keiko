/**
 * Editor command-action descriptors and keybinding catalogue for the VS Code-feeling UX (Issue #1205).
 *
 * Two kinds of command surface meet here:
 *
 * 1. **Editor-intrinsic** commands (find, format, accept/reject inline suggestion, command palette,
 *    accessibility help) already ship with Monaco. Their built-in action ids are listed in
 *    {@link MONACO_BUILTIN_ACTION_IDS} so the UX spec, status bar, and tests reference one source of
 *    truth; the editor never re-implements them.
 * 2. **Host-owned** commands (Generate Tests) are registered into Monaco via `editor.addAction`, so
 *    they appear in Monaco's native command palette (F1) and context menu and carry a keybinding.
 *    The run handler is host-injected; the descriptor maths stay node-testable (the `monaco-editor`
 *    import is type-only, like {@link import("./keybindings.js").buildSaveActionDescriptor}).
 */
import type * as monaco from "monaco-editor";

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
  "editor.generateTests": { mac: "⌘⌥T", pc: "Ctrl+Alt+T" },
};

/** Stable id and label for the host-owned Generate Tests action (palette + context-menu entry). */
export const EDITOR_GENERATE_TESTS_ACTION_ID = "keiko.editor.generateTests";
export const EDITOR_GENERATE_TESTS_ACTION_LABEL = "Generate Tests";

/**
 * Structural view of the `KeyMod`/`KeyCode` members the Keiko-registered actions need (injectable so
 * the binding maths stay node-testable without loading the Monaco runtime).
 */
export interface CommandActionKeys {
  readonly KeyMod: { readonly CtrlCmd: number; readonly Alt: number };
  readonly KeyCode: { readonly KeyT: number };
}

/**
 * `Cmd/Ctrl+Alt+T` packed as Monaco's keybinding integer (`CtrlCmd | Alt | KeyT`).
 *
 * Chosen to avoid every Monaco built-in chord and to be inert against the Workspace window-management
 * chords: those (`Cmd/Ctrl+Arrow` move, `Alt+Arrow` resize, `Cmd/Ctrl+Alt+±0` zoom) are skipped while
 * a form field — including Monaco's focused input textarea — holds focus, so an in-editor chord never
 * collides with them (see the #1205 keyboard conflict review).
 */
export function buildGenerateTestsKeybinding(keys: CommandActionKeys): number {
  return keys.KeyMod.CtrlCmd | keys.KeyMod.Alt | keys.KeyCode.KeyT;
}

/** Inputs for the Generate Tests action descriptor: the key constants plus the host run handler. */
export interface GenerateTestsActionArgs {
  readonly keys: CommandActionKeys;
  readonly run: () => void;
}

/**
 * Build the `addAction` descriptor for Generate Tests. Registering it surfaces the host command in
 * Monaco's native command palette (F1 / right-click → Command Palette) and context menu and binds it
 * to `Cmd/Ctrl+Alt+T`; the run handler delegates to the host's governed test-generation flow (#1202),
 * which the server keeps switched off in v1 (ADR-0042 D7).
 */
export function buildGenerateTestsActionDescriptor(
  args: GenerateTestsActionArgs,
): monaco.editor.IActionDescriptor {
  return {
    id: EDITOR_GENERATE_TESTS_ACTION_ID,
    label: EDITOR_GENERATE_TESTS_ACTION_LABEL,
    keybindings: [buildGenerateTestsKeybinding(args.keys)],
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 2,
    run: args.run,
  };
}
