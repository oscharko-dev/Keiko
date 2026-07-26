import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  COHORTS,
  MERGED_PULL_REQUESTS_QUERY,
  MERGE_ORDER_OVERSAMPLE,
  OUTCOMES,
  collectMergedPullRequests,
  earliestStart,
  executeSettlementCli,
  ghGraphql,
  ghGraphqlWithRetry,
  median,
  renderReport,
  requiredChecksFromContributing,
  requiredGreenAt,
  requireRepositorySlug,
  runSettlementReport,
  summarizeCohorts,
  summarizePullRequest,
  timelineFromNode,
} from "../report-settlement-latency.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REQUIRED = ["ci", "workflow hygiene", "ui"];

function head(startedAt, requiredGreenAt = null) {
  return { startedAt, requiredGreenAt };
}

function checkRun(name, conclusion, startedAt, completedAt) {
  return { __typename: "CheckRun", name, conclusion, startedAt, completedAt };
}

describe("required checks come from CONTRIBUTING.md", () => {
  it("parses the committed list rather than keeping a second copy", () => {
    const checks = requiredChecksFromContributing(
      readFileSync(resolve(repoRoot, "CONTRIBUTING.md"), "utf8"),
    );

    expect(checks).toContain("ci");
    expect(checks).toContain("workflow hygiene");
    expect(checks).toContain("Keiko for Quality");
    expect(new Set(checks).size).toBe(checks.length);
    expect(checks.length).toBeGreaterThanOrEqual(10);
  });

  it("stops at the end of the list and ignores prose that follows", () => {
    const markdown = [
      "All required status checks must pass before merge:",
      "",
      "1. `ci`",
      "2. `ui`",
      "",
      "`workflow hygiene` runs actionlint and friends.",
      "3. `not part of the list`",
    ].join("\n");

    expect(requiredChecksFromContributing(markdown)).toEqual(["ci", "ui"]);
  });

  it("fails loud when the document no longer states the list", () => {
    expect(() => requiredChecksFromContributing("# Contributing\n\nNothing here.")).toThrow(
      /no longer states/u,
    );
    expect(() =>
      requiredChecksFromContributing("required status checks must pass\n\nprose only\n"),
    ).toThrow(/lists no required status checks/u);
  });
});

