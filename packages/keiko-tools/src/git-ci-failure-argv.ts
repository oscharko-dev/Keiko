import { isGitHubOwnerAndRepo } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";

export type GitCiFailureReadKind = "check-run" | "annotations" | "workflow-run" | "jobs";
export interface GitCiFailureReadSource {
  readonly repository: string;
  readonly id: number;
  readonly attempt: number;
}
const PROJECTIONS: Readonly<Record<GitCiFailureReadKind, string>> = {
  "check-run":
    "{id,url,name,headSha:.head_sha,appId:.app.id,suiteId:.check_suite.id,status,conclusion,annotationCount:.output.annotations_count,title:.output.title,summary:.output.summary,text:.output.text}",
  annotations:
    "[.[] | {path,startLine:.start_line,endLine:.end_line,level:.annotation_level,title,message,details:.raw_details}]",
  "workflow-run":
    "{id,url,workflowId:.workflow_id,path,headSha:.head_sha,event,status,conclusion,runAttempt:.run_attempt,repositoryId:.repository.id,headRepositoryId:.head_repository.id,repository:.repository.full_name,createdAt:.created_at,updatedAt:.updated_at,pullRequests:[.pull_requests[] | {number,headSha:.head.sha,baseSha:.base.sha}],referencedWorkflows:[(.referenced_workflows // [])[] | {path,sha,ref}]}",
  jobs: "{total:.total_count,values:[.jobs[] | {id,url,runId:.run_id,headSha:.head_sha,name,status,conclusion,steps:[.steps[] | {number,name,status,conclusion}]}]}",
};
function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
/** Fixed github.com GET operands. gh owns transport redirects; returned identities are rechecked. */
export function buildGitCiFailureArgv(
  kind: GitCiFailureReadKind,
  source: GitCiFailureReadSource,
  page = 1,
): readonly string[] {
  if (!isGitHubOwnerAndRepo(source.repository) || !positive(source.id) || !positive(source.attempt))
    throw new TypeError("Invalid CI diagnostic source");
  if (!Number.isSafeInteger(page) || page < 1 || page > 2 || !Object.hasOwn(PROJECTIONS, kind))
    throw new TypeError("Invalid CI diagnostic read");
  const id = String(source.id);
  const paging = `per_page=50&page=${String(page)}`;
  const paths: Record<GitCiFailureReadKind, string> = {
    "check-run": `check-runs/${id}`,
    annotations: `check-runs/${id}/annotations?${paging}`,
    "workflow-run": `actions/runs/${id}`,
    jobs: `actions/runs/${id}/attempts/${String(source.attempt)}/jobs?${paging}`,
  };
  return Object.freeze([
    "api",
    "--hostname",
    "github.com",
    "--method",
    "GET",
    `/repos/${source.repository}/${paths[kind]}`,
    "--jq",
    PROJECTIONS[kind],
  ]);
}
