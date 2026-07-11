/**
 * The Monaco change/mount handlers and lifecycle refs for
 * {@link import("./KeikoCodeEditor.js").KeikoCodeEditor} (Issue #1194).
 *
 * Isolates the imperative editor wiring (controlled-change emission, mount wiring, view-state
 * preservation, unmount disposal) into small hooks so the component body stays a thin render. The
 * DOM/Monaco edges are touched only inside the returned callbacks/effect, never at module scope.
 */
import { type OnChange, type OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";

import { buildSaveRequest } from "./save-state.js";
import type { KeikoCodeEditorProps } from "./types.js";
import { applyViewState, captureViewState } from "./view-state.js";
import {
  reapplyEditorTheme,
  wireEditorOnMount,
  type MountEditor,
  type MountMonaco,
} from "./on-mount.js";
import type {
  WireEditorCommands,
  WireEditorCodeActions,
  WireEditorCompletion,
  WireEditorDefinition,
  WireEditorDiagnostics,
  WireEditorFormatting,
  WireEditorHover,
  WireEditorInlineCompletion,
  WireEditorInlayHints,
  WireEditorCallHierarchy,
  WireEditorReferences,
  WireEditorSignatureHelp,
  WireEditorSymbols,
  WireEditorGitGutter,
  WireEditorBlame,
  WireEditorConflicts,
} from "./on-mount.js";
import type { EditorGitGutterBridge, EditorGitGutterChanges } from "./git-gutter-bridge.js";
import type { EditorCallHierarchyResponse } from "./call-hierarchy-bridge.js";
import type { EditorInlayHintsResponse } from "./inlay-hints-bridge.js";
import type {
  EditorCodeActionsResponse,
  EditorCompletionResponse,
  EditorDefinitionResponse,
  EditorDiagnosticsResponse,
  EditorFormattingResponse,
  EditorHoverResponse,
  EditorInlineCompletionResponse,
  EditorReferencesResponse,
  EditorSignatureHelpResponse,
  EditorSymbolsResponse,
  EditorChangeOrigin,
} from "../index.js";
import {
  createEditorRequestId,
  DEFAULT_COMPLETION_CONTEXT_BUDGET_BYTES,
  DEFAULT_COMPLETION_TRIGGER_CHARACTERS,
  editorRangeToMonaco,
  type MonacoRange,
} from "./completion-bridge.js";
import { MONACO_BUILTIN_ACTION_IDS } from "./command-actions.js";
import {
  DEFAULT_INLINE_COMPLETION_CONTEXT_BUDGET_BYTES,
  DEFAULT_INLINE_COMPLETION_DEBOUNCE_MS,
} from "./inline-completion-bridge.js";
import {
  DEFAULT_DIAGNOSTICS_DEBOUNCE_MS,
  type DiagnosticOverviewMarker,
} from "./diagnostics-bridge.js";
import {
  createInlineCompletionTelemetry,
  type InlineCompletionTelemetry,
} from "./inline-completion-telemetry.js";
import { deriveLargeFileMode } from "./large-file-mode.js";

export interface EditorHandlers {
  readonly onChange: OnChange;
  readonly onMount: OnMount;
  readonly formatDocument: () => void;
  readonly revealDiagnosticMarker: (marker: DiagnosticOverviewMarker) => void;
  readonly refreshGitGutter: () => void;
}

// A single module-scope UTF-8 encoder shared across every change event. `TextEncoder` is stateless
// between `encode` calls, so one instance is safe to reuse; constructing a fresh encoder per
// keystroke (as the previous code did) allocated a throwaway object on every hot-path change. The
// host owns its own `UTF8_ENCODER`; this is the package-side equivalent so the controlled editor
// never allocates an encoder per change.
const CHANGE_UTF8_ENCODER = new TextEncoder();

type OverviewMarkersHandler = (markers: readonly DiagnosticOverviewMarker[]) => void;
type CallHierarchyResultHandler = (response: EditorCallHierarchyResponse) => void;

interface ProgrammaticEditorChange {
  readonly text: string;
  readonly origin: EditorChangeOrigin;
}

type ProgrammaticEditorChangeRef = MutableRefObject<ProgrammaticEditorChange | null>;

interface EditorRefs {
  readonly editorRef: MutableRefObject<MountEditor | null>;
  readonly monacoRef: MutableRefObject<MountMonaco | null>;
  readonly containerRef: MutableRefObject<HTMLElement | null>;
  readonly viewStateRef: MutableRefObject<unknown>;
  readonly disposeRef: MutableRefObject<(() => void) | null>;
  readonly revealDecorationIdsRef: MutableRefObject<string[]>;
  readonly revealTimeoutRef: MutableRefObject<number | null>;
  readonly gitGutterBridgeRef: MutableRefObject<EditorGitGutterBridge | null>;
}

function useEditorRefs(): EditorRefs {
  const editorRef = useRef<MountEditor | null>(null);
  const monacoRef = useRef<MountMonaco | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const viewStateRef = useRef<unknown>(null);
  const disposeRef = useRef<(() => void) | null>(null);
  const revealDecorationIdsRef = useRef<string[]>([]);
  const revealTimeoutRef = useRef<number | null>(null);
  const gitGutterBridgeRef = useRef<EditorGitGutterBridge | null>(null);
  return useMemo(
    () => ({
      editorRef,
      monacoRef,
      containerRef,
      viewStateRef,
      disposeRef,
      revealDecorationIdsRef,
      revealTimeoutRef,
      gitGutterBridgeRef,
    }),
    [
      editorRef,
      monacoRef,
      containerRef,
      viewStateRef,
      disposeRef,
      revealDecorationIdsRef,
      revealTimeoutRef,
      gitGutterBridgeRef,
    ],
  );
}

function clearRevealDecoration(refs: EditorRefs): void {
  if (refs.revealTimeoutRef.current !== null) {
    window.clearTimeout(refs.revealTimeoutRef.current);
    refs.revealTimeoutRef.current = null;
  }
  const editor = refs.editorRef.current;
  if (editor === null || refs.revealDecorationIdsRef.current.length === 0) return;
  refs.revealDecorationIdsRef.current = editor.deltaDecorations(
    refs.revealDecorationIdsRef.current,
    [],
  );
}

function applyRevealRequest(
  refs: EditorRefs,
  revealRequest: KeikoCodeEditorProps["revealRequest"],
): void {
  const editor = refs.editorRef.current;
  if (editor === null || revealRequest === undefined) return;
  const monacoRange = editorRangeToMonaco(revealRequest.range);
  const safeRange = {
    startLineNumber: Math.max(1, monacoRange.startLineNumber),
    startColumn: 1,
    endLineNumber: Math.max(monacoRange.startLineNumber, monacoRange.endLineNumber),
    endColumn: Math.max(1, monacoRange.endColumn),
  };
  clearRevealDecoration(refs);
  editor.focus();
  editor.setSelection(safeRange);
  // Keep the whole-line highlight, but place the cursor at the actual symbol/reference column so
  // cursor-derived breadcrumbs can resolve an indented nested symbol instead of only its parent.
  editor.setPosition({
    lineNumber: safeRange.startLineNumber,
    column: Math.max(1, monacoRange.startColumn),
  });
  editor.revealRangeInCenterIfOutsideViewport(safeRange);
  refs.revealDecorationIdsRef.current = editor.deltaDecorations(
    [],
    [
      {
        range: safeRange,
        options: {
          isWholeLine: true,
          className: "keiko-editor-reference-target",
        },
      },
    ],
  );
  refs.revealTimeoutRef.current = window.setTimeout(() => {
    clearRevealDecoration(refs);
  }, 2400);
}

function revealDiagnosticMarker(refs: EditorRefs, marker: DiagnosticOverviewMarker): void {
  const editor = refs.editorRef.current;
  if (editor === null) return;
  const startLineNumber = Math.max(1, marker.startLineNumber);
  const startColumn = Math.max(1, marker.startColumn);
  const endLineNumber = Math.max(startLineNumber, marker.endLineNumber);
  const endColumn = Math.max(startColumn + 1, marker.endColumn);
  const range = { startLineNumber, startColumn, endLineNumber, endColumn };
  editor.focus();
  editor.setSelection(range);
  editor.setPosition({ lineNumber: startLineNumber, column: startColumn });
  editor.revealRangeInCenterIfOutsideViewport(range);
}

function useSaveEmitter(
  props: KeikoCodeEditorProps,
  editorRef: MutableRefObject<MountEditor | null>,
  readOnly: boolean,
): () => void {
  // The save command is registered into Monaco ONCE at mount: `@monaco-editor/react` captures the
  // `onMount` prop into a ref at first render and never re-reads a later identity. A plain closure
  // over `props` would therefore persist the mount-time text and silently discard every later edit.
  // Read the live values from a render-updated ref so Cmd/Ctrl+S always saves the current buffer.
  const latest = useRef({ props, readOnly });
  latest.current = { props, readOnly };
  return useCallback((): void => {
    const { props: current, readOnly: currentReadOnly } = latest.current;
    if (editorRef.current === null || currentReadOnly) {
      return;
    }
    current.onSaveRequested(
      buildSaveRequest(
        current.fileModel.identity,
        current.buffer.content.text,
        current.buffer.content.relativePath,
        current.fileModel.savedVersion,
      ),
    );
  }, [editorRef]);
}

// Exported for the per-keystroke allocation regression test (GEN-PERF-EDITOR-005): the hot-path
// change handler must reuse the module-scope encoder and never construct a fresh `TextEncoder` per
// change. Not part of the public package surface.
export function useChangeHandler(
  onContentChange: KeikoCodeEditorProps["onContentChange"],
  readOnly: boolean,
  programmaticChangeRef?: ProgrammaticEditorChangeRef,
): OnChange {
  return useCallback<OnChange>(
    (value): void => {
      if (value === undefined || readOnly) {
        return;
      }
      const programmatic = programmaticChangeRef?.current;
      const origin = programmatic?.text === value ? programmatic.origin : "human";
      if (programmaticChangeRef !== undefined && programmatic?.text === value) {
        programmaticChangeRef.current = null;
      }
      onContentChange({ text: value, sizeBytes: CHANGE_UTF8_ENCODER.encode(value).length }, origin);
    },
    [readOnly, onContentChange, programmaticChangeRef],
  );
}

function wholeModelRange(editor: MountEditor): MonacoRange | null {
  const model = editor.getModel?.();
  if (model === undefined || model === null) return null;
  const lineCount = model.getLineCount();
  return {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: lineCount,
    endColumn: model.getLineMaxColumn(lineCount),
  };
}

function emitHostEditFallback(
  request: NonNullable<KeikoCodeEditorProps["hostEditRequest"]>,
  onContentChange: KeikoCodeEditorProps["onContentChange"],
): void {
  onContentChange(
    { text: request.text, sizeBytes: CHANGE_UTF8_ENCODER.encode(request.text).length },
    request.origin,
  );
}

function applyHostEditRequest(
  request: NonNullable<KeikoCodeEditorProps["hostEditRequest"]>,
  refs: EditorRefs,
  onContentChange: KeikoCodeEditorProps["onContentChange"],
  programmaticChangeRef: ProgrammaticEditorChangeRef,
): void {
  const editor = refs.editorRef.current;
  const range = editor === null ? null : wholeModelRange(editor);
  if (editor?.executeEdits === undefined || range === null) {
    emitHostEditFallback(request, onContentChange);
    return;
  }
  programmaticChangeRef.current = { text: request.text, origin: request.origin };
  editor.pushUndoStop?.();
  const applied = editor.executeEdits("keiko.host-edit", [{ range, text: request.text }]);
  editor.pushUndoStop?.();
  if (!applied) {
    programmaticChangeRef.current = null;
    emitHostEditFallback(request, onContentChange);
  }
}

function useHostEditRequest(
  props: KeikoCodeEditorProps,
  refs: EditorRefs,
  programmaticChangeRef: ProgrammaticEditorChangeRef,
): void {
  const handledRequestIdRef = useRef<string | null>(null);
  useEffect(() => {
    const request = props.hostEditRequest;
    if (request === undefined || handledRequestIdRef.current === request.id) return;
    const applyIfMounted = (): void => {
      if (refs.editorRef.current === null || handledRequestIdRef.current === request.id) return;
      handledRequestIdRef.current = request.id;
      applyHostEditRequest(request, refs, props.onContentChange, programmaticChangeRef);
    };
    if (refs.editorRef.current === null) {
      queueMicrotask(applyIfMounted);
      return;
    }
    applyIfMounted();
  }, [programmaticChangeRef, props.hostEditRequest, props.onContentChange, refs]);
}

// Builds the completion wiring from the live props ref so a resolver swap (e.g. the host opening a
// different file in the same editor mount, #1196) is always honoured — `@monaco-editor/react`
// captures `onMount` once, so the registered provider must read the latest resolver, not a
// mount-time closure. Returns undefined when the host supplies no resolver, so no provider is
// registered (no silent or placeholder completion affordance).
function buildCompletionWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
  streamId: string,
): WireEditorCompletion | undefined {
  if (latestProps.current.provideCompletions === undefined) {
    return undefined;
  }
  return {
    isCurrentDocument: isCurrentDocument(latestProps),
    resolve: (query, signal): Promise<EditorCompletionResponse> => {
      const live = latestProps.current.provideCompletions;
      return live === undefined
        ? Promise.reject(new Error("completion resolver unavailable"))
        : live(query, signal);
    },
    triggerCharacters:
      latestProps.current.completionTriggerCharacters ?? DEFAULT_COMPLETION_TRIGGER_CHARACTERS,
    contextBudgetBytes: DEFAULT_COMPLETION_CONTEXT_BUDGET_BYTES,
    streamId,
    newRequestId: createEditorRequestId,
  };
}