describe("head greenness", () => {
  it("takes the latest successful completion per check, so a re-run wins", () => {
    const contexts = [
      checkRun("ci", "SUCCESS", "2026-07-25T10:00:00Z", "2026-07-25T10:20:00Z"),
      checkRun("ci", "SUCCESS", "2026-07-25T10:30:00Z", "2026-07-25T10:50:00Z"),
      checkRun("workflow hygiene", "SUCCESS", "2026-07-25T10:00:00Z", "2026-07-25T10:05:00Z"),
    ];

    expect(requiredGreenAt(contexts, REQUIRED)).toBe("2026-07-25T10:50:00.000Z");
  });

  it("accepts a required check that failed and was then re-run green", () => {
    const contexts = [
      checkRun("ci", "FAILURE", "2026-07-25T10:00:00Z", "2026-07-25T10:20:00Z"),
      checkRun("ci", "SUCCESS", "2026-07-25T10:30:00Z", "2026-07-25T10:55:00Z"),
      checkRun("workflow hygiene", "SUCCESS", "2026-07-25T10:00:00Z", "2026-07-25T10:05:00Z"),
    ];

    expect(requiredGreenAt(contexts, REQUIRED)).toBe("2026-07-25T10:55:00.000Z");
  });

  it("still refuses a check whose latest attempt failed, whatever came before", () => {
    const contexts = [
      checkRun("ci", "SUCCESS", "2026-07-25T10:00:00Z", "2026-07-25T10:20:00Z"),
      checkRun("ci", "FAILURE", "2026-07-25T10:30:00Z", "2026-07-25T10:55:00Z"),
      checkRun("workflow hygiene", "SUCCESS", "2026-07-25T10:00:00Z", "2026-07-25T10:05:00Z"),
    ];

    expect(requiredGreenAt(contexts, REQUIRED)).toBeNull();
  });

  it("treats a check that is still running as the newest state, and not as green", () => {
    const contexts = [
      checkRun("ci", "SUCCESS", "2026-07-25T10:00:00Z", "2026-07-25T10:20:00Z"),
      checkRun("workflow hygiene", "SUCCESS", "2026-07-25T10:00:00Z", "2026-07-25T10:05:00Z"),
      { __typename: "CheckRun", name: "ui", conclusion: null, startedAt: "2026-07-25T10:00:00Z" },
    ];

    expect(requiredGreenAt(contexts, REQUIRED)).toBeNull();
  });

  it("returns null when a required check failed, whatever else succeeded", () => {
    const contexts = [
      checkRun("ci", "SUCCESS", "2026-07-25T10:00:00Z", "2026-07-25T10:20:00Z"),
      checkRun("workflow hygiene", "FAILURE", "2026-07-25T10:00:00Z", "2026-07-25T10:05:00Z"),
    ];

    expect(requiredGreenAt(contexts, REQUIRED)).toBeNull();
  });

  it("returns null when too few required checks ran to call the head green", () => {
    const one = [checkRun("ci", "SUCCESS", "2026-07-25T10:00:00Z", "2026-07-25T10:20:00Z")];
    const two = [
      ...one,
      checkRun("workflow hygiene", "SUCCESS", "2026-07-25T10:00:00Z", "2026-07-25T10:05:00Z"),
    ];

    expect(requiredGreenAt(one, REQUIRED)).toBeNull();
    expect(requiredGreenAt(two, REQUIRED)).toBe("2026-07-25T10:20:00.000Z");
  });

  it("accepts commit statuses beside check runs, and ignores non-required contexts", () => {
    const contexts = [
      checkRun("ci", "SUCCESS", "2026-07-25T10:00:00Z", "2026-07-25T10:20:00Z"),
      {
        __typename: "StatusContext",
        context: "ui",
        state: "SUCCESS",
        createdAt: "2026-07-25T10:40:00Z",
      },
      {
        __typename: "StatusContext",
        context: "advisory",
        state: "FAILURE",
        createdAt: "2026-07-25T11:00:00Z",
      },
    ];

    expect(requiredGreenAt(contexts, REQUIRED)).toBe("2026-07-25T10:40:00.000Z");
  });

  it("reads the earliest start as the push proxy and tolerates an absent one", () => {
    expect(
      earliestStart([
        checkRun("ci", "SUCCESS", "2026-07-25T10:07:00Z", "2026-07-25T10:20:00Z"),
        checkRun("ui", "SUCCESS", "2026-07-25T10:03:00Z", "2026-07-25T10:25:00Z"),
      ]),
    ).toBe("2026-07-25T10:03:00.000Z");
    expect(earliestStart([{ __typename: "CheckRun", name: "ci" }])).toBeUndefined();
  });
});

