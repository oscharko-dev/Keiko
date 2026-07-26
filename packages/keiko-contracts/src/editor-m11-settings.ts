// M11 extension adapter over the existing M7 registry. The legacy M7 resolver and scope types remain
// unchanged; this module adds profile/root layers and preserves policy-last semantics.

import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  parseEditorM7SettingPatch,
} from "./editor-m7.js";
import type {
  EditorM7PolicyCeiling,
  EditorM7ReasonCode,
  EditorM7SettingEffect,
  EditorM7SettingId,
  EditorM7SettingScope,
  EditorM7SettingSecurity,
  EditorM7SettingsEvent,
  EditorM7SettingsLayer,
  EditorM7SettingsMutation,
  EditorM7SettingsMutationOk,
  EditorM7SettingsMutationResult,
  EditorM7SettingsSnapshot,
  EditorM7SettingValue,
} from "./editor-m7.js";
import type { ManagedLspControlSnapshot } from "./managed-lsp-route.js";
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
export type EditorM11SettingScope = EditorM7SettingScope | "root";

/**
 * What each layer stores for a setting in its OWN right, before resolution picks a winner.
 *
 * `value` answers "what is in effect"; this answers "what would I be rewriting". An editor that
 * composes a new value from the old one — a keybinding list, any other collection — must build it
 * from the layer it is about to write, never from the resolved view, or the write silently copies
 * a foreign layer's content into the target layer (#2618). A key is absent exactly when that layer
 * holds no value of its own for the setting.
 */
export interface EditorM11SettingLayerValues {
  readonly profile?: EditorM7SettingValue | undefined;
  readonly user?: EditorM7SettingValue | undefined;
  readonly workspace?: EditorM7SettingValue | undefined;
  readonly root?: EditorM7SettingValue | undefined;
}

export interface EditorM11ResolvedSetting {
  readonly id: EditorM7SettingId;
  readonly value: EditorM7SettingValue;
  readonly source: EditorM11SettingSource;
  readonly scope: EditorM11SettingScope;
  readonly layers: EditorM11SettingLayerValues;
  readonly policyLocked: boolean;
  readonly reasonCode?: EditorM7ReasonCode | undefined;
  readonly effect: EditorM7SettingEffect;
  readonly profileRef?: WorkspaceProfileRef | undefined;
  readonly rootRef?: WorkspaceRootRef | undefined;
}

export interface EditorM11ManagedLanguageComposition {
  readonly revision: number;
  readonly etag: string;
  readonly storeState: EditorM7SettingsSnapshot["storeState"];
  readonly settingsCount: number;
  readonly rootRef?: WorkspaceRootRef | undefined;
  readonly rootIdentityDigest?: WorkspaceRootIdentityDigest | undefined;
  readonly languages?: ManagedLspControlSnapshot["languages"] | undefined;
  readonly settings?: ManagedLspControlSnapshot["settings"] | undefined;
}

export interface EditorM11SettingsSnapshot extends Omit<
  EditorM7SettingsSnapshot,
  "managedLanguages" | "settings"
> {
  readonly rootRevision?: number | undefined;
  readonly rootRef?: WorkspaceRootRef | undefined;
  readonly rootIdentityDigest?: WorkspaceRootIdentityDigest | undefined;
  readonly settings: readonly EditorM11ResolvedSetting[];
  readonly managedLanguages?: EditorM11ManagedLanguageComposition | undefined;
  readonly profiles?: EditorM11ProfilesSnapshot | undefined;
}

export const EDITOR_M11_DEFAULT_PROFILE_REF = "profile-default" as WorkspaceProfileRef;

export interface EditorM11ProfileSummary {
  readonly profileRef: WorkspaceProfileRef;
  readonly displayName: string;
  readonly revision: number;
  readonly settingCount: number;
  readonly builtIn: boolean;
}

