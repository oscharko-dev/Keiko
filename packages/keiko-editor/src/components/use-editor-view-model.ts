/**
 * Derived view model for {@link import("./KeikoCodeEditor.js").KeikoCodeEditor} (Issue #1194).
 *
 * Collapses the controlled props into the render-only flags and the status view model the shell
 * needs, so the component function itself stays small. Pure with respect to its inputs (a plain
 * computation), exposed as a hook only for ergonomic call-site memoisation by the component.
 */
import { isDocumentDirty } from "../index.js";
import { effectiveReadOnly, isMaxSizeExceeded } from "./save-state.js";
import { deriveStatusViewModel, type EditorStatusViewModel } from "./status-text.js";
import type { KeikoCodeEditorProps } from "./types.js";

const DEFAULT_MAX_SIZE_BYTES = 262_144;

export interface EditorViewModel {
  readonly readOnly: boolean;
  readonly truncated: boolean;
  readonly overLimit: boolean;
  readonly maxSizeBytes: number;
  readonly status: EditorStatusViewModel;
}

/** Compute the editor's derived render state from the controlled props. */
export function computeEditorViewModel(props: KeikoCodeEditorProps): EditorViewModel {
  const maxSizeBytes = props.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const truncated = props.buffer.content.truncated;
  const overLimit = isMaxSizeExceeded(props.buffer.content, maxSizeBytes);
  const readOnly = effectiveReadOnly({
    modelReadOnly: props.fileModel.readOnly,
    bufferReadOnly: props.buffer.readOnly,
    override: props.readOnly,
    truncated,
    overLimit,
    notReady: props.loadState.status !== "ready",
  });
  const status = deriveStatusViewModel({
    loadState: props.loadState,
    saveStatus: props.saveStatus,
    saveError: props.saveError,
    dirty: isDocumentDirty(props.fileModel),
    truncated,
    modifiedAt: props.modifiedAt,
  });
  return {
    readOnly,
    truncated,
    overLimit,
    maxSizeBytes,
    status,
  };
}
