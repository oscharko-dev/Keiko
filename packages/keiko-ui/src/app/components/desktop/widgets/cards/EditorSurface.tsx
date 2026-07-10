"use client";

/**
 * Client-only Keiko Editor surface for the Workspace editor card (Issue #1196).
 *
 * Loaded exclusively through `next/dynamic(..., { ssr: false })` from {@link
 * import("./EditorWidget.js").EditorWidget}, so `monaco-editor` is bundled into a browser-only chunk
 * and never evaluated during the Next static-export prerender. It boots the local, no-CDN Monaco
 * runtime once and then renders the controlled {@link KeikoCodeEditor}. The host (EditorWidget) owns
 * every BFF call and the file/save lifecycle; this surface adds no I/O of its own (Engineering Note:
 * workspace API clients stay in the host, never in the editor tier).
 */
import { memo, useEffect, useState, type ReactElement } from "react";
import {
  KeikoCodeEditor,
  type EditorBuffer,
  type EditorChangeOrigin,
  type EditorCodeActionsResolver,
  type EditorCompletionResolver,
  type EditorContentDelta,
  type EditorDefinitionResolver,
  type EditorDiagnosticsResolver,
  type EditorDiagnosticsSummary,
  type EditorFileModel,
  type EditorFormattingResolver,
  type EditorHostEditRequest,
  type EditorHoverResolver,
  type EditorInlineCompletionResolver,
  type EditorPosition,
  type EditorRange,
  type EditorReferencesResolver,
  type EditorSaveRequest,
  type EditorSaveStatus,
  type EditorSignatureHelpResolver,
  type EditorSymbolsResolver,
  type EditorThemeVariant,
  type InlineCompletionTelemetrySnapshot,
  type KeikoCodeEditorProps,
  type KeikoEditorLoadState,
} from "@oscharko-dev/keiko-editor";

import {
  ensureMonacoLanguage,
  ensureMonacoRuntime,
  isMonacoLanguageReady,
} from "./editorMonacoRuntime";

export interface EditorSurfaceProps {
  readonly buffer: EditorBuffer;
  readonly fileModel: EditorFileModel;
  /**
   * The host's file-load lifecycle (fetch/IO), independent of the Monaco runtime status. When the
   * local runtime cannot start, the surface overrides this with a controlled load-error state.
   */
  readonly fileLoadState: KeikoEditorLoadState;
  readonly saveStatus: EditorSaveStatus;
  readonly saveError?: string | undefined;
  readonly modifiedAt?: number | undefined;
  readonly maxSizeBytes?: number | undefined;
  readonly themeVariant?: EditorThemeVariant | undefined;
  readonly ariaLabel?: string | undefined;
  readonly onContentChange: (next: EditorContentDelta, origin: EditorChangeOrigin) => void;
  readonly onSaveRequested: (request: EditorSaveRequest) => void;
  readonly onSelectionChange?: ((selection: EditorRange | null) => void) | undefined;
  readonly onCursorChange?: ((position: EditorPosition) => void) | undefined;
  readonly revealRequest?: KeikoCodeEditorProps["revealRequest"] | undefined;
  readonly hostEditRequest?: EditorHostEditRequest | undefined;
  readonly onRuntimeError?: ((message: string) => void) | undefined;
  /**
   * Host completion resolver (Issue #1199). When present, the editor registers a Monaco completion
   * provider that bridges to it; the host (EditorWidget) owns the BFF call. Absent for non-source
   * buffers, where no governed deterministic provider exists.
   */
  readonly provideCompletions?: EditorCompletionResolver | undefined;
  readonly completionTriggerCharacters?: readonly string[] | undefined;
  /**
   * Host inline-completion (ghost-text) resolver (Issue #1200). When present, the editor registers a
   * Monaco inline-completion provider and enables inline suggest; the host owns the BFF call. Absent
   * for non-source buffers.
   */
  readonly provideInlineCompletions?: EditorInlineCompletionResolver | undefined;
  /** Observer for content-free inline-completion acceptance/rejection telemetry counts. */
  readonly onInlineCompletionTelemetry?:
    ((snapshot: InlineCompletionTelemetrySnapshot) => void) | undefined;
  /**
   * Host language-intelligence resolvers (Issue #1201). When present, the editor registers the
   * corresponding Monaco surface (diagnostics markers, hover widget, document-symbol outline,
   * explicit "format document") that bridges to the host's governed `/api/editor/language` BFF call.
   * Absent for non-source buffers, where no governed deterministic provider exists.
   */
  readonly provideDiagnostics?: EditorDiagnosticsResolver | undefined;
  readonly provideHover?: EditorHoverResolver | undefined;
  readonly provideSymbols?: EditorSymbolsResolver | undefined;
  readonly provideFormatting?: EditorFormattingResolver | undefined;
  readonly provideDefinition?: EditorDefinitionResolver | undefined;
  readonly uriForPath?: KeikoCodeEditorProps["uriForPath"] | undefined;
  readonly provideReferences?: EditorReferencesResolver | undefined;
  readonly provideCodeActions?: EditorCodeActionsResolver | undefined;
  readonly provideSignatureHelp?: EditorSignatureHelpResolver | undefined;
  readonly formatRequestNonce?: number | undefined;
  /** Content-free diagnostic-count observer for the host status bar (Issue #1205). */
  readonly onDiagnosticsSummary?: ((summary: EditorDiagnosticsSummary) => void) | undefined;
  /** Host handler for the palette/keybinding "Generate Tests" command (Issue #1205). */
  readonly onGenerateTests?: (() => void) | undefined;
  /** Host handler for the selection-only Ask Keiko command (Issue #2119). */
  readonly onAskKeikoAboutSelection?: KeikoCodeEditorProps["onAskKeikoAboutSelection"] | undefined;
  /** Host handler for the F2 Rename Symbol command (Epic #2089, Issue #2105). */
  readonly onRenameSymbol?: (() => void) | undefined;
  /**
   * Whether the editor renders its own save/truncation footer (Issue #1205). The card sets this to
   * `false` because it renders the unified {@link EditorStatusBar} as the single status surface.
   */
  readonly showStatusFooter?: boolean | undefined;
}