// Builds the inline-completion (ghost-text) wiring from the live props ref (Issue #1200), mirroring
// `buildCompletionWiring`. Returns undefined when the host supplies no inline resolver, so no inline
// provider is registered. The telemetry accumulator is created once per mount and forwards each
// content-free snapshot to the live `onInlineCompletionTelemetry` prop.
function buildInlineCompletionWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
  streamId: string,
  telemetry: InlineCompletionTelemetry,
): WireEditorInlineCompletion | undefined {
  if (latestProps.current.provideInlineCompletions === undefined) {
    return undefined;
  }
  return {
    isCurrentDocument: isCurrentDocument(latestProps),
    resolve: (query, signal): Promise<EditorInlineCompletionResponse> => {
      const live = latestProps.current.provideInlineCompletions;
      return live === undefined
        ? Promise.reject(new Error("inline completion resolver unavailable"))
        : live(query, signal);
    },
    contextBudgetBytes: DEFAULT_INLINE_COMPLETION_CONTEXT_BUDGET_BYTES,
    streamId,
    newRequestId: createEditorRequestId,
    debounceDelayMs:
      latestProps.current.inlineCompletionDebounceMs ?? DEFAULT_INLINE_COMPLETION_DEBOUNCE_MS,
    telemetry,
  };
}

