import { createHash } from "node:crypto";

import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  parseEditorM7SettingPatch,
  resolveEditorM7Settings,
  type EditorM7AiActivationSummary,
  type EditorM7PolicyCeiling,
  type EditorM7ReasonCode,
  type EditorM7ResolvedSetting,
  type EditorM7SettingId,
  type EditorM7SettingScope,
  type EditorM7SettingValue,
  type EditorM7SettingsMutationAction,
  type EditorM7SettingsMutationResult,
  type EditorM7SettingsSnapshot,
  type EditorM7StoreState,
} from "@oscharko-dev/keiko-contracts";

import type { WorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import type {
  ManagedLspControlService,
  ManagedLspControlSnapshot,
} from "../lsp/managedLspControl.js";
import {
  editorSettingsWorkspaceFingerprint,
  type EditorSettingsChangeEvent,
  type EditorSettingsIdempotencyRecord,
  type EditorSettingsStore,
  type EditorSettingsStoreState,
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
  readonly scope: EditorM7SettingScope;
  readonly values?: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>> | undefined;
  readonly settingIds?: readonly EditorM7SettingId[] | undefined;
}

export interface EditorSettingsControlService {
  readonly stateDir: string;
  readonly read: (realRoot?: string) => Promise<EditorM7SettingsSnapshot>;
  readonly mutate: (
    mutation: EditorSettingsControlMutation,
  ) => Promise<EditorM7SettingsMutationResult>;
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
        readonly settings: readonly EditorM7ResolvedSetting[];
      }) => EditorM7AiActivationSummary)
    | undefined;
}

type MutableRecord = EditorSettingsUserRecord | EditorSettingsWorkspaceRecord;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function revisionFor(userRevision: number, workspaceRevision: number): number {
  return userRevision * 1_000_000 + workspaceRevision;
}

function etag(
  realRoot: string | undefined,
  userRevision: number,
  workspaceRevision: number,
): string {
  const rootToken = realRoot === undefined ? "user" : editorSettingsWorkspaceFingerprint(realRoot);
  return `"edm7-${String(userRevision)}-${String(workspaceRevision)}-${rootToken.slice(0, 24)}"`;
}

function combinedState(
  userState: EditorSettingsStoreState,
  workspaceState: EditorSettingsStoreState,
): EditorM7StoreState {
  if (userState === "unavailable" || workspaceState === "unavailable") return "unavailable";
  return userState === "ready" || workspaceState === "ready" ? "ready" : "absent";
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

function snapshotFromRecords(args: {
  readonly realRoot?: string | undefined;
  readonly user: {
    readonly state: EditorSettingsStoreState;
    readonly record: EditorSettingsUserRecord;
  };
  readonly workspace: {
    readonly state: EditorSettingsStoreState;
    readonly record: EditorSettingsWorkspaceRecord | undefined;
  };
  readonly ceiling?: EditorM7PolicyCeiling | undefined;
  readonly managedLanguageSnapshot?: ManagedLspControlSnapshot | undefined;
  readonly aiAssistance?: EditorM7AiActivationSummary | undefined;
}): EditorM7SettingsSnapshot {
  const workspaceRevision = args.workspace.record?.revision ?? 0;
  const userRevision = args.user.record.revision;
  const settings = effectiveSettings(args.user.record, args.workspace.record, args.ceiling);
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: combinedState(args.user.state, args.workspace.state),
    userRevision,
    workspaceRevision,
    revision: revisionFor(userRevision, workspaceRevision),
    etag: etag(args.realRoot, userRevision, workspaceRevision),
    ...(args.realRoot === undefined ? {} : { root: args.realRoot }),
    definitions: EDITOR_M7_SETTING_REGISTRY,
    settings,
    eventSequence: Math.max(
      eventSequence(args.user.record),
      eventSequence(args.workspace.record ?? args.user.record),
    ),
    ...(args.managedLanguageSnapshot === undefined
      ? {}
      : { managedLanguages: managedLanguageSummary(args.managedLanguageSnapshot) }),
    ...(args.aiAssistance === undefined ? {} : { aiAssistance: args.aiAssistance }),
  };
}

function managedLanguageSummary(
  snapshot: ManagedLspControlSnapshot,
): NonNullable<EditorM7SettingsSnapshot["managedLanguages"]> {
  return {
    revision: snapshot.revision,
    etag: snapshot.etag,
    storeState: snapshot.storeState,
    settingsCount: snapshot.settings.length,
  };
}

function effectiveSettings(
  user: EditorSettingsUserRecord,
  workspace: EditorSettingsWorkspaceRecord | undefined,
  ceiling: EditorM7PolicyCeiling | undefined,
): readonly EditorM7ResolvedSetting[] {
  return resolveEditorM7Settings({
    user: settingsLayer("user", user.values),
    ...(workspace === undefined ? {} : { workspace: settingsLayer("workspace", workspace.values) }),
    ...(ceiling === undefined ? {} : { ceiling }),
  });
}

function targetRevision(
  mutation: EditorSettingsControlMutation,
  user: EditorSettingsUserRecord,
  workspace: EditorSettingsWorkspaceRecord | undefined,
): number {
  return mutation.scope === "user" ? user.revision : (workspace?.revision ?? 0);
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
  if (mutation.scope === "workspace" && mutation.realRoot === undefined) return "UNSAFE_PATH";
  if (mutation.action === "set") return validateSetMutation(mutation);
  return validateResetMutation(mutation);
}

