import { describe, expect, it, vi } from "vitest";

import {
  checkGreptileFindings,
  main,
  validateGreptileEvidence,
} from "../check-greptile-findings.mjs";

const HEAD = "a".repeat(40);
const ENV = {
  GITHUB_REPOSITORY: "oscharko-dev/Keiko",
  GITHUB_TOKEN: "test",
  QUALITY_HEAD_SHA: HEAD,
  QUALITY_PULL_REQUEST: "2876",
};
const CHECK = {
  app: { id: 867_647 },
  conclusion: "success",
  head_sha: HEAD,
  name: "Greptile Review",
  status: "completed",
};
const SUMMARY = {
  body: `<h3>Greptile Summary</h3> Last reviewed commit: /commit/${HEAD}`,
  updated_at: "2026-08-01T07:00:00Z",
  user: { login: "greptile-apps[bot]" },
};
const THREAD_CONNECTION = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    },
  },
};

function response(payload, ok = true, status = ok ? 200 : 400, headers = {}) {
  return {
    headers: { get: vi.fn((name) => headers[name.toLowerCase()] ?? null) },
    json: vi.fn().mockResolvedValue(payload),
    ok,
    status,
  };
}

function requestSequence(...responses) {
  return vi.fn().mockImplementation(() => Promise.resolve(responses.shift()));
}

