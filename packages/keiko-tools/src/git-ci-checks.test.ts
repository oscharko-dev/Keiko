import { describe, expect, it } from "vitest";
import { collectGitCiRequirements } from "./git-ci-requirements.js";
import { classifyGitCiChecks, type GitCiChecksInput } from "./git-ci-checks.js";
import { gitDeliveryObservationFailure } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import type { GitProviderPageResult } from "./git-provider-observation.js";

function page(values: readonly unknown[]): GitProviderPageResult {
  return { values, completeness: { complete: true, entries: values.length, pages: 1, bytes: 1 } };
}
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const RUN = {
  id: 1,
  name: "build",
  headSha: HEAD,
  appId: 7,
  status: "completed",
  conclusion: "success",
  startedAt: "2026-09-05T00:00:00Z",
  completedAt: "2026-09-05T00:01:00Z",
  suiteId: 10,
  annotationCount: 0,
};
function input(checks: readonly unknown[]): GitCiChecksInput {
  return {
    headSha: HEAD,
    baseSha: BASE,
    prNumber: 17,
    repositoryId: 9,
    requirements: collectGitCiRequirements({
      protection: {
        outcome: "protected" as const,
        value: {
          checks: { checks: [{ context: "build", app_id: 7 }], contexts: ["build"] },
          strict: false,
          reviewCount: 0,
        },
      },
      rules: page([]),
    }),
    checkRuns: page(checks),
    commitStatuses: page([]),
    workflowRuns: page([]),
  };
}
describe("exact-head required CI classification", () => {
  it.each(["checkRuns", "commitStatuses", "workflowRuns"] as const)(
    "cannot return green with partial %s",
    (key) => {
      expect(
        classifyGitCiChecks({
          ...input([RUN]),
          [key]: {
            values: [],
            completeness: {
              complete: false,
              entries: 0,
              pages: 3,
              bytes: 1,
              failure: gitDeliveryObservationFailure("pagination-exhausted"),
            },
          },
        }),
      ).toMatchObject({ status: "unknown", failure: { reason: "pagination-exhausted" } });
    },
  );

  it("cannot accept a passing stale head or unknown provider state", () => {
    expect(classifyGitCiChecks(input([{ ...RUN, headSha: BASE }]))).toMatchObject({
      required: [{ classification: "stale-or-wrong-app" }],
      overall: "unknown",
    });
    expect(classifyGitCiChecks(input([{ ...RUN, status: "future-state" }]))).toMatchObject({
      required: [{ classification: "unknown" }],
    });
    expect(
      classifyGitCiChecks(input([{ ...RUN, status: "queued", conclusion: null }])),
    ).toMatchObject({ required: [{ classification: "queued-or-running" }], overall: "pending" });
  });

  it("refuses duplicate page IDs and malformed identity fields without silently dropping them", () => {
    for (const checks of [
      [RUN, RUN],
      [{ ...RUN, id: -1 }],
      [{ ...RUN, appId: "7" }],
      [{ ...RUN, startedAt: "bad-time" }],
    ])
      expect(classifyGitCiChecks(input(checks))).toMatchObject({
        status: "unknown",
        failure: { reason: "malformed-response" },
      });
  });

  it.each([
    ["success", "passed"],
    ["failure", "failed"],
    ["skipped", "skipped"],
    ["cancelled", "cancelled"],
    ["stale", "stale-or-wrong-app"],
    ["neutral", "unknown"],
  ])("keeps required %s distinct as %s", (conclusion, classification) => {
    expect(classifyGitCiChecks(input([{ ...RUN, conclusion }]))).toMatchObject({
      status: "observed",
      required: [{ classification }],
    });
  });
  it("refuses duplicate or wrong-app passing runs, and distinguishes missing checks", () => {
    expect(classifyGitCiChecks(input([]))).toMatchObject({
      required: [{ classification: "missing" }],
    });
    expect(classifyGitCiChecks(input([{ ...RUN, appId: 8 }]))).toMatchObject({
      required: [{ classification: "stale-or-wrong-app" }],
    });
    expect(classifyGitCiChecks(input([RUN, { ...RUN, id: 2 }]))).toMatchObject({
      required: [{ classification: "unknown" }],
    });
  });
  it("keeps failing advisory checks separate from a passing required check", () => {
    expect(
      classifyGitCiChecks(input([RUN, { ...RUN, id: 2, name: "advisory", conclusion: "failure" }])),
    ).toMatchObject({
      overall: "passed",
      required: [{ classification: "passed" }],
      advisory: [{ classification: "failed" }],
    });
  });
});

