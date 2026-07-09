import { createHash } from "node:crypto";
import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  validateCodingWorkbenchAuthorityEnvelope,
  validateCodingWorkbenchEvidenceRecord,
  type CodingWorkbenchActionClass,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchConnectorScope,
  type CodingWorkbenchEvidenceRecord,
  type CommandTaskRunRequest,
  type GitRepositoryAgentOperationKind,
  type GitRepositoryAgentOperationRequest,
} from "@oscharko-dev/keiko-contracts";

export type AutonomousDeliveryDenialReason =
  | "authority-envelope-invalid"
  | "authority-envelope-unconfirmed"
  | "authority-expired"
  | "branch-out-of-envelope"
  | "budget-exceeded"
  | "connector-object-out-of-envelope"
  | "connector-scope-missing"
  | "delivery-policy-denied"
  | "operator-stopped"
  | "permission-scope-missing";

export type AutonomousDeliveryDecision =
  | {
      readonly status: "allowed";
      readonly evidence: CodingWorkbenchEvidenceRecord;
    }
  | {
      readonly status: "denied";
      readonly denialReason: AutonomousDeliveryDenialReason;
      readonly evidence: CodingWorkbenchEvidenceRecord;
    };

export interface AutonomousDeliveryConfirmation {
  readonly confirmed: boolean;
  readonly approvalProofDigest: string;
  readonly confirmedAt: string;
}

export interface AutonomousDeliveryUsage {
  readonly runtimeMs: number;
  readonly toolCalls: number;
  readonly promptTokens: number;
  readonly patchBytes: number;
}

export interface AutonomousDeliveryOperationStep {
  readonly kind: "repository-operation";
  readonly stepId: string;
  readonly request: GitRepositoryAgentOperationRequest;
}

export interface AutonomousDeliveryCommandStep {
  readonly kind: "command-task";
  readonly stepId: string;
  readonly request: CommandTaskRunRequest;
}

export type AutonomousDeliveryConnectorProvider = "github" | "jira";
export type AutonomousDeliveryConnectorObjectKind = "issue" | "pull-request";
export type AutonomousDeliveryConnectorAction = "status-update" | "comment";
export type AutonomousDeliveryConnectorStatus =
  "in-progress" | "ready-for-human-review" | "blocked" | "done";
export type AutonomousDeliveryConnectorCommentKind = "progress" | "handoff" | "closure";