describe("pull-request summary", () => {
  it("measures a clean pull request that merged straight after turning green", () => {
    const report = summarizePullRequest({
      number: 2718,
      mergedAt: "2026-07-25T11:00:00Z",
      heads: [head("2026-07-25T10:00:00Z", "2026-07-25T10:58:00Z")],
      findings: [],
    });

    expect(report).toEqual({
      number: 2718,
      cohort: "clean",
      outcome: "measured",
      headCount: 1,
      repairRounds: 0,
      findingCount: 0,
      checksGreenToMergedMinutes: 2,
      firstGreenToMergedMinutes: 2,
      reactionMinutes: [],
    });
  });

  it("separates the settlement span from the final gap across repair rounds", () => {
    const report = summarizePullRequest({
      number: 2700,
      mergedAt: "2026-07-25T13:00:00Z",
      heads: [
        head("2026-07-25T10:00:00Z", "2026-07-25T10:30:00Z"),
        head("2026-07-25T11:00:00Z", "2026-07-25T12:59:00Z"),
      ],
      findings: ["2026-07-25T10:40:00Z"],
    });

    expect(report.cohort).toBe("finding-bearing");
    expect(report.repairRounds).toBe(1);
    // Auto-merge closes the final gap in a minute; the settlement span carries the repair round.
    expect(report.checksGreenToMergedMinutes).toBe(1);
    expect(report.firstGreenToMergedMinutes).toBe(150);
    expect(report.reactionMinutes).toEqual([20]);
  });

  it("reports a pull request CI never observed instead of aborting the whole report", () => {
    const report = summarizePullRequest({
      number: 3,
      mergedAt: "2026-07-25T11:00:00Z",
      heads: [],
      findings: [],
    });

    expect(report).toMatchObject({
      outcome: "unobserved",
      headCount: 0,
      repairRounds: 0,
      checksGreenToMergedMinutes: null,
      firstGreenToMergedMinutes: null,
    });
  });

  it("reports a head that never went green instead of guessing a duration", () => {
    const report = summarizePullRequest({
      number: 2702,
      mergedAt: "2026-07-25T13:00:00Z",
      heads: [head("2026-07-25T10:00:00Z", "2026-07-25T10:30:00Z"), head("2026-07-25T11:00:00Z")],
      findings: ["2026-07-25T10:40:00Z"],
    });

    expect(report.outcome).toBe("never-fully-green");
    expect(report.checksGreenToMergedMinutes).toBeNull();
    expect(report.firstGreenToMergedMinutes).toBe(150);
  });

  it("reports an administrative merge that landed before its checks finished", () => {
    const report = summarizePullRequest({
      number: 2732,
      mergedAt: "2026-07-25T12:00:00Z",
      heads: [head("2026-07-25T10:00:00Z", "2026-07-25T12:30:00Z")],
      findings: [],
    });

    expect(report.outcome).toBe("merged-before-green");
    expect(report.checksGreenToMergedMinutes).toBeNull();
    expect(report.firstGreenToMergedMinutes).toBeNull();
  });

  it("counts a reaction only for a round that answered a finding", () => {
    const report = summarizePullRequest({
      number: 1,
      mergedAt: "2026-07-25T14:00:00Z",
      heads: [
        head("2026-07-25T10:00:00Z", "2026-07-25T10:30:00Z"),
        head("2026-07-25T11:00:00Z", "2026-07-25T11:30:00Z"),
        head("2026-07-25T12:00:00Z", "2026-07-25T13:00:00Z"),
      ],
      findings: ["2026-07-25T11:40:00Z"],
    });

    expect(report.repairRounds).toBe(2);
    expect(report.reactionMinutes).toEqual([20]);
  });

  it("counts a finding that arrived while CI was still running", () => {
    const report = summarizePullRequest({
      number: 1,
      mergedAt: "2026-07-25T14:00:00Z",
      heads: [
        head("2026-07-25T10:00:00Z", "2026-07-25T10:30:00Z"),
        head("2026-07-25T11:00:00Z", "2026-07-25T13:00:00Z"),
      ],
      // Published 10 minutes into CI, well before the head turned green - the common case.
      findings: ["2026-07-25T10:10:00Z"],
    });

    expect(report.reactionMinutes).toEqual([50]);
  });

  it("fails loud on malformed data rather than reporting a wrong duration", () => {
    const valid = {
      number: 1,
      mergedAt: "2026-07-25T11:00:00Z",
      heads: [head("2026-07-25T10:00:00Z", "2026-07-25T10:30:00Z")],
      findings: [],
    };

    expect(() => summarizePullRequest({ ...valid, number: "1" })).toThrow(/integer number/u);
    expect(() => summarizePullRequest({ ...valid, mergedAt: "yesterday" })).toThrow(/ISO-8601/u);
    expect(() => summarizePullRequest({ ...valid, mergedAt: undefined })).toThrow(/ISO-8601/u);
    expect(() => summarizePullRequest({ ...valid, heads: undefined })).toThrow(TypeError);
    expect(() => summarizePullRequest({ ...valid, findings: "none" })).toThrow(
      /array of instants/u,
    );
    expect(() => summarizePullRequest({ ...valid, findings: ["soon"] })).toThrow(/ISO-8601/u);
    expect(() =>
      summarizePullRequest({
        ...valid,
        heads: [head("2026-07-25T11:00:00Z"), head("2026-07-25T10:00:00Z")],
      }),
    ).toThrow(/ordered by their start instant/u);
  });
});

