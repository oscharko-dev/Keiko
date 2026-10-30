// The dry run of a review start (Issue #4136): the models were validated by the caller; this reads
// the target without fetching, creating refs or a worktree, and returns the estimate. A pull
// request's change size comes from its read-only detail; a local range is resolved and listed with
// the hardened review runner.

import type {
  ReviewRunEstimate,
  ReviewTargetRequest,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { listGitReviewChanges, resolveGitReviewCommit } from "@oscharko-dev/keiko-git";

import type { ReviewServices } from "../services.js";
import { estimateReviewRun, reviewDiffBudgetTokens } from "./budget.js";
import type { ReviewRunStore } from "./store.js";

interface DryRunTarget {
  readonly baseSha: string;
  readonly headSha: string;
  readonly changedLines: number;
}

async function pullRequestTarget(
  services: ReviewServices,
  repositoryRoot: string,
  number: number,
  correlationId: string,
): Promise<DryRunTarget | undefined> {
  const detail = await services.pullRequests.detail(repositoryRoot, number, correlationId);
  const pullRequest = detail.availability === "available" ? detail.pullRequest : null;
  if (pullRequest === null) return undefined;
  return {
    baseSha: pullRequest.baseSha,
    headSha: pullRequest.headSha,
    changedLines: pullRequest.additions + pullRequest.deletions,
  };
}

async function localRangeTarget(
  services: ReviewServices,
  repositoryRoot: string,
  target: Extract<ReviewTargetRequest, { readonly kind: "local-range" }>,
  correlationId: string,
): Promise<DryRunTarget | undefined> {
  const ctx = { runner: services.reviewRunner(correlationId), timeoutMs: 30_000 };
  const base = await resolveGitReviewCommit(ctx, { cwd: repositoryRoot, ref: target.baseRef });
  const head = await resolveGitReviewCommit(ctx, { cwd: repositoryRoot, ref: target.headRef });
  if (!base.ok || !head.ok || base.value === undefined || head.value === undefined) {
    return undefined;
  }
  const changes = await listGitReviewChanges(
    { ...ctx, maxBytes: 16 * 1024 * 1024 },
    { cwd: repositoryRoot, baseSha: base.value, headSha: head.value },
  );
  if (!changes.ok) return undefined;
  const changedLines = changes.value.reduce(
    (sum, change) => sum + (change.addedLines ?? 0) + (change.removedLines ?? 0),
    0,
  );
  return { baseSha: base.value, headSha: head.value, changedLines };
}

/** The estimate of a dry run, or `undefined` when the target cannot be read. */
export async function estimateDryRun(
  services: ReviewServices,
  store: ReviewRunStore,
  repositoryRoot: string,
  target: ReviewTargetRequest,
  correlationId: string,
): Promise<ReviewRunEstimate | undefined> {
  const resolved =
    target.kind === "pull-request"
      ? await pullRequestTarget(services, repositoryRoot, target.number, correlationId)
      : await localRangeTarget(services, repositoryRoot, target, correlationId);
  if (resolved === undefined) return undefined;
  return estimateReviewRun(
    resolved.changedLines,
    reviewDiffBudgetTokens(resolved.baseSha, resolved.headSha),
    store.medianDurationMs(),
  );
}