function EditorSurface(props: EditorSurfaceProps): ReactElement {
  // Idempotent and cheap after the first call; computing it in render means the very first paint
  // already reflects an unsupported runtime instead of flashing an editor that cannot mount.
  const runtime = ensureMonacoRuntime();
  const languageId = props.fileModel.identity.language;
  const onRuntimeError = props.onRuntimeError;
  const [languageReady, setLanguageReady] = useState(() => isMonacoLanguageReady(languageId));

  useEffect(() => {
    if (!runtime.supported) {
      setLanguageReady(true);
      return;
    }
    if (isMonacoLanguageReady(languageId)) {
      setLanguageReady(true);
      return;
    }
    let cancelled = false;
    setLanguageReady(false);
    void ensureMonacoLanguage(languageId)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        onRuntimeError?.(`Failed to load Monaco language '${languageId}': ${message}`);
      })
      .finally(() => {
        if (!cancelled) {
          setLanguageReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [languageId, onRuntimeError, runtime.supported]);

  const loadState: KeikoEditorLoadState = runtime.supported
    ? languageReady
      ? props.fileLoadState
      : { status: "loading" }
    : { status: "error", message: runtime.message };

  return (
    <KeikoCodeEditor
      buffer={props.buffer}
      fileModel={props.fileModel}
      loadState={loadState}
      saveStatus={props.saveStatus}
      saveError={props.saveError}
      modifiedAt={props.modifiedAt}
      maxSizeBytes={props.maxSizeBytes}
      themeVariant={props.themeVariant}
      ariaLabel={props.ariaLabel}
      onContentChange={props.onContentChange}
      onSaveRequested={props.onSaveRequested}
      onSelectionChange={props.onSelectionChange}
      onCursorChange={props.onCursorChange}
      revealRequest={props.revealRequest}
      hostEditRequest={props.hostEditRequest}
      onRuntimeError={onRuntimeError}
      provideCompletions={props.provideCompletions}
      completionTriggerCharacters={props.completionTriggerCharacters}
      provideInlineCompletions={props.provideInlineCompletions}
      onInlineCompletionTelemetry={props.onInlineCompletionTelemetry}
      provideDiagnostics={props.provideDiagnostics}
      provideHover={props.provideHover}
      provideSymbols={props.provideSymbols}
      provideFormatting={props.provideFormatting}
      provideDefinition={props.provideDefinition}
      uriForPath={props.uriForPath}
      provideReferences={props.provideReferences}
      provideCodeActions={props.provideCodeActions}
      provideSignatureHelp={props.provideSignatureHelp}
      formatRequestNonce={props.formatRequestNonce}
      onDiagnosticsSummary={props.onDiagnosticsSummary}
      onGenerateTests={props.onGenerateTests}
      onAskKeikoAboutSelection={props.onAskKeikoAboutSelection}
      onRenameSymbol={props.onRenameSymbol}
      showStatusFooter={props.showStatusFooter}
    />
  );
}

/**
 * Memoized so frequent host re-renders that leave the editor-relevant props untouched do not
 * re-reconcile the Monaco surface. The host re-renders on every cursor/selection move and on each
 * diagnostic-count update, but `buffer` is memoized and the resolver callbacks are `useCallback`-stable,
 * so on those renders every prop here is referentially equal and `React.memo` skips the surface.
 * `React.memo` only bails on shallow-equal props, so it can never paint stale content.
 */
export default memo(EditorSurface);
