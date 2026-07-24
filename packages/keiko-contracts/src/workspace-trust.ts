// Canonical per-root Workspace Trust. Records are server-owned facts; browser input cannot mint one.

import type { CommandTaskTrustState } from "./command-runner.js";
import { strictestCodingWorkbenchPolicyEffect } from "./coding-workbench.js";
import type { CodingWorkbenchPolicyEffect } from "./coding-workbench.js";
import {
  WORKSPACE_CONTRACT_SCHEMA_VERSION,
  hasOnlyWorkspaceKeys,
  isWorkspaceFact,
  isWorkspaceManifestDigest,
  isWorkspaceManifestRef,
  isWorkspaceRecord,
  isWorkspaceRootIdentityDigest,
  isWorkspaceRootRef,
  isWorkspaceTrustBasisDigest,
  workspaceContractInvalid,
  workspaceContractValid,
} from "./workspace-contract-primitives.js";
import type {
  WorkspaceContractValidation,
  WorkspaceFact,
  WorkspaceManifestDigest,
  WorkspaceManifestRef,
  WorkspaceRootIdentityDigest,
  WorkspaceRootRef,
  WorkspaceTrustBasisDigest,
} from "./workspace-contract-primitives.js";

export const WORKSPACE_TRUST_SCHEMA_VERSION = WORKSPACE_CONTRACT_SCHEMA_VERSION;

export type WorkspaceTrustLevel = "trusted" | "restricted";

export const WORKSPACE_TRUST_LEVELS: readonly WorkspaceTrustLevel[] = Object.freeze([
  "trusted",
  "restricted",
] as const);

export type WorkspaceTrustReason =
  | "human-grant"
  | "human-revocation"
  | "identity-changed"
  | "manifest-changed"
  | "trust-basis-changed"
  | "policy"
  | "state-unavailable";

export const WORKSPACE_TRUST_REASONS: readonly WorkspaceTrustReason[] = Object.freeze([
  "human-grant",
  "human-revocation",
  "identity-changed",
  "manifest-changed",
  "trust-basis-changed",
  "policy",
  "state-unavailable",
] as const);

export interface WorkspaceTrustBinding {
  readonly manifestRef: WorkspaceManifestRef;
  readonly manifestRevision: number;
  readonly manifestDigest: WorkspaceManifestDigest;
  readonly rootRef: WorkspaceRootRef;
  readonly rootIdentityDigest: WorkspaceRootIdentityDigest;
  readonly trustBasisDigest: WorkspaceFact<WorkspaceTrustBasisDigest>;
}

export interface WorkspaceTrustRecord {
  readonly kind: "workspace-trust";
  readonly schemaVersion: typeof WORKSPACE_TRUST_SCHEMA_VERSION;
  readonly binding: WorkspaceTrustBinding;
  readonly trust: WorkspaceTrustLevel;
  readonly decidedBy: "server";
  readonly reason: WorkspaceTrustReason;
  readonly revision: number;
  readonly policyVersion: string;
}

export type WorkspaceTrustAssessment = WorkspaceFact<WorkspaceTrustRecord>;
export type WorkspaceTrustOperationClass = "read" | "mutate" | "execute";

// Redacted browser projection for one registered root. The server echoes only the user-selected
// project id plus closed trust metadata; canonical root identities, manifest digests, and trust-basis
// digests stay server-side. `revision: null` means no validated durable record is available.
export interface WorkspaceTrustStatus {
  readonly kind: "workspace-trust-status";
  readonly schemaVersion: typeof WORKSPACE_TRUST_SCHEMA_VERSION;
  readonly projectId: string;
  readonly trust: WorkspaceTrustLevel;
  readonly decidedBy: "server";
  readonly reason: WorkspaceTrustReason;
  readonly revision: number | null;
}

