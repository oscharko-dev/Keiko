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
import { type ReactElement } from "react";
import {
  KeikoCodeEditor,
  type EditorBuffer,
  type EditorChangeOrigin,
  type EditorCompletionResolver,
  type EditorContentDelta,
  type EditorDiagnosticsResolver,
  type EditorFileModel,
  type EditorFormattingResolver,
  type EditorHoverResolver,
  type EditorInlineCompletionResolver,
  type EditorPosition,
  type EditorRange,
  type EditorSaveRequest,
  type EditorSaveStatus,
  type EditorSymbolsResolver,
  type EditorThemeVariant,
  type InlineCompletionTelemetrySnapshot,
  type KeikoEditorLoadState,
} from "@oscharko-dev/keiko-editor";

import { ensureMonacoRuntime } from "./editorMonacoRuntime";

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
    | ((snapshot: InlineCompletionTelemetrySnapshot) => void)
    | undefined;
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
}

export default function EditorSurface(props: EditorSurfaceProps): ReactElement {
  // Idempotent and cheap after the first call; computing it in render means the very first paint
  // already reflects an unsupported runtime instead of flashing an editor that cannot mount.
  const runtime = ensureMonacoRuntime();
  const loadState: KeikoEditorLoadState = runtime.supported
    ? props.fileLoadState
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
      onRuntimeError={props.onRuntimeError}
      provideCompletions={props.provideCompletions}
      completionTriggerCharacters={props.completionTriggerCharacters}
      provideInlineCompletions={props.provideInlineCompletions}
      onInlineCompletionTelemetry={props.onInlineCompletionTelemetry}
      provideDiagnostics={props.provideDiagnostics}
      provideHover={props.provideHover}
      provideSymbols={props.provideSymbols}
      provideFormatting={props.provideFormatting}
    />
  );
}
