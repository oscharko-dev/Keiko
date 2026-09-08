import {
  isGitPullRequestIdentity,
  type GitPullRequestIdentity,
} from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import { sameGitHubOwnerAndRepo } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { isGitObjectId } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses only the closed provider projection; title/body/credential fields are never admitted. */
export function parseGitPrIdentity(
  value: unknown,
  repository: string,
): GitPullRequestIdentity | undefined {
  return isGitPullRequestIdentity(value) && sameGitHubOwnerAndRepo(value.repository, repository)
    ? value
    : undefined;
}

export function parseGitPrIdentityList(
  value: unknown,
  repository: string,
  headRef: string,
): readonly GitPullRequestIdentity[] | undefined {
  if (!Array.isArray(value) || value.length > 2) return undefined;
  const identities: GitPullRequestIdentity[] = [];
  for (const candidate of value) {
    const identity = parseGitPrIdentity(candidate, repository);
    if (identity?.headRef !== headRef) return undefined;
    identities.push(identity);
  }
  return identities;
}

export function parseGitPrBranchHead(value: unknown, headRef: string): string | undefined {
  return record(value) &&
    Object.keys(value).length === 3 &&
    value.ref === `refs/heads/${headRef}` &&
    value.type === "commit" &&
    isGitObjectId(value.sha)
    ? value.sha
    : undefined;
}

/** Which validation a provider create response failed. Closed and body-free: it names the failing
 * step, never the bytes, so a create that reached the provider yet could not be reported as a
 * success is diagnosable from the activity log alone (#3390, rehearsal run-15). */
export type GitPrIdentityIssue =
  | "json-invalid"
  | "shape-invalid"
  | "repository-mismatch"
  | "head-repository-mismatch"
  | "head-ref-mismatch"
  | "base-ref-mismatch"
  | "draft-mismatch"
  | "state-not-open";

export type CreatedGitPrIdentityDiagnosis =
  | { readonly ok: true; readonly identity: GitPullRequestIdentity }
  | { readonly ok: false; readonly issue: GitPrIdentityIssue };

interface CreatedGitPrRequest {
  readonly ownerAndRepo: string;
  readonly headBranchName: string;
  readonly baseBranchName: string;
  readonly isDraft: boolean;
}

function createdIdentityIssue(
  identity: GitPullRequestIdentity,
  request: CreatedGitPrRequest,
): GitPrIdentityIssue | undefined {
  if (!sameGitHubOwnerAndRepo(identity.repository, request.ownerAndRepo))
    return "repository-mismatch";
  if (!sameGitHubOwnerAndRepo(identity.headRepository, request.ownerAndRepo))
    return "head-repository-mismatch";
  if (identity.headRef !== request.headBranchName) return "head-ref-mismatch";
  if (identity.baseRef !== request.baseBranchName) return "base-ref-mismatch";
  if (identity.isDraft !== request.isDraft) return "draft-mismatch";
  if (identity.state !== "open") return "state-not-open";
  return undefined;
}

/** Validates the provider's create response against the request that produced it and names the
 * first failing step; `parseCreatedGitPrIdentity` below is the identity-or-nothing view of it. */
export function explainCreatedGitPrIdentity(
  stdout: string,
  request: CreatedGitPrRequest,
): CreatedGitPrIdentityDiagnosis {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return { ok: false, issue: "json-invalid" };
  }
  if (!isGitPullRequestIdentity(value)) return { ok: false, issue: "shape-invalid" };
  const issue = createdIdentityIssue(value, request);
  return issue === undefined ? { ok: true, identity: value } : { ok: false, issue };
}

export function parseCreatedGitPrIdentity(
  stdout: string,
  request: CreatedGitPrRequest,
): GitPullRequestIdentity | undefined {
  const diagnosis = explainCreatedGitPrIdentity(stdout, request);
  return diagnosis.ok ? diagnosis.identity : undefined;
}

export const GIT_PR_IDENTITY_JQ =
  "{number,externalId:.node_id,url:.html_url,repository:.base.repo.full_name," +
  "headRepository:.head.repo.full_name,headRef:.head.ref,headSha:.head.sha," +
  "baseRef:.base.ref,baseSha:.base.sha,state,isDraft:.draft}";
