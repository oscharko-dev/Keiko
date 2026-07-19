import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  EDITOR_M11_DEFAULT_PROFILE_REF,
  EDITOR_M11_SETTINGS_SCHEMA_VERSION,
  WORKSPACE_PROFILE_SCHEMA_VERSION,
  editorM11RootSettingIsMonotonic,
  isWorkspaceProfileDisplayName,
  isWorkspaceProfileRef,
  parseEditorM7SettingPatch,
  resolveEditorM11Settings,
  type EditorM7AiActivationSummary,
  type EditorM7PolicyCeiling,
  type EditorM7ReasonCode,
  type EditorM7SettingId,
  type EditorM7SettingScope,
  type EditorM7SettingValue,
  type EditorM7SettingsMutationAction,
  type EditorM7StoreState,
  type EditorM11ResolvedSetting,
  type EditorM11ProfileMutation,
  type EditorM11ProfileReasonCode,
  type EditorM11ProfileMutationResult,
  type EditorM11ProfilesSnapshot,
  type EditorM11RootSettingsLayer,
  type EditorM11SettingScope,
  type EditorM11SettingsMutationResult,
  type EditorM11SettingsSnapshot,
  type WorkspaceProfileManifest,
  type WorkspaceProfileExportResult,
  type WorkspaceProfileImportFailureCode,
  type WorkspaceProfileImportPreview,
  type WorkspaceProfileRef,
} from "@oscharko-dev/keiko-contracts";

import type { WorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import type {
  ManagedLspControlService,
  ManagedLspControlSnapshot,
} from "../lsp/managedLspControl.js";
import type { DebugActivationControlService } from "../dap/debugActivationControl.js";
import { debugActivationWorkspaceFingerprint } from "../dap/debugActivationEvidence.js";
import { inspectWorkspaceRootIdentity } from "../../workspace-root-identity.js";
import {
  editorSettingsWorkspaceFingerprint,
  type EditorSettingsChangeEvent,
  type EditorSettingsIdempotencyRecord,
  type EditorSettingsStore,
  type EditorSettingsStoreState,
  type EditorSettingsRootRecord,
  type EditorSettingsUserRecord,
  type EditorSettingsWorkspaceRecord,
} from "./editorSettingsStore.js";
import {
  createEditorProfilesStore,
  type EditorProfilesChangeEvent,
  type EditorProfilesIdempotencyRecord,
  type EditorProfilesLoadResult,
  type EditorProfilesRecord,
  type EditorProfilesStore,
  type EditorProfilesStoreState,
} from "./editorProfilesStore.js";
import {
  assembleEditorProfileExport,
  previewEditorProfileImport,
  type PreparedEditorProfileImport,
} from "./editorProfilePortability.js";

const MAX_IDEMPOTENCY_KEY_CHARS = 128;
const MAX_IDEMPOTENCY_RECORDS = 64;
const MAX_EVENTS = 128;

export interface EditorSettingsControlMutation {
  readonly action: EditorM7SettingsMutationAction;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly realRoot?: string | undefined;
  readonly scope: EditorM11SettingScope;
  readonly values?: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>> | undefined;
  readonly settingIds?: readonly EditorM7SettingId[] | undefined;
}

export interface EditorSettingsControlService {
  readonly stateDir: string;
  readonly read: (realRoot?: string) => Promise<EditorM11SettingsSnapshot>;
  readonly readProfiles?: (() => Promise<EditorM11ProfilesSnapshot>) | undefined;
  readonly mutate: (
    mutation: EditorSettingsControlMutation,
  ) => Promise<EditorM11SettingsMutationResult>;
  readonly mutateProfile?:
    | ((mutation: EditorProfilesControlMutation) => Promise<EditorM11ProfileMutationResult>)
    | undefined;
  readonly exportProfile?:
    ((profileRef?: WorkspaceProfileRef) => Promise<EditorProfileExportControlResult>) | undefined;
  readonly previewProfileImport?:
    | ((
        value: unknown,
        expectedRevision: number,
      ) => Promise<EditorProfileImportPreviewControlResult>)
    | undefined;
  readonly applyProfileImport?:
    | ((mutation: EditorProfileImportControlMutation) => Promise<EditorProfileImportApplyResult>)
    | undefined;
}

export type EditorProfilesControlMutation = Omit<
  EditorM11ProfileMutation,
  "schemaVersion" | "root"
> & {
  readonly idempotencyKey: string;
  readonly realRoot?: string | undefined;
};

export interface EditorProfileImportControlMutation {
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly manifest: unknown;
  readonly previewDigest: string;
  readonly switchAfterImport: boolean;
  readonly realRoot?: string | undefined;
}

export type EditorProfileExportControlResult =
  | WorkspaceProfileExportResult
  | { readonly kind: "invalid"; readonly code: "PROFILE_NOT_FOUND" }
  | { readonly kind: "unavailable"; readonly code: "STATE_UNAVAILABLE" };

export type EditorProfileImportPreviewControlResult =
  | WorkspaceProfileImportPreview
  | { readonly kind: "conflict"; readonly code: "STALE_REVISION"; readonly etag: string }
  | { readonly kind: "invalid"; readonly code: WorkspaceProfileImportFailureCode }
  | { readonly kind: "unavailable"; readonly code: "STATE_UNAVAILABLE" };

export type EditorProfileImportApplyResult =
  | Exclude<EditorM11ProfileMutationResult, { readonly kind: "invalid" }>
  | {
      readonly kind: "invalid";
      readonly code: EditorM11ProfileReasonCode | WorkspaceProfileImportFailureCode;
    };

export interface EditorSettingsControlOptions {
  readonly store: EditorSettingsStore;
  readonly profilesStore?: EditorProfilesStore | undefined;
  readonly mutex: WorkspaceMutexRegistry;
  readonly profileRefFactory?: (() => WorkspaceProfileRef) | undefined;
  readonly managedLspControl?: ManagedLspControlService | undefined;
  readonly policyCeiling?: (() => EditorM7PolicyCeiling) | undefined;
  readonly aiAssistance?:
    | ((args: {
        readonly realRoot?: string | undefined;
        readonly revision: number;
        readonly settings: readonly EditorM11ResolvedSetting[];
      }) => EditorM7AiActivationSummary)
    | undefined;
  /** ADR-0136 D7 derived gate; `debuggingEnabled` remains the only durable opt-in. */
  readonly debugActivation?: DebugActivationControlService | undefined;
}

type MutableRecord =
  EditorSettingsUserRecord | EditorSettingsWorkspaceRecord | EditorSettingsRootRecord;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function revisionFor(
  userRevision: number,
  workspaceRevision: number,
  rootRevision: number,
  profileRevision: number,
): number {
  return (
    userRevision * 1_000_000_000_000 +
    workspaceRevision * 1_000_000 +
    rootRevision +
    profileRevision
  );
}

function etag(
  realRoot: string | undefined,
  userRevision: number,
  workspaceRevision: number,
  rootRevision: number,
  profileRevision: number,
): string {
  const rootToken = realRoot === undefined ? "user" : editorSettingsWorkspaceFingerprint(realRoot);
  const profileToken = profileRevision === 0 ? "" : `-p${String(profileRevision)}`;
  return `"edm7-${String(userRevision)}-${String(workspaceRevision)}-${String(rootRevision)}${profileToken}-${rootToken.slice(0, 24)}"`;
}

function combinedState(
  userState: EditorSettingsStoreState,
  workspaceState: EditorSettingsStoreState,
  rootState: EditorSettingsStoreState,
  profileState: EditorProfilesStoreState,
): EditorM7StoreState {
  if (
    userState === "unavailable" ||
    workspaceState === "unavailable" ||
    rootState === "unavailable" ||
    profileState === "unavailable"
  ) {
    return "unavailable";
  }
  return userState === "ready" ||
    workspaceState === "ready" ||
    rootState === "ready" ||
    profileState === "ready"
    ? "ready"
    : "absent";
}

function settingsLayer(
  scope: EditorM7SettingScope,
  values: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>>,
): { readonly scope: EditorM7SettingScope; readonly values: typeof values } {
  return { scope, values };
}

function eventSequence(record: MutableRecord): number {
  return record.events.at(-1)?.sequence ?? 0;
}

interface SnapshotRecords {
  readonly realRoot?: string | undefined;
  readonly user: {
    readonly state: EditorSettingsStoreState;
    readonly record: EditorSettingsUserRecord;
  };
  readonly workspace: {
    readonly state: EditorSettingsStoreState;
    readonly record: EditorSettingsWorkspaceRecord | undefined;
  };
  readonly rootLayer: {
    readonly state: EditorSettingsStoreState;
    readonly record: EditorSettingsRootRecord | undefined;
  };
  readonly profiles: EditorProfilesLoadResult;
  readonly ceiling?: EditorM7PolicyCeiling | undefined;
  readonly managedLanguageSnapshot?: ManagedLspControlSnapshot | undefined;
  readonly aiAssistance?: EditorM7AiActivationSummary | undefined;
}

type RootIdentity = ReturnType<typeof inspectWorkspaceRootIdentity>;

function optionalRecordRevision(record: MutableRecord | undefined): number {
  return record?.revision ?? 0;
}

function rootSnapshotFields(
  realRoot: string | undefined,
  identity: RootIdentity | undefined,
): Pick<EditorM11SettingsSnapshot, "root" | "rootIdentityDigest" | "rootRef"> {
  if (realRoot === undefined || identity === undefined) return {};
  return {
    root: realRoot,
    rootRef: identity.rootRef,
    rootIdentityDigest: identity.identityDigest,
  };
}

function managedLanguageFields(
  snapshot: ManagedLspControlSnapshot | undefined,
  identity: RootIdentity | undefined,
): Pick<EditorM11SettingsSnapshot, "managedLanguages"> {
  return snapshot === undefined
    ? {}
    : { managedLanguages: managedLanguageSummary(snapshot, identity) };
}

function aiAssistanceFields(
  summary: EditorM7AiActivationSummary | undefined,
): Pick<EditorM11SettingsSnapshot, "aiAssistance"> {
  return summary === undefined ? {} : { aiAssistance: summary };
}

function latestEventSequence(args: SnapshotRecords): number {
  return Math.max(
    eventSequence(args.user.record),
    eventSequence(args.workspace.record ?? args.user.record),
    eventSequence(args.rootLayer.record ?? args.user.record),
    args.profiles.record.events.at(-1)?.sequence ?? 0,
  );
}

function snapshotFromRecords(args: SnapshotRecords): EditorM11SettingsSnapshot {
  const workspaceRevision = optionalRecordRevision(args.workspace.record);
  const rootRevision = optionalRecordRevision(args.rootLayer.record);
  const userRevision = args.user.record.revision;
  const profileRevision = args.profiles.record.revision;
  const identity =
    args.realRoot === undefined ? undefined : inspectWorkspaceRootIdentity(args.realRoot);
  const settings = effectiveSettings(
    args.user.record,
    args.workspace.record,
    args.rootLayer.record,
    activeProfile(args.profiles.record),
    identity,
    args.ceiling,
  );
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: combinedState(
      args.user.state,
      args.workspace.state,
      args.rootLayer.state,
      args.profiles.state,
    ),
    userRevision,
    workspaceRevision,
    rootRevision,
    revision: revisionFor(userRevision, workspaceRevision, rootRevision, profileRevision),
    etag: etag(args.realRoot, userRevision, workspaceRevision, rootRevision, profileRevision),
    ...rootSnapshotFields(args.realRoot, identity),
    definitions: EDITOR_M7_SETTING_REGISTRY,
    settings,
    eventSequence: latestEventSequence(args),
    profiles: profilesSnapshot(args.profiles),
    ...managedLanguageFields(args.managedLanguageSnapshot, identity),
    ...aiAssistanceFields(args.aiAssistance),
  };
}