const STATUS = {
  id: 2,
  context: "build",
  state: "success",
  creatorId: 7,
  createdAt: "2026-09-05T00:01:00Z",
  updatedAt: "2026-09-05T00:01:00Z",
};
function unbound(checks: readonly unknown[], statuses: readonly unknown[]): GitCiChecksInput {
  return {
    ...input(checks),
    commitStatuses: page(statuses),
    requirements: collectGitCiRequirements({
      protection: {
        outcome: "protected",
        value: {
          checks: { contexts: ["build"], checks: [] },
          strict: false,
          reviewCount: 0,
        },
      },
      rules: page([]),
    }),
  };
}
describe("legacy statuses and modern checks", () => {
  it("does not confuse a status creator's user ID with a required application ID", () => {
    expect(classifyGitCiChecks({ ...input([]), commitStatuses: page([STATUS]) })).toMatchObject({
      required: [{ classification: "stale-or-wrong-app" }],
    });
    expect(classifyGitCiChecks({ ...input([RUN]), commitStatuses: page([STATUS]) })).toMatchObject({
      required: [{ classification: "unknown" }],
    });
  });
  it("requires both a status and a modern check when they share the required context", () => {
    expect(classifyGitCiChecks(unbound([RUN], [{ ...STATUS, state: "failure" }]))).toMatchObject({
      required: [{ classification: "failed" }],
    });
    expect(classifyGitCiChecks(unbound([RUN], [STATUS]))).toMatchObject({
      required: [{ classification: "passed" }],
    });
  });
  it("selects the current status by event chronology independent of response ordering", () => {
    const prior = { ...STATUS, id: 3, state: "failure", createdAt: "2026-09-05T00:00:00Z" };
    const first = classifyGitCiChecks(unbound([], [STATUS, prior]));
    const reversed = classifyGitCiChecks(unbound([], [prior, STATUS]));
    expect(first).toEqual(reversed);
    expect(first).toMatchObject({
      required: [{ classification: "passed", evidence: [{ kind: "commit-status", id: 2 }] }],
    });
  });
  it("rejects ambiguous equal-time status updates and unbound checks from multiple applications", () => {
    expect(
      classifyGitCiChecks(unbound([], [STATUS, { ...STATUS, id: 3, state: "failure" }])),
    ).toMatchObject({ required: [{ classification: "unknown" }] });
    expect(classifyGitCiChecks(unbound([RUN, { ...RUN, id: 3, appId: 8 }], []))).toMatchObject({
      required: [{ classification: "unknown" }],
    });
  });
});

