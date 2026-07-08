/**
 * Host-owned rename command bridge (Epic #2089, Issue #2105).
 *
 * Registers a Keiko command action bound to F2. It delegates the actual rename flow to the host so
 * multi-file changesets can be reviewed in `KeikoDiffEditor`; it never registers Monaco's native
 * rename provider and never applies edits itself.
 */
import type * as monaco from "monaco-editor";

export const EDITOR_RENAME_SYMBOL_ACTION_ID = "keiko.editor.renameSymbol";
export const EDITOR_RENAME_SYMBOL_ACTION_LABEL = "Rename Symbol";

export interface RenameCommandActionKeys {
  readonly KeyCode: { readonly F2: number };
}

export interface RenameActionArgs {
  readonly keys: RenameCommandActionKeys;
  readonly run: () => void;
}

export function buildRenameSymbolKeybinding(keys: RenameCommandActionKeys): number {
  return keys.KeyCode.F2;
}

export function buildRenameSymbolActionDescriptor(
  args: RenameActionArgs,
): monaco.editor.IActionDescriptor {
  return {
    id: EDITOR_RENAME_SYMBOL_ACTION_ID,
    label: EDITOR_RENAME_SYMBOL_ACTION_LABEL,
    keybindings: [buildRenameSymbolKeybinding(args.keys)],
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 1,
    run: args.run,
  };
}
