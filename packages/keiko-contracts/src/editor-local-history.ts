// Metadata-only local-history contracts. Checkpoint bodies live in a dedicated encrypted vault and
// must self-bind to every identity field represented by EditorLocalHistoryEntry after decryption.

import {
  WORKSPACE_CONTRACT_SCHEMA_VERSION,
  hasOnlyWorkspaceKeys,
  isPortableWorkspaceRelativePath,
  isWorkspaceContentDigest,
  isWorkspaceFact,
  isWorkspaceHistoryEntryRef,
  isWorkspaceIsoInstant,
  isWorkspacePathDigest,
  isWorkspaceRecord,
  isWorkspaceRootIdentityDigest,
  isWorkspaceRootRef,
  isWorkspaceVaultEntryRef,
  workspaceContractInvalid,
  workspaceContractValid,
} from "./workspace-contract-primitives.js";
import type {
  WorkspaceContentDigest,
  WorkspaceContractValidation,
  WorkspaceFact,
  WorkspaceHistoryEntryRef,
  WorkspaceIsoInstant,
  WorkspacePathDigest,
  WorkspaceRootIdentityDigest,
  WorkspaceRootRef,
  WorkspaceVaultEntryRef,
} from "./workspace-contract-primitives.js";

export const EDITOR_LOCAL_HISTORY_SCHEMA_VERSION = WORKSPACE_CONTRACT_SCHEMA_VERSION;
export const EDITOR_LOCAL_HISTORY_ENCRYPTION = "aes-256-gcm-v1" as const;
export const EDITOR_LOCAL_HISTORY_MAX_ENTRIES = 512 as const;
export const EDITOR_LOCAL_HISTORY_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
export const EDITOR_LOCAL_HISTORY_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const EDITOR_LOCAL_HISTORY_MAX_PINNED_BYTES = 64 * 1024 * 1024;
export const EDITOR_LOCAL_HISTORY_MAX_VERSIONS_PER_FILE = 50 as const;
export const EDITOR_LOCAL_HISTORY_TTL_DAYS = 90 as const;

export type EditorLocalHistoryOrigin = "user-save" | "agent-apply" | "pre-restore";

export const EDITOR_LOCAL_HISTORY_ORIGINS: readonly EditorLocalHistoryOrigin[] = Object.freeze([
  "user-save",
  "agent-apply",
  "pre-restore",
] as const);

export interface EditorLocalHistoryEncryptedContentRef {
  readonly kind: "vault-reference";
  readonly vaultEntryRef: WorkspaceVaultEntryRef;
  readonly encryption: typeof EDITOR_LOCAL_HISTORY_ENCRYPTION;
}

export interface EditorLocalHistoryEntry {
  readonly kind: "local-history-entry";
  readonly schemaVersion: typeof EDITOR_LOCAL_HISTORY_SCHEMA_VERSION;
  readonly entryRef: WorkspaceHistoryEntryRef;
  readonly workspaceId: string;
  readonly rootRef: WorkspaceRootRef;
  readonly rootIdentityDigest: WorkspaceRootIdentityDigest;
  readonly relativePath: string;
  readonly relativePathDigest: WorkspacePathDigest;
  readonly predecessor: WorkspaceFact<WorkspaceHistoryEntryRef>;
  readonly sequence: number;
  readonly origin: EditorLocalHistoryOrigin;
  readonly recordedAt: WorkspaceIsoInstant;
  readonly lastAccessedAt: WorkspaceIsoInstant;
  readonly plaintextContentDigest: WorkspaceContentDigest;
  readonly plaintextByteLength: number;
  readonly payloadBindingDigest: WorkspaceContentDigest;
  readonly encryptedContent: EditorLocalHistoryEncryptedContentRef;
  readonly pinned: boolean;
  readonly pinnedAt: WorkspaceFact<WorkspaceIsoInstant>;
}

export interface EditorLocalHistoryIndex {
  readonly kind: "local-history-index";
  readonly schemaVersion: typeof EDITOR_LOCAL_HISTORY_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly revision: number;
  readonly maxEntries: typeof EDITOR_LOCAL_HISTORY_MAX_ENTRIES;
  readonly totalPlaintextBytes: number;
  readonly entries: readonly EditorLocalHistoryEntry[];
}

export interface EditorLocalHistoryRetentionRequirement {
  readonly requiredEntryCount: number;
  readonly requiredByteCount: number;
}

export type EditorLocalHistoryRetentionPlan =
  | { readonly ok: true; readonly entryRefs: readonly WorkspaceHistoryEntryRef[] }
  | {
      readonly ok: false;
      readonly entryRefs: readonly WorkspaceHistoryEntryRef[];
      readonly reason: "INVALID_REQUIREMENT" | "PINNED_CAPACITY_EXHAUSTED";
    };

