/**
 * Pure derivation of the diff editor's accessible summary and notices (Issue #1195, AC4 + AC5).
 *
 * The change summary is a single live region whose ARIA role flips to `alert` only when the runtime
 * failed to load, and stays a polite `status` otherwise. Every string here is metadata — counts,
 * status words, and the host-redacted display path — and never the diff content itself, so the
 * summary explains the changed-file state without exposing secret material (AC4). Keeping the wording
 * and role here makes the a11y contract node-testable and the component shell thin.
 */
import type { PatchPreviewFileStatus, PatchPreviewModel } from "../patch-preview.js";
import type { KeikoEditorLoadState } from "./types.js";

export type DiffStatusRole = "status" | "alert";
export type DiffStatusAriaLive = "polite" | "assertive";

export interface DiffStatusViewModel {
  readonly role: DiffStatusRole;
  readonly ariaLive: DiffStatusAriaLive;
  readonly message: string;
}

const STATUS_LABELS: Readonly<Record<PatchPreviewFileStatus, string>> = {
  created: "created",
  modified: "modified",
  deleted: "deleted",
  binary: "binary",
  unsupported: "not previewable",
};

/** Human label for a file's reviewable state, used by the file list and the summary. */
export function diffFileStatusLabel(status: PatchPreviewFileStatus): string {
  return STATUS_LABELS[status];
}

export interface DiffSummaryArgs {
  readonly model: PatchPreviewModel;
  readonly loadState: KeikoEditorLoadState;
  /** Display path of the file currently under review, or null when none/empty. */
  readonly selectedDisplayPath: string | null;
  readonly selectedStatus: PatchPreviewFileStatus | null;
}

function changeCounts(model: PatchPreviewModel): string {
  const parts = [
    `${String(model.createdCount)} created`,
    `${String(model.modifiedCount)} modified`,
    `${String(model.deletedCount)} deleted`,
  ];
  const nonText = model.binaryCount + model.unsupportedCount;
  if (nonText > 0) {
    parts.push(`${String(nonText)} not shown as text`);
  }
  return parts.join(", ");
}

function selectedClause(args: DiffSummaryArgs): string {
  if (args.selectedDisplayPath === null || args.selectedStatus === null) {
    return "";
  }
  return ` Showing ${args.selectedDisplayPath} (${diffFileStatusLabel(args.selectedStatus)}).`;
}

/**
 * Derive the change-summary region's role and message. Load errors are assertive (`alert`);
 * everything else is polite (`status`). Never includes diff content (AC4).
 */
export function deriveDiffSummary(args: DiffSummaryArgs): DiffStatusViewModel {
  if (args.loadState.status === "loading") {
    return { role: "status", ariaLive: "polite", message: "Loading diff…" };
  }
  if (args.loadState.status === "error") {
    return {
      role: "alert",
      ariaLive: "assertive",
      message: "Diff failed to load. Review actions that require the diff editor are unavailable.",
    };
  }
  if (args.model.totalFileCount === 0) {
    return { role: "status", ariaLive: "polite", message: "No changes to review." };
  }
  const base = `Reviewing ${String(args.model.totalFileCount)} changed file(s): ${changeCounts(args.model)}.`;
  return { role: "status", ariaLive: "polite", message: `${base}${selectedClause(args)}` };
}

/**
 * Derive the persistent truncation notice, or null when nothing was bounded (AC5). Reports omitted
 * files and clamped content explicitly so a large patch never appears complete when it is not.
 */
export function deriveDiffTruncationNote(model: PatchPreviewModel): string | null {
  if (!model.truncated) {
    return null;
  }
  const parts: string[] = [];
  if (model.omittedFileCount > 0) {
    parts.push(
      `${String(model.omittedFileCount)} file(s) not shown because the patch exceeds the review limit.`,
    );
  }
  if (model.files.some((file) => file.truncated)) {
    parts.push("Some files were truncated to the display limit.");
  }
  return parts.length === 0 ? null : parts.join(" ");
}
