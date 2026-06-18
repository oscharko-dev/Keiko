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

function useMountHandler(
  props: KeikoCodeEditorProps,
  refs: EditorRefs,
  emitSave: () => void,
): OnMount {
  const { onCursorChange, onSelectionChange, onRuntimeError, themeVariant, autoFocus } = props;
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
      });
    },
    [refs, emitSave, themeVariant, autoFocus, onCursorChange, onSelectionChange, onRuntimeError],
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
