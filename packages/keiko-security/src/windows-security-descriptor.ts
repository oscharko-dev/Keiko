// Owner-private policy for a Windows self-relative SECURITY_DESCRIPTOR.
//
// This module is the single owner of the "is this object private to the current principal?"
// decision on Windows. The PowerShell collector only gathers facts — the descriptor bytes from
// FileSecurity.GetSecurityDescriptorBinaryForm() and the process token's user and default-owner
// SIDs — and never renders a verdict itself, so the policy cannot drift between a script string and
// TypeScript. The module is pure (no Node or OS imports) so the whole decision is exercised on every
// CI platform, Linux included.
//
// The policy mirrors keiko_coordinator_windows_owner_private and
// keiko_coordinator_windows_directory_private in
// native/portable-launcher/keiko-portable-update-coordinator-windows.h (lines 155-264): the owner
// must be the token user, or SYSTEM/Administrators only when that SID is also the token's default
// owner (an elevated process); inherit-only ACEs are skipped; any allow ACE that grants a write
// right to a SID other than the token user, SYSTEM, or Administrators refuses. Deliberate
// differences, all stricter (fail closed): an ACE type the parser does not recognise is refused as
// "unsupported-ace" instead of being skipped, a NULL DACL is reported explicitly, every offset and
// size is bounds-checked so a hostile descriptor is "malformed-descriptor" rather than undefined
// behaviour, and no broad group (Authenticated Users, Users, Everyone, CREATOR OWNER) is a trusted
// writer.

export type WindowsOwnerPrivateRefusal =
  "malformed-descriptor" | "foreign-owner" | "null-dacl" | "foreign-write" | "unsupported-ace";

export type WindowsDescriptorVerdict =
  | { readonly kind: "owner-private" }
  | { readonly kind: "refused"; readonly reason: WindowsOwnerPrivateRefusal };

export interface WindowsDescriptorPrincipal {
  /** The process token's user SID, e.g. "S-1-5-21-...-1001". */
  readonly userSid: string;
  /** The process token's default owner SID: the user, or S-1-5-32-544 when the process is elevated. */
  readonly tokenOwnerSid: string;
}

const FILE_WRITE_DATA = 0x00000002; // also FILE_ADD_FILE
const FILE_APPEND_DATA = 0x00000004; // also FILE_ADD_SUBDIRECTORY
const FILE_WRITE_EA = 0x00000010;
const FILE_DELETE_CHILD = 0x00000040;
const FILE_WRITE_ATTRIBUTES = 0x00000100;
const DELETE = 0x00010000;
const WRITE_DAC = 0x00040000;
const WRITE_OWNER = 0x00080000;
const MAXIMUM_ALLOWED = 0x02000000;
const GENERIC_ALL = 0x10000000;
const GENERIC_WRITE = 0x40000000;

/**
 * Every access right that lets a principal change the object's data, attributes, name, DACL, or
 * owner. Matches the native coordinator's write_mask (FILE_ADD_FILE and FILE_ADD_SUBDIRECTORY share
 * the FILE_WRITE_DATA and FILE_APPEND_DATA bits) plus MAXIMUM_ALLOWED.
 */
export const WINDOWS_WRITE_ACCESS_MASK =
  FILE_WRITE_DATA |
  FILE_APPEND_DATA |
  FILE_WRITE_EA |
  FILE_DELETE_CHILD |
  FILE_WRITE_ATTRIBUTES |
  DELETE |
  WRITE_DAC |
  WRITE_OWNER |
  MAXIMUM_ALLOWED |
  GENERIC_ALL |
  GENERIC_WRITE;

const LOCAL_SYSTEM_SID = "S-1-5-18";
const BUILTIN_ADMINISTRATORS_SID = "S-1-5-32-544";
const ELEVATED_OWNER_SIDS: ReadonlySet<string> = new Set([
  LOCAL_SYSTEM_SID,
  BUILTIN_ADMINISTRATORS_SID,
]);

