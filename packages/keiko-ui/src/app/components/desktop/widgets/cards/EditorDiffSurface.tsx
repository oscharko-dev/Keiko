"use client";

/**
 * Client-only generated-test diff review surface for the editor card (Issue #1202).
 *
 * The host builds the patch-preview model from the governed BFF response and renders it through the
 * existing `KeikoDiffEditor` (#1195). This wrapper only ensures the local Monaco runtime is available;
 * patch apply and verification stay disabled by the host-provided action availability.
 */
import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  buildPatchPreview,
  KeikoDiffEditor,
  type EditorPatchFileChange,
  type KeikoDiffEditorProps,
  type KeikoEditorLoadState,
  type EditorPreviewedPatch,
  type EditorTextEdit,
  type PatchPreviewModel,
  type PatchPreviewSource,
} from "@oscharko-dev/keiko-editor";
import type {
  WorkspaceReplacePreviewEdit,
  WorkspaceReplacePreviewFileEdit,
  WorkspaceReplacePreviewResponse,
} from "@oscharko-dev/keiko-contracts";

import {
  areMonacoLanguagesReady,
  ensureMonacoLanguages,
  ensureMonacoRuntime,
} from "./editorMonacoRuntime";

export type EditorDiffSurfaceProps = Omit<KeikoDiffEditorProps, "loadState"> & {
  readonly loadState: KeikoEditorLoadState;
};

function replaceEditToEditorEdit(edit: WorkspaceReplacePreviewEdit): EditorTextEdit {
  return {
    range: {
      start: { line: edit.range.startLine - 1, column: edit.range.startColumn - 1 },
      end: { line: edit.range.endLine - 1, column: edit.range.endColumn - 1 },
    },
    newText: edit.newText,
  };
}

function replaceFileToPatchChange(file: WorkspaceReplacePreviewFileEdit): EditorPatchFileChange {
  return {
    uri: file.path,
    edits: file.edits.map(replaceEditToEditorEdit),
    isNewFile: false,
    isDeletion: false,
  };
}

export function buildWorkspaceReplacePatchModel(
  response: WorkspaceReplacePreviewResponse,
  sources: Readonly<Record<string, PatchPreviewSource>>,
): PatchPreviewModel {
  const patch: EditorPreviewedPatch = {
    patchId: "workspace-replace-preview",
    status: "previewed",
    provenance: { origin: "applied-patch" },
    changes: response.files.map(replaceFileToPatchChange),
  };
  const model = buildPatchPreview({ patch, sources });
  const omittedFileCount = model.omittedFileCount + response.omittedFileCount;
  return {
    ...model,
    omittedFileCount,
    totalFileCount: model.totalFileCount + response.omittedFileCount,
    truncated: model.truncated || omittedFileCount > 0,
  };
}

export default function EditorDiffSurface(props: EditorDiffSurfaceProps): ReactElement {
  const runtime = ensureMonacoRuntime();
  const onRuntimeError = props.onRuntimeError;
  const languages = useMemo(
    () => Array.from(new Set(props.model.files.map((file) => file.language))).sort(),
    [props.model.files],
  );
  const languageKey = languages.join("\0");
  const [languagesReady, setLanguagesReady] = useState(() => areMonacoLanguagesReady(languages));

  useEffect(() => {
    if (!runtime.supported) {
      setLanguagesReady(true);
      return;
    }
    if (areMonacoLanguagesReady(languages)) {
      setLanguagesReady(true);
      return;
    }
    let cancelled = false;
    setLanguagesReady(false);
    void ensureMonacoLanguages(languages)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        onRuntimeError?.(`Failed to load Monaco diff language: ${message}`);
      })
      .finally(() => {
        if (!cancelled) {
          setLanguagesReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [languageKey, languages, onRuntimeError, runtime.supported]);

  const loadState: KeikoEditorLoadState = runtime.supported
    ? languagesReady
      ? props.loadState
      : { status: "loading" }
    : { status: "error", message: runtime.message };

  return <KeikoDiffEditor {...props} loadState={loadState} />;
}
