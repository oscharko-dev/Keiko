"use client";

/**
 * `KeikoCodeEditor` — the reusable, controlled, host-agnostic code editor (Issue #1194).
 *
 * A thin React shell over `@monaco-editor/react`'s `<Editor>`. It is controlled (`value` is the
 * buffer text), prop-driven, and emits intent (`onContentChange`, `onSaveRequested`,
 * `onSelectionChange`, `onCursorChange`) while rendering host-owned status. All editor fundamentals,
 * coordinate conversion, save-state, view-state, status wording, and mount wiring live in the pure
 * sibling helpers, so this file stays a render.
 *
 * Import-side-effect-free: `window`/`document`/`monaco` are touched only inside the `onMount`
 * callback (the live `monaco` namespace arrives as its second arg) and the unmount effect — never
 * at module scope (ADR-0042; `sideEffects:false`). No loader/worker bootstrap happens here; that is
 * the host's job (#1196).
 */
import { Editor } from "@monaco-editor/react";
import { useMemo, type ReactElement } from "react";

import { inferMonacoLanguageId } from "../monaco/language-inference.js";
import { buildEditorOptions } from "./editor-options.js";
import { deriveLargeFileMode } from "./large-file-mode.js";
import type { EditorStatusViewModel } from "./status-text.js";
import type { KeikoCodeEditorProps } from "./types.js";
import { useEditorHandlers } from "./use-editor-handlers.js";
import { computeEditorViewModel } from "./use-editor-view-model.js";

const EDITOR_HEIGHT = "100%";

/** A sized placeholder shown while Monaco loads — same box as the editor, so no layout shift. */
function EditorLoadingBox(): ReactElement {
  return (
    <div
      data-testid="keiko-editor-loading"
      style={{ width: "100%", height: "100%" }}
      aria-hidden="true"
    />
  );
}

function EditorRuntimeErrorBox(props: { readonly message: string }): ReactElement {
  return (
    <div
      data-testid="keiko-editor-runtime-error"
      role="alert"
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        padding: "12px",
        textAlign: "center",
      }}
    >
      {`Editor failed to load: ${props.message}`}
    </div>
  );
}

/** The accessible status + max-size footer beneath the editor. */
function EditorStatusFooter(props: {
  readonly status: EditorStatusViewModel;
  readonly overLimit: boolean;
  readonly maxSizeBytes: number;
}): ReactElement {
  return (
    <>
      <div
        role={props.status.role}
        aria-live={props.status.ariaLive}
        data-testid="keiko-editor-status"
      >
        {props.status.message}
      </div>
      {props.overLimit ? (
        <div data-testid="keiko-editor-limit" role="note">
          {`File exceeds the ${String(props.maxSizeBytes)}-byte editor limit and is read-only.`}
        </div>
      ) : null}
    </>
  );
}

// Memoise the Monaco construction options + inferred language: `@monaco-editor/react` calls
// `editor.updateOptions` whenever the `options` identity changes, so a fresh object every render (on
// each cursor move or status update) would churn the editor needlessly. Provider presence toggles the
// inline-suggest and hover sinks (Issues #1200/#1201).
function useEditorConstructionOptions(
  props: KeikoCodeEditorProps,
  readOnly: boolean,
): {
  readonly options: ReturnType<typeof buildEditorOptions>;
  readonly monacoLanguage: string;
} {
  const relativePath = props.buffer.content.relativePath;
  const { ariaLabel } = props;
  const inlineCompletionEnabled = props.provideInlineCompletions !== undefined;
  const hoverEnabled = props.provideHover !== undefined;
  // Large-file degraded mode (Issue #1207, ADR-0042 D3.6). Recomputed only when the buffer size or
  // text changes; the byte check short-circuits before the bounded line scan so the derivation never
  // dominates a keystroke.
  const { sizeBytes, text } = props.buffer.content;
  const degraded = useMemo(
    () => deriveLargeFileMode({ sizeBytes, text }) === "degraded",
    [sizeBytes, text],
  );
  const options = useMemo(
    () =>
      buildEditorOptions({
        readOnly,
        ariaPath: relativePath,
        ariaLabel,
        inlineCompletionEnabled,
        hoverEnabled,
        degraded,
      }),
    [readOnly, relativePath, ariaLabel, inlineCompletionEnabled, hoverEnabled, degraded],
  );
  const monacoLanguage = useMemo(() => inferMonacoLanguageId(relativePath), [relativePath]);
  return { options, monacoLanguage };
}

export function KeikoCodeEditor(props: KeikoCodeEditorProps): ReactElement {
  const view = computeEditorViewModel(props);
  const handlers = useEditorHandlers(props, view.readOnly);
  const { buffer, fileModel } = props;
  const { options, monacoLanguage } = useEditorConstructionOptions(props, view.readOnly);

  return (
    <div
      data-testid="keiko-code-editor"
      style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}
    >
      <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0 }}>
        {props.loadState.status === "ready" ? (
          <Editor
            value={buffer.content.text}
            language={monacoLanguage}
            path={fileModel.identity.uri}
            theme={`keiko-editor-${props.themeVariant ?? "dark"}`}
            height={EDITOR_HEIGHT}
            loading={<EditorLoadingBox />}
            options={options}
            // Scroll/fold/cursor view state is restored per `path` by `@monaco-editor/react`'s default
            // `saveViewState` mechanism as the host swaps files within a mounted editor; the package's
            // own view-state seam (use-editor-handlers.ts) is a secondary, host-injectable hook.
            onChange={handlers.onChange}
            onMount={handlers.onMount}
          />
        ) : props.loadState.status === "error" ? (
          <EditorRuntimeErrorBox message={props.loadState.message} />
        ) : (
          <EditorLoadingBox />
        )}
      </div>
      {(props.showStatusFooter ?? true) ? (
        <EditorStatusFooter
          status={view.status}
          overLimit={view.overLimit}
          maxSizeBytes={view.maxSizeBytes}
        />
      ) : null}
    </div>
  );
}
