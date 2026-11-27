import type {
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

function placeable(entry: GitStagedChangeEntry): boolean {
  return [entry.path, entry.oldPath].every(
    (path) => path === undefined || (!path.includes("�") && isRepositoryRelativePath(path)),
  );
}

function clampCount(value: number): number {
  return Math.min(value, CODING_WORKBENCH_APPROVAL_REVIEW_MAX_COUNT);
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
  const paths = entries
    .map((entry) => entry.path)
    .slice(0, CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS);
  const review: CodingWorkbenchRuntimePendingApprovalReview = {
    requestId: result.proposalId,
    paths,
    pathsTruncated: paths.length < entries.length,
    fileCount: entries.length,
    addedLines: clampCount(entries.reduce((count, entry) => count + entry.addedLines, 0)),
    deletedLines: clampCount(entries.reduce((count, entry) => count + entry.deletedLines, 0)),
    verifiedCommit: { result, message },
  };
  return validateCodingWorkbenchRuntimeApprovalReviewChannelPayload({
    session: "active",
    pending: review,
  }).ok
    ? { review, renameCount: entries.filter((entry) => entry.oldPath !== undefined).length }
    : { incomplete: "payload-invalid" };
}
