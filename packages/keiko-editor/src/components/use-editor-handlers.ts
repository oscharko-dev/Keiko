/**
 * The Monaco change/mount handlers and lifecycle refs for
 * {@link import("./KeikoCodeEditor.js").KeikoCodeEditor} (Issue #1194).
 *
 * Isolates the imperative editor wiring (controlled-change emission, mount wiring, view-state
 * preservation, unmount disposal) into small hooks so the component body stays a thin render. The
 * DOM/Monaco edges are touched only inside the returned callbacks/effect, never at module scope.
 */
import { type OnChange, type OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

import { buildSaveRequest } from "./save-state.js";
import type { KeikoCodeEditorProps } from "./types.js";
import { applyViewState, captureViewState } from "./view-state.js";
import { wireEditorOnMount, type MountEditor, type MountMonaco } from "./on-mount.js";
import type { WireEditorCompletion, WireEditorInlineCompletion } from "./on-mount.js";
import type { EditorCompletionResponse, EditorInlineCompletionResponse } from "../index.js";
import {
  createEditorRequestId,
  DEFAULT_COMPLETION_CONTEXT_BUDGET_BYTES,
  DEFAULT_COMPLETION_TRIGGER_CHARACTERS,
} from "./completion-bridge.js";
import {
  DEFAULT_INLINE_COMPLETION_CONTEXT_BUDGET_BYTES,
  DEFAULT_INLINE_COMPLETION_DEBOUNCE_MS,
} from "./inline-completion-bridge.js";
import {
  createInlineCompletionTelemetry,
  type InlineCompletionTelemetry,
} from "./inline-completion-telemetry.js";

export interface EditorHandlers {
  readonly onChange: OnChange;
  readonly onMount: OnMount;
}

interface EditorRefs {
  readonly editorRef: MutableRefObject<MountEditor | null>;
  readonly viewStateRef: MutableRefObject<unknown>;
  readonly disposeRef: MutableRefObject<(() => void) | null>;
}

function useEditorRefs(): EditorRefs {
  return {
    editorRef: useRef<MountEditor | null>(null),
    viewStateRef: useRef<unknown>(null),
    disposeRef: useRef<(() => void) | null>(null),
  };
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

function useMountHandler(
  props: KeikoCodeEditorProps,
  refs: EditorRefs,
  emitSave: () => void,
): OnMount {
  const { onCursorChange, onSelectionChange, onRuntimeError, themeVariant, autoFocus } = props;
  // Live props for the completion resolvers (read at provider-call time, not mount time).
  const latestProps = useRef(props);
  latestProps.current = props;
  const { streamId, inlineStreamId, telemetry } = useMountStreams(latestProps);
  return useCallback<OnMount>(
    (editor, monaco): void => {
      const mountEditor: MountEditor = editor;
      // The live `monaco` namespace arrives typed as the editor library's `Monaco`, which the
      // typed-lint program cannot fully resolve (it surfaces as error-typed); narrow it at this
      // single seam to the minimal structural view the mount wiring consumes.
      const mountMonaco = monaco as unknown as MountMonaco;
      refs.editorRef.current = mountEditor;
      applyViewState(editor, refs.viewStateRef.current);
      refs.disposeRef.current = wireEditorOnMount({
        editor: mountEditor,
        monaco: mountMonaco,
        container: editor.getContainerDomNode(),
        themeVariant: themeVariant ?? "dark",
        autoFocus: autoFocus ?? false,
        onSave: emitSave,
        onCursorChange,
        onSelectionChange,
        onThemeError: onRuntimeError,
        completion: buildCompletionWiring(latestProps, streamId),
        inlineCompletion: buildInlineCompletionWiring(latestProps, inlineStreamId, telemetry),
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
    ],
  );
}

function useUnmountDisposal(refs: EditorRefs): void {
  const { editorRef, viewStateRef, disposeRef } = refs;
  useEffect((): (() => void) => {
    return (): void => {
      if (editorRef.current !== null) {
        viewStateRef.current = captureViewState(editorRef.current);
      }
      disposeRef.current?.();
      disposeRef.current = null;
      editorRef.current = null;
    };
  }, [editorRef, viewStateRef, disposeRef]);
}

/** Wire change/mount handlers and unmount disposal; returns the handlers for `<Editor>`. */
export function useEditorHandlers(props: KeikoCodeEditorProps, readOnly: boolean): EditorHandlers {
  const refs = useEditorRefs();
  const emitSave = useSaveEmitter(props, refs.editorRef, readOnly);
  const onChange = useChangeHandler(props.onContentChange, readOnly);
  const onMount = useMountHandler(props, refs, emitSave);
  useUnmountDisposal(refs);
  return { onChange, onMount };
}
