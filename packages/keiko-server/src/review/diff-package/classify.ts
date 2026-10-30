// Classification of every changed path into exactly one coverage list (Issue #4134).
//
// One precedence, applied to the Git listing alone (modes, object ids and line counts), before any
// blob is read: a gitlink is `submodule` (never recursed), a link is `symlink` (never followed),
// a deletion is `deletedOnly`, then file-type filtering, then content-free changes (`modeOnly`, or
// a rename without a content change, which is included without hunks), then Git's binary verdict
// (resolved by size first, so a giant blob is never diffed), then the per-file line bound. Every
// other path is a packaging candidate.

import type {
  ReviewDiffFileRef,
  ReviewDiffFileStatus,
  ReviewDiffFilterReason,
} from "@oscharko-dev/keiko-contracts";
import type { GitReviewChange, GitReviewChangeStatus } from "@oscharko-dev/keiko-git";
import { reviewDiffFilterReason } from "./filters.js";
import { reviewDiffLanguage } from "./languages.js";
import { reviewDiffPathText } from "./paths.js";

const GITLINK_MODE = "160000";
const SYMLINK_MODE = "120000";

const STATUSES: Readonly<Record<GitReviewChangeStatus, ReviewDiffFileStatus>> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  T: "type-changed",
};

type ReviewDiffPlacement =
  | { readonly list: "submodule" | "symlink" | "deletedOnly" | "modeOnly" }
  | { readonly list: "filtered"; readonly reason: ReviewDiffFilterReason }
  | { readonly list: "too-large" }
  /** Git counts the pair as binary; its sizes decide between `binary` and `too-large`. */
  | { readonly list: "sized" }
  /** `patch`: diff two blobs; `added`: read the head blob; `empty`: no content to package. */
  | { readonly list: "candidate"; readonly content: "patch" | "added" | "empty" };

export interface ReviewDiffChangedFile {
  readonly change: GitReviewChange;
  readonly ref: ReviewDiffFileRef;
  readonly placement: ReviewDiffPlacement;
}

function isGitlink(change: GitReviewChange): boolean {
  return change.oldMode === GITLINK_MODE || change.newMode === GITLINK_MODE;
}

function isSymlink(change: GitReviewChange): boolean {
  return change.oldMode === SYMLINK_MODE || change.newMode === SYMLINK_MODE;
}

function contentPlacement(change: GitReviewChange): ReviewDiffPlacement {
  if (change.status === "A") {
    return { list: "candidate", content: change.addedLines === 0 ? "empty" : "added" };
  }
  return { list: "candidate", content: "patch" };
}

function placementOf(
  change: GitReviewChange,
  path: string,
  options: { readonly excludedPaths: readonly string[]; readonly fileMaxChangedLines: number },
): ReviewDiffPlacement {
  if (isGitlink(change)) return { list: "submodule" };
  if (isSymlink(change)) return { list: "symlink" };
  if (change.status === "D") return { list: "deletedOnly" };
  const filter = reviewDiffFilterReason(path, options.excludedPaths);
  if (filter !== undefined) return { list: "filtered", reason: filter };
  if (change.oldOid === change.newOid) {
    return change.oldMode === change.newMode
      ? { list: "candidate", content: "empty" }
      : { list: "modeOnly" };
  }
  if (change.addedLines === undefined || change.removedLines === undefined)
    return { list: "sized" };
  if (change.addedLines + change.removedLines > options.fileMaxChangedLines) {
    return { list: "too-large" };
  }
  return contentPlacement(change);
}

function withPreviousPath(change: GitReviewChange): Partial<ReviewDiffFileRef> {
  if (change.previousPath === undefined) return {};
  const previous = reviewDiffPathText(change.previousPath);
  return previous.pathBytesBase64 === undefined
    ? { previousPath: previous.path }
    : { previousPath: previous.path, previousPathBytesBase64: previous.pathBytesBase64 };
}

/** The verbatim coverage entry and the list placement of one changed path. */
export function classifyReviewChange(
  change: GitReviewChange,
  options: { readonly excludedPaths: readonly string[]; readonly fileMaxChangedLines: number },
): ReviewDiffChangedFile {
  const current = reviewDiffPathText(change.path);
  const gitlink = isGitlink(change);
  const ref: ReviewDiffFileRef = {
    path: current.path,
    ...(current.pathBytesBase64 === undefined ? {} : { pathBytesBase64: current.pathBytesBase64 }),
    ...withPreviousPath(change),
    status: STATUSES[change.status],
    language: reviewDiffLanguage(current.path),
    addedLines: gitlink ? 0 : (change.addedLines ?? 0),
    removedLines: gitlink ? 0 : (change.removedLines ?? 0),
  };
  return { change, ref, placement: placementOf(change, current.path, options) };
}
