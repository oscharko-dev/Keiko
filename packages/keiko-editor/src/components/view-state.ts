/**
 * Pure, injectable view-state capture/restore wrappers (Issue #1194).
 *
 * Scroll position, folded regions, and cursor placement are preserved across re-mounts by saving
 * and restoring Monaco's opaque view state. The Monaco editor is reached through a minimal injected
 * seam (mirroring `theme-resolver.ts`'s injection style), so the capture/restore round-trip is
 * node-testable without a real editor instance. The view-state token is opaque to this module.
 */

/** Minimal structural view of the editor's view-state API (`monaco.editor.IStandaloneCodeEditor`). */
export interface ViewStateEditorLike<T> {
  saveViewState(): T | null;
  restoreViewState(state: T): void;
}

/** Capture the editor's current view state, or `null` when none is available yet. */
export function captureViewState<T>(editor: ViewStateEditorLike<T>): T | null {
  return editor.saveViewState();
}

/**
 * Restore a previously captured view state. A `null` state is a no-op (nothing was captured), so
 * the first mount of a document does not throw.
 */
export function applyViewState<T>(editor: ViewStateEditorLike<T>, state: T | null): void {
  if (state === null) {
    return;
  }
  editor.restoreViewState(state);
}
