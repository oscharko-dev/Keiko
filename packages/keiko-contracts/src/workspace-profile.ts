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
  isWorkspaceProfileRef,
  isWorkspaceRecord,
  workspaceContractInvalid,
  workspaceContractValid,
} from "./workspace-contract-primitives.js";
import type {
  WorkspaceContractValidation,
  WorkspaceProfileRef,
} from "./workspace-contract-primitives.js";

export const WORKSPACE_PROFILE_SCHEMA_VERSION = WORKSPACE_CONTRACT_SCHEMA_VERSION;
export const WORKSPACE_PROFILE_DISPLAY_NAME_MAX_CHARS = 80 as const;

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

export interface WorkspaceProfileExportRedaction {
  readonly settingId: EditorM7SettingId;
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

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isWorkspaceProfileDisplayName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return [
    value.length > 0,
    value.length <= WORKSPACE_PROFILE_DISPLAY_NAME_MAX_CHARS,
    !hasControlCharacter(value),
  ].every(Boolean);
}

function isWorkspaceProfileManifest(value: unknown): value is WorkspaceProfileManifest {
  if (!isWorkspaceRecord(value) || !hasOnlyWorkspaceKeys(value, PROFILE_KEYS)) return false;
  if (!isEditorM11ProfileSettingsLayer(value.settings)) return false;
  return [
    value.kind === "workspace-profile",
    value.schemaVersion === WORKSPACE_PROFILE_SCHEMA_VERSION,
    isWorkspaceProfileRef(value.profileRef),
    isWorkspaceProfileDisplayName(value.displayName),
    isRevision(value.revision),
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