describe("Greptile finding settlement", () => {
  it("accepts exact-head completion with a clean summary and no open thread", () => {
    expect(
      validateGreptileEvidence({ check: CHECK, comments: [SUMMARY], head: HEAD, threads: [] }),
    ).toEqual([]);
  });

  it("ignores a forged summary posted by a non-Greptile author", () => {
    const forged = { ...SUMMARY, user: { login: "pull-request-author" } };
    expect(
      validateGreptileEvidence({ check: CHECK, comments: [forged], head: HEAD, threads: [] }),
    ).toEqual(["latest Greptile summary is not bound to the exact head"]);
  });

  it("rejects the wrong producer, incomplete review, stale summary, and open thread", () => {
    const problems = validateGreptileEvidence({
      check: { ...CHECK, app: { id: 1 }, conclusion: null, status: "in_progress" },
      comments: [{ ...SUMMARY, body: "<h3>Greptile Summary</h3> stale" }],
      head: HEAD,
      threads: [
        {
          comments: { nodes: [{ author: { login: "greptile-apps" } }] },
          isResolved: false,
        },
      ],
    });
    expect(problems).toEqual([
      "review completion is not bound to the expected app and exact head",
      "exact-head Greptile review did not complete successfully",
      "latest Greptile summary is not bound to the exact head",
      "Greptile has unresolved inline review conversations",
    ]);
  });

  it.each(["P0", "P1", "P2"])("rejects an unresolved %s summary finding", (severity) => {
    const summary = { ...SUMMARY, body: `${SUMMARY.body} <img alt="${severity}">` };
    expect(
      validateGreptileEvidence({ check: CHECK, comments: [summary], head: HEAD, threads: [] }),
    ).toContain("latest Greptile summary contains an unresolved severity finding");
  });

  it("ignores resolved Greptile threads and unresolved threads owned by another reviewer", () => {
    const greptile = { comments: { nodes: [{ author: { login: "greptile-apps" } }] } };
    const other = { comments: { nodes: [{ author: { login: "other" } }] } };
    expect(
      validateGreptileEvidence({
        check: CHECK,
        comments: [SUMMARY],
        head: HEAD,
        threads: [
          { ...greptile, isResolved: true },
          { ...other, isResolved: false },
        ],
      }),
    ).toEqual([]);
  });

  it.each([
    [{ ...ENV, GITHUB_REPOSITORY: "other/repository" }, "repository identity"],
    [{ ...ENV, QUALITY_PULL_REQUEST: "0" }, "pull request number"],
    [{ ...ENV, QUALITY_HEAD_SHA: "dev" }, "immutable commit SHA"],
    [{ ...ENV, GITHUB_TOKEN: "" }, "GitHub read token"],
  ])("rejects invalid execution context without making a request", async (env, finding) => {
    const request = vi.fn();
    await expect(checkGreptileFindings(env, request, vi.fn())).rejects.toThrow(finding);
    expect(request).not.toHaveBeenCalled();
  });

  it("collects bounded GitHub evidence and returns no raw provider content", async () => {
    const request = requestSequence(
      response({ check_runs: [CHECK] }),
      response([SUMMARY]),
      response(THREAD_CONNECTION),
    );
    await expect(checkGreptileFindings(ENV, request, vi.fn())).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0][0]).toContain(`/commits/${HEAD}/check-runs`);
    expect(request.mock.calls[0][1].headers.authorization).toBe("Bearer test");
    expect(request.mock.calls[2][0]).toBe("https://api.github.com/graphql");
  });

  it("accepts GitHub's case-insensitive canonical repository slug", async () => {
    const request = requestSequence(
      response({ check_runs: [CHECK] }),
      response([SUMMARY]),
      response(THREAD_CONNECTION),
    );
    await expect(
      checkGreptileFindings({ ...ENV, GITHUB_REPOSITORY: "oscharko-dev/keiko" }, request, vi.fn()),
    ).resolves.toEqual([]);
  });

  it("waits for exact-head completion and for a lagging summary update", async () => {
    const stale = { ...SUMMARY, body: "<h3>Greptile Summary</h3> stale" };
    const request = requestSequence(
      response({ check_runs: [{ ...CHECK, status: "in_progress" }] }),
      response({ check_runs: [CHECK] }),
      response([stale]),
      response(THREAD_CONNECTION),
      response([SUMMARY]),
      response(THREAD_CONNECTION),
    );
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(checkGreptileFindings(ENV, request, wait)).resolves.toEqual([]);
    expect(wait).toHaveBeenNthCalledWith(1, 10_000);
    expect(wait).toHaveBeenNthCalledWith(2, 5_000);
  });

  it("retries a transient GitHub response with bounded backoff", async () => {
    const request = requestSequence(
      response({}, false, 503),
      response({ check_runs: [CHECK] }),
      response([SUMMARY]),
      response(THREAD_CONNECTION),
    );
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(checkGreptileFindings(ENV, request, wait)).resolves.toEqual([]);
    expect(wait).toHaveBeenCalledWith(1_000);
  });

  it("does not retry a permission-denied 403", async () => {
    const request = vi.fn().mockResolvedValue(response({}, false, 403));
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(checkGreptileFindings(ENV, request, wait)).rejects.toThrow(
      "GitHub evidence request did not succeed",
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("retries a rate-limited 403", async () => {
    const request = requestSequence(
      response({}, false, 403, { "x-ratelimit-remaining": "0" }),
      response({ check_runs: [CHECK] }),
      response([SUMMARY]),
      response(THREAD_CONNECTION),
    );
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(checkGreptileFindings(ENV, request, wait)).resolves.toEqual([]);
    expect(wait).toHaveBeenCalledWith(1_000);
  });

  it("reports its own deadline before the workflow timeout", async () => {
    vi.useFakeTimers();
    try {
      const pending = checkGreptileFindings(ENV, () => new Promise(() => undefined), vi.fn());
      const assertion = expect(pending).rejects.toThrow("fifteen-minute execution budget");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the exact-head review never completes", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(response({ check_runs: [{ ...CHECK, status: "in_progress" }] }));
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(checkGreptileFindings(ENV, request, wait)).rejects.toThrow(
      "did not complete within ten minutes",
    );
    expect(request).toHaveBeenCalledTimes(60);
    expect(wait).toHaveBeenCalledTimes(60);
  });

  it("returns every final problem when a stale summary exhausts settlement", async () => {
    const stale = { ...SUMMARY, body: '<h3>Greptile Summary</h3> <img alt="P1"> stale' };
    const request = vi.fn().mockImplementation((url) => {
      if (url.includes("check-runs")) return Promise.resolve(response({ check_runs: [CHECK] }));
      if (url.includes("graphql")) {
        return Promise.resolve(
          response({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        comments: { nodes: [{ author: { login: "greptile-apps" } }] },
                        isResolved: false,
                      },
                    ],
                    pageInfo: { endCursor: null, hasNextPage: false },
                  },
                },
              },
            },
          }),
        );
      }
      return Promise.resolve(response([stale]));
    });
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(checkGreptileFindings(ENV, request, wait)).resolves.toEqual([
      "latest Greptile summary is not bound to the exact head",
      "Greptile has unresolved inline review conversations",
    ]);
    expect(wait).toHaveBeenCalledTimes(12);
  });

  it("paginates comments and review threads without dropping evidence", async () => {
    const fullCommentPage = Array.from({ length: 100 }, (_, id) => ({ id }));
    const firstThreads = structuredClone(THREAD_CONNECTION);
    firstThreads.data.repository.pullRequest.reviewThreads.pageInfo = {
      endCursor: "next",
      hasNextPage: true,
    };
    const request = requestSequence(
      response({ check_runs: [CHECK] }),
      response(fullCommentPage),
      response(firstThreads),
      response([SUMMARY]),
      response(THREAD_CONNECTION),
    );
    await expect(checkGreptileFindings(ENV, request, vi.fn())).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("fails closed when comment evidence exceeds fifty pages", async () => {
    const fullPage = Array.from({ length: 100 }, (_, id) => ({ id }));
    const request = vi.fn().mockImplementation((url) => {
      if (url.includes("check-runs")) return Promise.resolve(response({ check_runs: [CHECK] }));
      if (url.includes("graphql")) return Promise.resolve(response(THREAD_CONNECTION));
      return Promise.resolve(response(fullPage));
    });
    await expect(checkGreptileFindings(ENV, request, vi.fn())).rejects.toThrow(
      "comment evidence exceeds the bounded audit scope",
    );
  });

  it("fails closed when review-thread evidence exceeds fifty pages", async () => {
    const paginated = structuredClone(THREAD_CONNECTION);
    paginated.data.repository.pullRequest.reviewThreads.pageInfo = {
      endCursor: "next",
      hasNextPage: true,
    };
    const request = vi.fn().mockImplementation((url) => {
      if (url.includes("check-runs")) return Promise.resolve(response({ check_runs: [CHECK] }));
      if (url.includes("graphql")) return Promise.resolve(response(paginated));
      return Promise.resolve(response([SUMMARY]));
    });
    await expect(checkGreptileFindings(ENV, request, vi.fn())).rejects.toThrow(
      "thread evidence exceeds the bounded audit scope",
    );
  });

  it("rejects a missing review-thread pagination cursor", async () => {
    const missingCursor = structuredClone(THREAD_CONNECTION);
    missingCursor.data.repository.pullRequest.reviewThreads.pageInfo = {
      endCursor: null,
      hasNextPage: true,
    };
    const request = requestSequence(
      response({ check_runs: [CHECK] }),
      response([SUMMARY]),
      response(missingCursor),
    );
    await expect(checkGreptileFindings(ENV, request, vi.fn())).rejects.toThrow(
      "pagination cursor is missing",
    );
  });

  it("fails closed on malformed or unavailable GitHub evidence", async () => {
    await expect(
      checkGreptileFindings(ENV, requestSequence(response({}, false)), vi.fn()),
    ).rejects.toThrow("GitHub evidence request did not succeed");
    await expect(
      checkGreptileFindings(
        ENV,
        requestSequence(response({ check_runs: [CHECK] }), response({}), response({})),
        vi.fn(),
      ),
    ).rejects.toThrow("pull request comments response is malformed");
  });

  it("returns testable CLI statuses with redacted diagnostics", async () => {
    const log = vi.fn();
    const error = vi.fn();
    const success = requestSequence(
      response({ check_runs: [CHECK] }),
      response([SUMMARY]),
      response(THREAD_CONNECTION),
    );
    await expect(main(ENV, success, vi.fn(), log, error)).resolves.toBe(0);
    expect(log).toHaveBeenCalledOnce();

    await expect(
      main({ ...ENV, QUALITY_HEAD_SHA: "hostile" }, vi.fn(), vi.fn(), log, error),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      "greptile-findings: FAIL — head must be an immutable commit SHA",
    );
  });
});
