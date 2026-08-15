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
// workspace-trust.ts's policyVersion field is a free-standing version string, not an opaque
// reference, but the two happen to share the exact same syntax rule today (KEIKO-0162:
// workspace-trust.ts used to carry its own character-for-character copy of this pattern under a
// different name). A distinct RegExp literal, not an alias to OPAQUE_REF_PATTERN: this is a
// clarity choice, not a mutation-safety one -- neither pattern carries the `g`/`y` flag, so
// `.test()` never reads or writes `.lastIndex` on either object (KfQ thread 3788742105 raised a
// shared-mutable-lastIndex concern that does not apply here, confirmed by checking the flags and
// every call site). The two literals exist separately so a future change to either rule is a
// one-line diff at its own definition, not an implicit change to the object the other rule also
// happens to reference.
export const WORKSPACE_POLICY_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{2,95}$/u;
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

// ─── Revision numbers and control-character text (KEIKO-0162) ─────────────────────
// Shared by workspace-manifest.ts, workspace-profile.ts, and workspace-trust.ts, each of which used
// to carry its own byte-identical copy of both checks: the revision guard under two different names
// (isNonNegativeRevision, isRevision) and the control-character guard twice verbatim.

export function isWorkspaceRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function hasWorkspaceControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
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

// Overlap comparison folds case on both POSIX and Windows (#2615). macOS APFS/HFS+ and
// case-insensitive Linux mounts open one filesystem directory under many case variants; without
// case folding here, a hostile or accidentally-typed manifest can list `[/Users/Alice/proj,
// /users/alice/proj]` and split trust bindings across a single directory. Case-sensitive Linux
// paths that legitimately differ only in case are exceedingly rare and lose nothing by being
// rejected as overlapping — the failure closes trust rather than widening it.
function normalizedCanonicalWorkspaceRoot(value: string): string {
  return value.toLowerCase();
}

function canonicalWorkspaceRootBodySegmentIsValid(
  segment: string,
  style: CanonicalWorkspaceRootStyle,
): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  // Win32 opens a path by stripping trailing dots and spaces from each
  // segment: `C:\work\app` and `C:\work\app.\child` (segment `app.`) resolve
  // to the same filesystem directory but pass a string-prefix overlap check
  // as distinct. Fail closed so `workspaceCanonicalRootsDoNotOverlap` cannot
  // admit a hostile manifest that splits trust bindings on one dir.
  if (style === "windows") {
    const last = segment.codePointAt(segment.length - 1);
    if (last === 0x2e /* . */ || last === 0x20 /* space */) return false;
  }
  return true;
}

function canonicalWorkspaceRootBodyIsValid(
  value: string,
  style: CanonicalWorkspaceRootStyle,
): boolean {
  const separator = canonicalWorkspaceRootSeparator(style);
  const bodySegments = value.split(separator).slice(1);
  if (bodySegments.length === 1 && bodySegments[0] === "") return true;
  return bodySegments.every((segment): boolean =>
    canonicalWorkspaceRootBodySegmentIsValid(segment, style),
  );
}

export function isCanonicalWorkspaceRoot(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (value.includes("\0")) return false;
  const style = canonicalWorkspaceRootStyle(value);
  if (style === undefined) return false;
  return canonicalWorkspaceRootBodyIsValid(value, style);
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
  const normalizedParent = normalizedCanonicalWorkspaceRoot(parent);
  const normalizedCandidate = normalizedCanonicalWorkspaceRoot(candidate);
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
