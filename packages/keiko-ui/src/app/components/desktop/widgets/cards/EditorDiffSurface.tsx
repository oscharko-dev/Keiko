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
  KeikoDiffEditor,
  type KeikoDiffEditorProps,
  type KeikoEditorLoadState,
} from "@oscharko-dev/keiko-editor";

import {
  areMonacoLanguagesReady,
  ensureMonacoLanguages,
  ensureMonacoRuntime,
} from "./editorMonacoRuntime";

export type EditorDiffSurfaceProps = Omit<KeikoDiffEditorProps, "loadState"> & {
  readonly loadState: KeikoEditorLoadState;
};

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
