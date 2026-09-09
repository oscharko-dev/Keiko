import { describe, expect, it, vi } from "vitest";
import { TARGET, PR, payload, response } from "./git-journey-test-support.js";
import { readGitJourneyFacts } from "./git-journey-facts.js";
import { buildGitJourneyReadArgv } from "./git-journey-read-argv.js";
import type { CommandResult } from "./types.js";

function fixture(value = payload()): {
  run: ReturnType<typeof vi.fn<(argv: readonly string[]) => Promise<CommandResult>>>;
  target: typeof TARGET;
  stillAuthorized: () => boolean;
} {
  return {
    target: { ...TARGET },
    stillAuthorized: (): boolean => true,
    run: vi.fn(() => Promise.resolve(response(value))),
  };
}
describe("canonical PR and bound issue lifecycle observation", () => {
  it.each(["OWNER/repo", "owner/REPO", "OWNER/REPO"])(
    "observes the same GitHub repository across canonical casing: %s",
    async (repository) => {
      const input = fixture();
      const result = await readGitJourneyFacts({
        ...input,
        target: { ...TARGET, repository },
      });
      expect(result).toMatchObject({
        status: "observed",
        identity: { repository: "owner/repo", headSha: PR.headRefOid },
        issue: { number: TARGET.issueNumber, state: "open" },
      });
      expect(input.run).toHaveBeenCalledTimes(2);
    },
  );

  it("does not equate a different repository when folding GitHub casing", async () => {
    expect(
      await readGitJourneyFacts({ ...fixture(), target: { ...TARGET, repository: "OWNER/REPO2" } }),
    ).toMatchObject({ status: "unavailable", failure: { reason: "revision-changed" } });
  });

  it("observes unresolved review conversations without issuing any mutation or returning bodies", async () => {
    const input = fixture();
    const result = await readGitJourneyFacts(input);
    expect(result).toMatchObject({
      status: "observed",
      identity: { headSha: PR.headRefOid },
      issue: { state: "open" },
      reviewConversations: { total: 1, unresolved: 1, resolved: 0 },
      reviewDecision: "approved",
    });
    expect(input.run).toHaveBeenCalledTimes(2);
    for (const [argv] of input.run.mock.calls) {
      expect(argv.slice(0, 6)).toEqual([
        "api",
        "--hostname",
        "github.com",
        "--method",
        "POST",
        "graphql",
      ]);
      const query = argv[7];
      expect(query).toContain("query KeikoJourneyObservation");
      expect(query).not.toMatch(
        /\b(?:mutation|body|mergePullRequest|closeIssue|enablePullRequestAutoMerge)\b/u,
      );
    }
    expect(result).not.toHaveProperty("threads");
  });
  it.each(["OPEN", "CLOSED"] as const)(
    "keeps observed human merge separate from issue state %s",
    async (state) => {
      const at = "2026-09-05T01:00:00Z";
      const input = fixture(
        payload(
          { state: "MERGED", mergedAt: at, mergeCommit: { oid: "c".repeat(40) } },
          { state, closedAt: state === "CLOSED" ? at : null },
        ),
      );
      expect(await readGitJourneyFacts(input)).toMatchObject({
        status: "observed",
        identity: { state: "closed" },
        mergedAt: at,
        mergeCommitSha: "c".repeat(40),
        issue: { state: state.toLowerCase() },
      });
    },
  );
  it("does not turn manual issue closure into a merged PR", async () => {
    const input = fixture(
      payload({ state: "CLOSED" }, { state: "CLOSED", closedAt: "2026-09-05T01:00:00Z" }),
    );
    expect(await readGitJourneyFacts(input)).toMatchObject({
      status: "observed",
      mergedAt: null,
      mergeCommitSha: null,
      issue: { state: "closed" },
    });
  });
  it("collects all bounded pages twice and retains every unresolved thread", async () => {
    const input = fixture();
    input.run.mockImplementation((argv): Promise<CommandResult> => {
      const second = argv.includes("cursor=cursor100");
      const offset = second ? 100 : 0;
      return Promise.resolve(
        response(
          payload(
            {},
            {},
            {
              totalCount: 150,
              nodes: Array.from({ length: second ? 50 : 100 }, (_, index) => ({
                id: `PRRT_${String(index + offset)}`,
                isResolved: index % 2 === 0,
              })),
              pageInfo: { hasNextPage: !second, endCursor: second ? "cursor150" : "cursor100" },
            },
          ),
        ),
      );
    });
    expect(await readGitJourneyFacts(input)).toMatchObject({
      status: "observed",
      reviewConversations: { total: 150, unresolved: 75, resolved: 75 },
    });
    expect(input.run).toHaveBeenCalledTimes(4);
  });
  it.each([
    { totalCount: 501 },
    { nodes: null },
    { totalCount: 2 },
    {
      nodes: [
        { id: "PRRT_1", isResolved: false },
        { id: "PRRT_1", isResolved: true },
      ],
      totalCount: 2,
    },
    { pageInfo: { hasNextPage: true, endCursor: "cursor1" } },
    { nodes: [{ id: "PRRT_1", isResolved: false, body: "untrusted" }] },
  ])("refuses partial, duplicate or malformed conversations %#", async (connection) => {
    expect(await readGitJourneyFacts(fixture(payload({}, {}, connection)))).toMatchObject({
      status: "unavailable",
    });
  });
  it.each([
    { headRefOid: "c".repeat(40) },
    { baseRefName: "other" },
    { reviewDecision: "CHANGES_REQUESTED" },
  ])("discards a changed PR/review observation %#", async (change) => {
    const input = fixture();
    input.run
      .mockResolvedValueOnce(response(payload()))
      .mockResolvedValue(response(payload(change)));
    expect(await readGitJourneyFacts(input)).toMatchObject({
      status: "unavailable",
      failure: { reason: "revision-changed" },
    });
  });
  it("discards a thread resolution change between otherwise identical reads", async () => {
    const input = fixture();
    input.run
      .mockResolvedValueOnce(response(payload()))
      .mockResolvedValue(
        response(payload({}, {}, { nodes: [{ id: "PRRT_1", isResolved: true }] })),
      );
    expect(await readGitJourneyFacts(input)).toMatchObject({
      failure: { reason: "revision-changed" },
    });
  });
  it.each([{ id: "I_OTHER" }, { number: 10 }, { repository: { nameWithOwner: "owner/other" } }])(
    "rejects a foreign bound issue %#",
    async (issue) => {
      expect(await readGitJourneyFacts(fixture(payload({}, issue)))).toMatchObject({
        failure: { reason: "revision-changed" },
      });
    },
  );
  it("rejects GraphQL partial data and a denied provider read", async () => {
    expect(
      await readGitJourneyFacts(fixture({ errors: [{ message: "untrusted" }], data: {} })),
    ).toMatchObject({ failure: { reason: "visibility-unknown" } });
    const input = fixture();
    input.run.mockResolvedValue(response(null, { exitCode: 1, stderr: "HTTP 403" }));
    expect(await readGitJourneyFacts(input)).toMatchObject({
      failure: { reason: "provider-forbidden" },
    });
  });
  it("rechecks live authority and cancellation before returning late facts", async () => {
    const input = fixture();
    const controller = new AbortController();
    input.run.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(response(payload()));
    });
    expect(await readGitJourneyFacts({ ...input, signal: controller.signal })).toMatchObject({
      failure: { reason: "cancelled" },
    });
    expect(input.run).toHaveBeenCalledOnce();
    input.run.mockClear();
    expect(
      await readGitJourneyFacts({ ...input, stillAuthorized: (): boolean => false }),
    ).toMatchObject({ failure: { reason: "authority-denied" } });
    expect(input.run).not.toHaveBeenCalled();
  });
  it("rejects unsafe input and pagination without exposing arbitrary fields or endpoints", async () => {
    const input = fixture();
    expect(
      await readGitJourneyFacts({
        ...input,
        target: { ...TARGET, repository: "owner/repo?query=bad" },
      }),
    ).toMatchObject({ failure: { reason: "invalid-binding" } });
    expect(input.run).not.toHaveBeenCalled();
    expect(() => buildGitJourneyReadArgv(TARGET, "\nmutation")).toThrow();
  });
});
