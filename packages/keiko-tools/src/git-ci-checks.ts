import {
  gitDeliveryObservationFailure,
  isGitDeliveryReadCompleteness,
  type GitDeliveryObservationFailure,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { isGitObjectId } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import { isGitHubOwnerAndRepo } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import type { GitProviderPageResult } from "./git-provider-observation.js";
import type { GitCiWorkflowDefinition } from "./git-ci-workflow-definitions.js";
import type {
  GitCiRequirement,
  GitCiRequirementsResult,
  GitCiStatusRequirement,
  GitCiWorkflowRequirement,
} from "./git-ci-requirements.js";

export type GitCiCheckClassification =
  | "missing"
  | "queued-or-running"
  | "passed"
  | "failed"
  | "skipped"
  | "cancelled"
  | "stale-or-wrong-app"
  | "unknown";
export type GitCiCheckKind = "check-run" | "commit-status" | "workflow-run";
export interface GitCiCheckEvidence {
  readonly kind: GitCiCheckKind;
  readonly id: number;
}
export interface GitCiRequiredCheckObservation {
  readonly requirement: GitCiRequirement;
  readonly classification: GitCiCheckClassification;
  readonly evidence: readonly GitCiCheckEvidence[];
  readonly evidenceCount: number;
  readonly evidenceTruncated: boolean;
}
export interface GitCiAdvisoryCheckObservation {
  readonly kind: GitCiCheckKind;
  readonly id: number;
  readonly name: string;
  readonly classification: GitCiCheckClassification;
}
export type GitCiChecksResult =
  | {
      readonly status: "observed";
      readonly required: readonly GitCiRequiredCheckObservation[];
      readonly advisory: readonly GitCiAdvisoryCheckObservation[];
      readonly overall: "passed" | "pending" | "failed" | "blocked" | "unknown";
    }
  | { readonly status: "unknown"; readonly failure: GitDeliveryObservationFailure };
export type GitCiWorkflowDefinitionBinding = GitCiWorkflowDefinition;
export interface GitCiChecksInput {
  readonly headSha: string;
  readonly baseSha: string;
  readonly prNumber: number;
  readonly repositoryId: number;
  readonly requirements: GitCiRequirementsResult;
  readonly checkRuns: GitProviderPageResult;
  readonly commitStatuses: GitProviderPageResult;
  readonly workflowRuns: GitProviderPageResult;
  readonly workflowDefinitions?: readonly GitCiWorkflowDefinitionBinding[];
}
interface Check {
  readonly kind: GitCiCheckKind;
  readonly id: number;
  readonly name: string;
  readonly appId: number | null;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly createdAt: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

const PENDING = new Set(["queued", "in_progress", "requested", "waiting", "pending"]);
const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure", "error"]);
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(value))
    throw new TypeError("Invalid CI event time");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError("Invalid CI event time");
  return parsed;
}
function nullableTime(value: unknown): number {
  return value === null ? 0 : timestamp(value);
}
function runAppId(raw: Record<string, unknown>, kind: GitCiCheckKind): number | null {
  if (kind !== "check-run") return null;
  if (raw.appId !== null && !positive(raw.appId))
    throw new TypeError("Invalid CI source application");
  return raw.appId;
}
function metadataList(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new TypeError("Invalid CI workflow metadata list");
  return value as unknown[];
}
function assertWorkflowMetadata(raw: Record<string, unknown>): void {
  if (![raw.workflowId, raw.runAttempt, raw.repositoryId, raw.headRepositoryId].every(positive))
    throw new TypeError("Invalid CI workflow source identity");
  if (timestamp(raw.updatedAt) < timestamp(raw.createdAt))
    throw new TypeError("Invalid CI workflow chronology");
  for (const request of metadataList(raw.pullRequests)) {
    if (
      !object(request) ||
      !positive(request.number) ||
      !isGitObjectId(request.headSha) ||
      !isGitObjectId(request.baseSha)
    )
      throw new TypeError("Invalid CI workflow pull request identity");
  }
  for (const reference of metadataList(raw.referencedWorkflows)) assertWorkflowReference(reference);
}
function assertWorkflowReference(reference: unknown): void {
  if (!object(reference) || !text(reference.path) || !isGitObjectId(reference.sha))
    throw new TypeError("Invalid CI workflow reference");
  if (reference.ref !== undefined && reference.ref !== null && !text(reference.ref))
    throw new TypeError("Invalid CI workflow reference label");
}
function assertCheckMetadata(raw: Record<string, unknown>): void {
  if (
    !positive(raw.suiteId) ||
    typeof raw.annotationCount !== "number" ||
    !Number.isSafeInteger(raw.annotationCount) ||
    raw.annotationCount < 0
  )
    throw new TypeError("Invalid CI check metadata");
  const completedAt = nullableTime(raw.completedAt);
  if (completedAt > 0 && completedAt < nullableTime(raw.startedAt))
    throw new TypeError("Invalid CI check chronology");
}
function parseRun(raw: Record<string, unknown>, kind: "check-run" | "workflow-run"): Check {
  const name = kind === "check-run" ? raw.name : raw.path;
  if (!text(name) || !isGitObjectId(raw.headSha) || typeof raw.status !== "string")
    throw new TypeError("Invalid CI run identity");
  if (raw.conclusion !== null && typeof raw.conclusion !== "string")
    throw new TypeError("Invalid CI run conclusion");
  const appId = runAppId(raw, kind);
  if (kind === "workflow-run") assertWorkflowMetadata(raw);
  else assertCheckMetadata(raw);
  return {
    kind,
    id: Number(raw.id),
    name,
    appId,
    headSha: raw.headSha,
    status: raw.status,
    conclusion: raw.conclusion,
    createdAt: nullableTime(kind === "check-run" ? raw.startedAt : raw.createdAt),
    raw,
  };
}
function parseStatus(raw: Record<string, unknown>, headSha: string): Check {
  if (!text(raw.context) || typeof raw.state !== "string" || !positive(raw.creatorId))
    throw new TypeError("Invalid CI commit status");
  const createdAt = timestamp(raw.createdAt);
  if (timestamp(raw.updatedAt) < createdAt) throw new TypeError("Invalid CI status chronology");
  return {
    kind: "commit-status",
    id: Number(raw.id),
    name: raw.context,
    appId: null,
    headSha,
    status: raw.state === "pending" ? "pending" : "completed",
    conclusion: raw.state,
    createdAt,
    raw,
  };
}
function parseList(page: GitProviderPageResult, kind: GitCiCheckKind, headSha: string): Check[] {
  const ids = new Set<number>();
  if (page.values.length > 500 || page.values.length !== page.completeness.entries)
    throw new TypeError("Incomplete CI list");
  return page.values.map((raw): Check => {
    if (!object(raw) || !positive(raw.id) || ids.has(raw.id))
      throw new TypeError("Invalid or repeated CI run ID");
    ids.add(raw.id);
    return kind === "commit-status" ? parseStatus(raw, headSha) : parseRun(raw, kind);
  });
}
function conclusion(check: Check, input: GitCiChecksInput): GitCiCheckClassification {
  if (check.headSha !== input.headSha) return "stale-or-wrong-app";
  if (PENDING.has(check.status)) return "queued-or-running";
  if (check.status !== "completed") return "unknown";
  if (check.conclusion === "success") return "passed";
  if (check.conclusion === "skipped") return "skipped";
  if (check.conclusion === "cancelled") return "cancelled";
  if (check.conclusion === "stale") return "stale-or-wrong-app";
  return check.conclusion !== null && FAILED.has(check.conclusion) ? "failed" : "unknown";
}
function combined(classes: readonly GitCiCheckClassification[]): GitCiCheckClassification {
  const order: readonly GitCiCheckClassification[] = [
    "unknown",
    "stale-or-wrong-app",
    "failed",
    "cancelled",
    "skipped",
    "missing",
    "queued-or-running",
  ];
  return order.find((value) => classes.includes(value)) ?? "passed";
}
function latestStatus(checks: readonly Check[]): readonly Check[] {
  if (checks.length === 0) return [];
  const latest = Math.max(...checks.map((value) => value.createdAt));
  return checks.filter((value) => value.createdAt === latest);
}
function statusClass(
  requirement: GitCiStatusRequirement,
  checks: readonly Check[],
  input: GitCiChecksInput,
): GitCiCheckClassification {
  const modern = checks.filter((check) => check.kind === "check-run");
  const statuses = latestStatus(checks.filter((check) => check.kind === "commit-status"));
  const matching = modern.filter(
    (check) => requirement.appId === null || check.appId === requirement.appId,
  );
  if (matching.length > 1 || statuses.length > 1) return "unknown";
  if (requirement.appId !== null && matching.length === 0) return "stale-or-wrong-app";
  if (requirement.appId !== null && statuses.length > 0) return "unknown";
  const selected = [...matching, ...statuses];
  if (selected.length === 0) return "missing";
  return combined(selected.map((check) => conclusion(check, input)));
}
function workflowDefinition(
  input: GitCiChecksInput,
  requirement: GitCiWorkflowRequirement,
): GitCiWorkflowDefinitionBinding | undefined {
  const definitions = input.workflowDefinitions ?? [];
  if (definitions.length > 8) return undefined;
  const matching = definitions.filter((value) => definitionMatches(value, requirement));
  return matching.length === 1 ? matching[0] : undefined;
}
function definitionMatches(
  value: GitCiWorkflowDefinitionBinding,
  requirement: GitCiWorkflowRequirement,
): boolean {
  return [
    value.repositoryId === requirement.repositoryId,
    value.path === requirement.path,
    value.ref === requirement.ref,
    isGitHubOwnerAndRepo(value.repository),
    isGitObjectId(value.sha),
    requirement.sha === null || value.sha === requirement.sha,
  ].every(Boolean);
}
function workflowRevision(
  requirement: GitCiWorkflowRequirement,
  value: Record<string, unknown>,
  sha: string,
): boolean {
  if (value.sha !== sha) return false;
  if (requirement.ref !== null && value.ref !== requirement.ref) return false;
  return true;
}
function ownWorkflowPath(
  requirement: GitCiWorkflowRequirement,
  check: Check,
  repository: string,
  sha: string,
): boolean {
  const marker = check.name.lastIndexOf("@");
  if (marker < 0) return false;
  const ownPath = check.name.slice(0, marker);
  const revision = check.name.slice(marker + 1);
  const pathMatches =
    ownPath === `${repository}/${requirement.path}` ||
    (check.raw.repositoryId === requirement.repositoryId && ownPath === requirement.path);
  return pathMatches && (revision === sha || revision === requirement.ref);
}
function referencedWorkflow(
  requirement: GitCiWorkflowRequirement,
  check: Check,
  input: GitCiChecksInput,
): boolean {
  const definition = workflowDefinition(input, requirement);
  if (definition === undefined || !Array.isArray(check.raw.referencedWorkflows)) return false;
  const repository = definition.repository.toLowerCase();
  if (!ownWorkflowPath(requirement, check, repository, definition.sha)) return false;
  const candidates = check.raw.referencedWorkflows as unknown[];
  if (candidates.length > 100) return false;
  return candidates.some((value) => {
    if (!object(value) || typeof value.path !== "string") return false;
    const marker = value.path.lastIndexOf("@");
    const path = marker < 0 ? value.path : value.path.slice(0, marker);
    return (
      path === `${repository}/${requirement.path}` &&
      workflowRevision(requirement, value, definition.sha)
    );
  });
}
function sameRepositoryWorkflow(
  requirement: GitCiWorkflowRequirement,
  check: Check,
  input: GitCiChecksInput,
): boolean {
  if (check.raw.repositoryId !== requirement.repositoryId) return false;
  const marker = check.name.lastIndexOf("@");
  if (marker < 0) return false;
  const path = check.name.slice(0, marker);
  const revision = check.name.slice(marker + 1);
  // A branch label cannot prove a required SHA; only the explicit object ID can do so.
  const sha = requirement.sha ?? workflowDefinition(input, requirement)?.sha;
  return path === requirement.path && sha !== undefined && revision === sha;
}
function exactWorkflowContext(check: Check, input: GitCiChecksInput): boolean {
  if (
    check.headSha !== input.headSha ||
    check.raw.repositoryId !== input.repositoryId ||
    check.raw.headRepositoryId !== input.repositoryId
  )
    return false;
  if (check.raw.event !== "pull_request" || !Array.isArray(check.raw.pullRequests)) return false;
  const requests = check.raw.pullRequests as unknown[];
  return (
    requests.length <= 100 &&
    requests.some(
      (value) =>
        object(value) &&
        value.number === input.prNumber &&
        value.headSha === input.headSha &&
        value.baseSha === input.baseSha,
    )
  );
}
// Owner audit finding b5-9: `checks` (from `workflowCandidate`) is pre-filtered by name-suffix only,
// so it can admit a check that is NOT the required workflow at all — an entirely unrelated
// repository whose path merely happens to share the required filename. Distinguish that "no real
// candidate exists" case from every other zero-exact-match case this classifier already treats as
// genuinely ambiguous: a check from the SAME numeric repository (only its revision/PR-context proof
// failed), or a check that self-reports (via a non-empty `referencedWorkflows`) some link to a
// reusable workflow, even one that fails full validation. Both of those are real, if unproven,
// evidence — declaring them "missing" would be a false confident-absence claim, so they stay
// "unknown". Only a check with NEITHER signal is a pure coincidental filename collision.
function workflowCouldBeRealCandidate(
  requirement: GitCiWorkflowRequirement,
  check: Check,
): boolean {
  if (check.raw.repositoryId === requirement.repositoryId) return true;
  return Array.isArray(check.raw.referencedWorkflows) && check.raw.referencedWorkflows.length > 0;
}
function workflowClass(
  requirement: GitCiWorkflowRequirement,
  checks: readonly Check[],
  input: GitCiChecksInput,
): GitCiCheckClassification {
  const matching = checks.filter(
    (check) =>
      sameRepositoryWorkflow(requirement, check, input) ||
      referencedWorkflow(requirement, check, input),
  );
  if (matching.length > 1) return "unknown";
  if (matching.length === 0)
    return checks.some((check) => workflowCouldBeRealCandidate(requirement, check))
      ? "unknown"
      : "missing";
  const check = matching[0];
  if (check === undefined) return "unknown";
  if (!exactWorkflowContext(check, input)) return "stale-or-wrong-app";
  return conclusion(check, input);
}
function workflowCandidate(requirement: GitCiWorkflowRequirement, check: Check): boolean {
  const matchPath = (value: unknown): boolean => {
    if (typeof value !== "string") return false;
    const path = value.split("@")[0];
    return path === requirement.path || path?.endsWith(`/${requirement.path}`) === true;
  };
  if (matchPath(check.name)) return true;
  if (!Array.isArray(check.raw.referencedWorkflows)) return false;
  return (check.raw.referencedWorkflows as unknown[]).some(
    (value) => object(value) && matchPath(value.path),
  );
}
function requirementObservation(
  requirement: GitCiRequirement,
  all: readonly Check[],
  input: GitCiChecksInput,
  used: Set<Check>,
): GitCiRequiredCheckObservation {
  const checks = all.filter((check) =>
    requirement.kind === "workflow"
      ? check.kind === "workflow-run" && workflowCandidate(requirement, check)
      : check.kind !== "workflow-run" && check.name === requirement.context,
  );
  for (const check of checks) used.add(check);
  const classification = requiredClass(requirement, checks, input);
  const evidence = selectEvidence(requirement, [
    ...checks.filter((check) => check.kind !== "commit-status"),
    ...latestStatus(checks.filter((check) => check.kind === "commit-status")),
  ]);
  return {
    requirement,
    classification,
    evidenceCount: evidence.length,
    evidenceTruncated: evidence.length > 32,
    evidence: evidence.slice(0, 32).map(({ kind, id }) => ({ kind, id })),
  };
}
function requiredClass(
  requirement: GitCiRequirement,
  checks: readonly Check[],
  input: GitCiChecksInput,
): GitCiCheckClassification {
  if (checks.length === 0) return "missing";
  return requirement.kind === "workflow"
    ? workflowClass(requirement, checks, input)
    : statusClass(requirement, checks, input);
}
function selectEvidence(requirement: GitCiRequirement, checks: readonly Check[]): readonly Check[] {
  if (requirement.kind !== "status-context" || requirement.appId === null) return checks;
  const matching = checks.filter(
    (check) => check.kind === "commit-status" || check.appId === requirement.appId,
  );
  return matching.length > 0 ? matching : checks;
}
function overall(
  required: readonly GitCiRequiredCheckObservation[],
): Extract<GitCiChecksResult, { status: "observed" }>["overall"] {
  const classes = new Set(required.map((value) => value.classification));
  if (classes.has("unknown") || classes.has("stale-or-wrong-app")) return "unknown";
  if (classes.has("failed")) return "failed";
  if (classes.has("skipped") || classes.has("cancelled")) return "blocked";
  if (classes.has("missing") || classes.has("queued-or-running")) return "pending";
  return "passed";
}
function inputFailure(input: GitCiChecksInput): GitDeliveryObservationFailure | undefined {
  if (
    !isGitObjectId(input.headSha) ||
    !isGitObjectId(input.baseSha) ||
    !positive(input.prNumber) ||
    !positive(input.repositoryId)
  )
    return gitDeliveryObservationFailure("invalid-binding");
  for (const page of [input.checkRuns, input.commitStatuses, input.workflowRuns]) {
    if (!isGitDeliveryReadCompleteness(page.completeness))
      return gitDeliveryObservationFailure("malformed-response");
    if (!page.completeness.complete) return page.completeness.failure;
    if (page.completeness.pages > 5) return gitDeliveryObservationFailure("pagination-exhausted");
    if (page.completeness.bytes > 1_048_576)
      return gitDeliveryObservationFailure("output-truncated");
  }
  return undefined;
}
/** Technical classes are intentionally separate from the merge gateway's unchanged GitHub tally. */
export function classifyGitCiChecks(input: GitCiChecksInput): GitCiChecksResult {
  if (input.requirements.status === "unknown") return input.requirements;
  const failure = inputFailure(input);
  if (failure !== undefined) return { status: "unknown", failure };
  try {
    const checks = [
      ...parseList(input.checkRuns, "check-run", input.headSha),
      ...parseList(input.commitStatuses, "commit-status", input.headSha),
      ...parseList(input.workflowRuns, "workflow-run", input.headSha),
    ];
    const used = new Set<Check>();
    const required = input.requirements.requirements.map((requirement) =>
      requirementObservation(requirement, checks, input, used),
    );
    const advisory = checks
      .filter((check) => !used.has(check))
      .map((check) => ({
        kind: check.kind,
        id: check.id,
        name: check.name,
        classification: conclusion(check, input),
      }));
    return { status: "observed", required, advisory, overall: overall(required) };
  } catch {
    return { status: "unknown", failure: gitDeliveryObservationFailure("malformed-response") };
  }
}
