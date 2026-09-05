import type { CodingWorkbenchIssueBindingFailure } from "@oscharko-dev/keiko-contracts";

const ISSUE_FAILURES: ReadonlySet<string> = new Set([
  "invalid-reference",
  "repository-mismatch",
  "auth-required",
  "issue-unavailable",
  "clone-failed",
  "authority-denied",
  "cancelled",
]);

const PREVIEW_CODES: Readonly<Record<string, CodingWorkbenchIssueBindingFailure>> = {
  CODING_WORKBENCH_ISSUE_INVALID_REFERENCE: "invalid-reference",
  CODING_WORKBENCH_ISSUE_REPOSITORY_MISMATCH: "repository-mismatch",
  CODING_WORKBENCH_ISSUE_AUTH_REQUIRED: "auth-required",
  CODING_WORKBENCH_ISSUE_UNAVAILABLE: "issue-unavailable",
  CODING_WORKBENCH_ISSUE_CLONE_FAILED: "clone-failed",
  CODING_WORKBENCH_ISSUE_AUTHORITY_DENIED: "authority-denied",
  CODING_WORKBENCH_ISSUE_CANCELLED: "cancelled",
};

/** Only the closed issue refusal vocabulary can cross the browser's diagnostic boundary. */
export function codingWorkbenchIssueFailure(
  value: unknown,
): CodingWorkbenchIssueBindingFailure | undefined {
  if (typeof value !== "string") return undefined;
  return ISSUE_FAILURES.has(value)
    ? (value as CodingWorkbenchIssueBindingFailure)
    : PREVIEW_CODES[value];
}

export function runtimeIssueFailure(
  value: unknown,
): CodingWorkbenchIssueBindingFailure | undefined {
  if (typeof value !== "object" || value === null || !("issueBindingFailure" in value))
    return undefined;
  return codingWorkbenchIssueFailure(value.issueBindingFailure);
}
