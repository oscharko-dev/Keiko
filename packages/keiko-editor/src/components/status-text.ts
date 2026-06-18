/**
 * Pure derivation of the accessible status region's role and message (Issue #1194).
 *
 * The component renders a single status region whose ARIA role flips to `alert` for error/conflict
 * states (assertive) and stays `status` (polite) otherwise. Keeping the wording and role here makes
 * the a11y contract node-testable and keeps the component shell thin.
 */
import type { EditorSaveStatus, KeikoEditorLoadState } from "./types.js";

/** The accessible role for the status region: assertive `alert` vs polite `status`. */
export type EditorStatusRole = "status" | "alert";

/** The matching `aria-live` politeness for the status region. */
export type EditorStatusAriaLive = "polite" | "assertive";

export interface StatusViewModelArgs {
  readonly loadState: KeikoEditorLoadState;
  readonly saveStatus: EditorSaveStatus;
  readonly saveError?: string | undefined;
  readonly dirty: boolean;
  readonly truncated: boolean;
  readonly modifiedAt?: number | undefined;
}

export interface EditorStatusViewModel {
  readonly role: EditorStatusRole;
  readonly ariaLive: EditorStatusAriaLive;
  readonly message: string;
}

/** A status region carries an explicit `aria-live` matching its role, for assistive-tech robustness
 * when the role flips between `status` and `alert` on the same element. */
function ariaLiveForRole(role: EditorStatusRole): EditorStatusAriaLive {
  return role === "alert" ? "assertive" : "polite";
}

function formatModifiedAt(modifiedAt: number | undefined): string {
  if (modifiedAt === undefined) {
    return "Saved";
  }
  return `Saved at ${new Date(modifiedAt).toISOString()}`;
}

function loadMessage(loadState: Exclude<KeikoEditorLoadState, { status: "ready" }>): string {
  return loadState.status === "loading"
    ? "Loading editor…"
    : `Editor failed to load: ${loadState.message}`;
}

function saveMessage(args: StatusViewModelArgs): string {
  switch (args.saveStatus) {
    case "saving":
      return "Saving…";
    case "saved":
      return formatModifiedAt(args.modifiedAt);
    case "error":
      return `Save failed: ${args.saveError ?? "unknown error"}`;
    case "conflict":
      return "Save conflict: the file changed elsewhere. Reload before saving.";
    case "idle":
      return args.dirty ? "Unsaved changes" : "Ready";
  }
}

/**
 * Derive the status region role and message. Error/conflict/load-error are assertive (`alert`);
 * everything else is polite (`status`). Truncation is appended as a persistent notice.
 */
export function deriveStatusViewModel(args: StatusViewModelArgs): EditorStatusViewModel {
  if (args.loadState.status !== "ready") {
    const role: EditorStatusRole = args.loadState.status === "error" ? "alert" : "status";
    return { role, ariaLive: ariaLiveForRole(role), message: loadMessage(args.loadState) };
  }
  const isAlert = args.saveStatus === "error" || args.saveStatus === "conflict";
  const role: EditorStatusRole = isAlert ? "alert" : "status";
  const base = saveMessage(args);
  const message = args.truncated
    ? `${base} File is truncated (read-only): it exceeds the display limit.`
    : base;
  return { role, ariaLive: ariaLiveForRole(role), message };
}