export interface AutonomousDeliveryConnectorOperationRequest {
  readonly provider: AutonomousDeliveryConnectorProvider;
  readonly objectKind: AutonomousDeliveryConnectorObjectKind;
  readonly action: AutonomousDeliveryConnectorAction;
  readonly targetRef: string;
  readonly idempotencyKey: string;
  readonly status?: AutonomousDeliveryConnectorStatus | undefined;
  readonly commentKind?: AutonomousDeliveryConnectorCommentKind | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface AutonomousDeliveryConnectorOperationResult {
  readonly status: "applied" | "previewed";
  readonly routeStatus: number;
}

export interface AutonomousDeliveryConnectorExecutor {
  execute(
    request: AutonomousDeliveryConnectorOperationRequest,
  ): Promise<AutonomousDeliveryConnectorOperationResult>;
}

export interface AutonomousDeliveryConnectorStep {
  readonly kind: "connector-operation";
  readonly stepId: string;
  readonly request: AutonomousDeliveryConnectorOperationRequest;
}

export type AutonomousDeliveryStep =
  AutonomousDeliveryOperationStep | AutonomousDeliveryCommandStep | AutonomousDeliveryConnectorStep;

export interface AutonomousDeliveryPolicyRequest {
  readonly authorityEnvelope: CodingWorkbenchAuthorityEnvelope;
  readonly confirmation: AutonomousDeliveryConfirmation;
  readonly approvalProofVerified: boolean;
  readonly deploymentCeilingVerified: boolean;
  readonly step: AutonomousDeliveryStep;
  readonly usage: AutonomousDeliveryUsage;
  readonly nowIso: string;
  readonly remainingStepCount: number;
  readonly operatorStopped?: boolean | undefined;
}

interface OperationRequirement {
  readonly actionClasses: readonly CodingWorkbenchActionClass[];
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[];
  readonly needsNetwork: boolean;
}

const SOURCE_CONTROL_READ = "source-control.read" satisfies CodingWorkbenchConnectorScope;
const SOURCE_CONTROL_WRITE = "source-control.write" satisfies CodingWorkbenchConnectorScope;
const ISSUE_TRACKER_WRITE = "issue-tracker.write" satisfies CodingWorkbenchConnectorScope;

const READ_REQUIREMENT = requirement(["workspace-read"], [SOURCE_CONTROL_READ], false);
const LOCAL_WRITE_REQUIREMENT = requirement(["workspace-write"], [SOURCE_CONTROL_WRITE], false);
const COMMIT_REQUIREMENT = requirement(["delivery-substrate"], [SOURCE_CONTROL_WRITE], false);
const FETCH_REQUIREMENT = requirement(
  ["delivery-substrate", "network-egress"],
  [SOURCE_CONTROL_READ],
  true,
);
const REMOTE_WRITE_REQUIREMENT = requirement(
  ["delivery-substrate", "network-egress"],
  [SOURCE_CONTROL_WRITE],
  true,
);
const COMMAND_TASK_REQUIREMENT = requirement(["command-execution", "verification"], [], false);
const ISSUE_TRACKER_WRITE_REQUIREMENT = requirement(
  ["connector-access", "network-egress"],
  [ISSUE_TRACKER_WRITE],
  true,
);

const OPERATION_REQUIREMENTS: Readonly<
  Partial<Record<GitRepositoryAgentOperationKind, OperationRequirement>>
> = Object.freeze({
  status: READ_REQUIREMENT,
  diff: READ_REQUIREMENT,
  "branch-list": READ_REQUIREMENT,
  "branch-create": LOCAL_WRITE_REQUIREMENT,
  "branch-switch": LOCAL_WRITE_REQUIREMENT,
  stage: LOCAL_WRITE_REQUIREMENT,
  unstage: LOCAL_WRITE_REQUIREMENT,
  commit: COMMIT_REQUIREMENT,
  fetch: FETCH_REQUIREMENT,
  pull: REMOTE_WRITE_REQUIREMENT,
  push: REMOTE_WRITE_REQUIREMENT,
  "pull-request": REMOTE_WRITE_REQUIREMENT,
});

export function decideAutonomousDeliveryOperation(
  request: AutonomousDeliveryPolicyRequest,
): AutonomousDeliveryDecision {
  const denialReason = denialReasonFor(request);
  if (denialReason !== undefined) return denied(request, denialReason);
  return { status: "allowed", evidence: evidenceRecord(request, false, "approval-proof-accepted") };
}

export function autonomousDeliveryDeniedStep(
  request: AutonomousDeliveryPolicyRequest,
  denialReason: AutonomousDeliveryDenialReason,
): Extract<AutonomousDeliveryDecision, { readonly status: "denied" }> {
  return denied(request, denialReason);
}

function validateAuthority(
  request: AutonomousDeliveryPolicyRequest,
): AutonomousDeliveryDenialReason | undefined {
  const envelope = request.authorityEnvelope;
  const parsed = validateCodingWorkbenchAuthorityEnvelope(envelope);
  if (!parsed.ok) return "authority-envelope-invalid";
  if (!request.deploymentCeilingVerified) return "delivery-policy-denied";
  return envelope.effectiveMode === "autonomous-delivery" ? undefined : "delivery-policy-denied";
}

function confirmationMatches(request: AutonomousDeliveryPolicyRequest): boolean {
  return request.confirmation.confirmed && request.approvalProofVerified;
}

function denialReasonFor(
  request: AutonomousDeliveryPolicyRequest,
): AutonomousDeliveryDenialReason | undefined {
  return (
    validateAuthority(request) ?? lifecycleDenialReason(request) ?? requirementDenialReason(request)
  );
}

function lifecycleDenialReason(
  request: AutonomousDeliveryPolicyRequest,
): AutonomousDeliveryDenialReason | undefined {
  if (!confirmationMatches(request)) return "authority-envelope-unconfirmed";
  if (request.operatorStopped === true) return "operator-stopped";
  if (envelopeExpired(request.nowIso, request.authorityEnvelope.expiresAt)) {
    return "authority-expired";
  }
  return budgetExceeded(request) ? "budget-exceeded" : undefined;
}

function requirementDenialReason(
  request: AutonomousDeliveryPolicyRequest,
): AutonomousDeliveryDenialReason | undefined {
  const requirement = stepRequirement(request.step);
  if (requirement === undefined) return "delivery-policy-denied";
  if (!hasActionClasses(request.authorityEnvelope, requirement.actionClasses)) {
    return "permission-scope-missing";
  }
  if (!stepPolicyAllowed(request)) return "delivery-policy-denied";
  if (!hasConnectorScopes(request.authorityEnvelope, requirement.connectorScopes)) {
    return "connector-scope-missing";
  }
  if (!networkAllowed(request.authorityEnvelope, requirement)) return "permission-scope-missing";
  return scopeDenialReason(request.authorityEnvelope, request.step);
}

function budgetExceeded(request: AutonomousDeliveryPolicyRequest): boolean {
  const budget = request.authorityEnvelope.budget;
  const usage = request.usage;
  return (
    usage.runtimeMs > budget.maxRuntimeMs ||
    usage.toolCalls + request.remainingStepCount > budget.maxToolCalls ||
    usage.promptTokens > budget.maxPromptTokens ||
    usage.patchBytes > budget.maxPatchBytes
  );
}

function envelopeExpired(nowIso: string, expiresAt: string): boolean {
  const nowMs = Date.parse(nowIso);
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isNaN(nowMs) || Number.isNaN(expiresAtMs) || nowMs >= expiresAtMs;
}

function operationRequirement(
  operation: GitRepositoryAgentOperationKind,
): OperationRequirement | undefined {
  return OPERATION_REQUIREMENTS[operation];
}

function stepRequirement(step: AutonomousDeliveryStep): OperationRequirement | undefined {
  if (step.kind === "command-task") return COMMAND_TASK_REQUIREMENT;
  if (step.kind === "connector-operation") return ISSUE_TRACKER_WRITE_REQUIREMENT;
  return operationRequirement(step.request.operation);
}

function stepPolicyAllowed(request: AutonomousDeliveryPolicyRequest): boolean {
  const step = request.step;
  if (step.kind === "command-task") return request.authorityEnvelope.commandPolicy.mode !== "deny";
  if (step.kind === "connector-operation") return connectorRequestShapeAllowed(step.request);
  if (step.request.operation !== "push") return true;
  return step.request.payload?.forcePush !== true;
}

function connectorRequestShapeAllowed(
  request: AutonomousDeliveryConnectorOperationRequest,
): boolean {
  if (request.action === "status-update") return request.status !== undefined;
  return request.commentKind !== undefined;
}

function requirement(
  actionClasses: readonly CodingWorkbenchActionClass[],
  connectorScopes: readonly CodingWorkbenchConnectorScope[],
  needsNetwork: boolean,
): OperationRequirement {
  return { actionClasses, connectorScopes, needsNetwork };
}

function hasActionClasses(
  envelope: CodingWorkbenchAuthorityEnvelope,
  required: readonly CodingWorkbenchActionClass[],
): boolean {
  return required.every((actionClass) => envelope.actionClasses.includes(actionClass));
}

function hasConnectorScopes(
  envelope: CodingWorkbenchAuthorityEnvelope,
  required: readonly CodingWorkbenchConnectorScope[],
): boolean {
  return required.every((scope) => envelope.connectorScopes.includes(scope));
}

function networkAllowed(
  envelope: CodingWorkbenchAuthorityEnvelope,
  requirement: OperationRequirement,
): boolean {
  if (!requirement.needsNetwork) return true;
  if (envelope.networkPolicy.mode === "deny-all") return false;
  return requirement.connectorScopes.every((scope) =>
    envelope.networkPolicy.connectorScopes.includes(scope),
  );
}

function branchAllowed(
  envelope: CodingWorkbenchAuthorityEnvelope,
  step: AutonomousDeliveryStep,
): boolean {
  if (step.kind !== "repository-operation") return true;
  const request = step.request;
  const head = headBranchForOperation(request);
  if (head !== undefined && head !== envelope.branch.headRef) return false;
  const base = baseBranchForOperation(request);
  if (base !== undefined && base !== envelope.branch.baseRef) return false;
  return branchMatchesEnvelope(envelope.branch.headRef, envelope.branch.allowedPrefixes);
}

function connectorObjectAllowed(
  envelope: CodingWorkbenchAuthorityEnvelope,
  step: AutonomousDeliveryStep,
): boolean {
  if (step.kind !== "connector-operation") return true;
  return envelope.taskRefs.includes(step.request.targetRef);
}

function scopeDenialReason(
  envelope: CodingWorkbenchAuthorityEnvelope,
  step: AutonomousDeliveryStep,
): AutonomousDeliveryDenialReason | undefined {
  if (!branchAllowed(envelope, step)) return "branch-out-of-envelope";
  return connectorObjectAllowed(envelope, step) ? undefined : "connector-object-out-of-envelope";
}

function headBranchForOperation(request: GitRepositoryAgentOperationRequest): string | undefined {
  const payload = request.payload ?? {};
  if (request.operation === "branch-create") return payloadString(payload, "branchName");
  if (request.operation === "branch-switch") return payloadString(payload, "branchName");
  if (request.operation === "push") {
    return payloadString(payload, "sourceBranchName") ?? payloadString(payload, "remoteBranchName");
  }
  if (request.operation === "pull-request" || request.operation === "merge") {
    return payloadString(payload, "headBranchName");
  }
  return undefined;
}

function baseBranchForOperation(request: GitRepositoryAgentOperationRequest): string | undefined {
  const payload = request.payload ?? {};
  if (request.operation === "branch-create") return payloadString(payload, "baseBranchName");
  if (request.operation === "pull-request" || request.operation === "merge") {
    return payloadString(payload, "baseBranchName");
  }
  return undefined;
}

function payloadString(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function branchMatchesEnvelope(branch: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => branch === prefix || branch.startsWith(prefix));
}

function denied(
  request: AutonomousDeliveryPolicyRequest,
  denialReason: AutonomousDeliveryDenialReason,
): Extract<AutonomousDeliveryDecision, { readonly status: "denied" }> {
  return {
    status: "denied",
    denialReason,
    evidence: evidenceRecord(request, true, summaryForDenial(denialReason)),
  };
}

function summaryForDenial(reason: AutonomousDeliveryDenialReason): string {
  if (reason === "operator-stopped") return "operator-stopped";
  if (reason === "authority-expired") return "expired";
  if (reason === "authority-envelope-unconfirmed") return "approval-proof-missing";
  if (reason === "branch-out-of-envelope") return "branch-prefix-denied";
  if (reason === "connector-object-out-of-envelope") return "scope-denied";
  if (reason === "connector-scope-missing") return "scope-denied";
  if (reason === "permission-scope-missing") return "permission-denied";
  return "policy-denied";
}

function evidenceRecord(
  request: AutonomousDeliveryPolicyRequest,
  denied: boolean,
  safeSummary: string,
): CodingWorkbenchEvidenceRecord {
  const record = {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    recordId: `autonomous-delivery-${numericDigest([
      request.authorityEnvelope.runId,
      request.step.stepId,
    ])}`,
    runId: request.authorityEnvelope.runId,
    occurredAt: request.nowIso,
    kind: denied ? "failure" : "permission",
    effectiveMode: request.authorityEnvelope.effectiveMode,
    runtimeSource: request.authorityEnvelope.runtimeSource,
    modelSource: request.authorityEnvelope.modelProfile.source,
    artifactLabel: artifactLabelForStep(request.step),
    safeSummary,
    digest: digest([request.authorityEnvelope.runId, request.step.stepId, safeSummary]),
    denied,
  } as const satisfies CodingWorkbenchEvidenceRecord;
  const validation = validateCodingWorkbenchEvidenceRecord(record);
  if (!validation.ok) throw new Error("autonomous delivery evidence validation failed");
  return record;
}

function artifactLabelForStep(step: AutonomousDeliveryStep): string {
  if (step.kind === "command-task") return "verification";
  if (step.kind === "connector-operation") return "issue-tracker";
  return artifactLabelForOperation(step.request.operation);
}

function artifactLabelForOperation(operation: GitRepositoryAgentOperationKind): string {
  if (operation === "status" || operation === "diff" || operation === "branch-list") {
    return "workspace-read";
  }
  if (operation === "branch-create" || operation === "branch-switch") return "workspace-write";
  if (operation === "stage" || operation === "unstage") return "workspace-write";
  return "delivery";
}

function numericDigest(parts: readonly string[]): string {
  return BigInt(`0x${digest(parts).slice(0, 12)}`).toString(10);
}

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}
