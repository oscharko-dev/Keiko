"use client";

/**
 * `KeikoDiffEditor` — the reusable, controlled, host-agnostic patch-review surface (Issue #1195).
 *
 * A thin React shell over `@monaco-editor/react`'s `<DiffEditor>`. It renders a host-built
 * {@link import("../patch-preview.js").PatchPreviewModel} as a changed-file list plus a read-only
 * original/modified diff for the selected file, with hunk navigation and accessible, content-free
 * status. It is review-only: both diff sides are read-only, so a generated patch is inspected without
 * mutating workspace files (AC1). Apply / reject / open-file / run-verification are emitted as intent
 * through host callbacks — the editor never applies a patch, validates it, or persists evidence
 * (ADR-0042 D1/D7). All derivation lives in the pure sibling helpers, so this file stays a render.
 *
 * Import-side-effect-free: `monaco`/DOM are touched only inside the `onMount` callback (ADR-0042;
 * `sideEffects:false`). No loader/worker bootstrap happens here; that is the host's job (#1196).
 */
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";

import type { EditorThemeVariant } from "../monaco/theme.js";
import type { PatchPreviewFile, PatchPreviewFileStatus } from "../patch-preview.js";
import { buildDiffEditorOptions } from "./diff-editor-options.js";
import {
  wireDiffEditorOnMount,
  type DiffMountController,
  type MountDiffMonaco,
} from "./diff-mount.js";
import {
  deriveDiffSummary,
  deriveDiffTruncationNote,
  diffFileStatusLabel,
  type DiffStatusViewModel,
} from "./diff-status-text.js";
import type { DiffActionAvailability, KeikoDiffEditorProps } from "./diff-types.js";
import { canNavigateDiffs, resolveSelectedFile } from "./diff-view-model.js";
import type { KeikoEditorLoadState } from "./types.js";

const DIFF_HEIGHT = "100%";

/**
 * File-list status indicator colour. Driven directly by the #1212 `--ed-diff-*-gutter` design tokens
 * (the diff gutter is a decoration, not a Monaco theme key — see `monaco/theme.ts`), each with a
 * `currentColor` fallback so a host that has not lifted the tokens still renders a visible marker.
 */
const STATUS_INDICATOR_COLOR: Readonly<Record<PatchPreviewFileStatus, string>> = {
  created: "var(--ed-diff-ins-gutter, currentColor)",
  modified: "var(--ed-diff-chg-gutter, currentColor)",
  deleted: "var(--ed-diff-rem-gutter, currentColor)",
  binary: "currentColor",
  unsupported: "currentColor",
};

function ChangeSummary({ summary }: { readonly summary: DiffStatusViewModel }): ReactElement {
  // Render the polite and assertive paths as distinctly-keyed elements so the transition into the
  // error state MOUNTS a fresh role="alert" node — NVDA/JAWS register a live region at insertion time
  // and may not re-announce a role/politeness change mutated on a persistent node (WCAG 4.1.3).
  return (
    <div
      key={summary.role}
      role={summary.role}
      aria-live={summary.ariaLive}
      data-testid="keiko-diff-summary"
    >
      {summary.message}
    </div>
  );
}

function TruncationNotice({ note }: { readonly note: string | null }): ReactElement | null {
  if (note === null) {
    return null;
  }
  // Polite live region so a truncation that newly appears (host swaps to a larger patch in place) is
  // announced; the text is metadata only (counts), never diff content.
  return (
    <div role="note" aria-live="polite" data-testid="keiko-diff-truncation">
      {note}
    </div>
  );
}

interface FileRowProps {
  readonly file: PatchPreviewFile;
  readonly selected: boolean;
  readonly onSelect: (uri: string) => void;
  readonly onOpenFile?: ((uri: string) => void) | undefined;
}

function FileRow({ file, selected, onSelect, onOpenFile }: FileRowProps): ReactElement {
  const statusLabel = diffFileStatusLabel(file.status);
  const fileLabel = `${file.displayPath} ${statusLabel}${file.truncated ? " truncated" : ""}`;
  return (
    <li data-diff-status={file.status} data-truncated={file.truncated ? "true" : undefined}>
      <button
        type="button"
        data-testid="keiko-diff-file"
        aria-label={fileLabel}
        aria-current={selected ? "true" : undefined}
        onClick={(): void => {
          onSelect(file.uri);
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: 2,
            backgroundColor: STATUS_INDICATOR_COLOR[file.status],
          }}
        />
        <span>{file.displayPath}</span>
        <span>{statusLabel}</span>
        {file.truncated ? <span>(truncated)</span> : null}
      </button>
      {onOpenFile === undefined ? null : (
        <button
          type="button"
          data-testid="keiko-diff-open-file"
          aria-label={`Open ${file.displayPath} in the workspace`}
          onClick={(): void => {
            onOpenFile(file.uri);
          }}
        >
          Open
        </button>
      )}
    </li>
  );
}

