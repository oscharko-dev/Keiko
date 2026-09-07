import type {
  CodingWorkbenchRuntimePendingApprovalReview,
  VerifiedCommitResult,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS,
  validateCodingWorkbenchRuntimeApprovalReviewChannelPayload,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-approval-review";
import { readGitStagedDiff } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { parseGitEditorUnifiedDiff } from "../gitDiffParser.js";
import { gitDeliveryTerminationHandler, type GitDeliveryExecutionSeams } from "./execution.js";
import type { VerifiedCommitRunContext } from "./verifiedCommitTypes.js";

/** The interactive staged diff owns commit review. An immutable PR snapshot cannot substitute. */
export async function readVerifiedCommitReview(
  context: VerifiedCommitRunContext,
  result: VerifiedCommitResult,
  message: string,
  seams: GitDeliveryExecutionSeams,
): Promise<CodingWorkbenchRuntimePendingApprovalReview | undefined> {
  const patch = await readGitStagedDiff({
    workspace: context.workspace,
    signal: context.signal,
    onTerminated: gitDeliveryTerminationHandler(seams, context.correlationId),
  });
  const diff = parseGitEditorUnifiedDiff(patch, {
    scope: "staged",
    selectedRootPrefix: "",
    processTruncated: false,
  });
  if (diff.truncated || diff.files.some((file) => file.truncated)) return undefined;
  const paths = diff.files
    .map((file) => file.path)
    .slice(0, CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS);
  const review: CodingWorkbenchRuntimePendingApprovalReview = {
    requestId: result.proposalId,
    paths,
    pathsTruncated: paths.length < diff.totalFiles,
    fileCount: diff.totalFiles,
    addedLines: diff.files.reduce((count, file) => count + file.addedLines, 0),
    deletedLines: diff.files.reduce((count, file) => count + file.removedLines, 0),
    verifiedCommit: { result, message },
  };
  return validateCodingWorkbenchRuntimeApprovalReviewChannelPayload({
    session: "active",
    pending: review,
  }).ok
    ? review
    : undefined;
}
