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
import { wireEditorOnMount, type MountEditor, type MountMonaco } from "./on-mount.js";
import type {
  WireEditorCommands,
  WireEditorCompletion,
  WireEditorDiagnostics,
  WireEditorFormatting,
  WireEditorHover,
  WireEditorInlineCompletion,
  WireEditorSymbols,
} from "./on-mount.js";
import type {
  EditorCompletionResponse,
  EditorDiagnosticsResponse,
  EditorFormattingResponse,
  EditorHoverResponse,
  EditorInlineCompletionResponse,
  EditorSymbolsResponse,
} from "../index.js";
import {
  createEditorRequestId,
  DEFAULT_COMPLETION_CONTEXT_BUDGET_BYTES,
  DEFAULT_COMPLETION_TRIGGER_CHARACTERS,
  editorRangeToMonaco,
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

export interface EditorHandlers {
  readonly onChange: OnChange;
  readonly onMount: OnMount;
  readonly formatDocument: () => void;
  readonly revealDiagnosticMarker: (marker: DiagnosticOverviewMarker) => void;
}

type OverviewMarkersHandler = (markers: readonly DiagnosticOverviewMarker[]) => void;

interface EditorRefs {
  readonly editorRef: MutableRefObject<MountEditor | null>;
  readonly viewStateRef: MutableRefObject<unknown>;
  readonly disposeRef: MutableRefObject<(() => void) | null>;
  readonly revealDecorationIdsRef: MutableRefObject<string[]>;
  readonly revealTimeoutRef: MutableRefObject<number | null>;
}

function useEditorRefs(): EditorRefs {
  const editorRef = useRef<MountEditor | null>(null);
  const viewStateRef = useRef<unknown>(null);
  const disposeRef = useRef<(() => void) | null>(null);
  const revealDecorationIdsRef = useRef<string[]>([]);
  const revealTimeoutRef = useRef<number | null>(null);
  return useMemo(
    () => ({ editorRef, viewStateRef, disposeRef, revealDecorationIdsRef, revealTimeoutRef }),
    [editorRef, viewStateRef, disposeRef, revealDecorationIdsRef, revealTimeoutRef],
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

function useChangeHandler(
  onContentChange: KeikoCodeEditorProps["onContentChange"],
  readOnly: boolean,
): OnChange {
  return useCallback<OnChange>(
    (value): void => {
      if (value === undefined || readOnly) {
        return;
      }
      onContentChange({ text: value, sizeBytes: new TextEncoder().encode(value).length }, "human");
    },
    [readOnly, onContentChange],
  );
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
    ...(onOverviewMarkers === undefined ? {} : { onOverviewMarkers }),
  };
}

// Builds the host command-action wiring (Issue #1205). Returns undefined when the host offers no
// command handler, so no Keiko action is registered into Monaco's palette. Each run reads the live
// prop so a handler swap (e.g. the host opening a different file) is honoured.
function buildCommandsWiring(
  latestProps: MutableRefObject<KeikoCodeEditorProps>,
): WireEditorCommands | undefined {
  if (latestProps.current.onGenerateTests === undefined) {
    return undefined;
  }
  return {
    generateTests: (): void => {
      latestProps.current.onGenerateTests?.();
    },
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
  readonly onCursorChange: KeikoCodeEditorProps["onCursorChange"];
  readonly onSelectionChange: KeikoCodeEditorProps["onSelectionChange"];
  readonly onRuntimeError: KeikoCodeEditorProps["onRuntimeError"];
  readonly themeVariant: KeikoCodeEditorProps["themeVariant"];
  readonly autoFocus: KeikoCodeEditorProps["autoFocus"];
}

function mountEditorRuntime(args: MountRuntimeArgs): void {
  const mountMonaco = args.monaco as MountMonaco;
  args.refs.editorRef.current = args.editor;
  applyViewState(args.editor, args.refs.viewStateRef.current);
  args.refs.disposeRef.current = wireEditorOnMount({
    editor: args.editor,
    monaco: mountMonaco,
    container: args.editor.getContainerDomNode(),
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
    commands: buildCommandsWiring(args.latestProps),
  });
  applyRevealRequest(args.refs, args.latestProps.current.revealRequest);
}

function useMountHandler(
  props: KeikoCodeEditorProps,
  refs: EditorRefs,
  emitSave: () => void,
  onOverviewMarkers: OverviewMarkersHandler | undefined,
): OnMount {
  const { onCursorChange, onSelectionChange, onRuntimeError, themeVariant, autoFocus } = props;
  // Live props for the completion resolvers (read at provider-call time, not mount time).
  const latestProps = useRef(props);
  latestProps.current = props;
  const { streamId, inlineStreamId, telemetry } = useMountStreams(latestProps);
  return useCallback<OnMount>(
    (editor, monaco): void => {
      mountEditorRuntime({
        editor,
        monaco,
        refs,
        emitSave,
        latestProps,
        streamId,
        inlineStreamId,
        telemetry,
        onOverviewMarkers,
        onCursorChange,
        onSelectionChange,
        onRuntimeError,
        themeVariant,
        autoFocus,
      });
    },
    [
      refs,
      emitSave,
      themeVariant,
      autoFocus,
      onCursorChange,
      onSelectionChange,
      onRuntimeError,
      latestProps,
      streamId,
      inlineStreamId,
      telemetry,
      onOverviewMarkers,
    ],
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

/** Wire change/mount handlers and unmount disposal; returns the handlers for `<Editor>`. */
export function useEditorHandlers(
  props: KeikoCodeEditorProps,
  readOnly: boolean,
  onOverviewMarkers?: OverviewMarkersHandler,
): EditorHandlers {
  const refs = useEditorRefs();
  const emitSave = useSaveEmitter(props, refs.editorRef, readOnly);
  const onChange = useChangeHandler(props.onContentChange, readOnly);
  const onMount = useMountHandler(props, refs, emitSave, onOverviewMarkers);
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
  useUnmountDisposal(refs);
  useRevealRequest(props, refs);
  return { onChange, onMount, formatDocument, revealDiagnosticMarker: revealDiagnostic };
}