const SECURITY_DESCRIPTOR_REVISION = 1;
const SECURITY_DESCRIPTOR_HEADER_LENGTH = 20;
const SE_DACL_PRESENT = 0x0004;
const SE_SELF_RELATIVE = 0x8000;

const SID_REVISION = 1;
const SID_MAX_SUB_AUTHORITIES = 15;
const SID_FIXED_LENGTH = 8;
const SID_AUTHORITY_DECIMAL_LIMIT = 0x100000000;

const ACL_HEADER_LENGTH = 8;
const ACL_REVISIONS: ReadonlySet<number> = new Set([2, 4]);
const ACE_HEADER_LENGTH = 4;
const ACE_MIN_LENGTH = 8;
const INHERIT_ONLY_ACE = 0x08;

const ACCESS_ALLOWED_TYPES: ReadonlySet<number> = new Set([0x00, 0x09]);
const ACCESS_ALLOWED_OBJECT_TYPES: ReadonlySet<number> = new Set([0x05, 0x0b]);
const ACCESS_DENIED_TYPES: ReadonlySet<number> = new Set([0x01, 0x06, 0x0a, 0x0c]);
const ACE_OBJECT_TYPE_PRESENT = 0x1;
const ACE_INHERITED_OBJECT_TYPE_PRESENT = 0x2;
const GUID_LENGTH = 16;

type ParsedAce =
  | {
      readonly kind: "allow";
      readonly inheritOnly: boolean;
      readonly mask: number;
      readonly sid: string;
    }
  | { readonly kind: "deny"; readonly inheritOnly: boolean }
  | { readonly kind: "unsupported"; readonly inheritOnly: boolean };

interface ParsedDescriptor {
  readonly owner: string;
  /** `null` is a NULL DACL: absent, or SE_DACL_PRESENT without a DACL offset. */
  readonly dacl: readonly ParsedAce[] | null;
}

interface DescriptorLayout {
  readonly control: number;
  readonly ownerOffset: number;
  readonly groupOffset: number;
  readonly saclOffset: number;
  readonly daclOffset: number;
}

const OWNER_PRIVATE: WindowsDescriptorVerdict = Object.freeze({ kind: "owner-private" });

function refused(reason: WindowsOwnerPrivateRefusal): WindowsDescriptorVerdict {
  return { kind: "refused", reason };
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function formatAuthority(authority: number): string {
  if (authority < SID_AUTHORITY_DECIMAL_LIMIT) return String(authority);
  return `0x${authority.toString(16).toUpperCase().padStart(12, "0")}`;
}

/**
 * Parses a binary SID at `offset`, bounded by the end of `bytes`. Returns the canonical string form
 * (as ConvertSidToStringSid renders it) and the SID's byte length, or `undefined` when the bytes do
 * not hold a valid revision-1 SID with at most 15 sub-authorities. Never throws.
 */
export function parseSidBytes(
  bytes: Uint8Array,
  offset: number,
): { sid: string; length: number } | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
  if (offset + SID_FIXED_LENGTH > bytes.length) return undefined;
  const view = viewOf(bytes);
  const subAuthorityCount = view.getUint8(offset + 1);
  if (view.getUint8(offset) !== SID_REVISION || subAuthorityCount > SID_MAX_SUB_AUTHORITIES) {
    return undefined;
  }
  const length = SID_FIXED_LENGTH + 4 * subAuthorityCount;
  if (offset + length > bytes.length) return undefined;
  let authority = 0;
  for (let index = 2; index < SID_FIXED_LENGTH; index += 1) {
    authority = authority * 256 + view.getUint8(offset + index);
  }
  const parts = ["S", String(SID_REVISION), formatAuthority(authority)];
  for (let index = 0; index < subAuthorityCount; index += 1) {
    parts.push(String(view.getUint32(offset + SID_FIXED_LENGTH + 4 * index, true)));
  }
  return { sid: parts.join("-"), length };
}

