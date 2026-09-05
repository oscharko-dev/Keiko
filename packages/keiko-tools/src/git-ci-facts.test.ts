import { describe, expect, it, vi, type Mock } from "vitest";
import type { CommandResult } from "./types.js";
import { readGitCiFacts } from "./git-ci-facts.js";
import { buildGitCiReadArgv, type GitCiReadKind } from "./git-ci-read-argv.js";

const TARGET = {
  ownerAndRepo: "owner/repo",
  prExternalId: "17",
  baseBranchName: "dev",
  headSha: "a".repeat(40),
};
const IDENTITY = {
  number: 17,
  externalId: "PR_17",
  url: "https://github.com/owner/repo/pull/17",
  repository: "owner/repo",
  headRepository: "owner/repo",
  headRef: "feature/issue-1",
  headSha: TARGET.headSha,
  baseRef: "dev",
  baseSha: "b".repeat(40),
  state: "open",
  isDraft: true,
};
function response(value: unknown, extra: Partial<CommandResult> = {}): CommandResult {
  return {
    command: "gh",
    args: [],
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify(value),
    stderr: "",
    durationMs: 0,
    timedOut: false,
    truncated: false,
    ...extra,
  };
}
function reader(
  overrides: Partial<Record<GitCiReadKind, unknown>> = {},
): Mock<(argv: readonly string[]) => Promise<CommandResult>> {
  const values: Record<GitCiReadKind, unknown> = {
    "pull-request": {
      identity: IDENTITY,
      repositoryId: 41,
      mergeable: true,
      mergeState: "clean",
      merged: false,
    },
    branch: { name: "dev", protected: false, sha: IDENTITY.baseSha },
    "branch-protection": { checks: null, reviewCount: 0, strict: false },
    "branch-rules": [],
    "check-runs": { total: 0, values: [] },
    "commit-statuses": [],
    "workflow-runs": { total: 0, values: [] },
    reviews: [],
    ...overrides,
  };
  return vi.fn((argv: readonly string[]): Promise<CommandResult> => {
    const kind = (Object.keys(values) as GitCiReadKind[]).find(
      (candidate) => buildGitCiReadArgv(candidate, TARGET, 1)[5] === argv[5],
    );
    return Promise.resolve(
      kind === undefined ? response(null, { exitCode: 1 }) : response(values[kind]),
    );
  });
}
describe("composed bounded Git provider facts", () => {
  it("reads current identities before and after all requirements/check observations", async () => {
    const run = reader();
    const facts = await readGitCiFacts({ target: TARGET, run });
    expect(facts.status).toBe("observed");
    if (facts.status !== "observed") throw new Error("Missing observed facts");
    expect(facts.identity).toEqual(IDENTITY);
    expect(facts.lists["check-runs"].completeness.complete).toBe(true);
    expect(facts).not.toHaveProperty("ready");
    expect(run.mock.calls[0]?.[0]).toEqual(buildGitCiReadArgv("pull-request", TARGET, 1));
    expect(run.mock.calls.at(-1)?.[0]).toEqual(buildGitCiReadArgv("pull-request", TARGET, 1));
  });
  it("retains unknown protection visibility even when every check list is empty", async () => {
    const base = reader({ branch: { name: "dev", protected: true, sha: IDENTITY.baseSha } });
    const run = (argv: readonly string[]): Promise<CommandResult> =>
      argv[5]?.endsWith("/protection") === true
        ? Promise.resolve(response(null, { exitCode: 1, stderr: "gh: Not Found (HTTP 404)" }))
        : base(argv);
    const facts = await readGitCiFacts({ target: TARGET, run });
    expect(facts).toMatchObject({
      status: "observed",
      protection: { outcome: "unknown", failure: { reason: "provider-not-found" } },
    });
  });
  it("confirms unprotected only with a complete exact branch observation", async () => {
    const base = reader();
    const run = (argv: readonly string[]): Promise<CommandResult> =>
      argv[5]?.endsWith("/protection") === true
        ? Promise.resolve(response(null, { exitCode: 1, stderr: "gh: Not Found (HTTP 404)" }))
        : base(argv);
    expect(await readGitCiFacts({ target: TARGET, run })).toMatchObject({
      status: "observed",
      protection: { outcome: "unprotected" },
    });
  });
  it("discards mixed-revision facts when a base or head changes during the read", async () => {
    for (const changed of [{ headSha: "c".repeat(40) }, { baseSha: "c".repeat(40) }]) {
      const base = reader();
      let prReads = 0;
      const run = (argv: readonly string[]): Promise<CommandResult> => {
        if (argv[5] === "/repos/owner/repo/pulls/17" && ++prReads === 2)
          return Promise.resolve(
            response({
              identity: { ...IDENTITY, ...changed },
              repositoryId: 41,
              mergeable: true,
              mergeState: "clean",
              merged: false,
            }),
          );
        return base(argv);
      };
      expect(await readGitCiFacts({ target: TARGET, run })).toMatchObject({
        status: "unavailable",
        failure: { reason: "revision-changed" },
      });
    }
  });
  it.each(["branch-rules", "branch-protection"] as const)(
    "discards same-head %s changes during check reads",
    async (surface) => {
      const base = reader();
      let reads = 0;
      const run = (args: readonly string[]): Promise<CommandResult> => {
        if (args[5] === buildGitCiReadArgv(surface, TARGET, 1)[5] && ++reads > 1)
          return Promise.resolve(
            response(
              surface === "branch-protection"
                ? {
                    checks: { contexts: ["new-required"], strict: false },
                    strict: false,
                    reviewCount: 0,
                  }
                : [
                    {
                      type: "required_status_checks",
                      ruleset_id: 9,
                      ruleset_source_type: "Repository",
                      parameters: {
                        strict_required_status_checks_policy: false,
                        required_status_checks: [{ context: "new-required", integration_id: 2 }],
                      },
                    },
                  ],
            ),
          );
        return base(args);
      };
      expect(await readGitCiFacts({ target: TARGET, run })).toMatchObject({
        status: "unavailable",
        failure: { reason: "revision-changed" },
      });
    },
  );
  it("rejects a mutable required workflow ref that changes during a same-head observation", async () => {
    const base = reader({
      "branch-rules": [
        {
          type: "workflows",
          ruleset_id: 7,
          ruleset_source_type: "Organization",
          parameters: {
            workflows: [
              { repository_id: 2, path: ".github/workflows/quality.yml", ref: "refs/heads/dev" },
            ],
          },
        },
      ],
    });
    let reads = 0;
    const run = (argv: readonly string[]): Promise<CommandResult> => {
      if (argv[5] === "/repositories/2")
        return Promise.resolve(response({ id: 2, repository: "governance/policy" }));
      if (argv[5] === "/repos/governance/policy/commits/refs%2Fheads%2Fdev") {
        reads += 1;
        return Promise.resolve(response({ sha: (reads === 1 ? "d" : "e").repeat(40) }));
      }
      return base(argv);
    };
    expect(await readGitCiFacts({ target: TARGET, run })).toMatchObject({
      status: "unavailable",
      failure: { reason: "revision-changed" },
    });
    expect(reads).toBe(2);
  });
  it("does no provider IO on invalid target or cancelled read", async () => {
    const run = reader();
    expect(await readGitCiFacts({ target: { ...TARGET, headSha: "HEAD" }, run })).toMatchObject({
      failure: { reason: "invalid-binding" },
    });
    expect(
      await readGitCiFacts({ target: TARGET, run, signal: AbortSignal.abort() }),
    ).toMatchObject({ failure: { reason: "cancelled" } });
    expect(run).not.toHaveBeenCalled();
  });
});