export interface EditorM11ProfilesSnapshot {
  readonly schemaVersion: typeof EDITOR_M11_SETTINGS_SCHEMA_VERSION;
  readonly storeState: EditorM7SettingsSnapshot["storeState"];
  readonly revision: number;
  readonly etag: string;
  readonly activeProfileRef: WorkspaceProfileRef;
  readonly profiles: readonly EditorM11ProfileSummary[];
}

export type EditorM11ProfileMutationAction =
  "create" | "rename" | "duplicate" | "delete" | "switch" | "set" | "reset";

export interface EditorM11ProfileMutation {
  readonly schemaVersion: typeof EDITOR_M7_SCHEMA_VERSION;
  readonly action: EditorM11ProfileMutationAction;
  readonly expectedRevision: number;
  readonly root?: string | undefined;
  readonly profileRef?: WorkspaceProfileRef | undefined;
  readonly displayName?: string | undefined;
  readonly values?: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>> | undefined;
  readonly settingIds?: readonly EditorM7SettingId[] | undefined;
}

export type EditorM11ProfileReasonCode =
  | EditorM7ReasonCode
  | "DEFAULT_PROFILE_IMMUTABLE"
  | "PROFILE_LIMIT_REACHED"
  | "PROFILE_NAME_CONFLICT"
  | "PROFILE_NOT_FOUND";

export interface EditorM11ProfileMutationOk {
  readonly kind: "ok";
  readonly changed: boolean;
  readonly profileRef: WorkspaceProfileRef;
  readonly revision: number;
  readonly etag: string;
  readonly profiles: EditorM11ProfilesSnapshot;
  readonly settings: EditorM11SettingsSnapshot;
}

export type EditorM11ProfileMutationResult =
  | EditorM11ProfileMutationOk
  | { readonly kind: "conflict"; readonly code: "STALE_REVISION"; readonly etag: string }
  | {
      readonly kind: "idempotencyConflict";
      readonly code: "IDEMPOTENCY_KEY_REUSED";
      readonly etag: string;
    }
  | { readonly kind: "invalid"; readonly code: EditorM11ProfileReasonCode }
  | { readonly kind: "unavailable"; readonly code: "STATE_UNAVAILABLE" };

export type EditorM11SettingsMutation = Omit<EditorM7SettingsMutation, "scope"> & {
  readonly scope: EditorM11SettingScope;
};

export interface EditorM11SettingsMutationOk extends Omit<EditorM7SettingsMutationOk, "snapshot"> {
  readonly snapshot: EditorM11SettingsSnapshot;
}

export type EditorM11SettingsMutationResult =
  EditorM11SettingsMutationOk | Exclude<EditorM7SettingsMutationResult, EditorM7SettingsMutationOk>;

export interface EditorM11SettingsEvent extends Omit<EditorM7SettingsEvent, "scope"> {
  readonly rootRevision?: number | undefined;
  readonly scope: EditorM11SettingScope;
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
  fallback: EditorM7SettingValue,
  input: EditorM11SettingsResolutionInput,
): EditorM11SettingSource {
  if (effectiveRootValue(id, fallback, input) !== undefined) return "root";
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
    effectiveRootValue(id, fallback, input) ??
    layerValue(id, input.workspace) ??
    layerValue(id, input.user) ??
    layerValue(id, input.profile) ??
    fallback
  );
}

function inheritedValue(
  id: EditorM7SettingId,
  fallback: EditorM7SettingValue,
  input: EditorM11SettingsResolutionInput,
): EditorM7SettingValue {
  return (
    layerValue(id, input.workspace) ??
    layerValue(id, input.user) ??
    layerValue(id, input.profile) ??
    fallback
  );
}

