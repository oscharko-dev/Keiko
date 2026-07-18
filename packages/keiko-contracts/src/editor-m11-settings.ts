// M11 extension adapter over the existing M7 registry. The legacy M7 resolver and scope types remain
// unchanged; this module adds profile/root layers and preserves policy-last semantics.

import { EDITOR_M7_SETTING_REGISTRY, parseEditorM7SettingPatch } from "./editor-m7.js";
import type {
  EditorM7PolicyCeiling,
  EditorM7ReasonCode,
  EditorM7SettingEffect,
  EditorM7SettingId,
  EditorM7SettingsLayer,
  EditorM7SettingValue,
} from "./editor-m7.js";
import {
  WORKSPACE_CONTRACT_SCHEMA_VERSION,
  hasOnlyWorkspaceKeys,
  isWorkspaceProfileRef,
  isWorkspaceRecord,
  isWorkspaceRootIdentityDigest,
  isWorkspaceRootRef,
  workspaceContractInvalid,
  workspaceContractValid,
} from "./workspace-contract-primitives.js";
import type {
  WorkspaceContractValidation,
  WorkspaceProfileRef,
  WorkspaceRootIdentityDigest,
  WorkspaceRootRef,
} from "./workspace-contract-primitives.js";

export const EDITOR_M11_SETTINGS_SCHEMA_VERSION = WORKSPACE_CONTRACT_SCHEMA_VERSION;

export interface EditorM11ProfileSettingsLayer {
  readonly kind: "editor-profile-settings";
  readonly schemaVersion: typeof EDITOR_M11_SETTINGS_SCHEMA_VERSION;
  readonly profileRef: WorkspaceProfileRef;
  readonly revision: number;
  readonly values: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>>;
}

export interface EditorM11RootSettingsLayer {
  readonly kind: "editor-root-settings";
  readonly schemaVersion: typeof EDITOR_M11_SETTINGS_SCHEMA_VERSION;
  readonly rootRef: WorkspaceRootRef;
  readonly rootIdentityDigest: WorkspaceRootIdentityDigest;
  readonly revision: number;
  readonly values: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>>;
}

export type EditorM11SettingSource = "builtInDefault" | "profile" | "user" | "workspace" | "root";

export interface EditorM11ResolvedSetting {
  readonly id: EditorM7SettingId;
  readonly value: EditorM7SettingValue;
  readonly source: EditorM11SettingSource;
  readonly policyLocked: boolean;
  readonly reasonCode?: EditorM7ReasonCode | undefined;
  readonly effect: EditorM7SettingEffect;
  readonly profileRef?: WorkspaceProfileRef | undefined;
  readonly rootRef?: WorkspaceRootRef | undefined;
}

export interface EditorM11SettingsResolutionInput {
  readonly profile?: EditorM11ProfileSettingsLayer | undefined;
  readonly user?: EditorM7SettingsLayer | undefined;
  readonly workspace?: EditorM7SettingsLayer | undefined;
  readonly root?: EditorM11RootSettingsLayer | undefined;
  readonly ceiling?: EditorM7PolicyCeiling | undefined;
}

const PROFILE_LAYER_KEYS = ["kind", "schemaVersion", "profileRef", "revision", "values"] as const;
const ROOT_LAYER_KEYS = [
  "kind",
  "schemaVersion",
  "rootRef",
  "rootIdentityDigest",
  "revision",
  "values",
] as const;

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function valuesPassM7Scope(scope: "user" | "workspace", value: unknown): boolean {
  return parseEditorM7SettingPatch(scope, value).ok;
}

function isProfileLayerUnsafe(value: unknown): value is EditorM11ProfileSettingsLayer {
  return (
    isWorkspaceRecord(value) &&
    hasOnlyWorkspaceKeys(value, PROFILE_LAYER_KEYS) &&
    value.kind === "editor-profile-settings" &&
    value.schemaVersion === EDITOR_M11_SETTINGS_SCHEMA_VERSION &&
    isWorkspaceProfileRef(value.profileRef) &&
    isRevision(value.revision) &&
    valuesPassM7Scope("user", value.values)
  );
}

