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
  WorkspaceContractValidationFail,
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

/**
 * The launcher-pairing markers the workspaces read may ASSERT on the wire (ADR-0141). The server is
 * the sole producer and asserts one of them on every outcome; a client never sends one.
 */
export const WORKSPACE_MANIFEST_SESSION_ASSERTIONS = ["paired", "unpaired"] as const;

export type WorkspaceManifestSessionAssertion =
  (typeof WORKSPACE_MANIFEST_SESSION_ASSERTIONS)[number];

/**
 * The pairing marker a client resolves the workspaces read to.
 *
 * `"unknown"` is not a server state: it is what a client resolves to when the response carries no
 * marker at all. Pairing is an authority input (an unpaired window's run start is guaranteed to fail
 * authority resolution, ADR-0141), so it may never be inferred from silence — a caller that gates on
 * a pairing must require the explicit `"paired"` assertion and treat `"unknown"` as not-granted.
 */
export type WorkspaceManifestSessionPairing = WorkspaceManifestSessionAssertion | "unknown";

/**
 * The exact body the workspaces read serializes. The marker is part of the shape, so a paired list
 * cannot be produced without asserting it.
 */
export interface WorkspaceManifestAccessResponse {
  readonly session: WorkspaceManifestSessionAssertion;
  readonly manifests: readonly WorkspaceManifest[];
}

/** What a client resolves a workspaces read to; `session` may additionally be `"unknown"`. */
export interface WorkspaceManifestAccess {
  readonly session: WorkspaceManifestSessionPairing;
  readonly manifests: readonly WorkspaceManifest[];
}

export interface WorkspaceManifestAccessParsed {
  readonly ok: true;
  readonly access: WorkspaceManifestAccess;
}

export type WorkspaceManifestAccessParse =
  WorkspaceManifestAccessParsed | WorkspaceContractValidationFail;

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
    const code = value.codePointAt(index) ?? 0;
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

/**
 * The single producer of the workspaces read body. The server builds every outcome through it, so the
 * pairing marker cannot be omitted from a response and cannot drift from what clients parse.
 */
export function workspaceManifestAccessResponse(
  session: WorkspaceManifestSessionAssertion,
  manifests: readonly WorkspaceManifest[],
): WorkspaceManifestAccessResponse {
  return { session, manifests };
}

function invalidWorkspaceManifestAccess(): WorkspaceContractValidationFail {
  return workspaceContractInvalid("workspace manifest access invalid");
}

function isWorkspaceManifestSessionAssertion(
  value: unknown,
): value is WorkspaceManifestSessionAssertion {
  return (
    typeof value === "string" &&
    (WORKSPACE_MANIFEST_SESSION_ASSERTIONS as readonly string[]).includes(value)
  );
}

// A present marker must be one of the server assertions; an absent one is NOT read as a pairing.
// Coercing silence into "paired" lets a response the server never marked claim a pairing, which
// fails open for every caller that gates an authority decision on it.
function accessSessionPairing(marker: unknown): WorkspaceManifestSessionPairing | undefined {
  if (marker === undefined) return "unknown";
  return isWorkspaceManifestSessionAssertion(marker) ? marker : undefined;
}

function isValidWorkspaceManifest(value: unknown): value is WorkspaceManifest {
  return validateWorkspaceManifest(value).ok;
}

function areWorkspaceManifests(value: unknown): value is readonly WorkspaceManifest[] {
  return Array.isArray(value) && value.every(isValidWorkspaceManifest);
}

function parseAccess(value: unknown): WorkspaceManifestAccessParse {
  if (!isWorkspaceRecord(value)) return invalidWorkspaceManifestAccess();
  const session = accessSessionPairing(value.session);
  const manifests = value.manifests;
  if (session === undefined || !areWorkspaceManifests(manifests)) {
    return invalidWorkspaceManifestAccess();
  }
  // An unpaired read discloses nothing, so a response asserting `unpaired` can never arrive with
  // manifests attached; it is rejected outright rather than partially trusted.
  if (session === "unpaired" && manifests.length > 0) return invalidWorkspaceManifestAccess();
  return { ok: true, access: { session, manifests } };
}

/**
 * The single fail-closed reader of the workspaces read body, shared by every client so the marker is
 * resolved identically everywhere. Never throws: a hostile or malformed response is rejected.
 */
export function parseWorkspaceManifestAccess(value: unknown): WorkspaceManifestAccessParse {
  try {
    return parseAccess(value);
  } catch {
    return invalidWorkspaceManifestAccess();
  }
}
