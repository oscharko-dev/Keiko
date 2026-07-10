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
  | "askKeikoAboutSelection"
  | "generateTests"
  | "renameSymbol"
  | "previewPatch"
  | "applyPatchReview"
  // Issue #1205: an explicit "Format Document" host capability (the governed deterministic formatter
  // from #1201, ADR-0042 D4). Maps 1:1 to the `provideFormatting` host resolver.
  | "formatDocument"
  // Issue #1205: standalone verification of a generated patch. Part of the governed test-generation
  // review flow (ADR-0042 D7), which is switched off in v1, so no host injects this capability yet;
  // the command stays in the catalogue as availability-gated vocabulary and surfaces once enabled.
  | "runVerification"
  // Issue #2212 (ADR-0126): general-purpose run affordances — file-targeted tests and workspace
  // typecheck/lint/build — always available when capable, unrelated to a pending patch. Kept DISTINCT
  // from the patch-review-scoped `runVerification` so neither wrongly gates the other. Maps 1:1 to the
  // `runWorkspaceVerification` host method.
  | "runWorkspaceVerification";

export type EditorCommandId =
  | "editor.save"
  | "editor.triggerCompletion"
  | "editor.triggerInlineCompletion"
  | "editor.acceptInlineCompletion"
  // Issue #1205: reject/hide the visible inline (ghost-text) suggestion. Editor-intrinsic (Monaco's
  // `editor.action.inlineSuggest.hide`), so it needs no host capability.
  | "editor.rejectInlineCompletion"
  | "editor.generateTests"
  | "editor.askKeikoAboutSelection"
  | "editor.renameSymbol"
  // Issue #1205: run verification over a generated patch (governed, off in v1 — see `runVerification`).
  | "editor.runVerification"
  // Issue #2212 (ADR-0126): general run affordances via the `runWorkspaceVerification` capability.
  // `runFileTests` targets the active file's tests (or its counterpart); the others are workspace-wide.
  | "editor.runFileTests"
  | "editor.runTypecheck"
  | "editor.runLint"
  | "editor.runBuild"
  | "editor.cancelVerification"
  | "editor.previewPatch"
  // Issue #1205: open the side-by-side diff/patch preview. Maps to the `previewPatch` capability.
  | "editor.openDiff"
  | "editor.applyPatch"
  | "editor.rejectPatch"
  // Issue #1205: explicit "Format Document". Maps to the `formatDocument` capability.
  | "editor.format"
  // Issue #1205: open the in-editor find/search widget. Editor-intrinsic (Monaco's `actions.find`).
  | "editor.find"
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
   * Whether the editor has a non-empty selection. Selection-scoped commands use this to remain
   * unavailable instead of silently widening their input to the active buffer.
   */
  readonly hasSelection: boolean;
  readonly inlineCompletionVisible: boolean;
  readonly pendingPatchId: string | null;
  // Issue #2212: whether a verification run is currently active. Gates `editor.cancelVerification` ON
  // and the four run commands OFF while a run is in flight.
  readonly verificationRunning: boolean;
  // Issue #2212: host-resolved — true when the active file, or its resolved test counterpart, can be
  // targeted by `editor.runFileTests` (so the editor needs no test-file-naming knowledge itself).
  readonly activeFileVerifiable: boolean;
  readonly availableCapabilities: readonly EditorHostCapability[];
}