function managedLanguageSummary(
  snapshot: ManagedLspControlSnapshot,
  identity: RootIdentity | undefined,
): NonNullable<EditorM11SettingsSnapshot["managedLanguages"]> {
  return {
    revision: snapshot.revision,
    etag: snapshot.etag,
    storeState: snapshot.storeState,
    settingsCount: snapshot.settings.length,
    ...(identity === undefined
      ? {}
      : { rootRef: identity.rootRef, rootIdentityDigest: identity.identityDigest }),
    languages: snapshot.languages,
    settings: snapshot.settings,
  };
}

function effectiveSettings(
  user: EditorSettingsUserRecord,
  workspace: EditorSettingsWorkspaceRecord | undefined,
  root: EditorSettingsRootRecord | undefined,
  profile: WorkspaceProfileManifest | undefined,
  identity: RootIdentity | undefined,
  ceiling: EditorM7PolicyCeiling | undefined,
): readonly EditorM11ResolvedSetting[] {
  return resolveEditorM11Settings({
    ...(profile === undefined ? {} : { profile: profile.settings }),
    user: settingsLayer("user", user.values),
    ...(workspace === undefined ? {} : { workspace: settingsLayer("workspace", workspace.values) }),
    ...(root === undefined || identity === undefined
      ? {}
      : { root: rootSettingsLayer(root, identity) }),
    ...(ceiling === undefined ? {} : { ceiling }),
  });
}

function activeProfile(record: EditorProfilesRecord): WorkspaceProfileManifest | undefined {
  return record.profiles.find((profile) => profile.profileRef === record.activeProfileRef);
}

function profileSummary(
  profile: WorkspaceProfileManifest,
): EditorM11ProfilesSnapshot["profiles"][number] {
  return {
    profileRef: profile.profileRef,
    displayName: profile.displayName,
    revision: profile.revision,
    settingCount: Object.keys(profile.settings.values).length,
    builtIn: false,
  };
}

function profilesSnapshot(loaded: EditorProfilesLoadResult): EditorM11ProfilesSnapshot {
  return {
    schemaVersion: EDITOR_M11_SETTINGS_SCHEMA_VERSION,
    storeState: loaded.state,
    revision: loaded.record.revision,
    etag: profileEtag(loaded.record.revision),
    activeProfileRef: loaded.record.activeProfileRef,
    profiles: [
      {
        profileRef: EDITOR_M11_DEFAULT_PROFILE_REF,
        displayName: "Default",
        revision: 0,
        settingCount: 0,
        builtIn: true,
      },
      ...loaded.record.profiles.map(profileSummary),
    ],
  };
}

function profileEtag(revision: number): string {
  return `"edp-${String(revision)}"`;
}

