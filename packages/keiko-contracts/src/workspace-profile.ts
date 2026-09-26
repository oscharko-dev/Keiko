// Portable profile contract. Trust, roots, authority, runtime identities, credentials, endpoints,
// and absolute paths are unrepresentable and unknown keys fail closed.

import {
  EDITOR_M11_SETTINGS_SCHEMA_VERSION,
  isEditorM11ProfileSettingsLayer,
} from "./editor-m11-settings.js";
import type { EditorM11ProfileSettingsLayer } from "./editor-m11-settings.js";
import type { EditorM7ReasonCode, EditorM7SettingId, EditorM7SettingValue } from "./editor-m7.js";
import {
  WORKSPACE_CONTRACT_SCHEMA_VERSION,
  hasOnlyWorkspaceKeys,
  hasWorkspaceControlCharacter,
  isWorkspaceProfileRef,
  isWorkspaceRecord,
  isWorkspaceRevision,
  workspaceContractInvalid,
  workspaceContractValid,
} from "./workspace-contract-primitives.js";
import type {
  WorkspaceContractValidation,
  WorkspaceProfileRef,
} from "./workspace-contract-primitives.js";

export const WORKSPACE_PROFILE_SCHEMA_VERSION = WORKSPACE_CONTRACT_SCHEMA_VERSION;
export const WORKSPACE_PROFILE_DISPLAY_NAME_MAX_CHARS = 80 as const;

const WORKSPACE_PROFILE_RESERVED_DISPLAY_NAME_KEY = "default";

export interface WorkspaceProfileManifest {
  readonly kind: "workspace-profile";
  readonly schemaVersion: typeof WORKSPACE_PROFILE_SCHEMA_VERSION;
  readonly profileRef: WorkspaceProfileRef;
  readonly displayName: string;
  readonly revision: number;
  readonly settings: EditorM11ProfileSettingsLayer;
}

export type WorkspaceProfilePortabilityReasonCode =
  EditorM7ReasonCode | "NON_PORTABLE_PATH" | "SECRET_LIKE";

/**
 * `settingId` also admits the profile's own display name. A name is user-chosen text that rides
 * along in the export manifest, so it can carry an absolute or home-directory path exactly as a
 * setting value can, and the epic forbids either in an export. It is not an `EditorM7SettingId`, so
 * the field names it explicitly rather than being left unreportable.
 */
export const WORKSPACE_PROFILE_DISPLAY_NAME_FIELD = "profileDisplayName";

export interface WorkspaceProfileExportRedaction {
  readonly settingId: EditorM7SettingId | typeof WORKSPACE_PROFILE_DISPLAY_NAME_FIELD;
  readonly reasonCode: "INVALID_VALUE" | "NON_PORTABLE_PATH" | "SECRET_LIKE";
  readonly rejectedCount: number;
}

export interface WorkspaceProfileExportResult {
  readonly kind: "ok";
  readonly schemaVersion: typeof WORKSPACE_PROFILE_SCHEMA_VERSION;
  readonly manifest: WorkspaceProfileManifest;
  readonly serializedManifest: string;
  readonly redactions: readonly WorkspaceProfileExportRedaction[];
}

export type WorkspaceProfileImportDisposition = "add" | "change" | "noOp" | "rejected";

export interface WorkspaceProfileImportPreviewRow {
  readonly settingId: string;
  readonly disposition: WorkspaceProfileImportDisposition;
  readonly value?: EditorM7SettingValue | undefined;
  readonly reasonCode?: WorkspaceProfilePortabilityReasonCode | undefined;
}

export interface WorkspaceProfileImportPreview {
  readonly kind: "ok";
  readonly schemaVersion: typeof WORKSPACE_PROFILE_SCHEMA_VERSION;
  readonly expectedRevision: number;
  readonly sourceDisplayName: string;
  readonly proposedDisplayName: string;
  readonly collisionRenamed: boolean;
  readonly rows: readonly WorkspaceProfileImportPreviewRow[];
  readonly previewDigest: string;
}

