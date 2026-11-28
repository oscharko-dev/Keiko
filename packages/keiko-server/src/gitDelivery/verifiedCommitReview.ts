import type {
  CodingWorkbenchReviewRename,
  CodingWorkbenchRuntimePendingApprovalReview,
  VerifiedCommitResult,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_APPROVAL_REVIEW_MAX_COUNT,
  CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS,
  validateCodingWorkbenchRuntimeApprovalReviewChannelPayload,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-approval-review";
import {
  readGitStagedChangeSummary,
  type GitStagedChangeEntry,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { isRepositoryRelativePath } from "../gitDiffParser.js";
import { gitDeliveryTerminationHandler, type GitDeliveryExecutionSeams } from "./execution.js";
import type { VerifiedCommitRunContext } from "./verifiedCommitTypes.js";

/**
 * Why a commit review could not be built; the closed value the activity log records. A change that
 * is merely large never lands here: the review carries exact counts and a bounded path list, so only
 * an identity the review cannot place (`diff-truncated`) or a payload its contract refuses blocks.
 * `file-truncated` is kept for logs written before the review stopped depending on a patch.
 */
export type VerifiedCommitReviewIncompleteCause =
  "diff-truncated" | "file-truncated" | "payload-invalid";

export type VerifiedCommitReviewRead =
  | {
      readonly review: CodingWorkbenchRuntimePendingApprovalReview;
      /** Body-free size fact of the staged change, for the activity log. */
      readonly renameCount: number;
    }
  | { readonly incomplete: VerifiedCommitReviewIncompleteCause };

// The review renders a rename with an arrow between its two names, so a name that holds one could
// pass for a rename. Such a review is refused instead of shown ambiguously.
const RENAME_ARROW = "\u2192";

function placeable(entry: GitStagedChangeEntry): boolean {
  return [entry.path, entry.oldPath].every(
    (path) =>
      path === undefined ||
      (!path.includes("\uFFFD") && !path.includes(RENAME_ARROW) && isRepositoryRelativePath(path)),
  );
}

// A rename carries both names as separate fields, each bounded on its own by the review contract,
// so the person sees what is removed as well as what appears and no joined label can pass the bound.
function renamesOf(
  entries: readonly GitStagedChangeEntry[],
): readonly CodingWorkbenchReviewRename[] {
  return entries.flatMap((entry) =>
    entry.oldPath === undefined ? [] : [{ path: entry.path, from: entry.oldPath }],
  );
}

/**
 * The interactive staged change owns commit review. An immutable PR snapshot cannot substitute.
 *
 * The review is built from Git's exact per-file counts, never from a size-bounded patch: how many
 * files and lines changed, and which of them, do not depend on a display bound. A change larger
 * than the path list says so (`pathsTruncated` with the true `fileCount`) and still reaches the
 * person. What is committed stays bound to the staged tree digest, not to this display.
 */
export async function readVerifiedCommitReview(
  context: VerifiedCommitRunContext,
  result: VerifiedCommitResult,
  message: string,
  seams: GitDeliveryExecutionSeams,
): Promise<VerifiedCommitReviewRead> {
  const entries = await readGitStagedChangeSummary({
    workspace: context.workspace,
    signal: context.signal,
    onTerminated: gitDeliveryTerminationHandler(seams, context.correlationId),
  });
  if (!entries.every(placeable)) return { incomplete: "diff-truncated" };
  const shown = entries.slice(0, CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS);
  const paths = shown.map((entry) => entry.path);
  const renames = renamesOf(shown);
  const added = entries.reduce((count, entry) => count + entry.addedLines, 0);
  const deleted = entries.reduce((count, entry) => count + entry.deletedLines, 0);
  const capped =
    added > CODING_WORKBENCH_APPROVAL_REVIEW_MAX_COUNT ||
    deleted > CODING_WORKBENCH_APPROVAL_REVIEW_MAX_COUNT;
  const review: CodingWorkbenchRuntimePendingApprovalReview = {
    requestId: result.proposalId,
    paths,
    pathsTruncated: paths.length < entries.length,
    ...(renames.length === 0 ? {} : { renames }),
    fileCount: entries.length,
    addedLines: Math.min(added, CODING_WORKBENCH_APPROVAL_REVIEW_MAX_COUNT),
    deletedLines: Math.min(deleted, CODING_WORKBENCH_APPROVAL_REVIEW_MAX_COUNT),
    // A count past the contract's bound is shown as the bound and said to be unavailable.
    ...(capped ? { countsUnavailable: true } : {}),
    verifiedCommit: { result, message },
  };
  return validateCodingWorkbenchRuntimeApprovalReviewChannelPayload({
    session: "active",
    pending: review,
  }).ok
    ? { review, renameCount: entries.filter((entry) => entry.oldPath !== undefined).length }
    : { incomplete: "payload-invalid" };
}
