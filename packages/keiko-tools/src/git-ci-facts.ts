import type { GitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import type { GitDeliveryObservationFailure } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { gitDeliveryObservationFailure } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import {
  buildGitCiReadArgv,
  type GitCiReadKind,
  type GitCiReadTarget,
} from "./git-ci-read-argv.js";
import { confirmUnprotectedBranchOnNotFound } from "./git-merge-node.js";
import { parseGitPrIdentity } from "./git-pr-identity.js";
import {
  readGitProviderPages,
  type GitProviderPageResult,
  type GitProviderReadRunner,
} from "./git-provider-observation.js";

import { readGitProviderValue, type GitProviderValueResult } from "./git-provider-value.js";

import { collectGitCiRequirements, type GitCiRequirementsResult } from "./git-ci-requirements.js";
import {
  readGitCiWorkflowDefinitions,
  type GitCiWorkflowDefinitionsResult,
} from "./git-ci-workflow-definitions.js";

type ListKind = "branch-rules" | "check-runs" | "commit-statuses" | "workflow-runs" | "reviews";
const LISTS: readonly ListKind[] = [
  "branch-rules",
  "check-runs",
  "commit-statuses",
  "workflow-runs",
  "reviews",
];
interface Unavailable {
  readonly status: "unavailable";
  readonly failure: GitDeliveryObservationFailure;
}

export type GitCiProtectionFacts =
  | { readonly outcome: "protected"; readonly value: Readonly<Record<string, unknown>> }
  | { readonly outcome: "unprotected" }
  | { readonly outcome: "unknown"; readonly failure: GitDeliveryObservationFailure };

export interface GitCiProviderFacts {
  readonly status: "observed";
  readonly identity: GitPullRequestIdentity;
  readonly repositoryId: number;
  readonly mergeable: boolean | null;
  readonly mergeState: string;
  readonly merged: boolean;
  readonly protection: GitCiProtectionFacts;
  readonly requirements: GitCiRequirementsResult;
  readonly workflowDefinitions: GitCiWorkflowDefinitionsResult;
  readonly lists: Readonly<Record<ListKind, GitProviderPageResult>>;
}
export type GitCiFactsResult = GitCiProviderFacts | Unavailable;
export interface GitCiProviderReader {
  readFacts(target: GitCiReadTarget): Promise<GitCiFactsResult>;
  readFailureContext?(
    facts: GitCiProviderFacts,
  ): Promise<
    import("@oscharko-dev/keiko-contracts/runtime/git-delivery-provider").GitCiFailureContextResult
  >;
}
interface Input {
  readonly target: GitCiReadTarget;
  readonly run: GitProviderReadRunner;
  readonly signal?: AbortSignal;
}
interface PrFacts {
  readonly identity: GitPullRequestIdentity;
  readonly repositoryId: number;
  readonly mergeable: boolean | null;
  readonly mergeState: string;
  readonly merged: boolean;
}

function unavailable(failure: GitDeliveryObservationFailure): Unavailable {
  return { status: "unavailable", failure };
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readValue(input: Input, kind: GitCiReadKind): Promise<GitProviderValueResult> {
  return readGitProviderValue({
    run: input.run,
    argv: buildGitCiReadArgv(kind, input.target, 1),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

function revisionMatches(
  identity: GitPullRequestIdentity | undefined,
  target: GitCiReadTarget,
): identity is GitPullRequestIdentity {
  return (
    identity?.number === Number(target.prExternalId) &&
    identity.baseRef === target.baseBranchName &&
    identity.headSha === target.headSha
  );
}
function prState(value: Record<string, unknown>): value is Record<string, unknown> & {
  repositoryId: number;
  mergeable: boolean | null;
  mergeState: string;
  merged: boolean;
} {
  return (
    typeof value.repositoryId === "number" &&
    Number.isSafeInteger(value.repositoryId) &&
    value.repositoryId > 0 &&
    (typeof value.mergeable === "boolean" || value.mergeable === null) &&
    typeof value.mergeState === "string" &&
    value.mergeState.length <= 32 &&
    typeof value.merged === "boolean"
  );
}
function prFacts(value: unknown, target: GitCiReadTarget): PrFacts | undefined {
  if (!object(value) || Object.keys(value).length !== 5 || !prState(value)) return undefined;
  const identity = parseGitPrIdentity(value.identity, target.ownerAndRepo);
  if (!revisionMatches(identity, target)) return undefined;
  return {
    identity,
    repositoryId: value.repositoryId,
    mergeable: value.mergeable,
    mergeState: value.mergeState,
    merged: value.merged,
  };
}

function validProtection(value: unknown): value is Record<string, unknown> {
  return (
    object(value) &&
    Object.keys(value).length === 3 &&
    (value.checks === null || object(value.checks)) &&
    typeof value.strict === "boolean" &&
    typeof value.reviewCount === "number" &&
    Number.isSafeInteger(value.reviewCount) &&
    value.reviewCount >= 0 &&
    value.reviewCount <= 100
  );
}
function unprotectedBranch(value: unknown, target: GitCiReadTarget, baseSha: string): boolean {
  return (
    object(value) &&
    Object.keys(value).length === 3 &&
    value.name === target.baseBranchName &&
    value.sha === baseSha &&
    value.protected === false
  );
}
async function protection(input: Input, baseSha: string): Promise<GitCiProtectionFacts> {
  const [branch, detail] = await Promise.all([
    readValue(input, "branch"),
    readValue(input, "branch-protection"),
  ]);
  if (detail.status === "observed")
    return validProtection(detail.value)
      ? { outcome: "protected", value: detail.value }
      : { outcome: "unknown", failure: gitDeliveryObservationFailure("malformed-response") };
  if (detail.failure.reason !== "provider-not-found")
    return { outcome: "unknown", failure: detail.failure };
  const confirmation = await confirmUnprotectedBranchOnNotFound({
    fetchBranch: () => Promise.resolve(branch.status === "observed" ? branch.value : undefined),
    isConfirmedUnprotected: (value) => unprotectedBranch(value, input.target, baseSha),
  });
  return confirmation === "unprotected"
    ? { outcome: "unprotected" }
    : { outcome: "unknown", failure: detail.failure };
}

function readList(input: Input, kind: ListKind): Promise<GitProviderPageResult> {
  return readGitProviderPages({
    run: input.run,
    argv: (page) => buildGitCiReadArgv(kind, input.target, page),
    pageSize: 100,
    maxPages: 3,
    maxBytes: 262_144,
    counted: kind === "check-runs" || kind === "workflow-runs",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}
async function readLists(input: Input): Promise<Readonly<Record<ListKind, GitProviderPageResult>>> {
  const entries = await Promise.all(
    LISTS.map(async (kind): Promise<readonly [ListKind, GitProviderPageResult]> => [
      kind,
      await readList(input, kind),
    ]),
  );
  return Object.fromEntries(entries) as Record<ListKind, GitProviderPageResult>;
}
interface PolicyObservation {
  readonly protection: GitCiProtectionFacts;
  readonly rules: GitProviderPageResult;
  readonly requirements: GitCiRequirementsResult;
  readonly workflowDefinitions: GitCiWorkflowDefinitionsResult;
}
async function policy(
  input: Input,
  pr: PrFacts,
  detail: GitCiProtectionFacts,
  rules: GitProviderPageResult,
): Promise<PolicyObservation> {
  const requirements = collectGitCiRequirements({ protection: detail, rules });
  const workflowDefinitions = await readGitCiWorkflowDefinitions({
    repositoryId: pr.repositoryId,
    repository: input.target.ownerAndRepo,
    requirements,
    run: input.run,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return { protection: detail, rules, requirements, workflowDefinitions };
}
async function refreshPolicy(
  input: Input,
  pr: PrFacts,
  first: PolicyObservation,
): Promise<PolicyObservation> {
  if (first.requirements.status === "unknown" || first.workflowDefinitions.status === "unknown")
    return first;
  const [detail, rules] = await Promise.all([
    protection(input, pr.identity.baseSha),
    readList(input, "branch-rules"),
  ]);
  return policy(input, pr, detail, rules);
}
function policyChanged(first: PolicyObservation, last: PolicyObservation): boolean {
  if (
    first.requirements.status === "unknown" ||
    last.requirements.status === "unknown" ||
    first.workflowDefinitions.status === "unknown" ||
    last.workflowDefinitions.status === "unknown"
  )
    return false;
  const reviews = (value: PolicyObservation): unknown =>
    value.protection.outcome === "protected" ? value.protection.value.reviewCount : 0;
  return (
    first.requirements.digest !== last.requirements.digest ||
    reviews(first) !== reviews(last) ||
    canonicalise(first.workflowDefinitions.definitions) !==
      canonicalise(last.workflowDefinitions.definitions)
  );
}

function samePrContext(first: PrFacts, last: PrFacts): boolean {
  return canonicalise(first) === canonicalise(last);
}
async function observe(input: Input, first: PrFacts): Promise<GitCiFactsResult> {
  const [detail, lists] = await Promise.all([
    protection(input, first.identity.baseSha),
    readLists(input),
  ]);
  const initialPolicy = await policy(input, first, detail, lists["branch-rules"]);
  const currentPolicy = await refreshPolicy(input, first, initialPolicy);
  if (policyChanged(initialPolicy, currentPolicy))
    return unavailable(gitDeliveryObservationFailure("revision-changed"));
  const final = await readValue(input, "pull-request");
  if (final.status === "unavailable") return final;
  const last = prFacts(final.value, input.target);
  if (last === undefined || !samePrContext(first, last))
    return unavailable(gitDeliveryObservationFailure("revision-changed"));
  return {
    status: "observed",
    ...last,
    protection: currentPolicy.protection,
    requirements: currentPolicy.requirements,
    workflowDefinitions: currentPolicy.workflowDefinitions,
    lists: { ...lists, "branch-rules": currentPolicy.rules },
  };
}

/** The raw, transient owning provider seam; technical readiness is derived separately from merge permission. */
export async function readGitCiFacts(request: Input): Promise<GitCiFactsResult> {
  const input = { ...request, target: Object.freeze({ ...request.target }) };
  try {
    buildGitCiReadArgv("pull-request", input.target, 1);
  } catch {
    return unavailable(gitDeliveryObservationFailure("invalid-binding"));
  }
  const first = await readValue(input, "pull-request");
  if (first.status === "unavailable") return first;
  const facts = prFacts(first.value, input.target);
  return facts === undefined
    ? unavailable(gitDeliveryObservationFailure("revision-changed"))
    : observe(input, facts);
}