describe("cohort aggregation", () => {
  const reports = [
    summarizePullRequest({
      number: 1,
      mergedAt: "2026-07-25T11:00:00Z",
      heads: [head("2026-07-25T10:00:00Z", "2026-07-25T10:50:00Z")],
      findings: [],
    }),
    summarizePullRequest({
      number: 2,
      mergedAt: "2026-07-25T13:00:00Z",
      heads: [
        head("2026-07-25T10:00:00Z", "2026-07-25T10:30:00Z"),
        head("2026-07-25T11:00:00Z", "2026-07-25T12:50:00Z"),
      ],
      findings: ["2026-07-25T10:40:00Z"],
    }),
  ];

  it("summarizes both cohorts, always in the same order", () => {
    const cohorts = summarizeCohorts(reports);

    expect(cohorts.map((cohort) => cohort.cohort)).toEqual([...COHORTS]);
    expect(cohorts[0]).toMatchObject({
      pullRequests: 1,
      measured: 1,
      medianSettlementMinutes: 150,
    });
    expect(cohorts[1]).toMatchObject({ pullRequests: 1, measured: 1, medianGapMinutes: 10 });
  });

  it("reports null rather than zero for an empty cohort", () => {
    const [findingBearing] = summarizeCohorts([]);

    expect(findingBearing).toMatchObject({
      pullRequests: 0,
      measured: 0,
      medianGapMinutes: null,
      medianSettlementMinutes: null,
      maxSettlementMinutes: null,
    });
  });

  it("computes a median for both odd and even sample counts", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("renders a report whose rows match the summaries", () => {
    const rendered = renderReport(reports, summarizeCohorts(reports));

    expect(rendered).toContain("| 1 | clean | measured |");
    expect(rendered).toContain("| 2 | finding-bearing | measured |");
    expect(rendered).toContain("median settlement");
  });

  it("renders an absent value as a dash in both tables, never as the string null", () => {
    const rendered = renderReport([], summarizeCohorts([]));

    expect(rendered).not.toContain("null");
    expect(rendered).toContain("| finding-bearing | 0 | 0 | - | - | - | - | - |");
  });
});

describe("redaction is structural", () => {
  const ENUMS = new Set([...OUTCOMES, ...COHORTS]);
  const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

  function assertRedacted(value, path) {
    if (value === null || typeof value === "number" || typeof value === "boolean") return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        assertRedacted(entry, `${path}[${String(index)}]`);
      });
      return;
    }
    if (typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) assertRedacted(entry, `${path}.${key}`);
      return;
    }
    // The only strings the schema admits are the closed enums and ISO instants. Anything else is
    // free text and could carry a finding body, a file name or an author.
    expect(
      typeof value === "string" && (ENUMS.has(value) || INSTANT.test(value)),
      `${path} carries free text: ${JSON.stringify(value)}`,
    ).toBe(true);
  }

  it("admits no free-text leaf anywhere in a summary or a cohort", () => {
    const reports = [
      summarizePullRequest({
        number: 2738,
        mergedAt: "2026-07-25T23:43:05Z",
        heads: [
          head("2026-07-25T22:00:00Z", "2026-07-25T22:40:00Z"),
          head("2026-07-25T23:00:00Z", "2026-07-25T23:43:00Z"),
        ],
        findings: ["2026-07-25T22:44:08Z"],
      }),
    ];

    assertRedacted(reports, "reports");
    assertRedacted(summarizeCohorts(reports), "cohorts");
  });

  it("drops everything but the instant when reducing a review thread", () => {
    const timeline = timelineFromNode(
      {
        number: 7,
        mergedAt: "2026-07-25T12:00:00Z",
        commits: { nodes: [] },
        reviewThreads: {
          nodes: [
            {
              comments: {
                nodes: [
                  {
                    createdAt: "2026-07-25T11:00:00Z",
                    body: "secret finding body",
                    author: { login: "reviewer" },
                    path: "packages/keiko-server/src/secret.ts",
                  },
                ],
              },
            },
          ],
        },
      },
      REQUIRED,
    );

    expect(timeline.findings).toEqual(["2026-07-25T11:00:00Z"]);
    expect(JSON.stringify(timeline)).not.toContain("secret");
    expect(JSON.stringify(timeline)).not.toContain("reviewer");
  });
});

