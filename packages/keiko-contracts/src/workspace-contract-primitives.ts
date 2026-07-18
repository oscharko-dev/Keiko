// Shared pure primitives for the M11 workspace contracts (Issue #2520). Runtime values remain
// ordinary JSON strings; brands become available only after these total validators accept them.

export const WORKSPACE_CONTRACT_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_OPAQUE_REF_MAX_CHARS = 96 as const;
export const WORKSPACE_PORTABLE_PATH_MAX_BYTES = 4096 as const;

declare const workspaceContractBrand: unique symbol;

export type WorkspaceBranded<Name extends string> = string & {
  readonly [workspaceContractBrand]: Name;
};

export type WorkspaceRootRef = WorkspaceBranded<"WorkspaceRootRef">;
export type WorkspaceManifestRef = WorkspaceBranded<"WorkspaceManifestRef">;
export type WorkspaceProfileRef = WorkspaceBranded<"WorkspaceProfileRef">;
export type WorkspaceHistoryEntryRef = WorkspaceBranded<"WorkspaceHistoryEntryRef">;
export type WorkspaceVaultEntryRef = WorkspaceBranded<"WorkspaceVaultEntryRef">;
export type WorkspaceRootIdentityDigest = WorkspaceBranded<"WorkspaceRootIdentityDigest">;
export type WorkspaceManifestDigest = WorkspaceBranded<"WorkspaceManifestDigest">;
export type WorkspaceTrustBasisDigest = WorkspaceBranded<"WorkspaceTrustBasisDigest">;
export type WorkspaceContentDigest = WorkspaceBranded<"WorkspaceContentDigest">;
export type WorkspacePathDigest = WorkspaceBranded<"WorkspacePathDigest">;
export type WorkspaceIsoInstant = WorkspaceBranded<"WorkspaceIsoInstant">;

export type WorkspaceFact<Value> =
  | { readonly outcome: "known"; readonly value: Value }
  | { readonly outcome: "unknown" }
  | { readonly outcome: "unavailable" }
  | { readonly outcome: "absent" };

export interface WorkspaceContractValidationOk {
  readonly ok: true;
}

export interface WorkspaceContractValidationFail {
  readonly ok: false;
  readonly reasons: readonly string[];
}

export type WorkspaceContractValidation =
  WorkspaceContractValidationOk | WorkspaceContractValidationFail;

type UnknownRecord = Readonly<Record<string, unknown>>;

const OPAQUE_REF_PATTERN = /^[a-z0-9][a-z0-9._-]{2,95}$/u;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const NON_KNOWN_FACT_OUTCOMES = ["unknown", "unavailable", "absent"] as const;

export function workspaceContractValid(): WorkspaceContractValidationOk {
  return { ok: true };
}

export function workspaceContractInvalid(reason: string): WorkspaceContractValidationFail {
  return { ok: false, reasons: [reason] };
}

export function isWorkspaceRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyWorkspaceKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  try {
    return Object.keys(value).every((key): boolean => allowed.includes(key));
  } catch {
    return false;
  }
}

function isOpaqueRef(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_REF_PATTERN.test(value);
}

export function isWorkspaceRootRef(value: unknown): value is WorkspaceRootRef {
  return isOpaqueRef(value);
}

export function isWorkspaceManifestRef(value: unknown): value is WorkspaceManifestRef {
  return isOpaqueRef(value);
}

export function isWorkspaceProfileRef(value: unknown): value is WorkspaceProfileRef {
  return isOpaqueRef(value);
}

export function isWorkspaceHistoryEntryRef(value: unknown): value is WorkspaceHistoryEntryRef {
  return isOpaqueRef(value);
}