const ENCRYPTED_REF_KEYS = ["kind", "vaultEntryRef", "encryption"] as const;
const ENTRY_KEYS = [
  "kind",
  "schemaVersion",
  "entryRef",
  "workspaceId",
  "rootRef",
  "rootIdentityDigest",
  "relativePath",
  "relativePathDigest",
  "predecessor",
  "sequence",
  "origin",
  "recordedAt",
  "lastAccessedAt",
  "plaintextContentDigest",
  "plaintextByteLength",
  "payloadBindingDigest",
  "encryptedContent",
  "pinned",
  "pinnedAt",
] as const;
const INDEX_KEYS = [
  "kind",
  "schemaVersion",
  "workspaceId",
  "revision",
  "maxEntries",
  "totalPlaintextBytes",
  "entries",
] as const;

type UnknownRecord = Readonly<Record<string, unknown>>;

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveBoundedInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}

function isNonNegativeBoundedInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isHistoryOrigin(value: unknown): value is EditorLocalHistoryOrigin {
  return EDITOR_LOCAL_HISTORY_ORIGINS.some((origin): boolean => origin === value);
}

function isEncryptedContentRef(value: unknown): value is EditorLocalHistoryEncryptedContentRef {
  return (
    isWorkspaceRecord(value) &&
    hasOnlyWorkspaceKeys(value, ENCRYPTED_REF_KEYS) &&
    value.kind === "vault-reference" &&
    isWorkspaceVaultEntryRef(value.vaultEntryRef) &&
    value.encryption === EDITOR_LOCAL_HISTORY_ENCRYPTION
  );
}

function pinMetadataMatches(
  pinned: boolean,
  pinnedAt: WorkspaceFact<WorkspaceIsoInstant>,
): boolean {
  return pinned ? pinnedAt.outcome === "known" : pinnedAt.outcome === "absent";
}

function historyEntryFieldsAreValid(value: UnknownRecord): boolean {
  return [
    value.kind === "local-history-entry",
    value.schemaVersion === EDITOR_LOCAL_HISTORY_SCHEMA_VERSION,
    isWorkspaceHistoryEntryRef(value.entryRef),
    isNonEmptyString(value.workspaceId),
    isWorkspaceRootRef(value.rootRef),
    isWorkspaceRootIdentityDigest(value.rootIdentityDigest),
    isPortableWorkspaceRelativePath(value.relativePath),
    isWorkspacePathDigest(value.relativePathDigest),
    isWorkspaceFact(value.predecessor, isWorkspaceHistoryEntryRef),
    isPositiveBoundedInteger(value.sequence, Number.MAX_SAFE_INTEGER),
    isHistoryOrigin(value.origin),
    isWorkspaceContentDigest(value.plaintextContentDigest),
    isNonNegativeBoundedInteger(value.plaintextByteLength, EDITOR_LOCAL_HISTORY_MAX_ENTRY_BYTES),
    isWorkspaceContentDigest(value.payloadBindingDigest),
    isEncryptedContentRef(value.encryptedContent),
  ].every(Boolean);
}

function historyEntryStateIsConsistent(value: UnknownRecord): boolean {
  if (
    !isWorkspaceIsoInstant(value.recordedAt) ||
    !isWorkspaceIsoInstant(value.lastAccessedAt) ||
    typeof value.pinned !== "boolean" ||
    !isWorkspaceFact(value.pinnedAt, isWorkspaceIsoInstant)
  ) {
    return false;
  }
  return (
    value.lastAccessedAt >= value.recordedAt && pinMetadataMatches(value.pinned, value.pinnedAt)
  );
}

function isHistoryEntry(value: unknown): value is EditorLocalHistoryEntry {
  if (!isWorkspaceRecord(value) || !hasOnlyWorkspaceKeys(value, ENTRY_KEYS)) return false;
  return historyEntryFieldsAreValid(value) && historyEntryStateIsConsistent(value);
}

export function validateEditorLocalHistoryEntry(value: unknown): WorkspaceContractValidation {
  try {
    return isHistoryEntry(value)
      ? workspaceContractValid()
      : workspaceContractInvalid("editor local history entry invalid");
  } catch {
    return workspaceContractInvalid("editor local history entry invalid");
  }
}

function entriesHaveUniqueIdentity(entries: readonly EditorLocalHistoryEntry[]): boolean {
  const entryRefs = new Set(entries.map((entry): WorkspaceHistoryEntryRef => entry.entryRef));
  const vaultRefs = new Set(
    entries.map((entry): WorkspaceVaultEntryRef => entry.encryptedContent.vaultEntryRef),
  );
  const checkpointIdentities = new Set(
    entries.map((entry): string =>
      JSON.stringify([
        entry.rootRef,
        entry.rootIdentityDigest,
        entry.relativePathDigest,
        entry.sequence,
      ]),
    ),
  );
  return (
    entryRefs.size === entries.length &&
    vaultRefs.size === entries.length &&
    checkpointIdentities.size === entries.length
  );
}

