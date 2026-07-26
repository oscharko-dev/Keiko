import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  COHORTS,
  MERGED_PULL_REQUESTS_QUERY,
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
    expect(() => summarizePullRequest({ ...valid, heads: [] })).toThrow(/at least one head/u);
    expect(() => summarizePullRequest({ ...valid, heads: undefined })).toThrow(
      /at least one head/u,
    );
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

  it("asks GitHub for merged pull requests against dev and validates the slug", () => {
    const query = vi.fn().mockReturnValue({
      repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [{ number: 1 }] } },
    });

    expect(collectMergedPullRequests(5, { repository: "o/r", query })).toEqual([{ number: 1 }]);
    expect(query).toHaveBeenCalledWith({ owner: "o", name: "r", count: 5, after: null });
    expect(MERGED_PULL_REQUESTS_QUERY).toContain('baseRefName:"dev"');
    expect(() => collectMergedPullRequests(5, { repository: "nope", query })).toThrow(
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
            nodes: [{ number: 1 }, { number: 2 }],
          },
        },
      })
      .mockReturnValueOnce({
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
            nodes: [{ number: 3 }],
          },
        },
      });

    expect(collectMergedPullRequests(3, { repository: "o/r", query })).toEqual([
      { number: 1 },
      { number: 2 },
      { number: 3 },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toMatchObject({ after: "cursor-1", count: 1 });
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