const POLICY_SHA = "d".repeat(40);
const WORKFLOW = {
  id: 20,
  workflowId: 5,
  path: "org/policies/.github/workflows/policy.yml@refs/heads/main",
  headSha: HEAD,
  event: "pull_request",
  status: "completed",
  conclusion: "success",
  runAttempt: 1,
  repositoryId: 9,
  headRepositoryId: 9,
  createdAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:01:00Z",
  pullRequests: [{ number: 17, headSha: HEAD, baseSha: BASE }],
  referencedWorkflows: [
    {
      path: "org/policies/.github/workflows/policy.yml@refs/heads/main",
      ref: "refs/heads/main",
      sha: POLICY_SHA,
    },
  ],
};
function workflows(
  values: readonly unknown[],
  requiredSha: string | null = POLICY_SHA,
): GitCiChecksInput {
  return {
    ...input([]),
    workflowRuns: page(values),
    workflowDefinitions: [
      {
        repositoryId: 10,
        repository: "org/policies",
        path: ".github/workflows/policy.yml",
        ref: "refs/heads/main",
        sha: POLICY_SHA,
      },
    ],
    requirements: collectGitCiRequirements({
      protection: { outcome: "unprotected" },
      rules: page([
        {
          ruleset_id: 4,
          ruleset_source_type: "Organization",
          type: "workflows",
          parameters: {
            workflows: [
              {
                repository_id: 10,
                path: ".github/workflows/policy.yml",
                ref: "refs/heads/main",
                sha: requiredSha,
              },
            ],
          },
        },
      ]),
    }),
  };
}
describe("required workflow definition and exact PR provenance", () => {
  it("binds mutable rule refs to the freshly resolved definition SHA", () => {
    const value = workflows([WORKFLOW], null);
    expect(classifyGitCiChecks(value)).toMatchObject({ overall: "passed" });
    expect(
      classifyGitCiChecks({
        ...value,
        workflowDefinitions:
          value.workflowDefinitions?.map((definition) => ({ ...definition, sha: HEAD })) ?? [],
      }),
    ).toMatchObject({ required: [{ classification: "unknown" }] });
    expect(classifyGitCiChecks({ ...value, workflowDefinitions: [] })).toMatchObject({
      required: [{ classification: "unknown" }],
    });
  });

  it("bounds evidence references without turning duplicate inputs into a passing result", () => {
    const value = classifyGitCiChecks(
      input(Array.from({ length: 40 }, (_unused, index) => ({ ...RUN, id: index + 1 }))),
    );
    if (value.status !== "observed") throw new Error("missing observations");
    expect(value.required[0]).toMatchObject({
      classification: "unknown",
      evidenceCount: 40,
      evidenceTruncated: true,
    });
    expect(value.required[0]?.evidence).toHaveLength(32);
  });

  it("does not treat a referenced policy as proof that its invocation actually ran", () => {
    expect(
      classifyGitCiChecks(
        workflows([{ ...WORKFLOW, path: ".github/workflows/ci.yml@refs/heads/dev" }]),
      ),
    ).toMatchObject({ required: [{ classification: "unknown" }], overall: "unknown" });
  });
  it.each([
    { runAttempt: 0 },
    { workflowId: "5" },
    { updatedAt: "2026-09-04T00:00:00Z" },
    { pullRequests: Array.from({ length: 101 }, () => WORKFLOW.pullRequests[0]) },
    { referencedWorkflows: Array.from({ length: 101 }, () => WORKFLOW.referencedWorkflows[0]) },
  ])("refuses malformed or oversized workflow metadata %j", (change) => {
    expect(classifyGitCiChecks(workflows([{ ...WORKFLOW, ...change }]))).toMatchObject({
      status: "unknown",
      failure: { reason: "malformed-response" },
    });
  });

  it("does not accept completeness claims beyond the owning page and byte caps", () => {
    for (const counts of [
      { pages: 6, bytes: 1 },
      { pages: 1, bytes: 1_048_577 },
    ]) {
      const value = input([RUN]);
      expect(
        classifyGitCiChecks({
          ...value,
          checkRuns: {
            ...value.checkRuns,
            completeness: { complete: true, entries: 1, ...counts },
          },
        }),
      ).toMatchObject({ status: "unknown" });
    }
  });

  it("proves a required organization workflow through the resolved definition repository and exact revision", () => {
    expect(classifyGitCiChecks(workflows([WORKFLOW]))).toMatchObject({
      status: "observed",
      overall: "passed",
      required: [{ classification: "passed" }],
    });
  });
  it.each([
    { headSha: BASE },
    { repositoryId: 11 },
    { headRepositoryId: 11 },
    { event: "workflow_dispatch" },
    { pullRequests: [{ number: 18, headSha: HEAD, baseSha: BASE }] },
    { pullRequests: [{ number: 17, headSha: HEAD, baseSha: HEAD }] },
  ])("refuses matching workflow success with wrong PR context %j", (change) => {
    expect(classifyGitCiChecks(workflows([{ ...WORKFLOW, ...change }]))).toMatchObject({
      required: [{ classification: "stale-or-wrong-app" }],
      overall: "unknown",
    });
  });
  it("cannot prove an external workflow from only its filename or a mismatched numeric repository binding", () => {
    const base = workflows([WORKFLOW]);
    for (const definitions of [
      [],
      [{ repositoryId: 11, repository: "org/policies" }],
      [{ repositoryId: 10, repository: "other/policies" }],
    ])
      expect(
        classifyGitCiChecks({
          ...base,
          workflowDefinitions: definitions.map((value) => ({
            ...value,
            path: ".github/workflows/policy.yml",
            ref: "refs/heads/main",
            sha: POLICY_SHA,
          })),
        }),
      ).toMatchObject({
        required: [{ classification: "unknown" }],
      });
  });
  it("cannot accept a different workflow ref or SHA, or duplicate successful executions", () => {
    for (const change of [{ ref: "refs/heads/other" }, { sha: HEAD }])
      expect(
        classifyGitCiChecks(
          workflows([
            {
              ...WORKFLOW,
              referencedWorkflows: [{ ...WORKFLOW.referencedWorkflows[0], ...change }],
            },
          ]),
        ),
      ).toMatchObject({ required: [{ classification: "unknown" }] });
    expect(classifyGitCiChecks(workflows([WORKFLOW, { ...WORKFLOW, id: 21 }]))).toMatchObject({
      required: [{ classification: "unknown" }],
    });
  });
  it("keeps unrelated workflows advisory and never treats a required skipped workflow as passed", () => {
    const unrelated = {
      ...WORKFLOW,
      id: 21,
      path: ".github/workflows/advisory.yml@dev",
      referencedWorkflows: [],
    };
    expect(
      classifyGitCiChecks(workflows([{ ...WORKFLOW, conclusion: "skipped" }, unrelated])),
    ).toMatchObject({
      overall: "blocked",
      required: [{ classification: "skipped" }],
      advisory: [{ id: 21, classification: "passed" }],
    });
  });
  // Owner audit finding b5-9: `workflowCandidate`'s pre-filter is name-suffix only, so an unrelated
  // workflow run from a completely different repository — sharing only the required path's
  // filename, and not even self-reporting (via `referencedWorkflows`) any link to it — must not
  // make a genuinely missing required workflow read as the more ambiguous "unknown".
  it("classifies an unrelated same-suffix workflow run from a different repository as missing", () => {
    const impostor = {
      ...WORKFLOW,
      id: 22,
      repositoryId: 999,
      headRepositoryId: 999,
      path: `unrelated-org/unrelated-repo/.github/workflows/policy.yml@${POLICY_SHA}`,
      referencedWorkflows: [],
    };
    expect(classifyGitCiChecks(workflows([impostor]))).toMatchObject({
      status: "observed",
      overall: "pending",
      required: [{ classification: "missing" }],
    });
  });
});
