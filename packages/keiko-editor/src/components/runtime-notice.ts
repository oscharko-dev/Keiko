// The runtime notices the editor reports through `onRuntimeError` (F29, ADR-0173 D13). The host
// forwards each one to the activity log, which admits exactly these code-owned shapes and redacts
// anything else. So a notice names what happened with a closed code, and an error travels only as
// its class name: `error.message` is environment-influenced text that can quote paths or content.

/** A failure the editor survives, named by the part that failed. */
export type EditorRuntimeFailure =
  | "git-gutter-refresh-failed"
  | "blame-read-failed"
  | "theme-registration-failed"
  | "diff-theme-registration-failed";

/** A host edit request the editor declined because the buffer is read-only. */
export const HOST_EDIT_IGNORED_NOTICE = "host-edit-ignored (reason=read-only)";

/** A retained model belonged to another workspace buffer, so the editor did not reuse it. */
export const MODEL_OWNERSHIP_CHANGED_NOTICE = "model-ownership-changed";

/** The error's class name, and nothing else from the value. */
export function runtimeErrorClass(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name.trim();
    return name.length > 0 ? name : "Error";
  }
  return typeof error;
}

export function runtimeFailureNotice(failure: EditorRuntimeFailure, error: unknown): string {
  return `${failure} (error=${runtimeErrorClass(error)})`;
}
