import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type {
  EditorM11ProfileMutationAction,
  WorkspaceProfileManifest,
  WorkspaceProfileRef,
} from "@oscharko-dev/keiko-contracts";
import { EDITOR_M7_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-m7";
import { EDITOR_M11_DEFAULT_PROFILE_REF } from "@oscharko-dev/keiko-contracts/runtime/editor-m11-settings";
import {
  isReservedWorkspaceProfileDisplayName,
  validateWorkspaceProfileManifest,
  workspaceProfileDisplayNameKey,
} from "@oscharko-dev/keiko-contracts/runtime/workspace-profile";
import { isWorkspaceProfileRef } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";

import { assertNoSymlinkedPathSegments, savePrivateJson } from "../../private-json.js";

const MAX_RECORD_BYTES = 512 * 1024;
const MAX_IDEMPOTENCY_RECORDS = 64;
const MAX_EVENTS = 128;
const MAX_CUSTOM_PROFILES = 31;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type EditorProfilesStoreState = "absent" | "ready" | "unavailable";

export interface EditorProfilesIdempotencyRecord {
  readonly keyHash: string;
  readonly requestHash: string;
  readonly changed: boolean;
  readonly revision: number;
  readonly profileRef: WorkspaceProfileRef;
}

export interface EditorProfilesChangeEvent {
  readonly schemaVersion: typeof EDITOR_M7_SCHEMA_VERSION;
  readonly sequence: number;
  readonly action: EditorM11ProfileMutationAction;
  readonly profileRef: WorkspaceProfileRef;
  readonly outcome: "accepted" | "noOp";
}

export interface EditorProfilesRecord {
  readonly kind: "editor-profiles";
  readonly schemaVersion: typeof EDITOR_M7_SCHEMA_VERSION;
  readonly revision: number;
  readonly activeProfileRef: WorkspaceProfileRef;
  readonly profiles: readonly WorkspaceProfileManifest[];
  readonly idempotency: readonly EditorProfilesIdempotencyRecord[];
  readonly events: readonly EditorProfilesChangeEvent[];
}

export interface EditorProfilesLoadResult {
  readonly state: EditorProfilesStoreState;
  readonly record: EditorProfilesRecord;
}

export interface EditorProfilesStore {
  readonly stateDir: string;
  readonly load: () => EditorProfilesLoadResult;
  readonly commit: (record: EditorProfilesRecord) => void;
}

export interface EditorProfilesStoreOptions {
  readonly stateDir: string;
  readonly save?: ((path: string, value: Record<string, unknown>) => void) | undefined;
  readonly read?: ((path: string) => string) | undefined;
  readonly size?: ((path: string) => number) | undefined;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

export function editorProfilesRecordPath(stateDir: string): string {
  return join(stateDir, "editor-settings-profiles.json");
}

export function emptyEditorProfilesRecord(): EditorProfilesRecord {
  return {
    kind: "editor-profiles",
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    revision: 0,
    activeProfileRef: EDITOR_M11_DEFAULT_PROFILE_REF,
    profiles: [],
    idempotency: [],
    events: [],
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function parseIdempotencyRecord(value: unknown): EditorProfilesIdempotencyRecord | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, idempotencyKeys())) return undefined;
  if (!isSha(value.keyHash) || !isSha(value.requestHash)) return undefined;
  if (typeof value.changed !== "boolean" || !isRevision(value.revision)) return undefined;
  return isWorkspaceProfileRef(value.profileRef)
    ? (value as unknown as EditorProfilesIdempotencyRecord)
    : undefined;
}

function idempotencyKeys(): readonly string[] {
  return ["keyHash", "requestHash", "changed", "revision", "profileRef"];
}

function parseIdempotency(value: unknown): readonly EditorProfilesIdempotencyRecord[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_IDEMPOTENCY_RECORDS) return undefined;
  const records = value.map(parseIdempotencyRecord);
  return records.includes(undefined)
    ? undefined
    : (records as readonly EditorProfilesIdempotencyRecord[]);
}

function isProfileAction(value: unknown): value is EditorM11ProfileMutationAction {
  return ["create", "rename", "duplicate", "delete", "switch", "set", "reset"].includes(
    value as EditorM11ProfileMutationAction,
  );
}

function parseEvent(value: unknown): EditorProfilesChangeEvent | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, eventKeys())) return undefined;
  if (value.schemaVersion !== EDITOR_M7_SCHEMA_VERSION || !isRevision(value.sequence)) {
    return undefined;
  }
  if (!isProfileAction(value.action) || !isWorkspaceProfileRef(value.profileRef)) return undefined;
  return value.outcome === "accepted" || value.outcome === "noOp"
    ? (value as unknown as EditorProfilesChangeEvent)
    : undefined;
}

function eventKeys(): readonly string[] {
  return ["schemaVersion", "sequence", "action", "profileRef", "outcome"];
}