const BINDING_KEYS = [
  "manifestRef",
  "manifestRevision",
  "manifestDigest",
  "rootRef",
  "rootIdentityDigest",
  "trustBasisDigest",
] as const;
const RECORD_KEYS = [
  "kind",
  "schemaVersion",
  "binding",
  "trust",
  "decidedBy",
  "reason",
  "revision",
  "policyVersion",
] as const;
const STATUS_KEYS = [
  "kind",
  "schemaVersion",
  "projectId",
  "trust",
  "decidedBy",
  "reason",
  "revision",
] as const;
const POLICY_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{2,95}$/u;
const PROJECT_ID_MAX_CHARS = 4_096;

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isWorkspaceTrustBinding(value: unknown): value is WorkspaceTrustBinding {
  return (
    isWorkspaceRecord(value) &&
    hasOnlyWorkspaceKeys(value, BINDING_KEYS) &&
    isWorkspaceManifestRef(value.manifestRef) &&
    isRevision(value.manifestRevision) &&
    isWorkspaceManifestDigest(value.manifestDigest) &&
    isWorkspaceRootRef(value.rootRef) &&
    isWorkspaceRootIdentityDigest(value.rootIdentityDigest) &&
    isWorkspaceFact(value.trustBasisDigest, isWorkspaceTrustBasisDigest)
  );
}

export function validateWorkspaceTrustBinding(value: unknown): WorkspaceContractValidation {
  try {
    return isWorkspaceTrustBinding(value)
      ? workspaceContractValid()
      : workspaceContractInvalid("workspace trust binding invalid");
  } catch {
    return workspaceContractInvalid("workspace trust binding invalid");
  }
}

function trustReasonMatchesLevel(
  level: WorkspaceTrustLevel,
  reason: WorkspaceTrustReason,
): boolean {
  return level === "trusted" ? reason === "human-grant" : reason !== "human-grant";
}

function isWorkspaceTrustLevel(value: unknown): value is WorkspaceTrustLevel {
  return WORKSPACE_TRUST_LEVELS.includes(value as WorkspaceTrustLevel);
}

function isWorkspaceTrustReason(value: unknown): value is WorkspaceTrustReason {
  return WORKSPACE_TRUST_REASONS.includes(value as WorkspaceTrustReason);
}

/**
 * A trusted record requires a *determined* basis. `known` is a basis that was read, and `absent` is
 * a basis that was looked for and definitively is not there — for the package-script capability that
 * means the root has no scripts to execute at all. Both are determinate, and ADR-0147 D9 forbids
 * conflating `absent` with `unavailable`.
 *
 * `unknown` and `unavailable` mean the basis could not be determined and must never carry trust. A
 * basis that later changes outcome — a `package.json` appearing where there was none — no longer
 * matches the recorded fact, so the grant invalidates exactly as a content change does.
 */
function trustedBasisIsDetermined(
  level: WorkspaceTrustLevel,
  binding: WorkspaceTrustBinding,
): boolean {
  if (level !== "trusted") return true;
  const outcome = binding.trustBasisDigest.outcome;
  return outcome === "known" || outcome === "absent";
}

function isWorkspaceTrustRecord(value: unknown): value is WorkspaceTrustRecord {
  if (!isWorkspaceRecord(value) || !hasOnlyWorkspaceKeys(value, RECORD_KEYS)) return false;
  if (!isWorkspaceTrustBinding(value.binding)) return false;
  if (!isWorkspaceTrustLevel(value.trust) || !isWorkspaceTrustReason(value.reason)) {
    return false;
  }
  const fieldsValid = [
    value.kind === "workspace-trust",
    value.schemaVersion === WORKSPACE_TRUST_SCHEMA_VERSION,
    value.decidedBy === "server",
    isRevision(value.revision),
    typeof value.policyVersion === "string" && POLICY_VERSION_PATTERN.test(value.policyVersion),
  ].every(Boolean);
  return (
    fieldsValid &&
    trustReasonMatchesLevel(value.trust, value.reason) &&
    trustedBasisIsDetermined(value.trust, value.binding)
  );
}

export function validateWorkspaceTrustRecord(value: unknown): WorkspaceContractValidation {
  try {
    return isWorkspaceTrustRecord(value)
      ? workspaceContractValid()
      : workspaceContractInvalid("workspace trust record invalid");
  } catch {
    return workspaceContractInvalid("workspace trust record invalid");
  }
}

function isWorkspaceTrustStatusValue(value: unknown): value is WorkspaceTrustStatus {
  if (!isWorkspaceRecord(value) || !hasOnlyWorkspaceKeys(value, STATUS_KEYS)) return false;
  const projectIdValid =
    typeof value.projectId === "string" &&
    value.projectId.length > 0 &&
    value.projectId.length <= PROJECT_ID_MAX_CHARS &&
    !value.projectId.includes("\u0000");
  const fieldsValid = [
    value.kind === "workspace-trust-status",
    value.schemaVersion === WORKSPACE_TRUST_SCHEMA_VERSION,
    projectIdValid,
    isWorkspaceTrustLevel(value.trust),
    value.decidedBy === "server",
    isWorkspaceTrustReason(value.reason),
    value.revision === null || isRevision(value.revision),
  ].every(Boolean);
  return (
    fieldsValid &&
    isWorkspaceTrustLevel(value.trust) &&
    isWorkspaceTrustReason(value.reason) &&
    trustReasonMatchesLevel(value.trust, value.reason)
  );
}

