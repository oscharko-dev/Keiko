// The review baseline (Issue #4132): what each producer that reviewed Keiko's pull requests
// achieved, from the labeled harvest. Two quantities are kept apart under their own names because
// they answer different questions (docs/qa/review-agent-measurement.md):
//
// - thread-change rate: of all threads whose region could be measured, the share whose anchored
//   region changed later in the same pull request;
// - acceptance rate: of the decided threads (hits plus false alarms), the share that were hits.
//
// Every rate carries its absolute counts and a Wilson interval; a rate over nothing is null.

import {
  wilsonInterval,
  type WilsonInterval,
} from "@oscharko-dev/keiko-contracts/runtime/eval-metrics";

import { labelReviewThread } from "./labels.js";
import { reviewSplitOf } from "./replay.js";
import {
  REVIEW_PRODUCERS,
  type ReviewEvaluationSplit,
  type ReviewHarvestDataset,
  type ReviewHarvestPullRequest,
  type ReviewHarvestThread,
  type ReviewProducer,
  type ReviewReplyClassification,
  type ReviewThreadLabel,
  type ReviewThreadLabelling,
} from "./types.js";

export interface ReviewProducerBaseline {
  readonly producer: ReviewProducer;
  /** Pull requests this producer reviewed (a submitted review or at least one thread). */
  readonly pullRequestsReviewed: number;
  readonly pullRequestsWithThreads: number;
  readonly threads: number;
  readonly findingsPerReviewedPullRequest: number | null;
  readonly regionMeasured: number;
  readonly regionChanged: number;
  readonly threadChangeRate: WilsonInterval;
  readonly hits: number;
  readonly falseAlarms: number;
  readonly undecided: number;
  readonly unmeasured: number;
  readonly acceptanceRate: WilsonInterval;
  readonly refutations: {
    readonly total: number;
    /** Refuted with the code unchanged: the false alarms. */
    readonly confirmed: number;
    /** Refuted, then contradicted by a later change to the region: counted as hits. */
    readonly contradicted: number;
    readonly unmeasured: number;
  };
  readonly replies: {
    readonly fixed: number;
    readonly unclassified: number;
    readonly unanswered: number;
  };
}

export interface ReviewSplitCounts {
  readonly pullRequests: number;
  readonly pullRequestsWithThreads: number;
  readonly threads: number;
}

export interface ReviewBaseline {
  readonly repository: string;
  readonly datasetDigest: string;
  readonly pullRequests: number;
  readonly pullRequestsWithThreads: number;
  readonly firstPullRequest: number | null;
  readonly lastPullRequest: number | null;
  readonly producers: readonly ReviewProducerBaseline[];
  readonly splits: Readonly<Record<ReviewEvaluationSplit, ReviewSplitCounts>>;
}

interface Tally {
  threads: number;
  measured: number;
  changed: number;
  hits: number;
  falseAlarms: number;
  undecided: number;
  unmeasured: number;
  refuted: number;
  refutedConfirmed: number;
  refutedContradicted: number;
  refutedUnmeasured: number;
  fixed: number;
  unclassified: number;
  unanswered: number;
}

function emptyTally(): Tally {
  return {
    threads: 0,
    measured: 0,
    changed: 0,
    hits: 0,
    falseAlarms: 0,
    undecided: 0,
    unmeasured: 0,
    refuted: 0,
    refutedConfirmed: 0,
    refutedContradicted: 0,
    refutedUnmeasured: 0,
    fixed: 0,
    unclassified: 0,
    unanswered: 0,
  };
}

const LABEL_FIELD = {
  hit: "hits",
  "false-alarm": "falseAlarms",
  undecided: "undecided",
  unmeasured: "unmeasured",
} as const satisfies Record<ReviewThreadLabel, keyof Tally>;

