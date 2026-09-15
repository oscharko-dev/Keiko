import { vi } from "vitest";
import type {
  WorkspaceApi,
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

function activationSpies(patch: Partial<WorkspaceApi>): Pick<
  WorkspaceApi,
  "activateWindow" | "focus" | "replaceSelection"
> {
  const focus = patch.focus ?? vi.fn();
  const replaceSelection = patch.replaceSelection ?? vi.fn();
  const activateWindow =
    patch.activateWindow ??
    vi.fn((id: string): void => {
      focus(id);
      replaceSelection([id]);
    });
  return { activateWindow, focus, replaceSelection };
}

/**
 * The one `WorkspaceApi` test double.
 *
 * Every member is a no-op spy; `patch` overrides only what a test cares about.
 * This lives in one place because the alternative already cost us: the same
 * full stub was copied across six suites, so a single contract change (the
 * clipboard commands gaining counts, then a settled cut outcome) had to be
 * applied six times, and a member added later would only surface as a
 * TypeScript error in whichever copy was forgotten.
 */
export function workspaceApiFixture(patch: Partial<WorkspaceApi> = {}): WorkspaceApi {
  const activation = activationSpies(patch);
  return {
    add: vi.fn(() => null),
    openEditorFile: vi.fn(() => ({ ok: false as const, message: "Unable to open editor." })),
    toggleTool: vi.fn(),
    activateWindow: activation.activateWindow,
    focus: activation.focus,
    currentSelection: vi.fn(() => ({ focusedWindowId: null, selectedWindowIds: [] })),
    replaceSelection: activation.replaceSelection,
    toggleWindowSelection: vi.fn(),
    clearSelection: vi.fn(),
    moveSelectedWindowsBy: vi.fn(() => ({ dx: 0, dy: 0 })),
    copySelectedWindows: vi.fn(() => ({ captured: 0, skipped: 0, overflow: 0 })),
    cutSelectedWindows: vi.fn(() => cutResult({ captured: 0, skipped: 0, overflow: 0 })),
    pasteCopiedWindows: vi.fn(() => ({ pasted: 0, limitReached: false })),
    close: vi.fn(),
    minimize: vi.fn(),
    restore: vi.fn(),
    maximize: vi.fn(),
    update: vi.fn(),
    setSnap: vi.fn(),
    commitSnap: vi.fn(),
    tileAll: vi.fn(),
    splitFront: vi.fn(),
    cascade: vi.fn(),
    startConnect: vi.fn(),
    confirmConnect: vi.fn(),
    cancelConnect: vi.fn(),
    removeConn: vi.fn(),
    updateConnBoundScope: vi.fn(),
    connect: vi.fn(),
    linkedFilesRoot: vi.fn(() => null),
    linkedAllFilesRoots: vi.fn(() => []),
    linkedConnectorCapsuleIds: vi.fn(() => []),
    linkedConnectorCapsuleSetIds: vi.fn(() => []),
    linkedFigmaSnapshotRunIds: vi.fn(() => []),
    linkedFilesContext: vi.fn(() => null),
    currentFilesContext: vi.fn(() => null),
    zoomTo: vi.fn(),
    fitView: vi.fn(),
    resetView: vi.fn(),
    panBy: vi.fn(),
    rect: vi.fn(() => null),
    currentView: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
    ...patch,
  };
}