function rootSettingsLayer(
  record: EditorSettingsRootRecord,
  identity: RootIdentity,
): EditorM11RootSettingsLayer {
  return {
    kind: "editor-root-settings",
    schemaVersion: EDITOR_M11_SETTINGS_SCHEMA_VERSION,
    rootRef: identity.rootRef,
    rootIdentityDigest: identity.identityDigest,
    revision: record.revision,
    values: record.values,
  };
}

function targetRevision(
  mutation: EditorSettingsControlMutation,
  user: EditorSettingsUserRecord,
  workspace: EditorSettingsWorkspaceRecord | undefined,
  root: EditorSettingsRootRecord | undefined,
): number {
  if (mutation.scope === "user") return user.revision;
  return mutation.scope === "workspace" ? (workspace?.revision ?? 0) : (root?.revision ?? 0);
}

function requestHash(mutation: EditorSettingsControlMutation): string {
  return hash(
    JSON.stringify({
      action: mutation.action,
      expectedRevision: mutation.expectedRevision,
      scope: mutation.scope,
      root: mutationRootHash(mutation),
      values: mutation.values ?? null,
      settingIds: mutation.settingIds ?? null,
    }),
  );
}

function mutationRootHash(mutation: EditorSettingsControlMutation): string | null {
  if (mutation.scope === "user" || mutation.realRoot === undefined) return null;
  return editorSettingsWorkspaceFingerprint(mutation.realRoot);
}

function validMutation(mutation: EditorSettingsControlMutation): EditorM7ReasonCode | undefined {
  if (
    !Number.isSafeInteger(mutation.expectedRevision) ||
    mutation.expectedRevision < 0 ||
    mutation.idempotencyKey.length === 0 ||
    mutation.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS ||
    mutation.idempotencyKey.includes("\0")
  ) {
    return "INVALID_INPUT";
  }
  if (mutation.scope !== "user" && mutation.realRoot === undefined) return "UNSAFE_PATH";
  if (mutation.action === "set") return validateSetMutation(mutation);
  return validateResetMutation(mutation);
}

function validateSetMutation(
  mutation: EditorSettingsControlMutation,
): EditorM7ReasonCode | undefined {
  if (mutation.values === undefined || mutation.settingIds !== undefined) return "INVALID_INPUT";
  const parsed = parseEditorM7SettingPatch(
    mutation.scope === "root" ? "workspace" : mutation.scope,
    mutation.values,
  );
  return parsed.ok ? undefined : parsed.reasonCode;
}

function validateResetMutation(
  mutation: EditorSettingsControlMutation,
): EditorM7ReasonCode | undefined {
  if (mutation.settingIds === undefined || mutation.values !== undefined) return "INVALID_INPUT";
  const patch = Object.fromEntries(mutation.settingIds.map((id) => [id, null]));
  for (const id of mutation.settingIds) {
    const parsed = parseEditorM7SettingPatch(
      mutation.scope === "root" ? "workspace" : mutation.scope,
      { [id]: defaultComparableValue(id) },
    );
    if (!parsed.ok) return parsed.reasonCode;
  }
  return Object.keys(patch).length === mutation.settingIds.length ? undefined : "INVALID_INPUT";
}

function defaultComparableValue(id: EditorM7SettingId): EditorM7SettingValue {
  const definition = EDITOR_M7_SETTING_REGISTRY.find((entry) => entry.id === id);
  if (definition === undefined) throw new Error("unknown M7 setting id");
  return definition.defaultValue;
}

function idempotencyResult(
  record: MutableRecord,
  mutation: EditorSettingsControlMutation,
  snapshot: EditorM11SettingsSnapshot,
): EditorM11SettingsMutationResult | undefined {
  const keyHash = hash(mutation.idempotencyKey);
  const prior = record.idempotency.find((entry) => entry.keyHash === keyHash);
  if (prior === undefined) return undefined;
  if (prior.requestHash !== requestHash(mutation)) {
    return { kind: "idempotencyConflict", code: "IDEMPOTENCY_KEY_REUSED", etag: snapshot.etag };
  }
  return {
    kind: "ok",
    changed: prior.changed,
    revision: snapshot.revision,
    etag: snapshot.etag,
    snapshot,
  };
}

function appendBounded<T>(values: readonly T[], value: T, maximum: number): readonly T[] {
  return [...values, value].slice(-maximum);
}

function idempotencyRecord(
  mutation: EditorSettingsControlMutation,
  changed: boolean,
  revision: number,
): EditorSettingsIdempotencyRecord {
  return {
    keyHash: hash(mutation.idempotencyKey),
    requestHash: requestHash(mutation),
    resultKind: "ok",
    changed,
    revision,
  };
}

function changeEvent(
  mutation: EditorSettingsControlMutation,
  changed: boolean,
  sequence: number,
): EditorSettingsChangeEvent {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    sequence,
    scope: mutation.scope,
    action: mutation.action,
    settingIds: affectedIds(mutation),
    outcome: changed ? "accepted" : "noOp",
  };
}

function affectedIds(mutation: EditorSettingsControlMutation): readonly EditorM7SettingId[] {
  if (mutation.action !== "set") return mutation.settingIds ?? [];
  return mutation.values === undefined ? [] : (Object.keys(mutation.values) as EditorM7SettingId[]);
}

function debugWorkspaceActivation(
  settings: readonly EditorM11ResolvedSetting[],
): "enabled" | "disabled" | "unset" {
  const setting = settings.find((entry) => entry.id === "debuggingEnabled");
  if (setting === undefined || setting.source === "builtInDefault") return "unset";
  return setting.value === true ? "enabled" : "disabled";
}

function changedValues(
  record: MutableRecord,
  mutation: EditorSettingsControlMutation,
): Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>> {
  if (mutation.action === "set") {
    return mutation.values === undefined ? record.values : { ...record.values, ...mutation.values };
  }
  const resetIds = new Set(mutation.settingIds ?? []);
  return Object.fromEntries(
    Object.entries(record.values).filter(([id]) => !hasSettingId(resetIds, id)),
  );
}

function hasSettingId(ids: ReadonlySet<EditorM7SettingId>, value: string): boolean {
  return ids.has(value as EditorM7SettingId);
}

function recordWithMutation<T extends MutableRecord>(
  record: T,
  mutation: EditorSettingsControlMutation,
): { readonly record: T; readonly changed: boolean } {
  const nextValues = changedValues(record, mutation);
  const changed = JSON.stringify(nextValues) !== JSON.stringify(record.values);
  const revision = changed ? record.revision + 1 : record.revision;
  const next = {
    ...record,
    revision,
    values: nextValues,
    idempotency: appendBounded(
      record.idempotency,
      idempotencyRecord(mutation, changed, revision),
      MAX_IDEMPOTENCY_RECORDS,
    ),
    events: appendBounded(record.events, changeEvent(mutation, changed, revision), MAX_EVENTS),
  };
  return { record: next, changed };
}

function loadScopedRecords(
  realRoot: string | undefined,
  store: EditorSettingsStore,
): Pick<SnapshotRecords, "rootLayer" | "workspace"> {
  if (realRoot === undefined) {
    const absent = { state: "absent" as const, record: undefined };
    return { workspace: absent, rootLayer: absent };
  }
  return { workspace: store.loadWorkspace(realRoot), rootLayer: store.loadRoot(realRoot) };
}