describe("collection", () => {
  it("keeps only commits CI actually observed, so a batched push is one round", () => {
    const timeline = timelineFromNode(
      {
        number: 2738,
        mergedAt: "2026-07-25T23:43:05Z",
        commits: {
          nodes: [
            {
              commit: {
                oid: "a",
                committedDate: "2026-07-25T22:00:00Z",
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      checkRun("ci", "SUCCESS", "2026-07-25T22:05:00Z", "2026-07-25T22:40:00Z"),
                      checkRun("ui", "SUCCESS", "2026-07-25T22:06:00Z", "2026-07-25T22:35:00Z"),
                    ],
                  },
                },
              },
            },
            // Pushed inside the same batch behind a later commit: CI never ran on it.
            {
              commit: { oid: "b", committedDate: "2026-07-25T22:50:00Z", statusCheckRollup: null },
            },
          ],
        },
        reviewThreads: { nodes: [] },
      },
      REQUIRED,
    );

    expect(timeline.heads).toHaveLength(1);
    expect(timeline.heads[0]).toEqual({
      startedAt: "2026-07-25T22:05:00.000Z",
      requiredGreenAt: "2026-07-25T22:40:00.000Z",
    });
  });

  it("refuses to report durations for a pull request GitHub truncated", () => {
    const timeline = timelineFromNode(
      {
        number: 9,
        mergedAt: "2026-07-25T12:00:00Z",
        commits: {
          totalCount: 250,
          nodes: [
            {
              commit: {
                oid: "a",
                committedDate: "2026-07-25T10:00:00Z",
                statusCheckRollup: {
                  contexts: {
                    totalCount: 2,
                    nodes: [
                      checkRun("ci", "SUCCESS", "2026-07-25T10:01:00Z", "2026-07-25T10:20:00Z"),
                      checkRun("ui", "SUCCESS", "2026-07-25T10:02:00Z", "2026-07-25T10:25:00Z"),
                    ],
                  },
                },
              },
            },
          ],
        },
        reviewThreads: { totalCount: 0, nodes: [] },
      },
      REQUIRED,
    );

    expect(timeline.truncated).toBe(true);
    const report = summarizePullRequest(timeline);
    expect(report.outcome).toBe("truncated");
    expect(report.checksGreenToMergedMinutes).toBeNull();
    expect(report.firstGreenToMergedMinutes).toBeNull();
  });

  it("cannot establish greenness from a truncated context list", () => {
    const timeline = timelineFromNode(
      {
        number: 9,
        mergedAt: "2026-07-25T12:00:00Z",
        commits: {
          totalCount: 1,
          nodes: [
            {
              commit: {
                oid: "a",
                committedDate: "2026-07-25T10:00:00Z",
                statusCheckRollup: {
                  contexts: {
                    totalCount: 99,
                    nodes: [
                      checkRun("ci", "SUCCESS", "2026-07-25T10:01:00Z", "2026-07-25T10:20:00Z"),
                      checkRun("ui", "SUCCESS", "2026-07-25T10:02:00Z", "2026-07-25T10:25:00Z"),
                    ],
                  },
                },
              },
            },
          ],
        },
        reviewThreads: { totalCount: 0, nodes: [] },
      },
      REQUIRED,
    );

    expect(timeline.heads[0].requiredGreenAt).toBeNull();
  });

  it("clamps a commit-date fallback so one odd head cannot abort the whole report", () => {
    const withStart = (started, completed) => ({
      commit: {
        oid: "a",
        committedDate: "2026-07-25T09:00:00Z",
        statusCheckRollup: {
          totalCount: 2,
          contexts: {
            totalCount: 2,
            nodes: [
              checkRun("ci", "SUCCESS", started, completed),
              checkRun("ui", "SUCCESS", started, completed),
            ],
          },
        },
      },
    });
    // Head 2 has no observable CI start, so it falls back to a commit date that PRECEDES head 1's
    // CI start. Unclamped that inversion throws and takes every other pull request with it.
    const noStart = {
      commit: {
        oid: "b",
        committedDate: "2026-07-25T09:00:00Z",
        statusCheckRollup: {
          contexts: {
            totalCount: 1,
            nodes: [{ __typename: "CheckRun", name: "ci", conclusion: "SUCCESS" }],
          },
        },
      },
    };

    const timeline = timelineFromNode(
      {
        number: 5,
        mergedAt: "2026-07-25T13:00:00Z",
        commits: {
          totalCount: 2,
          nodes: [withStart("2026-07-25T11:00:00Z", "2026-07-25T11:30:00Z"), noStart],
        },
        reviewThreads: { totalCount: 0, nodes: [] },
      },
      REQUIRED,
    );

    expect(timeline.heads[1].startedAt).toBe(timeline.heads[0].startedAt);
    expect(() => summarizePullRequest(timeline)).not.toThrow();
  });

  it("refuses to page on when the query stops making progress", () => {
    const repeating = vi.fn().mockReturnValue({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: true, endCursor: "same" },
          nodes: [{ number: 1 }],
        },
      },
    });
    const empty = vi.fn().mockReturnValue({
      repository: {
        pullRequests: { pageInfo: { hasNextPage: true, endCursor: "c" }, nodes: [] },
      },
    });

    expect(() => collectMergedPullRequests(20, { repository: "o/r", query: repeating })).toThrow(
      /made no progress/u,
    );
    expect(() => collectMergedPullRequests(20, { repository: "o/r", query: empty })).toThrow(
      /made no progress/u,
    );
  });

  it("refuses to page on when GitHub promises a page but sends no cursor", () => {
    const query = vi.fn().mockReturnValue({
      repository: {
        pullRequests: { pageInfo: { hasNextPage: true }, nodes: [{ number: 1 }] },
      },
    });

    expect(() => collectMergedPullRequests(20, { repository: "o/r", query })).toThrow(
      /without a cursor/u,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("bounds the outbound call so a hung request cannot stall the report", () => {
    const execute = vi.fn().mockReturnValue({ status: 0, stdout: '{"data":{}}' });

    ghGraphql("q", {}, { execute, ghExecutable: "gh" });

    expect(execute.mock.calls[0][2]).toMatchObject({ timeout: expect.any(Number) });
    expect(execute.mock.calls[0][2].timeout).toBeGreaterThan(0);
  });

  it("asks GitHub for merged pull requests against dev and validates the slug", () => {
    const query = vi.fn().mockReturnValue({
      repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [{ number: 1 }] } },
    });

    expect(collectMergedPullRequests(3, { repository: "o/r", query })).toEqual([{ number: 1 }]);
    // The window is 3, but the collector oversamples so it can order by merge instant itself; the
    // first request is bounded by the page size rather than by the window.
    expect(query.mock.calls[0][0]).toMatchObject({ owner: "o", name: "r", after: null });
    expect(query.mock.calls[0][0].count).toBeGreaterThan(3);
    expect(MERGED_PULL_REQUESTS_QUERY).toContain('baseRefName:"dev"');
    expect(() => collectMergedPullRequests(3, { repository: "nope", query })).toThrow(
      /repository slug/u,
    );
    expect(requireRepositorySlug("oscharko-dev/Keiko")).toBe("oscharko-dev/Keiko");
  });

  it("pages until the window is filled, then stops asking", () => {
    const query = vi
      .fn()
      .mockReturnValueOnce({
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            nodes: [
              { number: 1, mergedAt: "2026-07-21T00:00:00Z" },
              { number: 2, mergedAt: "2026-07-22T00:00:00Z" },
            ],
          },
        },
      })
      .mockReturnValueOnce({
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false },
            nodes: [{ number: 3, mergedAt: "2026-07-23T00:00:00Z" }],
          },
        },
      });

    expect(
      collectMergedPullRequests(3, { repository: "o/r", query })
        .map((node) => node.number)
        .sort((left, right) => left - right),
    ).toEqual([1, 2, 3]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toMatchObject({ after: "cursor-1" });
  });

  it("orders by merge instant, because GitHub can only order by update instant", () => {
    // A pull request updated after it merged sorts ahead of a newer merge in GitHub's own ordering.
    const query = vi.fn().mockReturnValue({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false },
          nodes: [
            { number: 1, mergedAt: "2026-07-20T10:00:00Z" },
            { number: 2, mergedAt: "2026-07-25T10:00:00Z" },
            { number: 3, mergedAt: "2026-07-23T10:00:00Z" },
          ],
        },
      },
    });

    expect(collectMergedPullRequests(2, { repository: "o/r", query }).map((n) => n.number)).toEqual(
      [2, 3],
    );
    // …and it oversamples, because ordering a single window would only reorder the wrong sample.
    expect(query.mock.calls[0][0].count).toBeGreaterThan(2);
    expect(MERGE_ORDER_OVERSAMPLE).toBeGreaterThan(1);
  });

  it("stops early when GitHub reports no further page", () => {
    const query = vi.fn().mockReturnValue({
      repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [{ number: 1 }] } },
    });

    expect(collectMergedPullRequests(50, { repository: "o/r", query })).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("retries a transient GitHub outage with backoff, then gives up loudly", () => {
    const wait = vi.fn();
    const flaky = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "gh: ... (HTTP 504)" })
      .mockReturnValueOnce({ status: 0, stdout: '{"data":{"ok":true}}' });

    expect(ghGraphqlWithRetry("q", {}, { execute: flaky, ghExecutable: "gh", wait })).toEqual({
      ok: true,
    });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(2000);

    const always504 = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "(HTTP 504)" });
    expect(() =>
      ghGraphqlWithRetry("q", {}, { execute: always504, ghExecutable: "gh", wait, attempts: 3 }),
    ).toThrow(/504/u);
    expect(always504).toHaveBeenCalledTimes(3);
  });

  it("does not retry a failure that is not transport weather", () => {
    const wait = vi.fn();
    const rejected = vi
      .fn()
      .mockReturnValue({ status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" });

    expect(() =>
      ghGraphqlWithRetry("q", {}, { execute: rejected, ghExecutable: "gh", wait }),
    ).toThrow(/401/u);
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("fails loud when the query returns an unexpected shape", () => {
    const query = vi.fn().mockReturnValue({ repository: null });

    expect(() => collectMergedPullRequests(5, { repository: "o/r", query })).toThrow(
      /no node list/u,
    );
  });

  it("surfaces a graphql transport failure instead of returning an empty report", () => {
    const ok = vi.fn().mockReturnValue({ status: 0, stdout: '{"data":{"x":1}}' });
    const failed = vi.fn().mockReturnValue({ status: 1, stdout: "" });
    const errored = vi.fn().mockReturnValue({ error: new Error("ENOENT"), status: null });
    const graphqlErrors = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: '{"errors":[{"message":"bad"}]}' });

    expect(
      ghGraphql(
        "query{}",
        { a: 1, after: null, cursor: "c=1" },
        { execute: ok, ghExecutable: "gh" },
      ),
    ).toEqual({ x: 1 });
    // A null variable is omitted, an Int is type-inferred with -F, a cursor stays a raw string.
    expect(ok.mock.calls[0][1]).toEqual([
      "api",
      "graphql",
      "-f",
      "query=query{}",
      "-F",
      "a=1",
      "-f",
      "cursor=c=1",
    ]);
    expect(() => ghGraphql("q", {}, { execute: failed, ghExecutable: "gh" })).toThrow(/status 1/u);
    expect(() => ghGraphql("q", {}, { execute: errored, ghExecutable: "gh" })).toThrow(/ENOENT/u);
    expect(() => ghGraphql("q", {}, { execute: graphqlErrors, ghExecutable: "gh" })).toThrow(
      /1 error\(s\)/u,
    );
  });
});

