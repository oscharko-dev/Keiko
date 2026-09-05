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

export function parseCreatedGitPrIdentity(
  stdout: string,
  request: {
    readonly ownerAndRepo: string;
    readonly headBranchName: string;
    readonly baseBranchName: string;
    readonly isDraft: boolean;
  },
): GitPullRequestIdentity | undefined {
  try {
    const identity = parseGitPrIdentity(JSON.parse(stdout) as unknown, request.ownerAndRepo);
    if (identity === undefined) return undefined;
    return sameGitHubOwnerAndRepo(identity.headRepository, request.ownerAndRepo) &&
      identity.headRef === request.headBranchName &&
      identity.baseRef === request.baseBranchName &&
      identity.isDraft === request.isDraft &&
      identity.state === "open"
      ? identity
      : undefined;
  } catch {
    return undefined;
  }
}

export const GIT_PR_IDENTITY_JQ =
  "{number,externalId:.node_id,url:.html_url,repository:.base.repo.full_name," +
  "headRepository:.head.repo.full_name,headRef:.head.ref,headSha:.head.sha," +
  "baseRef:.base.ref,baseSha:.base.sha,state,isDraft:.draft}";
