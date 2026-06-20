/**
 * Pure save-command keybinding and action descriptor factories (Issue #1194).
 *
 * `KeyMod`/`KeyCode` are injected (the live values come from the `onMount(editor, monaco)`
 * callback), so the binding maths and the descriptor shape are node-testable without loading the
 * Monaco runtime. The `monaco-editor` import is type-only.
 */
import type * as monaco from "monaco-editor";

/** Stable id and label for the save command (also shown in the command palette / context menu). */
export const EDITOR_SAVE_ACTION_ID = "keiko.editor.save";
export const EDITOR_SAVE_ACTION_LABEL = "Save Document";

/** Structural view of the `KeyMod`/`KeyCode` enums the binding needs (injectable for tests). */
export interface MonacoKeyConstants {
  readonly KeyMod: { readonly CtrlCmd: number };
  readonly KeyCode: { readonly KeyS: number };
}

/** Build the `Cmd/Ctrl+S` chord as Monaco's packed keybinding integer (`CtrlCmd | KeyS`). */
export function buildSaveKeybinding(keys: MonacoKeyConstants): number {
  return keys.KeyMod.CtrlCmd | keys.KeyCode.KeyS;
}

/** Inputs for the save action descriptor: the key constants plus the run handler to invoke. */
export interface SaveActionDescriptorArgs {
  readonly keys: MonacoKeyConstants;
  readonly run: () => void;
}

/** Build the `addAction` descriptor that binds `Cmd/Ctrl+S` to the host save handler. */
export function buildSaveActionDescriptor(
  args: SaveActionDescriptorArgs,
): monaco.editor.IActionDescriptor {
  return {
    id: EDITOR_SAVE_ACTION_ID,
    label: EDITOR_SAVE_ACTION_LABEL,
    keybindings: [buildSaveKeybinding(args.keys)],
    run: args.run,
  };
}
