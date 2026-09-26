import { vi, type Mock } from "vitest";
import type { CommandResult } from "./types.js";
import type { GitCiProviderFacts } from "./git-ci-facts.js";
import type { GitProviderPageResult } from "./git-provider-observation.js";
import { collectGitCiRequirements } from "./git-ci-requirements.js";
export const HEAD = "a".repeat(40);
export const BASE = "b".repeat(40);
export const CHECK = {
  id: 123,
  name: "build",
  headSha: HEAD,
  appId: 7,
  status: "completed",
  conclusion: "failure",
  startedAt: "2026-09-05T00:00:00Z",
  completedAt: "2026-09-05T00:01:00Z",
  suiteId: 10,
  annotationCount: 1,
};
export const ANNOTATION = {
  path: "src/example.ts",
  startLine: 2,
  endLine: 2,
  level: "failure",
  title: "Type mismatch",
  message: "Expected a string.",
  details: null,
};
export function page(values: readonly unknown[]): GitProviderPageResult {
  return {
    values,
    completeness: {
      complete: true,
      entries: values.length,
      pages: 1,
      bytes: Buffer.byteLength(JSON.stringify(values)),
    },
  };
}
export function failureFacts(
  checks: readonly unknown[] = [CHECK],
  required = ["build"],
): GitCiProviderFacts {
  const protection = {
    outcome: "protected" as const,
    value: {
      checks: { contexts: required, checks: required.map((context) => ({ context, app_id: 7 })) },
      strict: false,
      reviewCount: 0,
    },
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
    requirements: collectGitCiRequirements({ protection, rules: page([]) }),
    workflowDefinitions: { status: "observed", definitions: [] },
    lists: {
      "branch-rules": page([]),
      "check-runs": page(structuredClone(checks)),
      "commit-statuses": page([]),
      "workflow-runs": page([]),
      reviews: page([]),
    },
  };
}
export function response(value: unknown, override: Partial<CommandResult> = {}): CommandResult {
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
    ...override,
  };
}
export function checkValue(check = CHECK): Record<string, unknown> {
  return {
    ...check,
    url: `https://api.github.com/repos/owner/repo/check-runs/${String(check.id)}`,
    title: "Build failed",
    summary: "Compiler reported one failure.",
    text: null,
  };
}
export function failureRunner(
  facts = failureFacts(),
): Mock<(argv: readonly string[]) => Promise<CommandResult>> {
  return vi.fn((argv): Promise<CommandResult> => {
    const endpoint = argv[5] ?? "";
    if (endpoint.includes("/pulls/"))
      return Promise.resolve(
        response({
          identity: facts.identity,
          repositoryId: facts.repositoryId,
          mergeable: true,
          mergeState: "clean",
          merged: false,
        }),
      );
    if (endpoint.includes("/annotations?")) return Promise.resolve(response([ANNOTATION]));
    const check = facts.lists["check-runs"].values.find(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        endpoint.endsWith(`/${String(value.id)}`),
    );
    return Promise.resolve(
      response(check === undefined ? null : checkValue(check as typeof CHECK)),
    );
  });
}
export const WORKFLOW = {
  id: 200,
  workflowId: 5,
  path: `.github/workflows/ci.yml@${HEAD}`,
  headSha: HEAD,
  event: "pull_request",
  status: "completed",
  conclusion: "failure",
  runAttempt: 2,
  repositoryId: 41,
  headRepositoryId: 41,
  createdAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:01:00Z",
  pullRequests: [{ number: 17, headSha: HEAD, baseSha: BASE }],
  referencedWorkflows: [],
};
export const JOB = {
  id: 300,
  url: "https://api.github.com/repos/owner/repo/actions/jobs/300",
  runId: 200,
  headSha: HEAD,
  name: "Typecheck",
  status: "completed",
  conclusion: "failure",
  steps: [{ number: 1, name: "Compile source", status: "completed", conclusion: "failure" }],
};
export function workflowFacts(): GitCiProviderFacts {
  const facts = failureFacts([]);
  const rules = page([
    {
      ruleset_id: 8,
      ruleset_source_type: "Repository",
      type: "workflows",
      parameters: {
        workflows: [{ repository_id: 41, path: ".github/workflows/ci.yml", ref: null, sha: HEAD }],
      },
    },
  ]);
  return {
    ...facts,
    protection: { outcome: "unprotected" },
    requirements: collectGitCiRequirements({ protection: { outcome: "unprotected" }, rules }),
    workflowDefinitions: {
      status: "observed",
      definitions: [
        {
          repositoryId: 41,
          repository: "owner/repo",
          path: ".github/workflows/ci.yml",
          ref: null,
          sha: HEAD,
        },
      ],
    },
    lists: {
      ...facts.lists,
      "branch-rules": rules,
      "workflow-runs": page([structuredClone(WORKFLOW)]),
    },
  };
}
export function workflowRunner(): Mock<(argv: readonly string[]) => Promise<CommandResult>> {
  const facts = workflowFacts();
  const base = failureRunner(facts);
  return vi.fn((argv): Promise<CommandResult> => {
    if (argv[5]?.includes("/jobs?") === true)
      return Promise.resolve(response({ total: 1, values: [JOB] }));
    if (argv[5]?.endsWith("/actions/runs/200") === true)
      return Promise.resolve(
        response({
          ...WORKFLOW,
          repository: "owner/repo",
          url: "https://api.github.com/repos/owner/repo/actions/runs/200",
        }),
      );
    return base(argv);
  });
}
