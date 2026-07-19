// Server-owned multi-root workspace manifest and explicit effectful-dispatch contracts.

import {
  WORKSPACE_CONTRACT_SCHEMA_VERSION,
  hasOnlyWorkspaceKeys,
  isCanonicalWorkspaceRoot,
  isWorkspaceFact,
  isWorkspaceManifestDigest,
  isWorkspaceManifestRef,
  isWorkspaceRecord,
  isWorkspaceRootIdentityDigest,
  isWorkspaceRootRef,
  isWorkspaceTrustBasisDigest,
  workspaceCanonicalRootsDoNotOverlap,
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

export const WORKSPACE_MANIFEST_SCHEMA_VERSION = WORKSPACE_CONTRACT_SCHEMA_VERSION;
export const WORKSPACE_MANIFEST_MAX_ROOTS = 32 as const;
export const WORKSPACE_ROOT_DISPLAY_NAME_MAX_CHARS = 120 as const;

export interface WorkspaceRootDescriptor {
  readonly rootRef: WorkspaceRootRef;
  /** Server-private canonical path. Never profile- or evidence-safe. */
  readonly canonicalRoot: string;
  readonly displayName: string;
  readonly identityDigest: WorkspaceRootIdentityDigest;
  readonly sourceDigest: WorkspaceFact<WorkspaceTrustBasisDigest>;
}

export interface WorkspaceManifest {
  readonly kind: "workspace-manifest";
  readonly schemaVersion: typeof WORKSPACE_MANIFEST_SCHEMA_VERSION;
  readonly manifestRef: WorkspaceManifestRef;
  readonly manifestDigest: WorkspaceManifestDigest;
  readonly workspaceId: string;
  readonly revision: number;
  readonly roots: readonly WorkspaceRootDescriptor[];
  readonly focusedRootRef: WorkspaceRootRef;
}

export type WorkspaceRootDispatchOperationClass = "mutating" | "executing";

export interface WorkspaceRootDispatch {
  readonly kind: "workspace-root-dispatch";
  readonly schemaVersion: typeof WORKSPACE_MANIFEST_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly manifestRef: WorkspaceManifestRef;
  readonly manifestRevision: number;
  readonly manifestDigest: WorkspaceManifestDigest;
  readonly rootRef: WorkspaceRootRef;
  readonly rootIdentityDigest: WorkspaceRootIdentityDigest;
  readonly operationClass: WorkspaceRootDispatchOperationClass;
}

const ROOT_KEYS = [
  "rootRef",
  "canonicalRoot",
  "displayName",
  "identityDigest",
  "sourceDigest",
] as const;
const MANIFEST_KEYS = [
  "kind",
  "schemaVersion",
  "manifestRef",
  "manifestDigest",
  "workspaceId",
  "revision",
  "roots",
  "focusedRootRef",
] as const;
const DISPATCH_KEYS = [
  "kind",
  "schemaVersion",
  "workspaceId",
  "manifestRef",
  "manifestRevision",
  "manifestDigest",
  "rootRef",
  "rootIdentityDigest",
  "operationClass",
] as const;

function isNonNegativeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isSafeDisplayName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return (
    value.length > 0 &&
    value.length <= WORKSPACE_ROOT_DISPLAY_NAME_MAX_CHARS &&
    !hasControlCharacter(value)
  );
}

function isWorkspaceRootDescriptor(value: unknown): value is WorkspaceRootDescriptor {
  return (
    isWorkspaceRecord(value) &&
    hasOnlyWorkspaceKeys(value, ROOT_KEYS) &&
    isWorkspaceRootRef(value.rootRef) &&
    isCanonicalWorkspaceRoot(value.canonicalRoot) &&
    isSafeDisplayName(value.displayName) &&
    isWorkspaceRootIdentityDigest(value.identityDigest) &&
    isWorkspaceFact(value.sourceDigest, isWorkspaceTrustBasisDigest)
  );
}

function hasUniqueRootDimensions(roots: readonly WorkspaceRootDescriptor[]): boolean {
  const refs = new Set(roots.map((root): WorkspaceRootRef => root.rootRef));
  const paths = new Set(roots.map((root): string => root.canonicalRoot));
  const identities = new Set(roots.map((root): WorkspaceRootIdentityDigest => root.identityDigest));
  return (
    refs.size === roots.length && paths.size === roots.length && identities.size === roots.length
  );
}

function rootsDoNotOverlap(roots: readonly WorkspaceRootDescriptor[]): boolean {
  return workspaceCanonicalRootsDoNotOverlap(roots.map((root): string => root.canonicalRoot));
}

function rootsAreValid(value: unknown): value is readonly WorkspaceRootDescriptor[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= WORKSPACE_MANIFEST_MAX_ROOTS &&
    value.every(isWorkspaceRootDescriptor) &&
    hasUniqueRootDimensions(value) &&
    rootsDoNotOverlap(value)
  );
}

function isWorkspaceManifest(value: unknown): value is WorkspaceManifest {
  if (!isWorkspaceRecord(value) || !hasOnlyWorkspaceKeys(value, MANIFEST_KEYS)) return false;
  const fieldsValid = [
    value.kind === "workspace-manifest",
    value.schemaVersion === WORKSPACE_MANIFEST_SCHEMA_VERSION,
    isWorkspaceManifestRef(value.manifestRef),
    isWorkspaceManifestDigest(value.manifestDigest),
    typeof value.workspaceId === "string" && value.workspaceId.length > 0,
    isNonNegativeRevision(value.revision),
    rootsAreValid(value.roots),
    isWorkspaceRootRef(value.focusedRootRef),
  ].every(Boolean);
  if (!fieldsValid || !rootsAreValid(value.roots) || !isWorkspaceRootRef(value.focusedRootRef)) {
    return false;
  }
  return value.roots.some((root): boolean => root.rootRef === value.focusedRootRef);
}

export function validateWorkspaceManifest(value: unknown): WorkspaceContractValidation {
  try {
    return isWorkspaceManifest(value)
      ? workspaceContractValid()
      : workspaceContractInvalid("workspace manifest invalid");
  } catch {
    return workspaceContractInvalid("workspace manifest invalid");
  }
}

function isWorkspaceRootDispatch(value: unknown): value is WorkspaceRootDispatch {
  if (!isWorkspaceRecord(value) || !hasOnlyWorkspaceKeys(value, DISPATCH_KEYS)) return false;
  return [
    value.kind === "workspace-root-dispatch",
    value.schemaVersion === WORKSPACE_MANIFEST_SCHEMA_VERSION,
    typeof value.workspaceId === "string" && value.workspaceId.length > 0,
    isWorkspaceManifestRef(value.manifestRef),
    isNonNegativeRevision(value.manifestRevision),
    isWorkspaceManifestDigest(value.manifestDigest),
    isWorkspaceRootRef(value.rootRef),
    isWorkspaceRootIdentityDigest(value.rootIdentityDigest),
    value.operationClass === "mutating" || value.operationClass === "executing",
  ].every(Boolean);
}

export function validateWorkspaceRootDispatch(value: unknown): WorkspaceContractValidation {
  try {
    return isWorkspaceRootDispatch(value)
      ? workspaceContractValid()
      : workspaceContractInvalid("workspace root dispatch invalid");
  } catch {
    return workspaceContractInvalid("workspace root dispatch invalid");
  }
}
