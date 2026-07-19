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
const POLICY_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{2,95}$/u;

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

function trustedBasisIsKnown(level: WorkspaceTrustLevel, binding: WorkspaceTrustBinding): boolean {
  return level !== "trusted" || binding.trustBasisDigest.outcome === "known";
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
    trustedBasisIsKnown(value.trust, value.binding)
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

function factsMatch(
  left: WorkspaceFact<WorkspaceTrustBasisDigest>,
  right: WorkspaceFact<WorkspaceTrustBasisDigest>,
): boolean {
  if (left.outcome !== right.outcome) return false;
  return left.outcome !== "known" || (right.outcome === "known" && left.value === right.value);
}

function trustBindingsMatch(left: WorkspaceTrustBinding, right: WorkspaceTrustBinding): boolean {
  return (
    left.manifestRef === right.manifestRef &&
    left.manifestRevision === right.manifestRevision &&
    left.manifestDigest === right.manifestDigest &&
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