describe("command line surface", () => {
  const node = {
    number: 1,
    mergedAt: "2026-07-25T11:00:00Z",
    commits: {
      nodes: [
        {
          commit: {
            oid: "a",
            committedDate: "2026-07-25T10:00:00Z",
            statusCheckRollup: {
              contexts: {
                nodes: [
                  checkRun("ci", "SUCCESS", "2026-07-25T10:01:00Z", "2026-07-25T10:50:00Z"),
                  checkRun("ui", "SUCCESS", "2026-07-25T10:02:00Z", "2026-07-25T10:45:00Z"),
                ],
              },
            },
          },
        },
      ],
    },
    reviewThreads: { nodes: [] },
  };

  it("runs end to end over injected collaborators", () => {
    const collect = vi.fn().mockReturnValue([node]);
    const { reports, cohorts } = runSettlementReport({
      argv: ["--count", "1"],
      collect,
      readRequired: () => REQUIRED,
    });

    expect(collect.mock.calls[0][0]).toBe(1);
    expect(reports[0]).toMatchObject({ number: 1, cohort: "clean", outcome: "measured" });
    expect(cohorts).toHaveLength(2);
  });

  it("defaults the window and rejects an out-of-range one", () => {
    const collect = vi.fn().mockReturnValue([]);

    runSettlementReport({ argv: [], collect, readRequired: () => REQUIRED });
    expect(collect.mock.calls[0][0]).toBe(20);

    for (const count of ["0", "101", "ten", "1.5"]) {
      expect(() =>
        runSettlementReport({ argv: ["--count", count], collect, readRequired: () => REQUIRED }),
      ).toThrow(/--count/u);
    }

    // A flag with no value is user error, not a request for the default window.
    for (const argv of [["--count"], ["--count", "--all"]]) {
      expect(() => runSettlementReport({ argv, collect, readRequired: () => REQUIRED })).toThrow(
        /--count needs a value/u,
      );
    }
  });

  it("names the pull request when one of them cannot be summarized", () => {
    const collect = vi.fn().mockReturnValue([{ number: 4242, mergedAt: "not-an-instant" }]);

    expect(() => runSettlementReport({ argv: [], collect, readRequired: () => REQUIRED })).toThrow(
      /pull request 4242: merge instant/u,
    );
  });

  it("prints the report and exits zero", () => {
    const log = vi.fn();
    const setExitCode = vi.fn();

    executeSettlementCli({
      run: () => ({ reports: [], cohorts: summarizeCohorts([]) }),
      log,
      setExitCode,
    });

    expect(setExitCode).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain("| cohort |");
  });

  it("reports a failure on stderr and exits non-zero", () => {
    const error = vi.fn();
    const setExitCode = vi.fn();

    executeSettlementCli({
      run: () => {
        throw new Error("merge instant must be an ISO-8601 instant");
      },
      error,
      log: vi.fn(),
      setExitCode,
    });

    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      "settlement-latency: FAIL - merge instant must be an ISO-8601 instant",
    );
  });

  it("reports a non-Error rejection without crashing", () => {
    const error = vi.fn();

    executeSettlementCli({
      run: () => {
        throw "broken";
      },
      error,
      log: vi.fn(),
      setExitCode: vi.fn(),
    });

    expect(error).toHaveBeenCalledWith("settlement-latency: FAIL - broken");
  });
});
