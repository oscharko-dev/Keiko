import { isGitHubOwnerAndRepo } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";

export interface GitJourneyReadTarget {
  readonly repository: string;
  readonly prNumber: number;
  readonly prNodeId: string;
  readonly issueNumber: number;
  readonly issueIdDigest: string;
}
const QUERY = `query KeikoJourneyObservation($owner:String!,$name:String!,$pr:Int!,$issue:Int!,$cursor:String){
  repository(owner:$owner,name:$name){nameWithOwner databaseId defaultBranchRef{name}
    issue(number:$issue){id number state closedAt repository{nameWithOwner}}
    pullRequest(number:$pr){id number url state isDraft baseRefName baseRefOid headRefName headRefOid
      mergedAt mergeCommit{oid} reviewDecision repository{nameWithOwner} headRepository{nameWithOwner}
      reviewThreads(first:100,after:$cursor){totalCount nodes{id isResolved} pageInfo{hasNextPage endCursor}}
    }
  }
}`;
function number(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000_000;
}
export function assertJourneyTarget(target: GitJourneyReadTarget): void {
  if (
    !isGitHubOwnerAndRepo(target.repository) ||
    !number(target.prNumber) ||
    !number(target.issueNumber)
  )
    throw new TypeError("Invalid journey repository binding");
  if (
    !/^[A-Za-z0-9_=-]{1,256}$/u.test(target.prNodeId) ||
    !/^[a-f0-9]{64}$/u.test(target.issueIdDigest)
  )
    throw new TypeError("Invalid journey provider identity");
}
/** Fixed read-only GraphQL selection; bodies, users and commands have no query field. */
export function buildGitJourneyReadArgv(
  target: GitJourneyReadTarget,
  cursor: string | undefined,
): readonly string[] {
  assertJourneyTarget(target);
  if (cursor !== undefined && !/^[A-Za-z0-9_+/=-]{1,512}$/u.test(cursor))
    throw new TypeError("Invalid journey pagination cursor");
  const [owner, name] = target.repository.split("/");
  return [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "POST",
    "graphql",
    "-f",
    `query=${QUERY}`,
    "-f",
    `owner=${owner ?? ""}`,
    "-f",
    `name=${name ?? ""}`,
    "-F",
    `pr=${String(target.prNumber)}`,
    "-F",
    `issue=${String(target.issueNumber)}`,
    ...(cursor === undefined ? [] : ["-f", `cursor=${cursor}`]),
  ];
}