// Builds the diagnostics wiring from the live props ref (Issue #1201), mirroring the completion
// builders. Returns undefined when the host supplies no diagnostics resolver, so no markers run.
function buildDiagnosticsWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
  streamId: string,
  onOverviewMarkers: OverviewMarkersHandler | undefined,
): WireEditorDiagnostics | undefined {
  if (latestProps.current.provideDiagnostics === undefined) {
    return undefined;
  }
  return {
    resolve: (query, signal): Promise<EditorDiagnosticsResponse> => {
      const live = latestProps.current.provideDiagnostics;
      return live === undefined
        ? Promise.reject(new Error("diagnostics resolver unavailable"))
        : live(query, signal);
    },
    debounceMs: latestProps.current.diagnosticsDebounceMs ?? DEFAULT_DIAGNOSTICS_DEBOUNCE_MS,
    streamId,
    newRequestId: createEditorRequestId,
    // Read the live observer at call time so a later `onDiagnosticsSummary` identity is honoured
    // without re-registering the bridge (the diagnostics provider registers once at mount).
    onSummary: (summary): void => {
      latestProps.current.onDiagnosticsSummary?.(summary);
    },
    onDiagnostics: (diagnostics): void => {
      latestProps.current.onDiagnostics?.(diagnostics);
    },
    ...(onOverviewMarkers === undefined ? {} : { onOverviewMarkers }),
  };
}