function versionsPerFileAreBounded(entries: readonly EditorLocalHistoryEntry[]): boolean {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const fileIdentity = JSON.stringify([
      entry.rootRef,
      entry.rootIdentityDigest,
      entry.relativePathDigest,
    ]);
    const count = (counts.get(fileIdentity) ?? 0) + 1;
    if (count > EDITOR_LOCAL_HISTORY_MAX_VERSIONS_PER_FILE) return false;
    counts.set(fileIdentity, count);
  }
  return true;
}

function sumEntryBytes(entries: readonly EditorLocalHistoryEntry[]): number {
  return entries.reduce((total, entry): number => total + entry.plaintextByteLength, 0);
}

function sumPinnedBytes(entries: readonly EditorLocalHistoryEntry[]): number {
  return entries.reduce(
    (total, entry): number => total + (entry.pinned ? entry.plaintextByteLength : 0),
    0,
  );
}

function historyIndexFieldsAreValid(value: UnknownRecord): boolean {
  return [
    value.kind === "local-history-index",
    value.schemaVersion === EDITOR_LOCAL_HISTORY_SCHEMA_VERSION,
    isNonEmptyString(value.workspaceId),
    isNonNegativeInteger(value.revision),
    value.maxEntries === EDITOR_LOCAL_HISTORY_MAX_ENTRIES,
    isNonNegativeInteger(value.totalPlaintextBytes),
  ].every(Boolean);
}

function historyIndexEntriesAreValid(value: UnknownRecord): boolean {
  if (!Array.isArray(value.entries)) return false;
  const entries = value.entries;
  return [
    entries.length <= EDITOR_LOCAL_HISTORY_MAX_ENTRIES,
    entries.every(isHistoryEntry),
    entries.every(
      (entry): boolean => isWorkspaceRecord(entry) && entry.workspaceId === value.workspaceId,
    ),
    entries.every(isHistoryEntry) && entriesHaveUniqueIdentity(entries),
    entries.every(isHistoryEntry) && versionsPerFileAreBounded(entries),
  ].every(Boolean);
}

function historyIndexTotalsAreValid(value: UnknownRecord): boolean {
  if (
    !Array.isArray(value.entries) ||
    !value.entries.every(isHistoryEntry) ||
    !isNonNegativeInteger(value.totalPlaintextBytes)
  ) {
    return false;
  }
  const entries = value.entries;
  return [
    value.totalPlaintextBytes === sumEntryBytes(entries),
    value.totalPlaintextBytes <= EDITOR_LOCAL_HISTORY_MAX_TOTAL_BYTES,
    sumPinnedBytes(entries) <= EDITOR_LOCAL_HISTORY_MAX_PINNED_BYTES,
  ].every(Boolean);
}

function isHistoryIndex(value: unknown): value is EditorLocalHistoryIndex {
  if (!isWorkspaceRecord(value) || !hasOnlyWorkspaceKeys(value, INDEX_KEYS)) return false;
  return (
    historyIndexFieldsAreValid(value) &&
    historyIndexEntriesAreValid(value) &&
    historyIndexTotalsAreValid(value)
  );
}

export function validateEditorLocalHistoryIndex(value: unknown): WorkspaceContractValidation {
  try {
    return isHistoryIndex(value)
      ? workspaceContractValid()
      : workspaceContractInvalid("editor local history index invalid");
  } catch {
    return workspaceContractInvalid("editor local history index invalid");
  }
}

function compareRetentionOrder(
  left: EditorLocalHistoryEntry,
  right: EditorLocalHistoryEntry,
): number {
  const byAccess = left.lastAccessedAt.localeCompare(right.lastAccessedAt);
  return byAccess === 0 ? left.entryRef.localeCompare(right.entryRef) : byAccess;
}

function requirementIsValid(requirement: EditorLocalHistoryRetentionRequirement): boolean {
  return (
    isNonNegativeInteger(requirement.requiredEntryCount) &&
    isNonNegativeInteger(requirement.requiredByteCount)
  );
}

export function planEditorLocalHistoryRetention(
  entries: readonly EditorLocalHistoryEntry[],
  requirement: EditorLocalHistoryRetentionRequirement,
): EditorLocalHistoryRetentionPlan {
  if (!requirementIsValid(requirement)) {
    return { ok: false, entryRefs: [], reason: "INVALID_REQUIREMENT" };
  }
  const candidates = entries.filter((entry): boolean => !entry.pinned).sort(compareRetentionOrder);
  const selected: WorkspaceHistoryEntryRef[] = [];
  let selectedBytes = 0;
  for (const entry of candidates) {
    if (
      selected.length >= requirement.requiredEntryCount &&
      selectedBytes >= requirement.requiredByteCount
    ) {
      break;
    }
    selected.push(entry.entryRef);
    selectedBytes += entry.plaintextByteLength;
  }
  const satisfied =
    selected.length >= requirement.requiredEntryCount &&
    selectedBytes >= requirement.requiredByteCount;
  return satisfied
    ? { ok: true, entryRefs: Object.freeze(selected) }
    : {
        ok: false,
        entryRefs: Object.freeze(selected),
        reason: "PINNED_CAPACITY_EXHAUSTED",
      };
}