function effectiveRootValue(
  id: EditorM7SettingId,
  fallback: EditorM7SettingValue,
  input: EditorM11SettingsResolutionInput,
): EditorM7SettingValue | undefined {
  const value = layerValue(id, input.root);
  if (value === undefined) return undefined;
  return editorM11RootSettingIsMonotonic(id, inheritedValue(id, fallback, input), value)
    ? value
    : undefined;
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

function scopeForSource(source: EditorM11ResolvedSetting["source"]): "root" | "workspace" | "user" {
  if (source === "root") return "root";
  return source === "workspace" ? "workspace" : "user";
}

// The RAW stored value per layer, not the effective one: the root layer's monotonic clamp decides
// what takes effect, never what that layer holds, and a scoped rewrite must preserve what it holds.
function layerValues(
  id: EditorM7SettingId,
  input: EditorM11SettingsResolutionInput,
): EditorM11SettingLayerValues {
  const profile = layerValue(id, input.profile);
  const user = layerValue(id, input.user);
  const workspace = layerValue(id, input.workspace);
  const root = layerValue(id, input.root);
  return {
    ...(profile === undefined ? {} : { profile }),
    ...(user === undefined ? {} : { user }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(root === undefined ? {} : { root }),
  };
}
function resolveSetting(
  definition: (typeof EDITOR_M7_SETTING_REGISTRY)[number],
  input: EditorM11SettingsResolutionInput,
): EditorM11ResolvedSetting {
  const source = resolvedSource(definition.id, definition.defaultValue, input);
  const reasonCode = input.ceiling?.locked[definition.id];
  return {
    id: definition.id,
    value: resolvedValue(definition.id, definition.defaultValue, input),
    source,
    scope: scopeForSource(source),
    layers: layerValues(definition.id, input),
    policyLocked: reasonCode !== undefined,
    ...(reasonCode === undefined ? {} : { reasonCode }),
    effect: definition.effect,
    ...provenance(source, input),
  };
}

function definitionSecurity(id: EditorM7SettingId): EditorM7SettingSecurity {
  const definition = EDITOR_M7_SETTING_REGISTRY.find((entry) => entry.id === id);
  return definition?.security ?? "policyCeiling";
}

export function editorM11RootSettingIsMonotonic(
  id: EditorM7SettingId,
  inherited: EditorM7SettingValue,
  root: EditorM7SettingValue,
): boolean {
  if (definitionSecurity(id) !== "policyCeiling") return true;
  return root !== true || inherited === true;
}

function isM11EventScope(value: unknown): value is EditorM11SettingScope {
  return value === "user" || value === "workspace" || value === "root";
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSettingId(value: unknown): value is EditorM7SettingId {
  return (
    typeof value === "string" &&
    EDITOR_M7_SETTING_REGISTRY.some((definition) => definition.id === value)
  );
}

function hasOnlyEventKeys(value: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(value).every((key) =>
    [
      "schemaVersion",
      "sequence",
      "kind",
      "revision",
      "userRevision",
      "workspaceRevision",
      "rootRevision",
      "scope",
      "settingIds",
      "storeState",
    ].includes(key),
  );
}

function hasValidEventRevisions(value: Readonly<Record<string, unknown>>): boolean {
  const revisions = [value.sequence, value.revision, value.userRevision, value.workspaceRevision];
  if (!revisions.every(isNonnegativeInteger)) return false;
  return value.rootRevision === undefined || isNonnegativeInteger(value.rootRevision);
}

function hasValidEventSettingIds(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every(isSettingId)) return false;
  return new Set(value).size === value.length;
}

function hasValidEventStoreState(value: unknown): boolean {
  return value === "absent" || value === "ready" || value === "unavailable";
}

function isM11SettingsEvent(value: unknown): value is EditorM11SettingsEvent {
  if (!isWorkspaceRecord(value) || !hasOnlyEventKeys(value)) return false;
  return [
    value.schemaVersion === "1" && (value.kind === "changed" || value.kind === "snapshot"),
    hasValidEventRevisions(value),
    isM11EventScope(value.scope) && hasValidEventSettingIds(value.settingIds),
    hasValidEventStoreState(value.storeState),
  ].every(Boolean);
}

export function parseEditorM11SettingsEvent(
  value: unknown,
): { readonly ok: true; readonly value: EditorM11SettingsEvent } | { readonly ok: false } {
  try {
    return isM11SettingsEvent(value) ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
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