async function loadManagedLanguageSnapshot(
  realRoot: string | undefined,
  control: ManagedLspControlService | undefined,
): Promise<ManagedLspControlSnapshot | undefined> {
  if (realRoot === undefined || control === undefined) return undefined;
  return control.read(realRoot);
}

function addDebuggingProjection(
  snapshot: EditorM11SettingsSnapshot,
  realRoot: string | undefined,
  control: DebugActivationControlService | undefined,
): EditorM11SettingsSnapshot {
  const debugging = control?.resolve({
    realRoot,
    revision: snapshot.revision,
    workspaceActivation: debugWorkspaceActivation(snapshot.settings),
  });
  return {
    ...snapshot,
    ...(debugging === undefined ? {} : { debugging }),
    ...(realRoot === undefined
      ? {}
      : { debugWorkspaceId: debugActivationWorkspaceFingerprint(realRoot) }),
  };
}

function addAiAssistanceProjection(
  snapshot: EditorM11SettingsSnapshot,
  realRoot: string | undefined,
  resolver: EditorSettingsControlOptions["aiAssistance"],
): EditorM11SettingsSnapshot {
  const aiAssistance = resolver?.({
    realRoot,
    revision: snapshot.revision,
    settings: snapshot.settings,
  });
  return aiAssistance === undefined ? snapshot : { ...snapshot, aiAssistance };
}

async function loadSnapshot(
  realRoot: string | undefined,
  options: EditorSettingsControlOptions,
): Promise<EditorM11SettingsSnapshot> {
  const user = options.store.loadUser();
  const profiles = profilesStoreFor(options).load();
  const { workspace, rootLayer } = loadScopedRecords(realRoot, options.store);
  const managedLanguageSnapshot = await loadManagedLanguageSnapshot(
    realRoot,
    options.managedLspControl,
  );
  const snapshot = snapshotFromRecords({
    realRoot,
    user,
    workspace,
    rootLayer,
    profiles,
    ceiling: options.policyCeiling?.(),
    managedLanguageSnapshot,
  });
  return addAiAssistanceProjection(
    addDebuggingProjection(snapshot, realRoot, options.debugActivation),
    realRoot,
    options.aiAssistance,
  );
}

function profilesStoreFor(options: EditorSettingsControlOptions): EditorProfilesStore {
  return options.profilesStore ?? createEditorProfilesStore({ stateDir: options.store.stateDir });
}

async function mutateLocked(
  mutation: EditorSettingsControlMutation,
  options: EditorSettingsControlOptions,
): Promise<EditorM11SettingsMutationResult> {
  const invalid = validMutation(mutation);
  if (invalid !== undefined) return { kind: "invalid", code: invalid };
  const loaded = loadMutationState(mutation, options);
  if (loaded.kind !== "ok") return loaded.result;
  const snapshot = await loadSnapshot(mutation.realRoot, options);
  const precondition = mutationPrecondition(mutation, loaded, snapshot);
  return precondition.kind === "failed"
    ? precondition.result
    : commitMutation(mutation, options, precondition.target);
}

type MutationPrecondition =
  | { readonly kind: "ok"; readonly target: MutableRecord }
  | { readonly kind: "failed"; readonly result: EditorM11SettingsMutationResult };

function mutationPrecondition(
  mutation: EditorSettingsControlMutation,
  loaded: Extract<LoadedMutationState, { readonly kind: "ok" }>,
  snapshot: EditorM11SettingsSnapshot,
): MutationPrecondition {
  const target = mutationTarget(
    mutation,
    loaded.user.record,
    loaded.workspace?.record,
    loaded.root?.record,
  );
  if (target === undefined) {
    return { kind: "failed", result: { kind: "invalid", code: "UNSAFE_PATH" } };
  }
  const replay = idempotencyResult(target, mutation, snapshot);
  if (replay !== undefined) return { kind: "failed", result: replay };
  if (
    targetRevision(mutation, loaded.user.record, loaded.workspace?.record, loaded.root?.record) !==
    mutation.expectedRevision
  ) {
    return {
      kind: "failed",
      result: { kind: "conflict", code: "STALE_REVISION", etag: snapshot.etag },
    };
  }
  if (
    !rootMutationIsMonotonic(
      mutation,
      loaded.user.record,
      loaded.workspace?.record,
      activeProfile(loaded.profiles.record),
    )
  ) {
    return { kind: "failed", result: { kind: "invalid", code: "POLICY_LOCKED" } };
  }
  return { kind: "ok", target };
}

type LoadedMutationState =
  | {
      readonly kind: "ok";
      readonly user: ReturnType<EditorSettingsStore["loadUser"]>;
      readonly profiles: EditorProfilesLoadResult;
      readonly workspace?: ReturnType<EditorSettingsStore["loadWorkspace"]> | undefined;
      readonly root?: ReturnType<EditorSettingsStore["loadRoot"]> | undefined;
    }
  | { readonly kind: "failed"; readonly result: EditorM11SettingsMutationResult };

function loadMutationState(
  mutation: EditorSettingsControlMutation,
  options: EditorSettingsControlOptions,
): LoadedMutationState {
  const user = options.store.loadUser();
  const profiles = profilesStoreFor(options).load();
  const workspace =
    mutation.realRoot === undefined ? undefined : options.store.loadWorkspace(mutation.realRoot);
  const root =
    mutation.realRoot === undefined ? undefined : options.store.loadRoot(mutation.realRoot);
  return user.state === "unavailable" ||
    profiles.state === "unavailable" ||
    workspace?.state === "unavailable" ||
    root?.state === "unavailable"
    ? { kind: "failed", result: { kind: "unavailable", code: "STATE_UNAVAILABLE" } }
    : { kind: "ok", user, profiles, workspace, root };
}

function rootMutationIsMonotonic(
  mutation: EditorSettingsControlMutation,
  user: EditorSettingsUserRecord,
  workspace: EditorSettingsWorkspaceRecord | undefined,
  profile: WorkspaceProfileManifest | undefined,
): boolean {
  if (mutation.scope !== "root" || mutation.action !== "set" || mutation.values === undefined) {
    return true;
  }
  const inherited = resolveEditorM11Settings({
    ...(profile === undefined ? {} : { profile: profile.settings }),
    user: settingsLayer("user", user.values),
    ...(workspace === undefined ? {} : { workspace: settingsLayer("workspace", workspace.values) }),
  });
  return Object.entries(mutation.values).every(([id, value]) => {
    const settingId = id as EditorM7SettingId;
    const parent = inherited.find((setting) => setting.id === settingId);
    return parent !== undefined && editorM11RootSettingIsMonotonic(settingId, parent.value, value);
  });
}

function mutationTarget(
  mutation: EditorSettingsControlMutation,
  user: EditorSettingsUserRecord,
  workspace: EditorSettingsWorkspaceRecord | undefined,
  root: EditorSettingsRootRecord | undefined,
): MutableRecord | undefined {
  if (mutation.scope === "user") return user;
  return mutation.scope === "workspace" ? workspace : root;
}

