/**
 * Editor command-action descriptors and keybinding catalogue for the VS Code-feeling UX (Issue #1205).
 *
 * Two kinds of command surface meet here:
 *
 * 1. **Editor-intrinsic** commands (find, format, accept/reject inline suggestion, command palette,
 *    accessibility help) already ship with Monaco. Their built-in action ids are listed in
 *    {@link MONACO_BUILTIN_ACTION_IDS} so the UX spec, status bar, and tests reference one source of
 *    truth; the editor never re-implements them.
 * 2. **Host-owned** commands (Generate Tests, Ask Keiko) are registered into Monaco via
 *    `editor.addAction`, so they appear in Monaco's native command palette (F1) and context menu and
 *    carry a keybinding. Run handlers are host-injected; descriptor maths and selection capture stay
 *    node-testable (`monaco-editor` remains a type-only import).
 */
import type * as monaco from "monaco-editor";

import type { EditorCommandId } from "../command-types.js";
import { monacoSelectionToEditorRange } from "./selection-reporting.js";
import type { AskKeikoAboutSelectionHandler } from "./types.js";

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
  "editor.askKeikoAboutSelection": { mac: "⌘⌥K", pc: "Ctrl+Alt+K" },
  "editor.renameSymbol": { mac: "F2", pc: "F2" },
};

/** Stable id and label for the host-owned Generate Tests action (palette + context-menu entry). */
export const EDITOR_GENERATE_TESTS_ACTION_ID = "keiko.editor.generateTests";
export const EDITOR_GENERATE_TESTS_ACTION_LABEL = "Generate Tests";

/** Stable id and label for the selection-scoped Ask Keiko action. */
export const EDITOR_ASK_KEIKO_ABOUT_SELECTION_ACTION_ID = "keiko.editor.askKeikoAboutSelection";
export const EDITOR_ASK_KEIKO_ABOUT_SELECTION_ACTION_LABEL = "Ask Keiko about this selection";

const EDITOR_HAS_SELECTION_CONTEXT_KEY = "editorHasSelection";

/**
 * Structural view of the `KeyMod`/`KeyCode` members the Keiko-registered actions need (injectable so
 * the binding maths stay node-testable without loading the Monaco runtime).
 */
export interface CommandActionKeys {
  readonly KeyMod: { readonly CtrlCmd: number; readonly Alt: number };
  readonly KeyCode: { readonly KeyT: number };
}

/** Key constants for the Ask Keiko selection command, kept additive for existing consumers. */
export interface AskKeikoAboutSelectionCommandActionKeys {
  readonly KeyMod: { readonly CtrlCmd: number; readonly Alt: number };
  readonly KeyCode: { readonly KeyK: number };
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

/** `Cmd/Ctrl+Alt+K` packed as Monaco's keybinding integer. */
export function buildAskKeikoAboutSelectionKeybinding(
  keys: AskKeikoAboutSelectionCommandActionKeys,
): number {
  return keys.KeyMod.CtrlCmd | keys.KeyMod.Alt | keys.KeyCode.KeyK;
}

export interface AskKeikoAboutSelectionActionArgs {
  readonly keys: AskKeikoAboutSelectionCommandActionKeys;
  readonly run: (editor: monaco.editor.ICodeEditor) => void;
}

/** Build the selection-gated Ask Keiko action descriptor for Monaco's existing command surface. */
export function buildAskKeikoAboutSelectionActionDescriptor(
  args: AskKeikoAboutSelectionActionArgs,
): monaco.editor.IActionDescriptor {
  return {
    id: EDITOR_ASK_KEIKO_ABOUT_SELECTION_ACTION_ID,
    label: EDITOR_ASK_KEIKO_ABOUT_SELECTION_ACTION_LABEL,
    precondition: EDITOR_HAS_SELECTION_CONTEXT_KEY,
    keybindings: [buildAskKeikoAboutSelectionKeybinding(args.keys)],
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 3,
    run: args.run,
  };
}

/** Capture the live non-empty selection without ever reading the full Monaco model. */
export function buildAskKeikoAboutSelectionRunHandler(
  onAsk: AskKeikoAboutSelectionHandler,
): (editor: monaco.editor.ICodeEditor) => void {
  return (editor): void => {
    const selection = editor.getSelection();
    if (selection === null) return;
    const range = monacoSelectionToEditorRange(selection);
    if (range === null) return;
    const model = editor.getModel();
    if (model === null) return;
    onAsk({ textMode: "selection", range, text: model.getValueInRange(selection) });
  };
}
