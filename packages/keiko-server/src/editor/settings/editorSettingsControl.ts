import { createHash } from "node:crypto";

import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  EDITOR_M11_SETTINGS_SCHEMA_VERSION,
  editorM11RootSettingIsMonotonic,
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
  type EditorM11RootSettingsLayer,
  type EditorM11SettingScope,
  type EditorM11SettingsMutationResult,
  type EditorM11SettingsSnapshot,
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
  readonly mutate: (
    mutation: EditorSettingsControlMutation,
  ) => Promise<EditorM11SettingsMutationResult>;
}

export interface EditorSettingsControlOptions {
  readonly store: EditorSettingsStore;
  readonly mutex: WorkspaceMutexRegistry;
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
): number {
  return userRevision * 1_000_000_000_000 + workspaceRevision * 1_000_000 + rootRevision;
}

function etag(
  realRoot: string | undefined,
  userRevision: number,
  workspaceRevision: number,
  rootRevision: number,
): string {
  const rootToken = realRoot === undefined ? "user" : editorSettingsWorkspaceFingerprint(realRoot);
  return `"edm7-${String(userRevision)}-${String(workspaceRevision)}-${String(rootRevision)}-${rootToken.slice(0, 24)}"`;
}

function combinedState(
  userState: EditorSettingsStoreState,
  workspaceState: EditorSettingsStoreState,
  rootState: EditorSettingsStoreState,
): EditorM7StoreState {
  if (
    userState === "unavailable" ||
    workspaceState === "unavailable" ||
    rootState === "unavailable"
  ) {
    return "unavailable";
  }
  return userState === "ready" || workspaceState === "ready" || rootState === "ready"
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
  );
}

function snapshotFromRecords(args: SnapshotRecords): EditorM11SettingsSnapshot {
  const workspaceRevision = optionalRecordRevision(args.workspace.record);
  const rootRevision = optionalRecordRevision(args.rootLayer.record);
  const userRevision = args.user.record.revision;
  const identity =
    args.realRoot === undefined ? undefined : inspectWorkspaceRootIdentity(args.realRoot);
  const settings = effectiveSettings(
    args.user.record,
    args.workspace.record,
    args.rootLayer.record,
    identity,
    args.ceiling,
  );
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: combinedState(args.user.state, args.workspace.state, args.rootLayer.state),
    userRevision,
    workspaceRevision,
    rootRevision,
    revision: revisionFor(userRevision, workspaceRevision, rootRevision),
    etag: etag(args.realRoot, userRevision, workspaceRevision, rootRevision),
    ...rootSnapshotFields(args.realRoot, identity),
    definitions: EDITOR_M7_SETTING_REGISTRY,
    settings,
    eventSequence: latestEventSequence(args),
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
  identity: RootIdentity | undefined,
  ceiling: EditorM7PolicyCeiling | undefined,
): readonly EditorM11ResolvedSetting[] {
  return resolveEditorM11Settings({
    user: settingsLayer("user", user.values),
    ...(workspace === undefined ? {} : { workspace: settingsLayer("workspace", workspace.values) }),
    ...(root === undefined || identity === undefined
      ? {}
      : { root: rootSettingsLayer(root, identity) }),
    ...(ceiling === undefined ? {} : { ceiling }),
  });
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
    ceiling: options.policyCeiling?.(),
    managedLanguageSnapshot,
  });
  return addAiAssistanceProjection(
    addDebuggingProjection(snapshot, realRoot, options.debugActivation),
    realRoot,
    options.aiAssistance,
  );
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
  if (!rootMutationIsMonotonic(mutation, loaded.user.record, loaded.workspace?.record)) {
    return { kind: "failed", result: { kind: "invalid", code: "POLICY_LOCKED" } };
  }
  return { kind: "ok", target };
}

type LoadedMutationState =
  | {
      readonly kind: "ok";
      readonly user: ReturnType<EditorSettingsStore["loadUser"]>;
      readonly workspace?: ReturnType<EditorSettingsStore["loadWorkspace"]> | undefined;
      readonly root?: ReturnType<EditorSettingsStore["loadRoot"]> | undefined;
    }
  | { readonly kind: "failed"; readonly result: EditorM11SettingsMutationResult };

function loadMutationState(
  mutation: EditorSettingsControlMutation,
  options: EditorSettingsControlOptions,
): LoadedMutationState {
  const user = options.store.loadUser();
  const workspace =
    mutation.realRoot === undefined ? undefined : options.store.loadWorkspace(mutation.realRoot);
  const root =
    mutation.realRoot === undefined ? undefined : options.store.loadRoot(mutation.realRoot);
  return user.state === "unavailable" ||
    workspace?.state === "unavailable" ||
    root?.state === "unavailable"
    ? { kind: "failed", result: { kind: "unavailable", code: "STATE_UNAVAILABLE" } }
    : { kind: "ok", user, workspace, root };
}

function rootMutationIsMonotonic(
  mutation: EditorSettingsControlMutation,
  user: EditorSettingsUserRecord,
  workspace: EditorSettingsWorkspaceRecord | undefined,
): boolean {
  if (mutation.scope !== "root" || mutation.action !== "set" || mutation.values === undefined) {
    return true;
  }
  const inherited = resolveEditorM11Settings({
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

export function createEditorSettingsControlService(
  options: EditorSettingsControlOptions,
): EditorSettingsControlService {
  return {
    stateDir: options.store.stateDir,
    read: (realRoot): Promise<EditorM11SettingsSnapshot> => loadSnapshot(realRoot, options),
    mutate: (mutation): Promise<EditorM11SettingsMutationResult> => {
      const rootKey =
        mutation.scope === "user" || mutation.realRoot === undefined
          ? "global"
          : editorSettingsWorkspaceFingerprint(mutation.realRoot);
      return options.mutex.runExclusive([`editor-settings:${mutation.scope}:${rootKey}`], () =>
        mutateLocked(mutation, options),
      );
    },
  };
}