async function commitMutation(
  mutation: EditorSettingsControlMutation,
  options: EditorSettingsControlOptions,
  target: MutableRecord,
): Promise<EditorM11SettingsMutationResult> {
  const next = recordWithMutation(target, mutation);
  persistMutationRecord(next.record, mutation.realRoot, options);
  const snapshot = await loadSnapshot(mutation.realRoot, options);
  try {
    await synchronizeDebugActivation(mutation, next.changed, snapshot, options);
  } catch (error: unknown) {
    // Never leave a durable opt-in narrowed while its mandatory session teardown failed. The caller
    // receives the failure, the original setting is restored, and no stale mutation is acknowledged.
    persistMutationRecord(target, mutation.realRoot, options);
    throw error;
  }
  const finalSnapshot = await loadSnapshot(mutation.realRoot, options);
  return {
    kind: "ok",
    changed: next.changed,
    revision: finalSnapshot.revision,
    etag: finalSnapshot.etag,
    snapshot: finalSnapshot,
  };
}

function persistMutationRecord(
  record: MutableRecord,
  realRoot: string | undefined,
  options: EditorSettingsControlOptions,
): void {
  if (record.kind === "user") {
    options.store.commitUser(record);
    return;
  }
  if (realRoot === undefined) return;
  if (record.kind === "workspace") options.store.commitWorkspace(realRoot, record);
  else options.store.commitRoot(realRoot, record);
}

async function synchronizeDebugActivation(
  mutation: EditorSettingsControlMutation,
  changed: boolean,
  snapshot: EditorM11SettingsSnapshot,
  options: EditorSettingsControlOptions,
): Promise<void> {
  if (
    options.debugActivation === undefined ||
    mutation.realRoot === undefined ||
    !affectedIds(mutation).includes("debuggingEnabled")
  ) {
    return;
  }
  const setting = snapshot.settings.find((entry) => entry.id === "debuggingEnabled");
  await options.debugActivation.synchronize({
    action: setting?.value === true ? "activate" : "deactivate",
    changed,
    context: {
      realRoot: mutation.realRoot,
      revision: snapshot.revision,
      workspaceActivation: debugWorkspaceActivation(snapshot.settings),
    },
  });
}

interface AppliedProfileMutation {
  readonly changed: boolean;
  readonly profileRef: WorkspaceProfileRef;
  readonly activeProfileRef: WorkspaceProfileRef;
  readonly profiles: readonly WorkspaceProfileManifest[];
}

type ProfileMutationApplication =
  | { readonly kind: "ok"; readonly value: AppliedProfileMutation }
  | { readonly kind: "invalid"; readonly code: EditorM11ProfileReasonCode };

function validProfileMutation(
  mutation: EditorProfilesControlMutation,
): EditorM11ProfileReasonCode | undefined {
  if (!validProfileMutationEnvelope(mutation)) return "INVALID_INPUT";
  if (mutation.action === "create") return validCreateProfileMutation(mutation);
  if (mutation.action === "rename" || mutation.action === "duplicate") {
    return validNamedProfileMutation(mutation);
  }
  if (mutation.action === "set") return validSetProfileMutation(mutation);
  if (mutation.action === "reset") return validResetProfileMutation(mutation);
  return validRefOnlyProfileMutation(mutation);
}

function validProfileMutationEnvelope(mutation: EditorProfilesControlMutation): boolean {
  return (
    Number.isSafeInteger(mutation.expectedRevision) &&
    mutation.expectedRevision >= 0 &&
    mutation.idempotencyKey.length > 0 &&
    mutation.idempotencyKey.length <= MAX_IDEMPOTENCY_KEY_CHARS &&
    !mutation.idempotencyKey.includes("\0")
  );
}

function validProfileName(value: string | undefined): boolean {
  return value?.trim() === value && isWorkspaceProfileDisplayName(value);
}

function validCreateProfileMutation(
  mutation: EditorProfilesControlMutation,
): EditorM11ProfileReasonCode | undefined {
  return validProfileName(mutation.displayName) &&
    mutation.profileRef === undefined &&
    mutation.values === undefined &&
    mutation.settingIds === undefined
    ? undefined
    : "INVALID_INPUT";
}

function validNamedProfileMutation(
  mutation: EditorProfilesControlMutation,
): EditorM11ProfileReasonCode | undefined {
  return validProfileName(mutation.displayName) &&
    isWorkspaceProfileRef(mutation.profileRef) &&
    mutation.values === undefined &&
    mutation.settingIds === undefined
    ? undefined
    : "INVALID_INPUT";
}

function validRefOnlyProfileMutation(
  mutation: EditorProfilesControlMutation,
): EditorM11ProfileReasonCode | undefined {
  return isWorkspaceProfileRef(mutation.profileRef) &&
    mutation.displayName === undefined &&
    mutation.values === undefined &&
    mutation.settingIds === undefined
    ? undefined
    : "INVALID_INPUT";
}

function validSetProfileMutation(
  mutation: EditorProfilesControlMutation,
): EditorM11ProfileReasonCode | undefined {
  if (
    !isWorkspaceProfileRef(mutation.profileRef) ||
    mutation.displayName !== undefined ||
    mutation.values === undefined ||
    mutation.settingIds !== undefined
  ) {
    return "INVALID_INPUT";
  }
  const parsed = parseEditorM7SettingPatch("user", mutation.values);
  return parsed.ok ? undefined : parsed.reasonCode;
}

function validResetProfileMutation(
  mutation: EditorProfilesControlMutation,
): EditorM11ProfileReasonCode | undefined {
  if (
    !isWorkspaceProfileRef(mutation.profileRef) ||
    mutation.displayName !== undefined ||
    mutation.values !== undefined ||
    mutation.settingIds === undefined ||
    mutation.settingIds.length === 0 ||
    new Set(mutation.settingIds).size !== mutation.settingIds.length
  ) {
    return "INVALID_INPUT";
  }
  return mutation.settingIds.every(
    (id) => parseEditorM7SettingPatch("user", { [id]: defaultComparableValue(id) }).ok,
  )
    ? undefined
    : "INVALID_INPUT";
}

function profileRequestHash(mutation: EditorProfilesControlMutation): string {
  return hash(
    JSON.stringify({
      action: mutation.action,
      expectedRevision: mutation.expectedRevision,
      profileRef: mutation.profileRef ?? null,
      displayName: mutation.displayName ?? null,
      values: mutation.values ?? null,
      settingIds: mutation.settingIds ?? null,
    }),
  );
}

function profileIdempotencyResult(
  record: EditorProfilesRecord,
  mutation: EditorProfilesControlMutation,
): EditorProfilesIdempotencyRecord | "conflict" | undefined {
  const prior = record.idempotency.find((entry) => entry.keyHash === hash(mutation.idempotencyKey));
  if (prior === undefined) return undefined;
  return prior.requestHash === profileRequestHash(mutation) ? prior : "conflict";
}

function profileByRef(
  profiles: readonly WorkspaceProfileManifest[],
  profileRef: WorkspaceProfileRef,
): WorkspaceProfileManifest | undefined {
  return profiles.find((profile) => profile.profileRef === profileRef);
}

function profileNameExists(
  profiles: readonly WorkspaceProfileManifest[],
  displayName: string,
  except?: WorkspaceProfileRef,
): boolean {
  const normalized = displayName.toLowerCase();
  if (normalized === "default") return true;
  return profiles.some(
    (profile) => profile.profileRef !== except && profile.displayName.toLowerCase() === normalized,
  );
}