interface FileListProps {
  readonly files: readonly PatchPreviewFile[];
  readonly selectedUri: string | null;
  readonly onSelect: (uri: string) => void;
  readonly onOpenFile?: ((uri: string) => void) | undefined;
}

function FileList(props: FileListProps): ReactElement {
  return (
    <ul
      aria-label="Changed files"
      data-testid="keiko-diff-file-list"
      style={{ flex: "0 0 auto", margin: 0, padding: 0, listStyle: "none", overflowY: "auto" }}
    >
      {props.files.map((file) => (
        <FileRow
          key={file.uri}
          file={file}
          selected={file.uri === props.selectedUri}
          onSelect={props.onSelect}
          onOpenFile={props.onOpenFile}
        />
      ))}
    </ul>
  );
}

function actionEnabled(flag: boolean | undefined, handler: (() => void) | undefined): boolean {
  return flag === true && handler !== undefined;
}

interface DiffToolbarProps {
  readonly canNavigate: boolean;
  readonly actions: DiffActionAvailability | undefined;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  readonly onApply?: (() => void) | undefined;
  readonly onReject?: (() => void) | undefined;
  readonly onRunVerification?: (() => void) | undefined;
}

interface ToolbarButtonProps {
  readonly testId: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}

function ToolbarButton(props: ToolbarButtonProps): ReactElement {
  return (
    <button
      type="button"
      data-testid={props.testId}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

/** Wrap an optional handler so a disabled/absent action is a no-op rather than a thrown call. */
function runAction(handler: (() => void) | undefined): () => void {
  return (): void => {
    handler?.();
  };
}

function DiffToolbar(props: DiffToolbarProps): ReactElement {
  const { actions } = props;
  return (
    <div role="toolbar" aria-label="Diff review actions" data-testid="keiko-diff-toolbar">
      <ToolbarButton
        testId="keiko-diff-prev"
        label="Previous change"
        disabled={!props.canNavigate}
        onClick={props.onPrev}
      />
      <ToolbarButton
        testId="keiko-diff-next"
        label="Next change"
        disabled={!props.canNavigate}
        onClick={props.onNext}
      />
      <ToolbarButton
        testId="keiko-diff-apply"
        label="Apply"
        disabled={!actionEnabled(actions?.canApply, props.onApply)}
        onClick={runAction(props.onApply)}
      />
      <ToolbarButton
        testId="keiko-diff-reject"
        label="Reject"
        disabled={!actionEnabled(actions?.canReject, props.onReject)}
        onClick={runAction(props.onReject)}
      />
      <ToolbarButton
        testId="keiko-diff-verify"
        label="Run verification"
        disabled={!actionEnabled(actions?.canRunVerification, props.onRunVerification)}
        onClick={runAction(props.onRunVerification)}
      />
    </div>
  );
}

interface DiffEditorViewProps {
  readonly file: PatchPreviewFile;
  readonly themeVariant: EditorThemeVariant;
  readonly onMount: DiffOnMount;
}

function DiffEditorView({ file, themeVariant, onMount }: DiffEditorViewProps): ReactElement {
  const options = useMemo(
    () => buildDiffEditorOptions({ ariaLabel: `Diff: ${file.displayPath}` }),
    [file.displayPath],
  );
  return (
    <DiffEditor
      original={file.original}
      modified={file.modified}
      originalLanguage={file.language}
      modifiedLanguage={file.language}
      theme={`keiko-editor-${themeVariant}`}
      height={DIFF_HEIGHT}
      loading={<div data-testid="keiko-diff-editor-loading" aria-hidden="true" />}
      options={options}
      onMount={onMount}
    />
  );
}

interface DiffPaneProps {
  readonly selected: PatchPreviewFile | null;
  readonly loadState: KeikoEditorLoadState;
  readonly themeVariant: EditorThemeVariant;
  readonly onMount: DiffOnMount;
}

function DiffPane(props: DiffPaneProps): ReactElement {
  if (props.loadState.status === "loading") {
    return (
      <div
        data-testid="keiko-diff-pane-loading"
        aria-hidden="true"
        style={{ width: "100%", height: "100%" }}
      />
    );
  }
  if (props.loadState.status === "error") {
    return (
      <div role="note" data-testid="keiko-diff-load-error">
        The diff editor could not be loaded.
      </div>
    );
  }
  if (props.selected === null) {
    return (
      <div role="note" data-testid="keiko-diff-empty">
        No file selected.
      </div>
    );
  }
  if (!props.selected.diffable) {
    return (
      <div role="note" data-testid="keiko-diff-unavailable">
        {props.selected.note ?? "This file cannot be previewed."}
      </div>
    );
  }
  return (
    <DiffEditorView
      file={props.selected}
      themeVariant={props.themeVariant}
      onMount={props.onMount}
    />
  );
}

interface DiffController {
  readonly onMount: DiffOnMount;
  readonly goToPrev: () => void;
  readonly goToNext: () => void;
}

/** Hold the imperative diff-editor handle and expose the mount + hunk-navigation callbacks. */
function useDiffController(
  themeVariant: EditorThemeVariant,
  onThemeError: ((message: string) => void) | undefined,
): DiffController {
  const controllerRef = useRef<DiffMountController | null>(null);
  const onMount = useCallback<DiffOnMount>(
    (editor, monaco): void => {
      // The live `monaco` namespace surfaces as error-typed to the typed-lint program; narrow it at
      // this single seam to the minimal structural view the mount wiring consumes (cf. KeikoCodeEditor).
      const mountMonaco = monaco as unknown as MountDiffMonaco;
      controllerRef.current = wireDiffEditorOnMount({
        editor,
        monaco: mountMonaco,
        themeVariant,
        onThemeError,
      });
    },
    [themeVariant, onThemeError],
  );
  const goToPrev = useCallback((): void => controllerRef.current?.goToPreviousDiff(), []);
  const goToNext = useCallback((): void => controllerRef.current?.goToNextDiff(), []);
  return { onMount, goToPrev, goToNext };
}

interface DiffEditorColumnProps {
  readonly selected: PatchPreviewFile | null;
  readonly loadState: KeikoEditorLoadState;
  readonly themeVariant: EditorThemeVariant;
  readonly actions: DiffActionAvailability | undefined;
  readonly controller: DiffController;
  readonly onApply?: (() => void) | undefined;
  readonly onReject?: (() => void) | undefined;
  readonly onRunVerification?: (() => void) | undefined;
}

function DiffEditorColumn(props: DiffEditorColumnProps): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}>
      <DiffToolbar
        canNavigate={props.loadState.status === "ready" && canNavigateDiffs(props.selected)}
        actions={props.actions}
        onPrev={props.controller.goToPrev}
        onNext={props.controller.goToNext}
        onApply={props.onApply}
        onReject={props.onReject}
        onRunVerification={props.onRunVerification}
      />
      <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0 }}>
        <DiffPane
          selected={props.selected}
          loadState={props.loadState}
          themeVariant={props.themeVariant}
          onMount={props.controller.onMount}
        />
      </div>
    </div>
  );
}