export type WorkspaceProfileImportFailureCode =
  | "FUTURE_SCHEMA_VERSION"
  | "IMPORT_TOO_DEEP"
  | "INVALID_MANIFEST"
  | "PREVIEW_MISMATCH"
  | "UNSUPPORTED_SCHEMA_VERSION";

export interface WorkspaceProfileImportApply {
  readonly schemaVersion: "1";
  readonly expectedRevision: number;
  readonly manifest: unknown;
  readonly previewDigest: string;
  readonly switchAfterImport: boolean;
  readonly root?: string | undefined;
}

const PROFILE_KEYS = [
  "kind",
  "schemaVersion",
  "profileRef",
  "displayName",
  "revision",
  "settings",
] as const;

export function isWorkspaceProfileDisplayName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return [
    value.length > 0,
    value.length <= WORKSPACE_PROFILE_DISPLAY_NAME_MAX_CHARS,
    !hasWorkspaceControlCharacter(value),
  ].every(Boolean);
}

/**
 * The identity under which two display names are the same name to a reader: surrounding
 * whitespace and letter case carry no meaning in the profile picker, so they carry none here.
 * Every reserved-name and collision decision goes through this one key.
 */
export function workspaceProfileDisplayNameKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * "Default" names the built-in profile. A custom profile may not claim it, however it is padded
 * or cased — two entries reading "Default" in the picker is a lie about which one is built in.
 */
export function isReservedWorkspaceProfileDisplayName(value: string): boolean {
  return workspaceProfileDisplayNameKey(value) === WORKSPACE_PROFILE_RESERVED_DISPLAY_NAME_KEY;
}

/**
 * The invariant every path that ASSIGNS a display name must satisfy — create, rename, duplicate
 * and import alike (#2618). Deliberately stricter than `isWorkspaceProfileDisplayName`, which
 * stays the looser parse predicate for manifests that are ALREADY persisted: tightening the parse
 * predicate would make records written before this fix unreadable and take the whole profile store
 * to `unavailable`, so writes fail closed while reads keep degrading gracefully.
 */
export function isAssignableWorkspaceProfileDisplayName(value: unknown): value is string {
  return isWorkspaceProfileDisplayName(value) && value.trim() === value;
}

function isWorkspaceProfileManifest(value: unknown): value is WorkspaceProfileManifest {
  if (!isWorkspaceRecord(value) || !hasOnlyWorkspaceKeys(value, PROFILE_KEYS)) return false;
  if (!isEditorM11ProfileSettingsLayer(value.settings)) return false;
  return [
    value.kind === "workspace-profile",
    value.schemaVersion === WORKSPACE_PROFILE_SCHEMA_VERSION,
    isWorkspaceProfileRef(value.profileRef),
    isWorkspaceProfileDisplayName(value.displayName),
    isWorkspaceRevision(value.revision),
    value.settings.profileRef === value.profileRef,
    value.settings.revision === value.revision,
  ].every(Boolean);
}

export function validateWorkspaceProfileManifest(value: unknown): WorkspaceContractValidation {
  try {
    return isWorkspaceProfileManifest(value)
      ? workspaceContractValid()
      : workspaceContractInvalid("workspace profile manifest invalid");
  } catch {
    return workspaceContractInvalid("workspace profile manifest invalid");
  }
}

/**
 * The V1 profile is portable by construction. Rebuilding its closed shape makes export redaction
 * deterministic and idempotent without copying caller-owned object properties.
 */
export function redactWorkspaceProfileForExport(
  profile: WorkspaceProfileManifest,
): WorkspaceProfileManifest {
  return {
    kind: "workspace-profile",
    schemaVersion: WORKSPACE_PROFILE_SCHEMA_VERSION,
    profileRef: profile.profileRef,
    displayName: profile.displayName,
    revision: profile.revision,
    settings: {
      kind: "editor-profile-settings",
      schemaVersion: EDITOR_M11_SETTINGS_SCHEMA_VERSION,
      profileRef: profile.settings.profileRef,
      revision: profile.settings.revision,
      values: Object.freeze({ ...profile.settings.values }),
    },
  };
}