function profileManifest(
  profileRef: WorkspaceProfileRef,
  displayName: string,
  values: WorkspaceProfileManifest["settings"]["values"],
  revision = 0,
): WorkspaceProfileManifest {
  return {
    kind: "workspace-profile",
    schemaVersion: WORKSPACE_PROFILE_SCHEMA_VERSION,
    profileRef,
    displayName,
    revision,
    settings: {
      kind: "editor-profile-settings",
      schemaVersion: EDITOR_M11_SETTINGS_SCHEMA_VERSION,
      profileRef,
      revision,
      values,
    },
  };
}

function replaceProfile(
  profiles: readonly WorkspaceProfileManifest[],
  replacement: WorkspaceProfileManifest,
): readonly WorkspaceProfileManifest[] {
  return profiles.map((profile) =>
    profile.profileRef === replacement.profileRef ? replacement : profile,
  );
}

function nextProfileRef(
  record: EditorProfilesRecord,
  factory: () => WorkspaceProfileRef,
): WorkspaceProfileRef | undefined {
  const profileRef = factory();
  return isWorkspaceProfileRef(profileRef) &&
    profileRef !== EDITOR_M11_DEFAULT_PROFILE_REF &&
    profileByRef(record.profiles, profileRef) === undefined
    ? profileRef
    : undefined;
}

function applyCreateProfile(
  record: EditorProfilesRecord,
  mutation: EditorProfilesControlMutation,
  factory: () => WorkspaceProfileRef,
): ProfileMutationApplication {
  const displayName = mutation.displayName ?? "";
  if (record.profiles.length >= 31) return { kind: "invalid", code: "PROFILE_LIMIT_REACHED" };
  if (profileNameExists(record.profiles, displayName)) {
    return { kind: "invalid", code: "PROFILE_NAME_CONFLICT" };
  }
  const profileRef = nextProfileRef(record, factory);
  if (profileRef === undefined) return { kind: "invalid", code: "INVALID_INPUT" };
  return {
    kind: "ok",
    value: {
      changed: true,
      profileRef,
      activeProfileRef: record.activeProfileRef,
      profiles: [...record.profiles, profileManifest(profileRef, displayName, {})],
    },
  };
}

function applyRenameProfile(
  record: EditorProfilesRecord,
  mutation: EditorProfilesControlMutation,
): ProfileMutationApplication {
  const profileRef = mutation.profileRef ?? EDITOR_M11_DEFAULT_PROFILE_REF;
  if (profileRef === EDITOR_M11_DEFAULT_PROFILE_REF) {
    return { kind: "invalid", code: "DEFAULT_PROFILE_IMMUTABLE" };
  }
  const profile = profileByRef(record.profiles, profileRef);
  if (profile === undefined) return { kind: "invalid", code: "PROFILE_NOT_FOUND" };
  const displayName = mutation.displayName ?? "";
  if (profileNameExists(record.profiles, displayName, profileRef)) {
    return { kind: "invalid", code: "PROFILE_NAME_CONFLICT" };
  }
  const changed = profile.displayName !== displayName;
  const revision = changed ? profile.revision + 1 : profile.revision;
  const replacement = profileManifest(profileRef, displayName, profile.settings.values, revision);
  return {
    kind: "ok",
    value: {
      changed,
      profileRef,
      activeProfileRef: record.activeProfileRef,
      profiles: changed ? replaceProfile(record.profiles, replacement) : record.profiles,
    },
  };
}

function sourceProfile(
  record: EditorProfilesRecord,
  profileRef: WorkspaceProfileRef,
):
  | {
      readonly displayName: string;
      readonly revision: number;
      readonly values: WorkspaceProfileManifest["settings"]["values"];
    }
  | undefined {
  if (profileRef === EDITOR_M11_DEFAULT_PROFILE_REF) {
    return { displayName: "Default", revision: 0, values: {} };
  }
  const profile = profileByRef(record.profiles, profileRef);
  return profile === undefined
    ? undefined
    : {
        displayName: profile.displayName,
        revision: profile.revision,
        values: profile.settings.values,
      };
}

function applyDuplicateProfile(
  record: EditorProfilesRecord,
  mutation: EditorProfilesControlMutation,
  factory: () => WorkspaceProfileRef,
): ProfileMutationApplication {
  const sourceRef = mutation.profileRef ?? EDITOR_M11_DEFAULT_PROFILE_REF;
  const source = sourceProfile(record, sourceRef);
  if (source === undefined) return { kind: "invalid", code: "PROFILE_NOT_FOUND" };
  const displayName = mutation.displayName ?? `${source.displayName} Copy`;
  if (record.profiles.length >= 31) return { kind: "invalid", code: "PROFILE_LIMIT_REACHED" };
  if (profileNameExists(record.profiles, displayName)) {
    return { kind: "invalid", code: "PROFILE_NAME_CONFLICT" };
  }
  const profileRef = nextProfileRef(record, factory);
  if (profileRef === undefined) return { kind: "invalid", code: "INVALID_INPUT" };
  return {
    kind: "ok",
    value: {
      changed: true,
      profileRef,
      activeProfileRef: record.activeProfileRef,
      profiles: [...record.profiles, profileManifest(profileRef, displayName, source.values)],
    },
  };
}

function applyDeleteProfile(
  record: EditorProfilesRecord,
  mutation: EditorProfilesControlMutation,
): ProfileMutationApplication {
  const profileRef = mutation.profileRef ?? EDITOR_M11_DEFAULT_PROFILE_REF;
  if (profileRef === EDITOR_M11_DEFAULT_PROFILE_REF) {
    return { kind: "invalid", code: "DEFAULT_PROFILE_IMMUTABLE" };
  }
  if (profileByRef(record.profiles, profileRef) === undefined) {
    return { kind: "invalid", code: "PROFILE_NOT_FOUND" };
  }
  return {
    kind: "ok",
    value: {
      changed: true,
      profileRef,
      activeProfileRef:
        record.activeProfileRef === profileRef
          ? EDITOR_M11_DEFAULT_PROFILE_REF
          : record.activeProfileRef,
      profiles: record.profiles.filter((profile) => profile.profileRef !== profileRef),
    },
  };
}

function applySwitchProfile(
  record: EditorProfilesRecord,
  mutation: EditorProfilesControlMutation,
): ProfileMutationApplication {
  const profileRef = mutation.profileRef ?? EDITOR_M11_DEFAULT_PROFILE_REF;
  if (
    profileRef !== EDITOR_M11_DEFAULT_PROFILE_REF &&
    profileByRef(record.profiles, profileRef) === undefined
  ) {
    return { kind: "invalid", code: "PROFILE_NOT_FOUND" };
  }
  return {
    kind: "ok",
    value: {
      changed: record.activeProfileRef !== profileRef,
      profileRef,
      activeProfileRef: profileRef,
      profiles: record.profiles,
    },
  };
}

function profileValuesAfterMutation(
  profile: WorkspaceProfileManifest,
  mutation: EditorProfilesControlMutation,
): WorkspaceProfileManifest["settings"]["values"] {
  if (mutation.action === "set") return { ...profile.settings.values, ...mutation.values };
  const reset = new Set(mutation.settingIds ?? []);
  return Object.fromEntries(
    Object.entries(profile.settings.values).filter(([id]) => !reset.has(id as EditorM7SettingId)),
  );
}

