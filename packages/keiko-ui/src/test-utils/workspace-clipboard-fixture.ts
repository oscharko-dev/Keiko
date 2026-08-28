import type {
  WorkspaceClipboardCaptureResult,
  WorkspaceClipboardCutResult,
} from "../app/components/desktop/hooks/useWorkspace.types";

/**
 * Builds a `cutSelectedWindows` return value for a test double.
 *
 * Cut reports the capture synchronously and the real outcome through `settled`,
 * because a connected window only leaves the workspace once its unbinds are
 * accepted. A double that resolves `settled` to something OTHER than the
 * capture models the refused-teardown case; by default the two agree, which is
 * the ordinary path.
 */
export function cutResult(
  capture: WorkspaceClipboardCaptureResult,
  settled: WorkspaceClipboardCaptureResult = capture,
): WorkspaceClipboardCutResult {
  return { ...capture, settled: Promise.resolve(settled) };
}