export function isWorkspaceTrustStatus(value: unknown): value is WorkspaceTrustStatus {
  try {
    return isWorkspaceTrustStatusValue(value);
  } catch {
    return false;
  }
}

function factsMatch(
  left: WorkspaceFact<WorkspaceTrustBasisDigest>,
  right: WorkspaceFact<WorkspaceTrustBasisDigest>,
): boolean {
  if (left.outcome !== right.outcome) return false;
  return left.outcome !== "known" || (right.outcome === "known" && left.value === right.value);
}

/**
 * ADR-0155 narrows this comparison to the dimensions that describe the trusted root itself. The
 * manifest revision and digest are workspace-level and change on focus and reorder, which carry no
 * authority, so including them revoked every grant on an ordinary Explorer click. They are still
 * recorded on the binding as provenance.
 *
 * Everything the removed dimensions protected is still covered: a replaced directory changes
 * `rootIdentityDigest`, changed approved bytes change `trustBasisDigest`, a removed root has its
 * record deleted with the manifest revision, and a root moved to another workspace changes
 * `manifestRef`.
 */
function trustBindingsMatch(left: WorkspaceTrustBinding, right: WorkspaceTrustBinding): boolean {
  return (
    left.manifestRef === right.manifestRef &&
    left.rootRef === right.rootRef &&
    left.rootIdentityDigest === right.rootIdentityDigest &&
    factsMatch(left.trustBasisDigest, right.trustBasisDigest)
  );
}

function resolvesTrusted(
  assessment: WorkspaceTrustAssessment,
  expectedBinding: WorkspaceTrustBinding,
): boolean {
  if (!isWorkspaceTrustBinding(expectedBinding)) return false;
  if (!isWorkspaceFact(assessment, isWorkspaceTrustRecord) || assessment.outcome !== "known") {
    return false;
  }
  return (
    assessment.value.trust === "trusted" &&
    trustBindingsMatch(assessment.value.binding, expectedBinding)
  );
}

export function isWorkspaceRestrictedModeActive(
  assessment: WorkspaceTrustAssessment,
  expectedBinding: WorkspaceTrustBinding,
): boolean {
  return !resolvesTrusted(assessment, expectedBinding);
}

export function projectCommandTaskTrustState(
  assessment: WorkspaceTrustAssessment,
  expectedBinding: WorkspaceTrustBinding,
): CommandTaskTrustState {
  return resolvesTrusted(assessment, expectedBinding) ? "trusted" : "approval-required";
}

export function workspaceTrustPolicyEffect(
  assessment: WorkspaceTrustAssessment,
  expectedBinding: WorkspaceTrustBinding,
  operation: WorkspaceTrustOperationClass,
): CodingWorkbenchPolicyEffect {
  const level = resolvesTrusted(assessment, expectedBinding) ? "trusted" : "restricted";
  return workspaceTrustLevelPolicyEffect(level, operation);
}

// Projection adapter for server consumers that have already resolved the canonical effective level.
// Exact `trusted` is the only widening value; omission and malformed runtime values stay restricted.
export function workspaceTrustLevelPolicyEffect(
  level: WorkspaceTrustLevel | undefined,
  operation: WorkspaceTrustOperationClass,
): CodingWorkbenchPolicyEffect {
  if (level === "trusted" || operation === "read") return "allowed";
  return operation === "execute" ? "denied" : "approval-required";
}

export function strictestWorkspaceTrustPolicyEffect(
  existingEffect: CodingWorkbenchPolicyEffect,
  assessment: WorkspaceTrustAssessment,
  expectedBinding: WorkspaceTrustBinding,
  operation: WorkspaceTrustOperationClass,
): CodingWorkbenchPolicyEffect {
  return strictestCodingWorkbenchPolicyEffect(
    existingEffect,
    workspaceTrustPolicyEffect(assessment, expectedBinding, operation),
  );
}
