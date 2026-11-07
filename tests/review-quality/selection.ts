// Which pull requests a gate run replays (Issue #4138). A development iteration replays a fixed
// sample: the most recent development pull requests with at least one decided thread (a hit or a
// false alarm), because a pull request whose threads are all undecided or unmeasured cannot move
// the actionable rate. The same sample serves every iteration, so their results compare. The
// holdout run replays every holdout pull request with a thread, as the replay's default does.

import { ReviewEval } from "@oscharko-dev/keiko-evaluations";

type Dataset = Pick<ReviewEval.ReviewHarvestDataset, "pullRequests">;
type PullRequest = ReviewEval.ReviewHarvestPullRequest;

function hasDecidedThread(pullRequest: PullRequest): boolean {
  return pullRequest.threads.some((thread) => {
    const { label } = ReviewEval.labelReviewThread(thread);
    return label === "hit" || label === "false-alarm";
  });
}

function hasCommits(pullRequest: PullRequest): boolean {
  return pullRequest.baseCommit !== null && pullRequest.headCommit !== null;
}

/** The development sample: the `size` most recent eligible pull requests, in ascending order. */
export function developmentSample(dataset: Dataset, size: number): readonly number[] {
  const eligible = dataset.pullRequests.filter(
    (pullRequest) =>
      ReviewEval.reviewSplitOf(pullRequest.number) === "development" &&
      hasCommits(pullRequest) &&
      hasDecidedThread(pullRequest),
  );
  return eligible
    .map((pullRequest) => pullRequest.number)
    .sort((left, right) => right - left)
    .slice(0, size)
    .sort((left, right) => left - right);
}

/** Every holdout pull request with at least one thread, in ascending order. */
export function holdoutPullRequests(dataset: Dataset): readonly number[] {
  return dataset.pullRequests
    .filter(
      (pullRequest) =>
        ReviewEval.reviewSplitOf(pullRequest.number) === "holdout" &&
        pullRequest.threads.length > 0,
    )
    .map((pullRequest) => pullRequest.number)
    .sort((left, right) => left - right);
}
