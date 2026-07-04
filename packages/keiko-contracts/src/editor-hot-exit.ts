import type { EditorDocumentVersion } from "./editor-session.js";

export const EDITOR_HOT_EXIT_SCHEMA_VERSION = 1 as const;
export const EDITOR_HOT_EXIT_INDEX_SCHEMA_VERSION = 2 as const;
export const EDITOR_HOT_EXIT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface EditorHotExitSnapshotV1 {
  readonly schemaVersion: typeof EDITOR_HOT_EXIT_SCHEMA_VERSION;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly content: string;
  readonly baseVersion: EditorDocumentVersion | null;
  readonly contentHash: string;
  readonly savedContentHash: string | null;
  readonly updatedAt: number;
  readonly paneId: string;
  readonly windowId: string;
}

export interface EditorHotExitIndexRecordV2 {
  readonly schemaVersion: typeof EDITOR_HOT_EXIT_INDEX_SCHEMA_VERSION;
  readonly locatorHash: string;
  readonly snapshotRef: string;
  readonly baseVersion: EditorDocumentVersion | null;
  readonly contentHash: string;
  readonly savedContentHash: string | null;
  readonly contentSizeBytes: number;
  readonly updatedAt: number;
  readonly paneId: string;
  readonly windowId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullOr(value: unknown, guard: (candidate: unknown) => boolean): boolean {
  return value === null || guard(value);
}

function isDocumentVersion(value: unknown): value is EditorDocumentVersion {
  return (
    isRecord(value) &&
    isNonNegativeFiniteNumber(value.sizeBytes) &&
    isNonNegativeFiniteNumber(value.modifiedAt) &&
    isSha256Hex(value.contentHash)
  );
}

export function isEditorHotExitSnapshotV1(value: unknown): value is EditorHotExitSnapshotV1 {
  if (!isRecord(value)) return false;
  return [
    value.schemaVersion === EDITOR_HOT_EXIT_SCHEMA_VERSION,
    isNonEmptyString(value.workspaceRoot),
    isNonEmptyString(value.relativePath),
    typeof value.content === "string",
    isNullOr(value.baseVersion, isDocumentVersion),
    isSha256Hex(value.contentHash),
    isNullOr(value.savedContentHash, isSha256Hex),
    isNonNegativeFiniteNumber(value.updatedAt),
    isNonEmptyString(value.paneId),
    isNonEmptyString(value.windowId),
  ].every(Boolean);
}

export function isEditorHotExitIndexRecordV2(value: unknown): value is EditorHotExitIndexRecordV2 {
  if (!isRecord(value)) return false;
  return [
    value.schemaVersion === EDITOR_HOT_EXIT_INDEX_SCHEMA_VERSION,
    isSha256Hex(value.locatorHash),
    isNonEmptyString(value.snapshotRef),
    isNullOr(value.baseVersion, isDocumentVersion),
    isSha256Hex(value.contentHash),
    isNullOr(value.savedContentHash, isSha256Hex),
    isNonNegativeFiniteNumber(value.contentSizeBytes),
    isNonNegativeFiniteNumber(value.updatedAt),
    isNonEmptyString(value.paneId),
    isNonEmptyString(value.windowId),
  ].every(Boolean);
}

export function editorHotExitSnapshotExpired(
  snapshot: EditorHotExitSnapshotV1,
  now: number,
  ttlMs = EDITOR_HOT_EXIT_TTL_MS,
): boolean {
  return snapshot.updatedAt + ttlMs < now;
}
