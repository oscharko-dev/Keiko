import type { GitCiProviderFacts } from "@oscharko-dev/keiko-tools/internal/git-mutation";

// Provider-observed CI facts as the server receives them from the keiko-tools reader. The
// requirements block is provider data, not a formula the server owns; the server tests in this
// directory already spell such blocks out literally (see ciReadinessSnapshot.test.ts).
type ProviderPage = GitCiProviderFacts["lists"][keyof GitCiProviderFacts["lists"]];

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

export function page(values: readonly unknown[]): ProviderPage {
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

const IDENTITY: GitCiProviderFacts["identity"] = {
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
};

function protectionFor(required: readonly string[]): GitCiProviderFacts["protection"] {
  return {
    outcome: "protected",
    value: {
      checks: {
        contexts: [...required],
        checks: required.map((context) => ({ context, app_id: 7 })),
      },
      strict: false,
      reviewCount: 0,
    },
  };
}

function requirementsFor(required: readonly string[]): GitCiProviderFacts["requirements"] {
  return {
    status: "observed",
    requirements: required.map((context) => ({
      kind: "status-context",
      context,
      appId: 7,
      sources: [{ kind: "branch-protection" }],
    })),
    strict: false,
    digest: "c".repeat(64),
  };
}

export function failureFacts(
  checks: readonly unknown[] = [CHECK],
  required: readonly string[] = ["build"],
): GitCiProviderFacts {
  return {
    status: "observed",
    identity: IDENTITY,
    repositoryId: 41,
    mergeable: true,
    mergeState: "clean",
    merged: false,
    protection: protectionFor(required),
    requirements: requirementsFor(required),
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
