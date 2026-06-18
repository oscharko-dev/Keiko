/**
 * Command and host-capability identities for the editor (Issue #1192).
 *
 * Kept separate from the runtime catalogue in `commands.ts` so both the catalogue and the host port
 * can `import type` these without pulling in any runtime value. An {@link EditorHostCapability} maps
 * 1:1 to an optional method on the host port; a command lists the capabilities it requires.
 */
export type EditorHostCapability =
  | "saveDocument"
  | "provideCompletions"
  | "provideInlineCompletions"
  | "provideDiagnostics"
  | "provideContext"
  | "generateTests"
  | "previewPatch"
  | "applyPatchReview";

export type EditorCommandId =
  | "editor.save"
  | "editor.triggerCompletion"
  | "editor.triggerInlineCompletion"
  | "editor.acceptInlineCompletion"
  | "editor.generateTests"
  | "editor.previewPatch"
  | "editor.applyPatch"
  | "editor.rejectPatch"
  | "editor.requestContext";

export interface EditorCommand {
  readonly id: EditorCommandId;
  readonly title: string;
  readonly requiredCapabilities: readonly EditorHostCapability[];
}

export interface EditorCommandContext {
  readonly readOnly: boolean;
  readonly dirty: boolean;
  /**
   * Whether the editor has a non-empty selection. Exposed for the host's keybinding/menu layer; the
   * built-in availability gates do not depend on it (selection-scoped commands arrive with their
   * owning issues, e.g. test generation from a selection).
   */
  readonly hasSelection: boolean;
  readonly inlineCompletionVisible: boolean;
  readonly pendingPatchId: string | null;
  readonly availableCapabilities: readonly EditorHostCapability[];
}
