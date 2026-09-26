import { describe, expect, it } from "vitest";
import { assessGitCiFacts } from "./git-ci-assessment.js";
import { collectGitCiRequirements } from "./git-ci-requirements.js";
import type { GitCiProviderFacts, GitCiProtectionFacts } from "./git-ci-facts.js";
import type { GitProviderPageResult } from "./git-provider-observation.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
function page(values: readonly unknown[] = []): GitProviderPageResult {
  return { values, completeness: { complete: true, pages: 1, entries: values.length, bytes: 100 } };
}
function facts(overrides: Partial<GitCiProviderFacts> = {}): GitCiProviderFacts {
  const protection: GitCiProtectionFacts = {
    outcome: "protected",
    value: { checks: null, strict: false, reviewCount: 2 },
  };
  return {
    status: "observed",
    identity: {
      number: 17,
      externalId: "PR_17",
      url: "https://github.com/owner/repo/pull/17",
      repository: "owner/repo",
      headRepository: "owner/repo",
      headRef: "feature/issue-1",
      headSha: HEAD,
      baseRef: "dev",
      baseSha: BASE,
      state: "open",
      isDraft: true,
    },
    repositoryId: 41,
    mergeable: true,
    mergeState: "clean",
    merged: false,
    protection,
    requirements: collectGitCiRequirements({ protection, rules: page() }),
    workflowDefinitions: { status: "observed", definitions: [] },
    lists: {
      "branch-rules": page(),
      "check-runs": page(),
      "commit-statuses": page(),
      "workflow-runs": page(),
      reviews: page(),
    },
    ...overrides,
  };
}
function check(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 10,
    name: "build",
    headSha: HEAD,
    appId: 2,
    status: "completed",
    conclusion: "success",
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:00:01.000Z",
    suiteId: 5,
    annotationCount: 0,
    ...overrides,
  };
}
function requiringBuild(): GitCiProviderFacts {
  const protection: GitCiProtectionFacts = {
    outcome: "protected",
    value: {
      checks: { contexts: ["build"], checks: [{ context: "build", app_id: 2 }] },
      strict: false,
      reviewCount: 2,
    },
  };
  return facts({
    protection,
    requirements: collectGitCiRequirements({ protection, rules: page() }),
  });
}
describe("technical CI assessment without merge authority", () => {
  it("reports completed technical requirements while preserving unmet human review and draftness", () => {
    expect(assessGitCiFacts(facts())).toMatchObject({
      reason: "required-checks-passed",
      complete: true,
      humanReview: { visibility: "complete", requiredCount: 2, approvedCount: 0 },
      pullRequest: { isDraft: true },
    });
  });
  it.each([
    [{ merged: true }, "pull-request-closed"],
    [{ mergeable: false }, "merge-conflict"],
    [{ mergeable: null }, "merge-context-unknown"],
    [{ mergeState: "unexpected-state" }, "merge-context-unknown"],
  ] as const)("keeps PR context blockers independent of checks %#", (change, reason) => {
    expect(assessGitCiFacts(facts(change)).reason).toBe(reason);
  });
  it("only requires a base update when that technical policy is active", () => {
    const base = facts({ mergeState: "behind" });
    expect(assessGitCiFacts(base).reason).toBe("required-checks-passed");
    const protection = {
      outcome: "protected",
      value: { checks: null, strict: true, reviewCount: 2 },
    } as const;
    expect(
      assessGitCiFacts({
        ...base,
        protection,
        requirements: collectGitCiRequirements({ protection, rules: page() }),
      }).reason,
    ).toBe("base-outdated");
  });
  it("keeps advisory failures out of the required verdict", () => {
    const base = requiringBuild();
    const result = assessGitCiFacts({
      ...base,
      lists: {
        ...base.lists,
        "check-runs": page([check(), check({ id: 11, name: "advisory", conclusion: "failure" })]),
      },
    });
    expect(result).toMatchObject({
      reason: "required-checks-passed",
      requiredChecks: { total: 1, passed: 1 },
      advisoryChecks: { total: 1, failed: 1 },
    });
  });
  it.each([
    ["failure", "required-checks-failed"],
    ["skipped", "required-checks-blocked"],
    ["cancelled", "required-checks-blocked"],
  ] as const)("classifies required %s without a false green", (conclusion, reason) => {
    const base = requiringBuild();
    expect(
      assessGitCiFacts({
        ...base,
        lists: { ...base.lists, "check-runs": page([check({ conclusion })]) },
      }).reason,
    ).toBe(reason);
  });
  it("rejects a partial check observation even with no known requirements", () => {
    const base = facts();
    expect(
      assessGitCiFacts({
        ...base,
        lists: {
          ...base.lists,
          "check-runs": {
            values: [],
            completeness: {
              complete: false,
              pages: 3,
              entries: 0,
              bytes: 100,
              failure: { reason: "pagination-exhausted", state: "unknown" },
            },
          },
        },
      }),
    ).toMatchObject({ reason: "pagination-exhausted", complete: false });
  });
  it("includes effective workflow revisions in the requirements digest", () => {
    const base = facts();
    const definition = {
      repositoryId: 5,
      repository: "governance/policy",
      path: ".github/workflows/quality.yml",
      ref: "refs/heads/dev",
      sha: BASE,
    };
    const before = assessGitCiFacts({
      ...base,
      workflowDefinitions: { status: "observed", definitions: [definition] },
    });
    const after = assessGitCiFacts({
      ...base,
      workflowDefinitions: { status: "observed", definitions: [{ ...definition, sha: HEAD }] },
    });
    expect(before.requirementsDigest).not.toBe(after.requirementsDigest);
  });
  it("uses the latest formal review, independent of provider ordering or later comments", () => {
    const base = facts();
    const review = {
      id: 1,
      userId: 4,
      state: "CHANGES_REQUESTED",
      commitSha: BASE,
      submittedAt: "2026-09-05T00:00:00.000Z",
    };
    const reviews = [
      { ...review, id: 3, state: "COMMENTED", submittedAt: "2026-09-05T00:02:00.000Z" },
      review,
      {
        ...review,
        id: 2,
        state: "APPROVED",
        commitSha: HEAD,
        submittedAt: "2026-09-05T00:01:00.000Z",
      },
    ];
    expect(
      assessGitCiFacts({ ...base, lists: { ...base.lists, reviews: page(reviews) } }).humanReview,
    ).toMatchObject({ approvedCount: 1, changesRequestedCount: 0 });
  });
});