function readLayout(bytes: Uint8Array): DescriptorLayout | undefined {
  if (bytes.length < SECURITY_DESCRIPTOR_HEADER_LENGTH) return undefined;
  const view = viewOf(bytes);
  const control = view.getUint16(2, true);
  if (view.getUint8(0) !== SECURITY_DESCRIPTOR_REVISION) return undefined;
  if ((control & SE_SELF_RELATIVE) === 0) return undefined;
  return {
    control,
    ownerOffset: view.getUint32(4, true),
    groupOffset: view.getUint32(8, true),
    saclOffset: view.getUint32(12, true),
    daclOffset: view.getUint32(16, true),
  };
}

function isBodyOffset(offset: number, length: number): boolean {
  return offset === 0 || (offset >= SECURITY_DESCRIPTOR_HEADER_LENGTH && offset < length);
}

function parseAllowedAce(
  ace: Uint8Array,
  inheritOnly: boolean,
  sidOffset: number,
): ParsedAce | undefined {
  const sid = parseSidBytes(ace, sidOffset);
  if (sid === undefined) return undefined;
  return {
    kind: "allow",
    inheritOnly,
    mask: viewOf(ace).getUint32(ACE_HEADER_LENGTH, true),
    sid: sid.sid,
  };
}

function parseObjectAllowedAce(ace: Uint8Array, inheritOnly: boolean): ParsedAce | undefined {
  const flagsOffset = ACE_HEADER_LENGTH + 4;
  if (flagsOffset + 4 > ace.length) return undefined;
  const flags = viewOf(ace).getUint32(flagsOffset, true);
  const known = ACE_OBJECT_TYPE_PRESENT | ACE_INHERITED_OBJECT_TYPE_PRESENT;
  if ((flags & ~known) !== 0) return undefined;
  let sidOffset = flagsOffset + 4;
  if ((flags & ACE_OBJECT_TYPE_PRESENT) !== 0) sidOffset += GUID_LENGTH;
  if ((flags & ACE_INHERITED_OBJECT_TYPE_PRESENT) !== 0) sidOffset += GUID_LENGTH;
  return parseAllowedAce(ace, inheritOnly, sidOffset);
}

function classifyAce(type: number, flags: number, ace: Uint8Array): ParsedAce | undefined {
  const inheritOnly = (flags & INHERIT_ONLY_ACE) !== 0;
  if (ACCESS_DENIED_TYPES.has(type)) return { kind: "deny", inheritOnly };
  if (ACCESS_ALLOWED_TYPES.has(type)) {
    return parseAllowedAce(ace, inheritOnly, ACE_HEADER_LENGTH + 4);
  }
  if (ACCESS_ALLOWED_OBJECT_TYPES.has(type)) return parseObjectAllowedAce(ace, inheritOnly);
  return { kind: "unsupported", inheritOnly };
}

function readAce(
  acl: Uint8Array,
  cursor: number,
): { readonly entry: ParsedAce; readonly size: number } | undefined {
  if (cursor + ACE_HEADER_LENGTH > acl.length) return undefined;
  const view = viewOf(acl);
  const size = view.getUint16(cursor + 2, true);
  if (size < ACE_MIN_LENGTH || size % 4 !== 0 || cursor + size > acl.length) return undefined;
  const entry = classifyAce(
    view.getUint8(cursor),
    view.getUint8(cursor + 1),
    acl.subarray(cursor, cursor + size),
  );
  return entry === undefined ? undefined : { entry, size };
}

function parseAcl(bytes: Uint8Array, offset: number): readonly ParsedAce[] | undefined {
  if (offset + ACL_HEADER_LENGTH > bytes.length) return undefined;
  const view = viewOf(bytes);
  const aclSize = view.getUint16(offset + 2, true);
  const aceCount = view.getUint16(offset + 4, true);
  if (!ACL_REVISIONS.has(view.getUint8(offset))) return undefined;
  if (aclSize < ACL_HEADER_LENGTH || offset + aclSize > bytes.length) return undefined;
  const acl = bytes.subarray(offset, offset + aclSize);
  const aces: ParsedAce[] = [];
  let cursor = ACL_HEADER_LENGTH;
  for (let index = 0; index < aceCount; index += 1) {
    const ace = readAce(acl, cursor);
    if (ace === undefined) return undefined;
    aces.push(ace.entry);
    cursor += ace.size;
  }
  return aces;
}