const REPLY_FIELD = {
  refuted: undefined,
  fixed: "fixed",
  unclassified: "unclassified",
} as const satisfies Record<ReviewReplyClassification, keyof Tally | undefined>;

function addRefutation(tally: Tally, labelling: ReviewThreadLabelling): void {
  if (!labelling.refuted) return;
  tally.refuted += 1;
  if (labelling.label === "false-alarm") tally.refutedConfirmed += 1;
  if (labelling.refutationContradicted) tally.refutedContradicted += 1;
  if (labelling.label === "unmeasured") tally.refutedUnmeasured += 1;
}

function addThread(tally: Tally, thread: ReviewHarvestThread): void {
  const labelling = labelReviewThread(thread);
  tally.threads += 1;
  tally[LABEL_FIELD[labelling.label]] += 1;
  if (labelling.label !== "unmeasured") tally.measured += 1;
  if (thread.regionChange === "changed") tally.changed += 1;
  const replyField =
    thread.reply === null ? "unanswered" : REPLY_FIELD[thread.reply.classification];
  if (replyField !== undefined) tally[replyField] += 1;
  addRefutation(tally, labelling);
}

function producerBaseline(
  producer: ReviewProducer,
  pullRequests: readonly ReviewHarvestPullRequest[],
): ReviewProducerBaseline {
  const tally = emptyTally();
  let withThreads = 0;
  for (const pullRequest of pullRequests) {
    const own = pullRequest.threads.filter((thread) => thread.producer === producer);
    if (own.length > 0) withThreads += 1;
    for (const thread of own) addThread(tally, thread);
  }
  const reviewed = pullRequests.filter((pr) => pr.reviewedBy.includes(producer)).length;
  return {
    producer,
    pullRequestsReviewed: reviewed,
    pullRequestsWithThreads: withThreads,
    threads: tally.threads,
    findingsPerReviewedPullRequest: reviewed === 0 ? null : tally.threads / reviewed,
    regionMeasured: tally.measured,
    regionChanged: tally.changed,
    threadChangeRate: wilsonInterval(tally.changed, tally.measured),
    hits: tally.hits,
    falseAlarms: tally.falseAlarms,
    undecided: tally.undecided,
    unmeasured: tally.unmeasured,
    acceptanceRate: wilsonInterval(tally.hits, tally.hits + tally.falseAlarms),
    refutations: {
      total: tally.refuted,
      confirmed: tally.refutedConfirmed,
      contradicted: tally.refutedContradicted,
      unmeasured: tally.refutedUnmeasured,
    },
    replies: { fixed: tally.fixed, unclassified: tally.unclassified, unanswered: tally.unanswered },
  };
}

function splitCounts(pullRequests: readonly ReviewHarvestPullRequest[]): ReviewSplitCounts {
  return {
    pullRequests: pullRequests.length,
    pullRequestsWithThreads: pullRequests.filter((pr) => pr.threads.length > 0).length,
    threads: pullRequests.reduce((sum, pr) => sum + pr.threads.length, 0),
  };
}

/** Summarizes the labeled harvest per producer and per split of the manifest boundary. */
export function summarizeReviewBaseline(dataset: ReviewHarvestDataset): ReviewBaseline {
  const pullRequests = dataset.pullRequests;
  return {
    repository: dataset.repository,
    datasetDigest: dataset.digest,
    pullRequests: pullRequests.length,
    pullRequestsWithThreads: pullRequests.filter((pr) => pr.threads.length > 0).length,
    firstPullRequest: dataset.population.firstPullRequest,
    lastPullRequest: dataset.population.lastPullRequest,
    producers: REVIEW_PRODUCERS.map((producer) => producerBaseline(producer, pullRequests)),
    splits: {
      development: splitCounts(
        pullRequests.filter((pr) => reviewSplitOf(pr.number) === "development"),
      ),
      holdout: splitCounts(pullRequests.filter((pr) => reviewSplitOf(pr.number) === "holdout")),
    },
  };
}
