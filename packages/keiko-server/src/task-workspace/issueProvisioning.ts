import { parseCodingWorkbenchIssuePreviewRequest } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import type { CodingWorkbenchIssueBindingFailure } from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import { resolveGitHubIssue } from "../coding-context/githubIssueResolution.js";
import { TaskWorkspaceError } from "./errors.js";

/** Preserves the issue intake remedy through the existing workspace failure envelope. */
export class IssueProvisioningError extends TaskWorkspaceError {
  public constructor(public readonly issueBindingFailure: CodingWorkbenchIssueBindingFailure) {
    super("INVALID_REQUEST", "Issue preview is stale or unavailable.");
  }
}

/** Issue intent selects no base: the existing provisioner receives the freshly resolved default. */
export async function issueProvisioningBase(
  deps: UiHandlerDeps,
  repositoryRoot: string,
  source: unknown,
  correlationId: string | undefined,
): Promise<string> {
  const input = validateSource(source);
  const request = parseCodingWorkbenchIssuePreviewRequest({
    repositoryPath: repositoryRoot,
    issueRef: input.issueRef,
  });
  if (request === undefined)
    throw new TaskWorkspaceError("INVALID_REQUEST", "Invalid issue source.");
  const resolved = await resolveGitHubIssue(deps, {
    repositoryRoot,
    issueRef: request.issueRef,
    correlationId,
  });
  if (!resolved.ok) throw new IssueProvisioningError(resolved.failure);
  if (resolved.binding.bindingDigest !== input.expectedBindingDigest)
    throw new IssueProvisioningError("issue-unavailable");
  return resolved.binding.defaultBaseRef;
}

function validateSource(
  source: unknown,
): Record<string, unknown> & { expectedBindingDigest: string } {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "Invalid issue source.");
  }
  const input = source as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !["kind", "issueRef", "expectedBindingDigest"].includes(key),
    ) ||
    input.kind !== "github-issue" ||
    typeof input.expectedBindingDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.expectedBindingDigest)
  ) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "Invalid issue source.");
  }
  return { ...input, expectedBindingDigest: input.expectedBindingDigest };
}