function applyProfileSettingsMutation(
  record: EditorProfilesRecord,
  mutation: EditorProfilesControlMutation,
): ProfileMutationApplication {
  const profileRef = mutation.profileRef ?? EDITOR_M11_DEFAULT_PROFILE_REF;
  if (profileRef === EDITOR_M11_DEFAULT_PROFILE_REF) {
    return { kind: "invalid", code: "DEFAULT_PROFILE_IMMUTABLE" };
  }
  const profile = profileByRef(record.profiles, profileRef);
  if (profile === undefined) return { kind: "invalid", code: "PROFILE_NOT_FOUND" };
  const values = profileValuesAfterMutation(profile, mutation);
  const changed = JSON.stringify(values) !== JSON.stringify(profile.settings.values);
  const revision = changed ? profile.revision + 1 : profile.revision;
  const replacement = profileManifest(profileRef, profile.displayName, values, revision);
  return {
    kind: "ok",
    value: {
      changed,
      profileRef,
      activeProfileRef: record.activeProfileRef,
      profiles: changed ? replaceProfile(record.profiles, replacement) : record.profiles,
    },
  };
}

function applyProfileMutation(
  record: EditorProfilesRecord,
  mutation: EditorProfilesControlMutation,
  factory: () => WorkspaceProfileRef,
): ProfileMutationApplication {
  if (mutation.action === "create") return applyCreateProfile(record, mutation, factory);
  if (mutation.action === "rename") return applyRenameProfile(record, mutation);
  if (mutation.action === "duplicate") return applyDuplicateProfile(record, mutation, factory);
  if (mutation.action === "delete") return applyDeleteProfile(record, mutation);
  if (mutation.action === "switch") return applySwitchProfile(record, mutation);
  return applyProfileSettingsMutation(record, mutation);
}

function nextProfilesRecord(
  record: EditorProfilesRecord,
  mutation: EditorProfilesControlMutation,
  applied: AppliedProfileMutation,
): EditorProfilesRecord {
  const revision = applied.changed ? record.revision + 1 : record.revision;
  const idempotency: EditorProfilesIdempotencyRecord = {
    keyHash: hash(mutation.idempotencyKey),
    requestHash: profileRequestHash(mutation),
    changed: applied.changed,
    revision,
    profileRef: applied.profileRef,
  };
  const event: EditorProfilesChangeEvent = {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    sequence: (record.events.at(-1)?.sequence ?? 0) + 1,
    action: mutation.action,
    profileRef: applied.profileRef,
    outcome: applied.changed ? "accepted" : "noOp",
  };
  return {
    ...record,
    revision,
    activeProfileRef: applied.activeProfileRef,
    profiles: applied.profiles,
    idempotency: appendBounded(record.idempotency, idempotency, MAX_IDEMPOTENCY_RECORDS),
    events: appendBounded(record.events, event, MAX_EVENTS),
  };
}

function defaultProfileRefFactory(): WorkspaceProfileRef {
  const value = `profile-${randomUUID()}`;
  if (!isWorkspaceProfileRef(value)) throw new Error("generated editor profile reference invalid");
  return value;
}

function importPreview(
  record: EditorProfilesRecord,
  manifest: unknown,
): PreparedEditorProfileImport {
  const active = sourceProfile(record, record.activeProfileRef);
  return previewEditorProfileImport(manifest, {
    activeValues: active?.values ?? {},
    existingNames: record.profiles.map((profile) => profile.displayName),
    expectedRevision: record.revision,
  });
}

function signedImportPreviewDigest(signingKey: Uint8Array, digest: string): string {
  return createHmac("sha256", signingKey).update(digest, "utf8").digest("hex");
}