function isRootLayerUnsafe(value: unknown): value is EditorM11RootSettingsLayer {
  return (
    isWorkspaceRecord(value) &&
    hasOnlyWorkspaceKeys(value, ROOT_LAYER_KEYS) &&
    value.kind === "editor-root-settings" &&
    value.schemaVersion === EDITOR_M11_SETTINGS_SCHEMA_VERSION &&
    isWorkspaceRootRef(value.rootRef) &&
    isWorkspaceRootIdentityDigest(value.rootIdentityDigest) &&
    isRevision(value.revision) &&
    valuesPassM7Scope("workspace", value.values)
  );
}

export function isEditorM11ProfileSettingsLayer(
  value: unknown,
): value is EditorM11ProfileSettingsLayer {
  try {
    return isProfileLayerUnsafe(value);
  } catch {
    return false;
  }
}

export function isEditorM11RootSettingsLayer(value: unknown): value is EditorM11RootSettingsLayer {
  try {
    return isRootLayerUnsafe(value);
  } catch {
    return false;
  }
}

export function validateEditorM11ProfileSettingsLayer(value: unknown): WorkspaceContractValidation {
  try {
    return isEditorM11ProfileSettingsLayer(value)
      ? workspaceContractValid()
      : workspaceContractInvalid("editor profile settings invalid");
  } catch {
    return workspaceContractInvalid("editor profile settings invalid");
  }
}

export function validateEditorM11RootSettingsLayer(value: unknown): WorkspaceContractValidation {
  try {
    return isEditorM11RootSettingsLayer(value)
      ? workspaceContractValid()
      : workspaceContractInvalid("editor root settings invalid");
  } catch {
    return workspaceContractInvalid("editor root settings invalid");
  }
}

interface ValuesLayer {
  readonly values: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>>;
}

function layerValue(
  id: EditorM7SettingId,
  layer: ValuesLayer | undefined,
): EditorM7SettingValue | undefined {
  return layer?.values[id];
}

function resolvedSource(
  id: EditorM7SettingId,
  input: EditorM11SettingsResolutionInput,
): EditorM11SettingSource {
  if (layerValue(id, input.root) !== undefined) return "root";
  if (layerValue(id, input.workspace) !== undefined) return "workspace";
  if (layerValue(id, input.user) !== undefined) return "user";
  return layerValue(id, input.profile) === undefined ? "builtInDefault" : "profile";
}

function resolvedValue(
  id: EditorM7SettingId,
  fallback: EditorM7SettingValue,
  input: EditorM11SettingsResolutionInput,
): EditorM7SettingValue {
  return (
    layerValue(id, input.root) ??
    layerValue(id, input.workspace) ??
    layerValue(id, input.user) ??
    layerValue(id, input.profile) ??
    fallback
  );
}

function provenance(
  source: EditorM11SettingSource,
  input: EditorM11SettingsResolutionInput,
): Pick<EditorM11ResolvedSetting, "profileRef" | "rootRef"> {
  if (source === "root" && input.root !== undefined) return { rootRef: input.root.rootRef };
  if (source === "profile" && input.profile !== undefined) {
    return { profileRef: input.profile.profileRef };
  }
  return {};
}

function resolveSetting(
  definition: (typeof EDITOR_M7_SETTING_REGISTRY)[number],
  input: EditorM11SettingsResolutionInput,
): EditorM11ResolvedSetting {
  const source = resolvedSource(definition.id, input);
  const reasonCode = input.ceiling?.locked[definition.id];
  return {
    id: definition.id,
    value: resolvedValue(definition.id, definition.defaultValue, input),
    source,
    policyLocked: reasonCode !== undefined,
    ...(reasonCode === undefined ? {} : { reasonCode }),
    effect: definition.effect,
    ...provenance(source, input),
  };
}

export function resolveEditorM11Settings(
  input: EditorM11SettingsResolutionInput,
): readonly EditorM11ResolvedSetting[] {
  return Object.freeze(
    EDITOR_M7_SETTING_REGISTRY.map((entry): EditorM11ResolvedSetting =>
      resolveSetting(entry, input),
    ),
  );
}