// Builds the host command-action wiring (Issue #1205). Returns undefined when the host offers no
// command handler, so no Keiko action is registered into Monaco's palette. Each run reads the live
// prop so a handler swap (e.g. the host opening a different file) is honoured.
function buildCommandsWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
): WireEditorCommands | undefined {
  if (
    latestProps.current.onGenerateTests === undefined &&
    latestProps.current.onAskKeikoAboutSelection === undefined &&
    latestProps.current.onRenameSymbol === undefined
  ) {
    return undefined;
  }
  return {
    ...(latestProps.current.onGenerateTests === undefined
      ? {}
      : {
          generateTests: (): void => {
            latestProps.current.onGenerateTests?.();
          },
        }),
    ...(latestProps.current.onAskKeikoAboutSelection === undefined
      ? {}
      : {
          askKeikoAboutSelection: (selection): void => {
            latestProps.current.onAskKeikoAboutSelection?.(selection);
          },
        }),
    ...(latestProps.current.onRenameSymbol === undefined
      ? {}
      : {
          renameSymbol: (): void => {
            latestProps.current.onRenameSymbol?.();
          },
        }),
  };
}

function isCurrentDocument(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
): (documentUri: string) => boolean {
  return (documentUri): boolean => latestProps.current.fileModel.identity.uri === documentUri;
}

// Builds the hover wiring from the live props ref (Issue #1201). Returns undefined when the host
// supplies no hover resolver, so no hover provider is registered.
function buildHoverWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
  streamId: string,
): WireEditorHover | undefined {
  if (latestProps.current.provideHover === undefined) {
    return undefined;
  }
  return {
    isCurrentDocument: isCurrentDocument(latestProps),
    resolve: (query, signal): Promise<EditorHoverResponse> => {
      const live = latestProps.current.provideHover;
      return live === undefined
        ? Promise.reject(new Error("hover resolver unavailable"))
        : live(query, signal);
    },
    streamId,
    newRequestId: createEditorRequestId,
  };
}

// Builds the document-symbol wiring from the live props ref (Issue #1201). Returns undefined when the
// host supplies no symbols resolver, so no symbol provider is registered.
function buildSymbolsWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
  streamId: string,
): WireEditorSymbols | undefined {
  if (latestProps.current.provideSymbols === undefined) {
    return undefined;
  }
  return {
    isCurrentDocument: isCurrentDocument(latestProps),
    resolve: (query, signal): Promise<EditorSymbolsResponse> => {
      const live = latestProps.current.provideSymbols;
      return live === undefined
        ? Promise.reject(new Error("symbols resolver unavailable"))
        : live(query, signal);
    },
    streamId,
    newRequestId: createEditorRequestId,
  };
}

// Builds the document-formatting wiring from the live props ref (Issue #1201). Returns undefined when
// the host supplies no formatting resolver, so no formatting provider is registered.
function buildFormattingWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
  streamId: string,
): WireEditorFormatting | undefined {
  if (latestProps.current.provideFormatting === undefined) {
    return undefined;
  }
  return {
    isCurrentDocument: isCurrentDocument(latestProps),
    resolve: (query, signal): Promise<EditorFormattingResponse> => {
      const live = latestProps.current.provideFormatting;
      return live === undefined
        ? Promise.reject(new Error("formatting resolver unavailable"))
        : live(query, signal);
    },
    streamId,
    newRequestId: createEditorRequestId,
  };
}

function buildDefinitionWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
  streamId: string,
): WireEditorDefinition | undefined {
  if (latestProps.current.provideDefinition === undefined) {
    return undefined;
  }
  return {
    isCurrentDocument: isCurrentDocument(latestProps),
    resolve: (query, signal): Promise<EditorDefinitionResponse> => {
      const live = latestProps.current.provideDefinition;
      return live === undefined
        ? Promise.reject(new Error("definition resolver unavailable"))
        : live(query, signal);
    },
    uriForPath: latestProps.current.uriForPath,
    streamId,
    newRequestId: createEditorRequestId,
  };
}

function buildTypeDefinitionWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
  streamId: string,
): WireEditorDefinition | undefined {
  if (latestProps.current.provideTypeDefinition === undefined) return undefined;
  return {
    isCurrentDocument: isCurrentDocument(latestProps),
    resolve: (query, signal): Promise<EditorDefinitionResponse> => {
      const live = latestProps.current.provideTypeDefinition;
      return live === undefined
        ? Promise.reject(new Error("type-definition resolver unavailable"))
        : live(query, signal);
    },
    uriForPath: latestProps.current.uriForPath,
    streamId,
    newRequestId: createEditorRequestId,
  };
}

function buildImplementationWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
  streamId: string,
): WireEditorDefinition | undefined {
  if (latestProps.current.provideImplementation === undefined) return undefined;
  return {
    isCurrentDocument: isCurrentDocument(latestProps),
    resolve: (query, signal): Promise<EditorDefinitionResponse> => {
      const live = latestProps.current.provideImplementation;
      return live === undefined
        ? Promise.reject(new Error("implementation resolver unavailable"))
        : live(query, signal);
    },
    uriForPath: latestProps.current.uriForPath,
    streamId,
    newRequestId: createEditorRequestId,
  };
}

function buildInlayHintsWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
  streamId: string,
): WireEditorInlayHints | undefined {
  if (latestProps.current.provideInlayHints === undefined) return undefined;
  return {
    isCurrentDocument: isCurrentDocument(latestProps),
    resolve: (query, signal): Promise<EditorInlayHintsResponse> => {
      const live = latestProps.current.provideInlayHints;
      return live === undefined
        ? Promise.reject(new Error("inlay-hints resolver unavailable"))
        : live(query, signal);
    },
    streamId,
    newRequestId: createEditorRequestId,
  };
}

function buildCallHierarchyWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
  streamId: string,
  onResult: CallHierarchyResultHandler | undefined,
): WireEditorCallHierarchy | undefined {
  const labels = latestProps.current.callHierarchyLabels;
  if (
    latestProps.current.provideCallHierarchy === undefined ||
    labels === undefined ||
    onResult === undefined
  )
    return undefined;
  return {
    isCurrentDocument: isCurrentDocument(latestProps),
    resolve: (query, signal): Promise<EditorCallHierarchyResponse> => {
      const live = latestProps.current.provideCallHierarchy;
      return live === undefined
        ? Promise.reject(new Error("call-hierarchy resolver unavailable"))
        : live(query, signal);
    },
    documentLanguage: latestProps.current.fileModel.identity.language,
    streamId,
    newRequestId: createEditorRequestId,
    labels: { command: labels.command },
    onResult,
  };
}

function buildReferencesWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
  streamId: string,
): WireEditorReferences | undefined {
  if (latestProps.current.provideReferences === undefined) {
    return undefined;
  }
  return {
    isCurrentDocument: isCurrentDocument(latestProps),
    resolve: (query, signal): Promise<EditorReferencesResponse> => {
      const live = latestProps.current.provideReferences;
      return live === undefined
        ? Promise.reject(new Error("references resolver unavailable"))
        : live(query, signal);
    },
    uriForPath: latestProps.current.uriForPath,
    streamId,
    newRequestId: createEditorRequestId,
  };
}

function buildCodeActionsWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
  streamId: string,
): WireEditorCodeActions | undefined {
  if (latestProps.current.provideCodeActions === undefined) {
    return undefined;
  }
  return {
    isCurrentDocument: isCurrentDocument(latestProps),
    resolve: (query, signal): Promise<EditorCodeActionsResponse> => {
      const live = latestProps.current.provideCodeActions;
      return live === undefined
        ? Promise.reject(new Error("code-action resolver unavailable"))
        : live(query, signal);
    },
    streamId,
    newRequestId: createEditorRequestId,
  };
}

function buildSignatureHelpWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
  streamId: string,
): WireEditorSignatureHelp | undefined {
  if (latestProps.current.provideSignatureHelp === undefined) {
    return undefined;
  }
  return {
    isCurrentDocument: isCurrentDocument(latestProps),
    resolve: (query, signal): Promise<EditorSignatureHelpResponse> => {
      const live = latestProps.current.provideSignatureHelp;
      return live === undefined
        ? Promise.reject(new Error("signature-help resolver unavailable"))
        : live(query, signal);
    },
    streamId,
    newRequestId: createEditorRequestId,
  };
}

function buildGitGutterWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
): WireEditorGitGutter | undefined {
  const gutter = latestProps.current.editorGitGutter;
  if (gutter === undefined) return undefined;
  const content = latestProps.current.buffer.content;
  const degraded =
    deriveLargeFileMode({ sizeBytes: content.sizeBytes, text: content.text }) === "degraded";
  return {
    degraded,
    labels: gutter.labels,
    onPeek: (peek): void => latestProps.current.editorGitGutter?.onPeek(peek),
    resolve: (): Promise<EditorGitGutterChanges> => {
      const live = latestProps.current.editorGitGutter;
      return live === undefined ? Promise.resolve({ staged: [], unstaged: [] }) : live.resolve();
    },
    onError: (message) => latestProps.current.onRuntimeError?.(message),
  };
}

function buildBlameWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
): WireEditorBlame | undefined {
  const blame = latestProps.current.editorBlame;
  if (blame === undefined) return undefined;
  const content = latestProps.current.buffer.content;
  return {
    ...blame,
    degraded:
      deriveLargeFileMode({ sizeBytes: content.sizeBytes, text: content.text }) === "degraded",
    dirty: () => latestProps.current.fileModel.dirty,
    resolve: () =>
      latestProps.current.editorBlame?.resolve() ?? Promise.reject(new Error("Blame unavailable")),
    onCommit: (hash) => latestProps.current.editorBlame?.onCommit(hash),
    onError: (message) => latestProps.current.onRuntimeError?.(message),
  };
}

function buildConflictWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
): WireEditorConflicts | undefined {
  const conflicts = latestProps.current.editorConflicts;
  if (conflicts === undefined) return undefined;
  const content = latestProps.current.buffer.content;
  return {
    degraded:
      deriveLargeFileMode({ sizeBytes: content.sizeBytes, text: content.text }) === "degraded",
    labels: conflicts.labels,
    onChange: (count, truncated): void =>
      latestProps.current.editorConflicts?.onChange(count, truncated),
    onStale: (): void => latestProps.current.editorConflicts?.onStale?.(),
  };
}

function captureGitGutterBridge(refs: EditorRefs): (bridge: EditorGitGutterBridge | null) => void {
  return (bridge): void => {
    refs.gitGutterBridgeRef.current = bridge;
  };
}

function availabilityBit(value: unknown): string {
  return value === undefined ? "0" : "1";
}

function runtimeWiringAvailabilityKey(props: KeikoCodeEditorProps): string {
  const availability = [
    props.provideCompletions,
    props.provideInlineCompletions,
    props.provideDiagnostics,
    props.provideHover,
    props.provideSymbols,
    props.provideFormatting,
    props.provideDefinition,
    props.provideTypeDefinition,
    props.provideImplementation,
    props.provideCallHierarchy,
    props.provideInlayHints,
    props.semanticTokens,
    props.provideReferences,
    props.provideCodeActions,
    props.provideSignatureHelp,
    props.onGenerateTests,
    props.onAskKeikoAboutSelection,
    props.onRenameSymbol,
    props.editorGitGutter,
    props.editorBlame,
    props.editorConflicts,
    deriveLargeFileMode({
      sizeBytes: props.buffer.content.sizeBytes,
      text: props.buffer.content.text,
    }),
  ]
    .map(availabilityBit)
    .join("");
  return `${availability}:${String(props.semanticTokens?.legendVersion ?? 0)}`;
}

// Stable per-editor-instance stream ids and the content-free telemetry accumulator. The completion
// and inline-completion streams are distinct so inline supersession never aliases the completion
// stream; the telemetry observer reads the live prop so a later `onInlineCompletionTelemetry`
// identity is honoured without re-registering the provider.
function useMountStreams(latestProps: MutableRefObject<KeikoCodeEditorProps>): {
  readonly streamId: string;
  readonly inlineStreamId: string;
  readonly telemetry: InlineCompletionTelemetry;
} {
  const streamIdRef = useRef<string | null>(null);
  const streamId = (streamIdRef.current ??= createEditorRequestId());
  const inlineStreamIdRef = useRef<string | null>(null);
  const inlineStreamId = (inlineStreamIdRef.current ??= `${streamId}:inline`);
  const telemetryRef = useRef<InlineCompletionTelemetry | null>(null);
  const telemetry = (telemetryRef.current ??= createInlineCompletionTelemetry((snapshot) => {
    latestProps.current.onInlineCompletionTelemetry?.(snapshot);
  }));
  return { streamId, inlineStreamId, telemetry };
}