function importPreviewDigestMatches(
  signingKey: Uint8Array,
  digest: string,
  provided: string,
): boolean {
  const expected = Buffer.from(signedImportPreviewDigest(signingKey, digest), "hex");
  const candidate = Buffer.from(provided, "hex");
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

function exportProfileLocked(
  profileRef: WorkspaceProfileRef | undefined,
  options: EditorSettingsControlOptions,
): EditorProfileExportControlResult {
  const loaded = profilesStoreFor(options).load();
  if (loaded.state === "unavailable") {
    return { kind: "unavailable", code: "STATE_UNAVAILABLE" };
  }
  const selectedRef = profileRef ?? loaded.record.activeProfileRef;
  const selected = sourceProfile(loaded.record, selectedRef);
  return selected === undefined
    ? { kind: "invalid", code: "PROFILE_NOT_FOUND" }
    : assembleEditorProfileExport(
        profileManifest(selectedRef, selected.displayName, selected.values, selected.revision),
      );
}

function previewProfileImportLocked(
  manifest: unknown,
  expectedRevision: number,
  options: EditorSettingsControlOptions,
  signingKey: Uint8Array,
): EditorProfileImportPreviewControlResult {
  const loaded = profilesStoreFor(options).load();
  if (loaded.state === "unavailable") {
    return { kind: "unavailable", code: "STATE_UNAVAILABLE" };
  }
  if (loaded.record.revision !== expectedRevision) {
    return { kind: "conflict", code: "STALE_REVISION", etag: profileEtag(loaded.record.revision) };
  }
  const prepared = importPreview(loaded.record, manifest);
  return prepared.kind === "ok"
    ? {
        ...prepared.preview,
        previewDigest: signedImportPreviewDigest(signingKey, prepared.preview.previewDigest),
      }
    : prepared;
}

function importRequestHash(mutation: EditorProfileImportControlMutation): string {
  return hash(
    JSON.stringify({
      expectedRevision: mutation.expectedRevision,
      manifest: mutation.manifest,
      previewDigest: mutation.previewDigest,
      switchAfterImport: mutation.switchAfterImport,
    }),
  );
}

function importIdempotencyResult(
  record: EditorProfilesRecord,
  mutation: EditorProfileImportControlMutation,
): EditorProfilesIdempotencyRecord | "conflict" | undefined {
  const prior = record.idempotency.find((entry) => entry.keyHash === hash(mutation.idempotencyKey));
  if (prior === undefined) return undefined;
  return prior.requestHash === importRequestHash(mutation) ? prior : "conflict";
}

function validImportMutation(mutation: EditorProfileImportControlMutation): boolean {
  return (
    Number.isSafeInteger(mutation.expectedRevision) &&
    mutation.expectedRevision >= 0 &&
    mutation.idempotencyKey.length > 0 &&
    mutation.idempotencyKey.length <= MAX_IDEMPOTENCY_KEY_CHARS &&
    !mutation.idempotencyKey.includes("\0") &&
    /^[a-f0-9]{64}$/u.test(mutation.previewDigest)
  );
}

function importedProfilesRecord(
  record: EditorProfilesRecord,
  mutation: EditorProfileImportControlMutation,
  prepared: Extract<PreparedEditorProfileImport, { readonly kind: "ok" }>,
  profileRef: WorkspaceProfileRef,
): EditorProfilesRecord {
  const revision = record.revision + 1;
  const idempotency: EditorProfilesIdempotencyRecord = {
    keyHash: hash(mutation.idempotencyKey),
    requestHash: importRequestHash(mutation),
    changed: true,
    revision,
    profileRef,
  };
  const event: EditorProfilesChangeEvent = {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    sequence: (record.events.at(-1)?.sequence ?? 0) + 1,
    action: "create",
    profileRef,
    outcome: "accepted",
  };
  return {
    ...record,
    revision,
    activeProfileRef: mutation.switchAfterImport ? profileRef : record.activeProfileRef,
    profiles: [
      ...record.profiles,
      profileManifest(profileRef, prepared.preview.proposedDisplayName, prepared.values),
    ],
    idempotency: appendBounded(record.idempotency, idempotency, MAX_IDEMPOTENCY_RECORDS),
    events: appendBounded(record.events, event, MAX_EVENTS),
  };
}

type ApplicableProfileImport =
  | {
      readonly kind: "ok";
      readonly prepared: Extract<PreparedEditorProfileImport, { readonly kind: "ok" }>;
      readonly profileRef: WorkspaceProfileRef;
    }
  | {
      readonly kind: "invalid";
      readonly code: EditorM11ProfileReasonCode | WorkspaceProfileImportFailureCode;
    };

function applicableProfileImport(
  record: EditorProfilesRecord,
  mutation: EditorProfileImportControlMutation,
  options: EditorSettingsControlOptions,
  signingKey: Uint8Array,
): ApplicableProfileImport {
  if (record.profiles.length >= 31) return { kind: "invalid", code: "PROFILE_LIMIT_REACHED" };
  const prepared = importPreview(record, mutation.manifest);
  if (prepared.kind === "invalid") return prepared;
  if (
    !importPreviewDigestMatches(signingKey, prepared.preview.previewDigest, mutation.previewDigest)
  ) {
    return { kind: "invalid", code: "PREVIEW_MISMATCH" };
  }
  const profileRef = nextProfileRef(record, options.profileRefFactory ?? defaultProfileRefFactory);
  return profileRef === undefined
    ? { kind: "invalid", code: "INVALID_INPUT" }
    : { kind: "ok", prepared, profileRef };
}

async function profileMutationOk(
  mutation: { readonly realRoot?: string | undefined },
  record: EditorProfilesRecord,
  idempotency: EditorProfilesIdempotencyRecord,
  options: EditorSettingsControlOptions,
): Promise<EditorM11ProfileMutationResult> {
  const settings = await loadSnapshot(mutation.realRoot, options);
  const profiles = settings.profiles ?? profilesSnapshot({ state: "ready", record });
  return {
    kind: "ok",
    changed: idempotency.changed,
    profileRef: idempotency.profileRef,
    revision: profiles.revision,
    etag: profiles.etag,
    profiles,
    settings,
  };
}

async function applyProfileImportLocked(
  mutation: EditorProfileImportControlMutation,
  options: EditorSettingsControlOptions,
  signingKey: Uint8Array,
): Promise<EditorProfileImportApplyResult> {
  if (!validImportMutation(mutation)) return { kind: "invalid", code: "INVALID_MANIFEST" };
  const store = profilesStoreFor(options);
  const loaded = store.load();
  if (loaded.state === "unavailable") {
    return { kind: "unavailable", code: "STATE_UNAVAILABLE" };
  }
  const prior = importIdempotencyResult(loaded.record, mutation);
  if (prior === "conflict") {
    return {
      kind: "idempotencyConflict",
      code: "IDEMPOTENCY_KEY_REUSED",
      etag: profileEtag(loaded.record.revision),
    };
  }
  if (prior !== undefined) return profileMutationOk(mutation, loaded.record, prior, options);
  if (loaded.record.revision !== mutation.expectedRevision) {
    return { kind: "conflict", code: "STALE_REVISION", etag: profileEtag(loaded.record.revision) };
  }
  const applicable = applicableProfileImport(loaded.record, mutation, options, signingKey);
  if (applicable.kind === "invalid") return applicable;
  const record = importedProfilesRecord(
    loaded.record,
    mutation,
    applicable.prepared,
    applicable.profileRef,
  );
  store.commit(record);
  const idempotency = record.idempotency.at(-1);
  if (idempotency === undefined) throw new Error("editor profile idempotency record missing");
  return profileMutationOk(mutation, record, idempotency, options);
}

async function mutateProfileLocked(
  mutation: EditorProfilesControlMutation,
  options: EditorSettingsControlOptions,
): Promise<EditorM11ProfileMutationResult> {
  const invalid = validProfileMutation(mutation);
  if (invalid !== undefined) return { kind: "invalid", code: invalid };
  const store = profilesStoreFor(options);
  const loaded = store.load();
  if (loaded.state === "unavailable") {
    return { kind: "unavailable", code: "STATE_UNAVAILABLE" };
  }
  const prior = profileIdempotencyResult(loaded.record, mutation);
  if (prior === "conflict") {
    return {
      kind: "idempotencyConflict",
      code: "IDEMPOTENCY_KEY_REUSED",
      etag: profileEtag(loaded.record.revision),
    };
  }
  if (prior !== undefined) return profileMutationOk(mutation, loaded.record, prior, options);
  if (loaded.record.revision !== mutation.expectedRevision) {
    return {
      kind: "conflict",
      code: "STALE_REVISION",
      etag: profileEtag(loaded.record.revision),
    };
  }
  const applied = applyProfileMutation(
    loaded.record,
    mutation,
    options.profileRefFactory ?? defaultProfileRefFactory,
  );
  if (applied.kind === "invalid") return applied;
  const record = nextProfilesRecord(loaded.record, mutation, applied.value);
  store.commit(record);
  const idempotency = record.idempotency.at(-1);
  if (idempotency === undefined) throw new Error("editor profile idempotency record missing");
  return profileMutationOk(mutation, record, idempotency, options);
}

export function createEditorSettingsControlService(
  options: EditorSettingsControlOptions,
): EditorSettingsControlService {
  const profileImportSigningKey = randomBytes(32);
  return {
    stateDir: options.store.stateDir,
    read: (realRoot): Promise<EditorM11SettingsSnapshot> => loadSnapshot(realRoot, options),
    readProfiles: (): Promise<EditorM11ProfilesSnapshot> =>
      Promise.resolve(profilesSnapshot(profilesStoreFor(options).load())),
    mutate: (mutation): Promise<EditorM11SettingsMutationResult> => {
      const rootKey =
        mutation.scope === "user" || mutation.realRoot === undefined
          ? "global"
          : editorSettingsWorkspaceFingerprint(mutation.realRoot);
      return options.mutex.runExclusive([`editor-settings:${mutation.scope}:${rootKey}`], () =>
        mutateLocked(mutation, options),
      );
    },
    mutateProfile: (mutation): Promise<EditorM11ProfileMutationResult> =>
      options.mutex.runExclusive(["editor-settings:user:global"], () =>
        mutateProfileLocked(mutation, options),
      ),
    exportProfile: (profileRef): Promise<EditorProfileExportControlResult> =>
      options.mutex.runExclusive(["editor-settings:user:global"], () =>
        Promise.resolve(exportProfileLocked(profileRef, options)),
      ),
    previewProfileImport: (
      value,
      expectedRevision,
    ): Promise<EditorProfileImportPreviewControlResult> =>
      options.mutex.runExclusive(["editor-settings:user:global"], () =>
        Promise.resolve(
          previewProfileImportLocked(value, expectedRevision, options, profileImportSigningKey),
        ),
      ),
    applyProfileImport: (mutation): Promise<EditorProfileImportApplyResult> =>
      options.mutex.runExclusive(["editor-settings:user:global"], () =>
        applyProfileImportLocked(mutation, options, profileImportSigningKey),
      ),
  };
}