function validateSetMutation(
  mutation: EditorSettingsControlMutation,
): EditorM7ReasonCode | undefined {
  if (mutation.values === undefined || mutation.settingIds !== undefined) return "INVALID_INPUT";
  const parsed = parseEditorM7SettingPatch(mutation.scope, mutation.values);
  return parsed.ok ? undefined : parsed.reasonCode;
}

function validateResetMutation(
  mutation: EditorSettingsControlMutation,
): EditorM7ReasonCode | undefined {
  if (mutation.settingIds === undefined || mutation.values !== undefined) return "INVALID_INPUT";
  const patch = Object.fromEntries(mutation.settingIds.map((id) => [id, null]));
  for (const id of mutation.settingIds) {
    const parsed = parseEditorM7SettingPatch(mutation.scope, { [id]: defaultComparableValue(id) });
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
  snapshot: EditorM7SettingsSnapshot,
): EditorM7SettingsMutationResult | undefined {
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

async function loadSnapshot(
  realRoot: string | undefined,
  options: EditorSettingsControlOptions,
): Promise<EditorM7SettingsSnapshot> {
  const user = options.store.loadUser();
  const workspace =
    realRoot === undefined
      ? { state: "absent" as const, record: undefined }
      : options.store.loadWorkspace(realRoot);
  const managedLanguageSnapshot =
    realRoot === undefined ? undefined : await options.managedLspControl?.read(realRoot);
  const snapshot = snapshotFromRecords({
    realRoot,
    user,
    workspace,
    ceiling: options.policyCeiling?.(),
    managedLanguageSnapshot,
  });
  const aiAssistance = options.aiAssistance?.({
    realRoot,
    revision: snapshot.revision,
    settings: snapshot.settings,
  });
  return aiAssistance === undefined ? snapshot : { ...snapshot, aiAssistance };
}

async function mutateLocked(
  mutation: EditorSettingsControlMutation,
  options: EditorSettingsControlOptions,
): Promise<EditorM7SettingsMutationResult> {
  const invalid = validMutation(mutation);
  if (invalid !== undefined) return { kind: "invalid", code: invalid };
  const loaded = loadMutationState(mutation, options);
  if (loaded.kind !== "ok") return loaded.result;
  const snapshot = await loadSnapshot(mutation.realRoot, options);
  const target = mutationTarget(mutation, loaded.user.record, loaded.workspace?.record);
  if (target === undefined) return { kind: "invalid", code: "UNSAFE_PATH" };
  const replay = idempotencyResult(target, mutation, snapshot);
  if (replay !== undefined) return replay;
  if (
    targetRevision(mutation, loaded.user.record, loaded.workspace?.record) !==
    mutation.expectedRevision
  ) {
    return { kind: "conflict", code: "STALE_REVISION", etag: snapshot.etag };
  }
  return commitMutation(mutation, options, target);
}

type LoadedMutationState =
  | {
      readonly kind: "ok";
      readonly user: ReturnType<EditorSettingsStore["loadUser"]>;
      readonly workspace?: ReturnType<EditorSettingsStore["loadWorkspace"]> | undefined;
    }
  | { readonly kind: "failed"; readonly result: EditorM7SettingsMutationResult };

function loadMutationState(
  mutation: EditorSettingsControlMutation,
  options: EditorSettingsControlOptions,
): LoadedMutationState {
  const user = options.store.loadUser();
  const workspace =
    mutation.realRoot === undefined ? undefined : options.store.loadWorkspace(mutation.realRoot);
  return user.state === "unavailable" || workspace?.state === "unavailable"
    ? { kind: "failed", result: { kind: "unavailable", code: "STATE_UNAVAILABLE" } }
    : { kind: "ok", user, workspace };
}

function mutationTarget(
  mutation: EditorSettingsControlMutation,
  user: EditorSettingsUserRecord,
  workspace: EditorSettingsWorkspaceRecord | undefined,
): MutableRecord | undefined {
  return mutation.scope === "user" ? user : workspace;
}

async function commitMutation(
  mutation: EditorSettingsControlMutation,
  options: EditorSettingsControlOptions,
  target: MutableRecord,
): Promise<EditorM7SettingsMutationResult> {
  const next = recordWithMutation(target, mutation);
  if (next.record.kind === "user") options.store.commitUser(next.record);
  else if (mutation.realRoot !== undefined)
    options.store.commitWorkspace(mutation.realRoot, next.record);
  const snapshot = await loadSnapshot(mutation.realRoot, options);
  return {
    kind: "ok",
    changed: next.changed,
    revision: snapshot.revision,
    etag: snapshot.etag,
    snapshot,
  };
}

export function createEditorSettingsControlService(
  options: EditorSettingsControlOptions,
): EditorSettingsControlService {
  return {
    stateDir: options.store.stateDir,
    read: (realRoot): Promise<EditorM7SettingsSnapshot> => loadSnapshot(realRoot, options),
    mutate: (mutation): Promise<EditorM7SettingsMutationResult> => {
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