function parseEvents(value: unknown): readonly EditorProfilesChangeEvent[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_EVENTS) return undefined;
  const events = value.map(parseEvent);
  return events.includes(undefined) ? undefined : (events as readonly EditorProfilesChangeEvent[]);
}

function parseProfile(value: unknown): WorkspaceProfileManifest | undefined {
  return validateWorkspaceProfileManifest(value).ok
    ? (value as WorkspaceProfileManifest)
    : undefined;
}

function parseProfiles(value: unknown): readonly WorkspaceProfileManifest[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_PROFILES) return undefined;
  const profiles = value.map(parseProfile);
  if (profiles.includes(undefined)) return undefined;
  const defined = profiles as readonly WorkspaceProfileManifest[];
  return profilesAreUnique(defined) ? defined : undefined;
}

// The reserved-name and collision decisions belong to the one key that defines when two display
// names are the same name to a reader (#2618): it trims as well as lower-cases. This function still
// only lower-cased, so a persisted profile named " Default " passed both checks and shadowed the
// built-in one in the picker — two entries reading "Default" with no way to tell which is which.
// The looser `isWorkspaceProfileDisplayName` parse predicate stays untouched on purpose: this is
// about identity, not about tightening what an already-persisted manifest may contain.
function profilesAreUnique(profiles: readonly WorkspaceProfileManifest[]): boolean {
  const refs = profiles.map((profile) => profile.profileRef);
  const names = profiles.map((profile) => workspaceProfileDisplayNameKey(profile.displayName));
  return (
    !refs.includes(EDITOR_M11_DEFAULT_PROFILE_REF) &&
    !profiles.some((profile) => isReservedWorkspaceProfileDisplayName(profile.displayName)) &&
    new Set(refs).size === refs.length &&
    new Set(names).size === names.length
  );
}

function activeProfileExists(
  activeProfileRef: WorkspaceProfileRef,
  profiles: readonly WorkspaceProfileManifest[],
): boolean {
  return (
    activeProfileRef === EDITOR_M11_DEFAULT_PROFILE_REF ||
    profiles.some((profile) => profile.profileRef === activeProfileRef)
  );
}

function parseRecord(value: unknown): EditorProfilesRecord | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, recordKeys())) return undefined;
  if (!hasValidRecordIdentity(value)) return undefined;
  const profiles = parseProfiles(value.profiles);
  const idempotency = parseIdempotency(value.idempotency);
  const events = parseEvents(value.events);
  if (profiles === undefined || idempotency === undefined || events === undefined) return undefined;
  if (!activeProfileExists(value.activeProfileRef, profiles)) return undefined;
  return { ...value, profiles, idempotency, events } as EditorProfilesRecord;
}

function hasValidRecordIdentity(value: UnknownRecord): value is UnknownRecord & {
  readonly revision: number;
  readonly activeProfileRef: WorkspaceProfileRef;
} {
  return (
    value.kind === "editor-profiles" &&
    value.schemaVersion === EDITOR_M7_SCHEMA_VERSION &&
    isRevision(value.revision) &&
    isWorkspaceProfileRef(value.activeProfileRef)
  );
}

function recordKeys(): readonly string[] {
  return [
    "kind",
    "schemaVersion",
    "revision",
    "activeProfileRef",
    "profiles",
    "idempotency",
    "events",
  ];
}

function safeRecordPath(path: string): boolean {
  try {
    assertNoSymlinkedPathSegments(path);
    return true;
  } catch {
    return false;
  }
}

function loadRecord(options: EditorProfilesStoreOptions): EditorProfilesLoadResult {
  const empty = emptyEditorProfilesRecord();
  const path = editorProfilesRecordPath(options.stateDir);
  if (!safeRecordPath(path)) return { state: "unavailable", record: empty };
  try {
    if (!existsSync(path)) return { state: "absent", record: empty };
    const size = options.size?.(path) ?? statSync(path).size;
    if (size > MAX_RECORD_BYTES) return { state: "unavailable", record: empty };
    const raw = JSON.parse(options.read?.(path) ?? readFileSync(path, "utf8")) as unknown;
    const record = parseRecord(raw);
    return record === undefined
      ? { state: "unavailable", record: empty }
      : { state: "ready", record };
  } catch {
    return { state: "unavailable", record: empty };
  }
}

function recordForWrite(record: EditorProfilesRecord): Record<string, unknown> {
  return {
    kind: record.kind,
    schemaVersion: record.schemaVersion,
    revision: record.revision,
    activeProfileRef: record.activeProfileRef,
    profiles: record.profiles,
    idempotency: record.idempotency,
    events: record.events,
  };
}

export function createEditorProfilesStore(
  options: EditorProfilesStoreOptions,
): EditorProfilesStore {
  const save = options.save ?? savePrivateJson;
  return {
    stateDir: options.stateDir,
    load: (): EditorProfilesLoadResult => loadRecord(options),
    commit: (record): void => {
      if (parseRecord(record) === undefined) throw new Error("editor profiles record invalid");
      save(editorProfilesRecordPath(options.stateDir), recordForWrite(record));
    },
  };
}
