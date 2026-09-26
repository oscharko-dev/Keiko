import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import type { CommandResult } from "./types.js";

export const TARGET = {
  repository: "owner/repo",
  prNumber: 17,
  prNodeId: "PR_17",
  issueNumber: 9,
  issueIdDigest: sha256Hex("I_9"),
};
export const PR = {
  id: "PR_17",
  number: 17,
  url: "https://github.com/owner/repo/pull/17",
  state: "OPEN",
  isDraft: false,
  baseRefName: "dev",
  baseRefOid: "a".repeat(40),
  headRefName: "feature/issue-9",
  headRefOid: "b".repeat(40),
  mergedAt: null,
  mergeCommit: null,
  reviewDecision: "APPROVED",
  repository: { nameWithOwner: "owner/repo" },
  headRepository: { nameWithOwner: "owner/repo" },
};
const ISSUE = {
  id: "I_9",
  number: 9,
  state: "OPEN",
  closedAt: null,
  repository: { nameWithOwner: "owner/repo" },
};
export function payload(
  pr: Readonly<Record<string, unknown>> = {},
  issue: Readonly<Record<string, unknown>> = {},
  connection: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    data: {
      repository: {
        nameWithOwner: "owner/repo",
        databaseId: 41,
        defaultBranchRef: { name: "dev" },
        issue: { ...ISSUE, ...issue },
        pullRequest: {
          ...PR,
          ...pr,
          reviewThreads: {
            totalCount: 1,
            nodes: [{ id: "PRRT_1", isResolved: false }],
            pageInfo: { hasNextPage: false, endCursor: "cursor1" },
            ...connection,
          },
        },
      },
    },
  };
}
export function response(value: unknown, extra: Partial<CommandResult> = {}): CommandResult {
  return {
    command: "gh",
    args: [],
    stdout: JSON.stringify(value),
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 0,
    timedOut: false,
    truncated: false,
    ...extra,
  };
}
