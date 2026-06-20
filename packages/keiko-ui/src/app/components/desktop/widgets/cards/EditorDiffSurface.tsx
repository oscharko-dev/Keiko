"use client";

/**
 * Client-only generated-test diff review surface for the editor card (Issue #1202).
 *
 * The host builds the patch-preview model from the governed BFF response and renders it through the
 * existing `KeikoDiffEditor` (#1195). This wrapper only ensures the local Monaco runtime is available;
 * patch apply and verification stay disabled by the host-provided action availability.
 */
import { type ReactElement } from "react";
import {
  KeikoDiffEditor,
  type KeikoDiffEditorProps,
  type KeikoEditorLoadState,
} from "@oscharko-dev/keiko-editor";

import { ensureMonacoRuntime } from "./editorMonacoRuntime";

export type EditorDiffSurfaceProps = Omit<KeikoDiffEditorProps, "loadState"> & {
  readonly loadState: KeikoEditorLoadState;
};

export default function EditorDiffSurface(props: EditorDiffSurfaceProps): ReactElement {
  const runtime = ensureMonacoRuntime();
  const loadState: KeikoEditorLoadState = runtime.supported
    ? props.loadState
    : { status: "error", message: runtime.message };

  return <KeikoDiffEditor {...props} loadState={loadState} />;
}
