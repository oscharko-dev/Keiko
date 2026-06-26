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
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";

import { inferMonacoLanguageId } from "../monaco/language-inference.js";
import { buildEditorOptions } from "./editor-options.js";
import type { DiagnosticOverviewMarker } from "./diagnostics-bridge.js";
import { deriveLargeFileMode } from "./large-file-mode.js";
import type { EditorStatusViewModel } from "./status-text.js";
import type { KeikoCodeEditorProps } from "./types.js";
import { useEditorHandlers } from "./use-editor-handlers.js";
import { computeEditorViewModel } from "./use-editor-view-model.js";

const EDITOR_HEIGHT = "100%";
const DIAGNOSTIC_OVERVIEW_WIDTH = 8;
const DIAGNOSTIC_OVERVIEW_MARKER_HEIGHT = 4;

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

function countLines(text: string): number {
  if (text.length === 0) return 1;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function markerTone(severity: number): string {
  if (severity >= 8) return "var(--ed-error, var(--feedback-danger, var(--danger)))";
  if (severity >= 4) return "var(--ed-warn, var(--warn))";
  return "var(--ed-info, var(--info))";
}

function markerSeverityLabel(severity: number): string {
  if (severity >= 8) return "Error";
  if (severity >= 4) return "Warning";
  return "Info";
}

function markerMeta(marker: DiagnosticOverviewMarker): string {
  const location = `Line ${String(marker.startLineNumber)}`;
  if (marker.source === undefined && marker.code === undefined) return location;
  if (marker.source === undefined) return `${location} · ${String(marker.code)}`;
  const codeSuffix = marker.code === undefined ? "" : `(${marker.code})`;
  return `${location} · ${marker.source}${codeSuffix}`;
}

function markerDataSeverity(severity: number): string {
  if (severity >= 8) return "error";
  if (severity >= 4) return "warning";
  return "info";
}

function markerTopPercent(marker: DiagnosticOverviewMarker, lineCount: number): number {
  const denominator = Math.max(1, lineCount);
  const start = Math.max(1, Math.min(marker.startLineNumber, denominator));
  return ((start - 1) / denominator) * 100;
}

function EditorDiagnosticMarkerButton(props: {
  readonly marker: DiagnosticOverviewMarker;
  readonly lineCount: number;
  readonly index: number;
  readonly onActivate: (marker: DiagnosticOverviewMarker) => void;
}): ReactElement {
  const marker = props.marker;
  const top = markerTopPercent(marker, props.lineCount);
  const severityLabel = markerSeverityLabel(marker.severity);
  const meta = markerMeta(marker);
  return (
    <button
      type="button"
      key={`${String(props.index)}:${String(marker.severity)}:${String(marker.startLineNumber)}:${
        marker.message
      }`}
      className="keiko-editor-diagnostic-marker"
      aria-label={`${severityLabel} diagnostic on ${meta}: ${marker.message}`}
      data-severity={markerDataSeverity(marker.severity)}
      onClick={() => {
        props.onActivate(marker);
      }}
      style={
        {
          position: "absolute",
          top: `clamp(0px, ${String(top)}%, calc(100% - ${String(
            DIAGNOSTIC_OVERVIEW_MARKER_HEIGHT,
          )}px))`,
          right: 0,
          width: "100%",
          height: DIAGNOSTIC_OVERVIEW_MARKER_HEIGHT,
          borderRadius: 999,
          background: markerTone(marker.severity),
          pointerEvents: "auto",
        } satisfies CSSProperties
      }
    >
      <span className="keiko-editor-diagnostic-tooltip" aria-hidden="true">
        <span className="keiko-editor-diagnostic-tooltip-message">{marker.message}</span>
        <span className="keiko-editor-diagnostic-tooltip-meta">{meta}</span>
      </span>
    </button>
  );
}

function EditorDiagnosticOverview(props: {
  readonly markers: readonly DiagnosticOverviewMarker[];
  readonly lineCount: number;
  readonly onActivate: (marker: DiagnosticOverviewMarker) => void;
}): ReactElement | null {
  if (props.markers.length === 0) return null;
  return (
    <div
      data-testid="keiko-editor-diagnostic-overview"
      className="keiko-editor-diagnostic-overview"
      aria-label="Diagnostic overview"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: DIAGNOSTIC_OVERVIEW_WIDTH,
        pointerEvents: "none",
        zIndex: "var(--z-tooltip)",
      }}
    >
      {props.markers.map((marker, index) => (
        <EditorDiagnosticMarkerButton
          key={`${String(index)}:${String(marker.severity)}:${String(marker.startLineNumber)}:${
            marker.message
          }`}
          marker={marker}
          lineCount={props.lineCount}
          index={index}
          onActivate={props.onActivate}
        />
      ))}
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

type EditorHandlers = ReturnType<typeof useEditorHandlers>;

function ReadyEditorSurface(props: {
  readonly editorProps: KeikoCodeEditorProps;
  readonly monacoLanguage: string;
  readonly options: ReturnType<typeof buildEditorOptions>;
  readonly handlers: EditorHandlers;
}): ReactElement {
  const editorProps = props.editorProps;
  return (
    <Editor
      value={editorProps.buffer.content.text}
      language={props.monacoLanguage}
      path={editorProps.fileModel.identity.uri}
      theme={`keiko-editor-${editorProps.themeVariant ?? "dark"}`}
      height={EDITOR_HEIGHT}
      loading={<EditorLoadingBox />}
      options={props.options}
      keepCurrentModel={false}
      // Scroll/fold/cursor view state is restored per `path` by `@monaco-editor/react`'s default
      // `saveViewState` mechanism as the host swaps files within a mounted editor; the package's
      // own view-state seam (use-editor-handlers.ts) is a secondary, host-injectable hook.
      onChange={props.handlers.onChange}
      onMount={props.handlers.onMount}
    />
  );
}

function EditorBody(props: {
  readonly editorProps: KeikoCodeEditorProps;
  readonly monacoLanguage: string;
  readonly options: ReturnType<typeof buildEditorOptions>;
  readonly handlers: EditorHandlers;
  readonly overviewMarkers: readonly DiagnosticOverviewMarker[];
  readonly lineCount: number;
}): ReactElement {
  const loadState = props.editorProps.loadState;
  return (
    <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0 }}>
      {loadState.status === "ready" ? (
        <ReadyEditorSurface
          editorProps={props.editorProps}
          monacoLanguage={props.monacoLanguage}
          options={props.options}
          handlers={props.handlers}
        />
      ) : loadState.status === "error" ? (
        <EditorRuntimeErrorBox message={loadState.message} />
      ) : (
        <EditorLoadingBox />
      )}
      <EditorDiagnosticOverview
        markers={props.overviewMarkers}
        lineCount={props.lineCount}
        onActivate={props.handlers.revealDiagnosticMarker}
      />
    </div>
  );
}

export function KeikoCodeEditor(props: KeikoCodeEditorProps): ReactElement {
  const view = computeEditorViewModel(props);
  const [overviewMarkers, setOverviewMarkers] = useState<readonly DiagnosticOverviewMarker[]>([]);
  const handlers = useEditorHandlers(props, view.readOnly, setOverviewMarkers);
  const { options, monacoLanguage } = useEditorConstructionOptions(props, view.readOnly);
  const lineCount = useMemo(
    () => countLines(props.buffer.content.text),
    [props.buffer.content.text],
  );
  const lastFormatRequestNonce = useRef(props.formatRequestNonce ?? 0);
  useEffect(() => {
    const nonce = props.formatRequestNonce ?? 0;
    if (nonce === lastFormatRequestNonce.current) return;
    lastFormatRequestNonce.current = nonce;
    handlers.formatDocument();
  }, [handlers, props.formatRequestNonce]);

  return (
    <div
      data-testid="keiko-code-editor"
      style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}
    >
      <EditorBody
        editorProps={props}
        monacoLanguage={monacoLanguage}
        options={options}
        handlers={handlers}
        overviewMarkers={overviewMarkers}
        lineCount={lineCount}
      />
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