function layoutOffsetsInBounds(layout: DescriptorLayout, length: number): boolean {
  return [layout.ownerOffset, layout.groupOffset, layout.saclOffset, layout.daclOffset].every(
    (offset) => isBodyOffset(offset, length),
  );
}

/** The group and SACL are never evaluated (SACL ACEs are audit/label types), but are bounds-checked. */
function unevaluatedPartsWellFormed(bytes: Uint8Array, layout: DescriptorLayout): boolean {
  if (layout.groupOffset !== 0 && parseSidBytes(bytes, layout.groupOffset) === undefined) {
    return false;
  }
  return layout.saclOffset === 0 || isAclHeaderInBounds(bytes, layout.saclOffset);
}

function parseDescriptor(bytes: Uint8Array): ParsedDescriptor | undefined {
  const layout = readLayout(bytes);
  if (layout === undefined || !layoutOffsetsInBounds(layout, bytes.length)) return undefined;
  const owner = layout.ownerOffset === 0 ? undefined : parseSidBytes(bytes, layout.ownerOffset);
  if (owner === undefined || !unevaluatedPartsWellFormed(bytes, layout)) return undefined;
  const dacl = layout.daclOffset === 0 ? null : parseAcl(bytes, layout.daclOffset);
  if (dacl === undefined) return undefined;
  const daclPresent = (layout.control & SE_DACL_PRESENT) !== 0;
  return { owner: owner.sid, dacl: daclPresent ? dacl : null };
}

function isAclHeaderInBounds(bytes: Uint8Array, offset: number): boolean {
  if (offset + ACL_HEADER_LENGTH > bytes.length) return false;
  const view = viewOf(bytes);
  const aclSize = view.getUint16(offset + 2, true);
  return (
    ACL_REVISIONS.has(view.getUint8(offset)) &&
    aclSize >= ACL_HEADER_LENGTH &&
    offset + aclSize <= bytes.length
  );
}

function isAcceptedOwner(owner: string, principal: WindowsDescriptorPrincipal): boolean {
  if (owner === principal.userSid) return true;
  return ELEVATED_OWNER_SIDS.has(owner) && owner === principal.tokenOwnerSid;
}

function evaluateDacl(
  dacl: readonly ParsedAce[],
  principal: WindowsDescriptorPrincipal,
): WindowsOwnerPrivateRefusal | undefined {
  const trustedWriters = new Set([principal.userSid, LOCAL_SYSTEM_SID, BUILTIN_ADMINISTRATORS_SID]);
  for (const ace of dacl) {
    // An inherit-only ACE does not apply to this object; a deny ACE can only restrict access.
    if (ace.inheritOnly || ace.kind === "deny") continue;
    if (ace.kind === "unsupported") return "unsupported-ace";
    if ((ace.mask & WINDOWS_WRITE_ACCESS_MASK) !== 0 && !trustedWriters.has(ace.sid)) {
      return "foreign-write";
    }
  }
  return undefined;
}

/**
 * Decides whether a self-relative security descriptor makes its object private to `principal`.
 * Structural validation runs first, then the owner rule, then the DACL rules. Never throws: any
 * inconsistent offset, size, or SID is "malformed-descriptor".
 */
export function evaluateWindowsSecurityDescriptor(
  descriptor: Uint8Array,
  principal: WindowsDescriptorPrincipal,
): WindowsDescriptorVerdict {
  const parsed = parseDescriptor(descriptor);
  if (parsed === undefined) return refused("malformed-descriptor");
  if (!isAcceptedOwner(parsed.owner, principal)) return refused("foreign-owner");
  if (parsed.dacl === null) return refused("null-dacl");
  const refusal = evaluateDacl(parsed.dacl, principal);
  return refusal === undefined ? OWNER_PRIVATE : refused(refusal);
}