interface MountRuntimeArgs {
  readonly editor: MountEditor;
  readonly monaco: unknown;
  readonly refs: EditorRefs;
  readonly emitSave: () => void;
  readonly latestProps: MutableRefObject<KeikoCodeEditorProps>;
  readonly streamId: string;
  readonly inlineStreamId: string;
  readonly telemetry: InlineCompletionTelemetry;
  readonly onOverviewMarkers: OverviewMarkersHandler | undefined;
  readonly onCallHierarchyResult: CallHierarchyResultHandler | undefined;
  readonly onCursorChange: KeikoCodeEditorProps["onCursorChange"];
  readonly onSelectionChange: KeikoCodeEditorProps["onSelectionChange"];
  readonly onRuntimeError: KeikoCodeEditorProps["onRuntimeError"];
  readonly themeVariant: KeikoCodeEditorProps["themeVariant"];
  readonly autoFocus: KeikoCodeEditorProps["autoFocus"];
}

function mountEditorRuntime(args: MountRuntimeArgs): void {
  args.refs.editorRef.current = args.editor;
  args.refs.monacoRef.current = args.monaco as MountMonaco;
  args.refs.containerRef.current = args.editor.getContainerDomNode();
  applyViewState(args.editor, args.refs.viewStateRef.current);
  args.refs.disposeRef.current = wireEditorOnMount({
    editor: args.editor,
    monaco: args.monaco as MountMonaco,
    container: args.refs.containerRef.current,
    themeVariant: args.themeVariant ?? "dark",
    autoFocus: args.autoFocus ?? false,
    onSave: args.emitSave,
    onCursorChange: args.onCursorChange,
    onSelectionChange: args.onSelectionChange,
    onThemeError: args.onRuntimeError,
    completion: buildCompletionWiring(args.latestProps, args.streamId),
    inlineCompletion: buildInlineCompletionWiring(
      args.latestProps,
      args.inlineStreamId,
      args.telemetry,
    ),
    diagnostics: buildDiagnosticsWiring(
      args.latestProps,
      `${args.streamId}:diagnostics`,
      args.onOverviewMarkers,
    ),
    hover: buildHoverWiring(args.latestProps, `${args.streamId}:hover`),
    symbols: buildSymbolsWiring(args.latestProps, `${args.streamId}:symbols`),
    formatting: buildFormattingWiring(args.latestProps, `${args.streamId}:formatting`),
    definition: buildDefinitionWiring(args.latestProps, `${args.streamId}:definition`),
    typeDefinition: buildTypeDefinitionWiring(args.latestProps, `${args.streamId}:type-definition`),
    implementation: buildImplementationWiring(args.latestProps, `${args.streamId}:implementation`),
    callHierarchy: buildCallHierarchyWiring(
      args.latestProps,
      `${args.streamId}:call-hierarchy`,
      args.onCallHierarchyResult,
    ),
    inlayHints: buildInlayHintsWiring(args.latestProps, `${args.streamId}:inlay-hints`),
    semanticTokens: args.latestProps.current.semanticTokens,
    references: buildReferencesWiring(args.latestProps, `${args.streamId}:references`),
    codeActions: buildCodeActionsWiring(args.latestProps, `${args.streamId}:codeActions`),
    signatureHelp: buildSignatureHelpWiring(args.latestProps, `${args.streamId}:signatureHelp`),
    commands: buildCommandsWiring(args.latestProps),
    gitGutter: buildGitGutterWiring(args.latestProps),
    blame: buildBlameWiring(args.latestProps),
    conflicts: buildConflictWiring(args.latestProps),
    onGitGutterBridge: captureGitGutterBridge(args.refs),
  });
  applyRevealRequest(args.refs, args.latestProps.current.revealRequest);
}

interface RuntimeWiringRefreshArgs extends Omit<
  MountRuntimeArgs,
  "editor" | "monaco" | "autoFocus"
> {
  readonly availabilityKey: string;
}

type RuntimeWiringBaseArgs = Omit<RuntimeWiringRefreshArgs, "availabilityKey">;

function refreshEditorRuntime(args: RuntimeWiringRefreshArgs): void {
  const editor = args.refs.editorRef.current;
  const monaco = args.refs.monacoRef.current;
  const container = args.refs.containerRef.current;
  if (editor === null || monaco === null || container === null) return;
  args.refs.viewStateRef.current = captureViewState(editor);
  args.refs.disposeRef.current?.();
  args.refs.disposeRef.current = null;
  mountEditorRuntime({ ...args, editor, monaco, autoFocus: false });
}

function useRuntimeWiringRefresh(args: RuntimeWiringRefreshArgs): void {
  const mountedAvailabilityKey = useRef<string | null>(null);
  useEffect(() => {
    const previous = mountedAvailabilityKey.current;
    mountedAvailabilityKey.current = args.availabilityKey;
    if (previous === null || previous === args.availabilityKey) return;
    refreshEditorRuntime(args);
  }, [args]);
}

