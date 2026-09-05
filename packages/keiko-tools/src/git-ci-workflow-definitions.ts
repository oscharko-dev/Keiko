import {
  gitDeliveryObservationFailure,
  type GitDeliveryObservationFailure,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { isGitHubOwnerAndRepo } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import {
  isGitObjectId,
  isSafeGitRefName,
} from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import type { GitCiRequirementsResult, GitCiWorkflowRequirement } from "./git-ci-requirements.js";
import type { GitProviderReadRunner } from "./git-provider-observation.js";
import { buildGitHubApiGetArgv, readGitProviderValue } from "./git-provider-value.js";

export interface GitCiWorkflowDefinition {
  readonly repositoryId: number;
  readonly repository: string;
  readonly path: string;
  readonly ref: string | null;
  readonly sha: string;
}
export type GitCiWorkflowDefinitionsResult =
  | { readonly status: "observed"; readonly definitions: readonly GitCiWorkflowDefinition[] }
  | { readonly status: "unknown"; readonly failure: GitDeliveryObservationFailure };
interface Input {
  readonly repositoryId: number;
  readonly repository: string;
  readonly requirements: GitCiRequirementsResult;
  readonly run: GitProviderReadRunner;
  readonly signal?: AbortSignal;
}
type RepositoryResult =
  | { readonly status: "observed"; readonly repository: string }
  | Extract<GitCiWorkflowDefinitionsResult, { status: "unknown" }>;
type RevisionResult =
  | { readonly status: "observed"; readonly sha: string }
  | Extract<GitCiWorkflowDefinitionsResult, { status: "unknown" }>;

function invalid(): Extract<GitCiWorkflowDefinitionsResult, { status: "unknown" }> {
  return { status: "unknown", failure: gitDeliveryObservationFailure("requirements-ambiguous") };
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function argv(endpoint: string, projection: string): readonly string[] {
  return ["api", "--hostname", "github.com", "--method", "GET", endpoint, "--jq", projection];
}
function read(
  input: Input,
  endpoint: string,
  projection: string,
): ReturnType<typeof readGitProviderValue> {
  return readGitProviderValue({
    run: input.run,
    argv: argv(endpoint, projection),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}
async function repository(input: Input, id: number): Promise<RepositoryResult> {
  if (id === input.repositoryId) return { status: "observed", repository: input.repository };
  if (!Number.isSafeInteger(id) || id <= 0) return invalid();
  const result = await read(input, `/repositories/${String(id)}`, "{id,repository:.full_name}");
  if (result.status === "unavailable") return { status: "unknown", failure: result.failure };
  const value = result.value;
  return object(value) &&
    Object.keys(value).length === 2 &&
    value.id === id &&
    typeof value.repository === "string" &&
    isGitHubOwnerAndRepo(value.repository)
    ? { status: "observed", repository: value.repository }
    : invalid();
}
async function revision(
  input: Input,
  ownerAndRepo: string,
  required: GitCiWorkflowRequirement,
): Promise<RevisionResult> {
  if (required.sha !== null)
    return isGitObjectId(required.sha) ? { status: "observed", sha: required.sha } : invalid();
  if (required.ref === null || !isSafeGitRefName(required.ref)) return invalid();
  const result = await read(
    input,
    `/repos/${ownerAndRepo}/commits/${encodeURIComponent(required.ref)}`,
    "{sha}",
  );
  if (result.status === "unavailable") return { status: "unknown", failure: result.failure };
  return object(result.value) &&
    Object.keys(result.value).length === 1 &&
    isGitObjectId(result.value.sha)
    ? { status: "observed", sha: result.value.sha }
    : invalid();
}
async function resolve(
  input: Input,
  workflows: readonly GitCiWorkflowRequirement[],
): Promise<GitCiWorkflowDefinitionsResult> {
  const repositories = new Map<number, RepositoryResult>();
  const revisions = new Map<string, RevisionResult>();
  const definitions: GitCiWorkflowDefinition[] = [];
  for (const required of workflows) {
    const repo =
      repositories.get(required.repositoryId) ?? (await repository(input, required.repositoryId));
    repositories.set(required.repositoryId, repo);
    if (repo.status === "unknown") return repo;
    const key = JSON.stringify([required.repositoryId, required.ref, required.sha]);
    const resolved = revisions.get(key) ?? (await revision(input, repo.repository, required));
    revisions.set(key, resolved);
    if (resolved.status === "unknown") return resolved;
    definitions.push(
      Object.freeze({
        repositoryId: required.repositoryId,
        repository: repo.repository,
        path: required.path,
        ref: required.ref,
        sha: resolved.sha,
      }),
    );
  }
  return { status: "observed", definitions: Object.freeze(definitions) };
}

/** Only definitions named by the collected active requirements can cause metadata reads. */
export function readGitCiWorkflowDefinitions(
  request: Input,
): Promise<GitCiWorkflowDefinitionsResult> {
  const input = Object.freeze({ ...request });
  if (input.requirements.status === "unknown") return Promise.resolve(input.requirements);
  if (
    !isGitHubOwnerAndRepo(input.repository) ||
    !Number.isSafeInteger(input.repositoryId) ||
    input.repositoryId <= 0
  )
    return Promise.resolve(invalid());
  const workflows = input.requirements.requirements
    .filter((requirement) => requirement.kind === "workflow")
    .map((requirement) => Object.freeze({ ...requirement }));
  if (workflows.length > 8 || new Set(workflows.map((item) => item.repositoryId)).size > 4)
    return Promise.resolve(invalid());
  return resolve(input, workflows);
}