export function KeikoDiffEditor(props: KeikoDiffEditorProps): ReactElement {
  const { model, loadState, themeVariant, actions } = props;
  const variant = themeVariant ?? "dark";
  const [selectedUri, setSelectedUri] = useState<string | null>(null);
  const { file: selected } = resolveSelectedFile(model, selectedUri);
  const controller = useDiffController(variant, props.onRuntimeError);

  const { onSelectFile } = props;
  const handleSelect = useCallback(
    (uri: string): void => {
      setSelectedUri(uri);
      onSelectFile?.(uri);
    },
    [onSelectFile],
  );

  const summary = deriveDiffSummary({
    model,
    loadState,
    selectedDisplayPath: selected?.displayPath ?? null,
    selectedStatus: selected?.status ?? null,
  });

  return (
    <div
      data-testid="keiko-diff-editor"
      style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}
    >
      <ChangeSummary summary={summary} />
      <TruncationNotice note={deriveDiffTruncationNote(model)} />
      <div style={{ display: "flex", flexDirection: "row", flex: "1 1 auto", minHeight: 0 }}>
        <FileList
          files={model.files}
          selectedUri={selected?.uri ?? null}
          onSelect={handleSelect}
          onOpenFile={props.onOpenFile}
        />
        <DiffEditorColumn
          selected={selected}
          loadState={loadState}
          themeVariant={variant}
          actions={actions}
          controller={controller}
          onApply={props.onApply}
          onReject={props.onReject}
          onRunVerification={props.onRunVerification}
        />
      </div>
    </div>
  );
}