function useRuntimeWiringBaseArgs(args: RuntimeWiringBaseArgs): RuntimeWiringBaseArgs {
  return useMemo<RuntimeWiringBaseArgs>(
    () => args,
    [
      args.refs,
      args.emitSave,
      args.latestProps,
      args.streamId,
      args.inlineStreamId,
      args.telemetry,
      args.onOverviewMarkers,
      args.onCallHierarchyResult,
      args.onCursorChange,
      args.onSelectionChange,
      args.onRuntimeError,
      args.themeVariant,
      args.refs.gitGutterBridgeRef,
    ],
  );
}

function useMountHandler(
  props: KeikoCodeEditorProps,
  refs: EditorRefs,
  emitSave: () => void,
  onOverviewMarkers: OverviewMarkersHandler | undefined,
  onCallHierarchyResult: CallHierarchyResultHandler | undefined,
): OnMount {
  const { onCursorChange, onSelectionChange, onRuntimeError, themeVariant, autoFocus } = props;
  const latestProps = useRef(props);
  latestProps.current = props;
  const { streamId, inlineStreamId, telemetry } = useMountStreams(latestProps);
  const availabilityKey = runtimeWiringAvailabilityKey(props);
  const baseArgs = useRuntimeWiringBaseArgs({
    refs,
    emitSave,
    latestProps,
    streamId,
    inlineStreamId,
    telemetry,
    onOverviewMarkers,
    onCallHierarchyResult,
    onCursorChange,
    onSelectionChange,
    onRuntimeError,
    themeVariant,
  });
  const refreshArgs = useMemo<RuntimeWiringRefreshArgs>(
    () => ({ ...baseArgs, availabilityKey }),
    [availabilityKey, baseArgs],
  );
  useRuntimeWiringRefresh(refreshArgs);
  return useCallback<OnMount>(
    (editor, monaco): void => {
      mountEditorRuntime({ ...baseArgs, editor, monaco, autoFocus });
    },
    [autoFocus, baseArgs],
  );
}

function useUnmountDisposal(refs: EditorRefs): void {
  const { editorRef, viewStateRef, disposeRef } = refs;
  useEffect((): (() => void) => {
    return (): void => {
      clearRevealDecoration(refs);
      if (editorRef.current !== null) {
        viewStateRef.current = captureViewState(editorRef.current);
      }
      disposeRef.current?.();
      disposeRef.current = null;
      editorRef.current = null;
    };
  }, [editorRef, viewStateRef, disposeRef]);
}

function useRevealRequest(props: KeikoCodeEditorProps, refs: EditorRefs): void {
  useEffect(() => {
    applyRevealRequest(refs, props.revealRequest);
  }, [props.revealRequest?.id, refs]);
}

// Re-theme the live editor when the app theme switches, instead of remounting (Issue 2.2). The mount
// run is skipped (the mount wiring already registered the theme); every later `themeVariant` change
// re-defines the variant from the now-current DOM tokens and applies it, so the undo stack and scroll/
// fold/cursor view state survive a light/dark toggle.
function useThemeReapply(props: KeikoCodeEditorProps, refs: EditorRefs): void {
  const { themeVariant, onRuntimeError } = props;
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const monaco = refs.monacoRef.current;
    const container = refs.containerRef.current;
    if (monaco === null || container === null) return;
    reapplyEditorTheme({
      monaco,
      container,
      themeVariant: themeVariant ?? "dark",
      onThemeError: onRuntimeError,
    });
  }, [themeVariant, onRuntimeError, refs.monacoRef, refs.containerRef]);
}

/** Wire change/mount handlers and unmount disposal; returns the handlers for `<Editor>`. */
export function useEditorHandlers(
  props: KeikoCodeEditorProps,
  readOnly: boolean,
  onOverviewMarkers?: OverviewMarkersHandler,
  onCallHierarchyResult?: CallHierarchyResultHandler,
): EditorHandlers {
  const refs = useEditorRefs();
  const programmaticChangeRef = useRef<ProgrammaticEditorChange | null>(null);
  const emitSave = useSaveEmitter(props, refs.editorRef, readOnly);
  const onChange = useChangeHandler(props.onContentChange, readOnly, programmaticChangeRef);
  const onMount = useMountHandler(props, refs, emitSave, onOverviewMarkers, onCallHierarchyResult);
  const formatDocument = useCallback((): void => {
    const editor = refs.editorRef.current;
    if (editor === null || readOnly) return;
    void editor.getAction(MONACO_BUILTIN_ACTION_IDS.format)?.run();
  }, [readOnly, refs.editorRef]);
  const revealDiagnostic = useCallback(
    (marker: DiagnosticOverviewMarker): void => {
      revealDiagnosticMarker(refs, marker);
    },
    [refs],
  );
  const refreshGitGutter = useCallback((): void => {
    refs.gitGutterBridgeRef.current?.refresh();
  }, [refs.gitGutterBridgeRef]);
  useUnmountDisposal(refs);
  useHostEditRequest(props, refs, programmaticChangeRef);
  useRevealRequest(props, refs);
  useThemeReapply(props, refs);
  return {
    onChange,
    onMount,
    formatDocument,
    revealDiagnosticMarker: revealDiagnostic,
    refreshGitGutter,
  };
}
