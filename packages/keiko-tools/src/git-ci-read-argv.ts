import { isGitHubOwnerAndRepo } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import {
  isGitObjectId,
  isSafeGitRefName,
} from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import { GIT_PR_IDENTITY_JQ } from "./git-pr-gateway.js";

export const GIT_CI_READ_KINDS = [
  "pull-request",
  "branch",
  "branch-protection",
  "branch-rules",
  "check-runs",
  "commit-statuses",
  "workflow-runs",
  "reviews",
] as const;
export type GitCiReadKind = (typeof GIT_CI_READ_KINDS)[number];
export interface GitCiReadTarget {
  readonly ownerAndRepo: string;
  readonly prExternalId: string;
  readonly baseBranchName: string;
  readonly headSha: string;
}

const PROJECTIONS: Readonly<Record<GitCiReadKind, string>> = {
  "pull-request": `{identity:${GIT_PR_IDENTITY_JQ},repositoryId:.base.repo.id,mergeable,mergeState:.mergeable_state,merged}`,
  branch: "{name,protected,sha:.commit.sha}",
  "branch-protection":
    "{checks:.required_status_checks,reviewCount:(.required_pull_request_reviews.required_approving_review_count // 0),strict:(.required_status_checks.strict // false)}",
  "branch-rules": "[.[] | {type,ruleset_id,ruleset_source_type,parameters}]",
  "check-runs":
    "{total:.total_count,values:[.check_runs[] | {id,name,headSha:.head_sha,appId:.app.id,status,conclusion,startedAt:.started_at,completedAt:.completed_at,suiteId:.check_suite.id,annotationCount:.output.annotations_count}]}",
  "commit-statuses":
    "[.[] | {id,context,state,creatorId:.creator.id,createdAt:.created_at,updatedAt:.updated_at}]",
  "workflow-runs":
    "{total:.total_count,values:[.workflow_runs[] | {id,workflowId:.workflow_id,path,headSha:.head_sha,event,status,conclusion,runAttempt:.run_attempt,repositoryId:.repository.id,headRepositoryId:.head_repository.id,createdAt:.created_at,updatedAt:.updated_at,pullRequests:[.pull_requests[] | {number,headSha:.head.sha,baseSha:.base.sha}],referencedWorkflows:[(.referenced_workflows // [])[] | {path,sha,ref}]}]}",
  reviews: "[.[] | {id,userId:.user.id,state,commitSha:.commit_id,submittedAt:.submitted_at}]",
};

function assertTarget(target: GitCiReadTarget, page: number): void {
  if (!isGitHubOwnerAndRepo(target.ownerAndRepo) || !isGitObjectId(target.headSha))
    throw new TypeError("Invalid CI repository revision");
  if (
    !/^[1-9]\d{0,9}$/u.test(target.prExternalId) ||
    !isSafeGitRefName(target.baseBranchName) ||
    target.baseBranchName.startsWith("refs/")
  )
    throw new TypeError("Invalid CI pull request target");
  if (!Number.isSafeInteger(page) || page < 1 || page > 5)
    throw new TypeError("Invalid CI observation page");
}

function endpoint(kind: GitCiReadKind, target: GitCiReadTarget, page: number): string {
  const branch = encodeURIComponent(target.baseBranchName);
  const paging = `per_page=100&page=${String(page)}`;
  const paths: Record<GitCiReadKind, string> = {
    "pull-request": `pulls/${target.prExternalId}`,
    branch: `branches/${branch}`,
    "branch-protection": `branches/${branch}/protection`,
    "branch-rules": `rules/branches/${branch}?${paging}`,
    "check-runs": `commits/${target.headSha}/check-runs?filter=all&${paging}`,
    "commit-statuses": `commits/${target.headSha}/statuses?${paging}`,
    "workflow-runs": `actions/runs?head_sha=${target.headSha}&${paging}`,
    reviews: `pulls/${target.prExternalId}/reviews?${paging}`,
  };
  return `/repos/${target.ownerAndRepo}/${paths[kind]}`;
}

/** Only read operands are constructed here; no workflow mutation or arbitrary endpoint is exposed. */
export function buildGitCiReadArgv(
  kind: GitCiReadKind,
  target: GitCiReadTarget,
  page: number,
): readonly string[] {
  assertTarget(target, page);
  if (!Object.hasOwn(PROJECTIONS, kind)) throw new TypeError("Invalid CI read surface");
  return [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "GET",
    endpoint(kind, target, page),
    "--jq",
    PROJECTIONS[kind],
  ];
}