export function isWorkspaceVaultEntryRef(value: unknown): value is WorkspaceVaultEntryRef {
  return isOpaqueRef(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA_256_PATTERN.test(value);
}

export function isWorkspaceRootIdentityDigest(
  value: unknown,
): value is WorkspaceRootIdentityDigest {
  return isSha256(value);
}

export function isWorkspaceManifestDigest(value: unknown): value is WorkspaceManifestDigest {
  return isSha256(value);
}

export function isWorkspaceTrustBasisDigest(value: unknown): value is WorkspaceTrustBasisDigest {
  return isSha256(value);
}

export function isWorkspaceContentDigest(value: unknown): value is WorkspaceContentDigest {
  return isSha256(value);
}

export function isWorkspacePathDigest(value: unknown): value is WorkspacePathDigest {
  return isSha256(value);
}

export function isWorkspaceIsoInstant(value: unknown): value is WorkspaceIsoInstant {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return !Number.isNaN(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isWorkspaceFactUnsafe<Value>(
  value: unknown,
  valueGuard: (candidate: unknown) => candidate is Value,
): value is WorkspaceFact<Value> {
  if (!isWorkspaceRecord(value) || typeof value.outcome !== "string") return false;
  if (value.outcome === "known") {
    return hasOnlyWorkspaceKeys(value, ["outcome", "value"]) && valueGuard(value.value);
  }
  return (
    NON_KNOWN_FACT_OUTCOMES.includes(value.outcome as (typeof NON_KNOWN_FACT_OUTCOMES)[number]) &&
    hasOnlyWorkspaceKeys(value, ["outcome"])
  );
}

export function isWorkspaceFact<Value>(
  value: unknown,
  valueGuard: (candidate: unknown) => candidate is Value,
): value is WorkspaceFact<Value> {
  try {
    return isWorkspaceFactUnsafe(value, valueGuard);
  } catch {
    return false;
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const point = value.codePointAt(index) ?? 0;
    if (point <= 0x7f) bytes += 1;
    else if (point <= 0x7ff) bytes += 2;
    else if (point > 0xffff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

type CanonicalWorkspaceRootStyle = "posix" | "windows";

function canonicalWorkspaceRootStyle(value: string): CanonicalWorkspaceRootStyle | undefined {
  if (value.startsWith("/")) return value.includes("\\") ? undefined : "posix";
  if (/^[A-Za-z]:\\/u.test(value)) return value.includes("/") ? undefined : "windows";
  return undefined;
}

function canonicalWorkspaceRootSeparator(style: CanonicalWorkspaceRootStyle): "/" | "\\" {
  return style === "posix" ? "/" : "\\";
}

function normalizedCanonicalWorkspaceRoot(
  value: string,
  style: CanonicalWorkspaceRootStyle,
): string {
  return style === "windows" ? value.toLowerCase() : value;
}

export function isCanonicalWorkspaceRoot(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (value.includes("\0")) return false;
  const style = canonicalWorkspaceRootStyle(value);
  if (style === undefined) return false;
  const separator = canonicalWorkspaceRootSeparator(style);
  return !value.split(separator).some((segment): boolean => segment === "." || segment === "..");
}

export function isPortableWorkspaceRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (utf8ByteLength(value) > WORKSPACE_PORTABLE_PATH_MAX_BYTES) return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  if (/^[A-Za-z]:/u.test(value) || value.startsWith("~")) return false;
  return !value
    .split("/")
    .some((segment): boolean => segment === "" || segment === "." || segment === "..");
}

function canonicalRootContains(parent: string, candidate: string): boolean {
  const parentStyle = canonicalWorkspaceRootStyle(parent);
  const candidateStyle = canonicalWorkspaceRootStyle(candidate);
  if (parentStyle === undefined || candidateStyle === undefined || parentStyle !== candidateStyle) {
    return false;
  }
  const separator = canonicalWorkspaceRootSeparator(parentStyle);
  const normalizedParent = normalizedCanonicalWorkspaceRoot(parent, parentStyle);
  const normalizedCandidate = normalizedCanonicalWorkspaceRoot(candidate, candidateStyle);
  const prefix = normalizedParent.endsWith(separator)
    ? normalizedParent
    : `${normalizedParent}${separator}`;
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(prefix);
}

export function workspaceCanonicalRootsDoNotOverlap(roots: readonly string[]): boolean {
  if (!roots.every((root): boolean => isCanonicalWorkspaceRoot(root))) return false;
  return roots.every((root, index): boolean =>
    roots.every(
      (candidate, candidateIndex): boolean =>
        index === candidateIndex ||
        (!canonicalRootContains(root, candidate) && !canonicalRootContains(candidate, root)),
    ),
  );
}
