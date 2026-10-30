import { describe, expect, it } from "vitest";

import { wilsonInterval } from "@oscharko-dev/keiko-contracts/runtime/eval-metrics";

import { summarizeReviewBaseline } from "./baseline.js";
import { REVIEW_EVALUATION_MANIFEST } from "./manifest.js";
import { formatWilson, renderReviewBaseline } from "./render.js";
import { dataset, pullRequest, thread } from "./_support.js";

const BOUNDARY = REVIEW_EVALUATION_MANIFEST.holdoutFromPullRequest;
const refuted = { classification: "refuted", producer: "human" } as const;
const fixed = { classification: "fixed", producer: "human" } as const;

const history = dataset([
  pullRequest(BOUNDARY - 1, [
    thread({ id: "1", regionChange: "changed", reply: fixed }),
    thread({ id: "2", regionChange: "unchanged", reply: refuted }),
    thread({ id: "3", regionChange: "changed", reply: refuted }),
    thread({ id: "4", regionChange: "unchanged" }),
    thread({ id: "5", regionChange: "unavailable", reply: refuted }),
    thread({
      id: "6",
      producer: "human",
      regionChange: "no-later-commit",
      reply: { classification: "unclassified", producer: "codex" },
    }),
  ]),
  pullRequest(BOUNDARY, [], { reviewedBy: ["coderabbit", "qodo"] }),
  pullRequest(BOUNDARY + 1, [thread({ id: "7", producer: "qodo", regionChange: "changed" })]),
]);

describe("summarizeReviewBaseline", () => {
  const baseline = summarizeReviewBaseline(history);
  const coderabbit = baseline.producers.find((entry) => entry.producer === "coderabbit");
  const qodo = baseline.producers.find((entry) => entry.producer === "qodo");

  it("keeps the thread-change rate and the acceptance rate apart", () => {
    // 2 changed of 4 measured threads; 2 hits of 3 decided (hits plus the one confirmed refutation).
    expect(coderabbit?.threadChangeRate).toEqual(wilsonInterval(2, 4));
    expect(coderabbit?.acceptanceRate).toEqual(wilsonInterval(2, 3));
  });

  it("counts refutations as confirmed, contradicted or unmeasured", () => {
    expect(coderabbit?.refutations).toEqual({
      total: 3,
      confirmed: 1,
      contradicted: 1,
      unmeasured: 1,
    });
    expect(coderabbit).toMatchObject({
      threads: 5,
      regionMeasured: 4,
      hits: 2,
      falseAlarms: 1,
      undecided: 1,
      unmeasured: 1,
    });
    expect(coderabbit?.replies).toEqual({ fixed: 1, unclassified: 0, unanswered: 1 });
  });

  it("reports findings per reviewed pull request, including reviews without threads", () => {
    expect(coderabbit).toMatchObject({
      pullRequestsReviewed: 2,
      pullRequestsWithThreads: 1,
      findingsPerReviewedPullRequest: 2.5,
    });
    expect(qodo).toMatchObject({
      pullRequestsReviewed: 2,
      threads: 1,
      findingsPerReviewedPullRequest: 0.5,
    });
    const codex = baseline.producers.find((entry) => entry.producer === "codex");
    expect(codex).toMatchObject({ pullRequestsReviewed: 0, findingsPerReviewedPullRequest: null });
    expect(codex?.threadChangeRate.rate).toBeNull();
  });

  it("splits the history at the manifest boundary", () => {
    expect(baseline.splits.development).toEqual({
      pullRequests: 1,
      pullRequestsWithThreads: 1,
      threads: 6,
    });
    expect(baseline.splits.holdout).toEqual({
      pullRequests: 2,
      pullRequestsWithThreads: 1,
      threads: 1,
    });
    expect(baseline).toMatchObject({
      pullRequests: 3,
      pullRequestsWithThreads: 2,
      datasetDigest: history.digest,
    });
  });

  it("renders absolute counts and intervals for every producer", () => {
    const text = renderReviewBaseline(baseline);
    expect(text).toContain(
      `| CodeRabbit | 2 | 5 | 2.50 | ${formatWilson(wilsonInterval(2, 4))} | 1 | 3 (1 confirmed, 1 contradicted) | 2 / 1 / 1 | ${formatWilson(wilsonInterval(2, 3))} |`,
    );
    expect(text).toContain(
      "| Codex | 0 | 0 | — | — (0/0) | 0 | 0 (0 confirmed, 0 contradicted) | 0 / 0 / 0 | — (0/0) |",
    );
    expect(formatWilson(wilsonInterval(1, 2))).toBe("50.0 % (1/2; 95 % CI 9.5-90.5 %)");
  });
});
