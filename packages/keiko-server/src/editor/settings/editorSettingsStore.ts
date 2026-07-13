import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  EDITOR_M7_SCHEMA_VERSION,
  parseEditorM7SettingPatch,
  type EditorM7ReasonCode,
  type EditorM7SettingId,
  type EditorM7SettingScope,
  type EditorM7SettingValue,
} from "@oscharko-dev/keiko-contracts";
import { containsPath } from "@oscharko-dev/keiko-git";

import { assertNoSymlinkedPathSegments, savePrivateJson } from "../../private-json.js";

const MAX_RECORD_BYTES = 512 * 1024;
const MAX_IDEMPOTENCY_RECORDS = 64;
const MAX_EVENTS = 128;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type EditorSettingsStoreState = "absent" | "ready" | "unavailable";

export interface EditorSettingsIdempotencyRecord {
  readonly keyHash: string;
  readonly requestHash: string;
  readonly resultKind: "ok" | "invalid";
  readonly changed: boolean;
  readonly revision: number;
}

export interface EditorSettingsChangeEvent {
  readonly schemaVersion: typeof EDITOR_M7_SCHEMA_VERSION;
  readonly sequence: number;
  readonly scope: EditorM7SettingScope;
  readonly action: "set" | "reset";
  readonly settingIds: readonly EditorM7SettingId[];
  readonly outcome: "accepted" | "noOp" | "rejected";
  readonly reasonCode?: EditorM7ReasonCode | undefined;
}

interface EditorSettingsRecordBase {
  readonly schemaVersion: typeof EDITOR_M7_SCHEMA_VERSION;
  readonly revision: number;
  readonly values: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>>;
  readonly idempotency: readonly EditorSettingsIdempotencyRecord[];
  readonly events: readonly EditorSettingsChangeEvent[];
}

export interface EditorSettingsUserRecord extends EditorSettingsRecordBase {
  readonly kind: "user";
}

export interface EditorSettingsWorkspaceRecord extends EditorSettingsRecordBase {
  readonly kind: "workspace";
  readonly workspaceFingerprint: string;
}

export interface EditorSettingsLoadResult<T extends EditorSettingsRecordBase> {
  readonly state: EditorSettingsStoreState;
  readonly record: T;
}

export interface EditorSettingsStore {
  readonly stateDir: string;
  readonly loadUser: () => EditorSettingsLoadResult<EditorSettingsUserRecord>;
  readonly loadWorkspace: (
    realRoot: string,
  ) => EditorSettingsLoadResult<EditorSettingsWorkspaceRecord>;
  readonly commitUser: (record: EditorSettingsUserRecord) => void;
  readonly commitWorkspace: (realRoot: string, record: EditorSettingsWorkspaceRecord) => void;
}

export interface EditorSettingsStoreOptions {
  readonly stateDir: string;
  readonly save?: ((path: string, value: Record<string, unknown>) => void) | undefined;
  readonly read?: ((path: string) => string) | undefined;
  readonly size?: ((path: string) => number) | undefined;
}

type UnknownRecord = Readonly<Record<string, unknown>>;
type JsonLoadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "oversized" }
  | { readonly kind: "value"; readonly value: unknown };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function editorSettingsWorkspaceFingerprint(realRoot: string): string {
  return sha256(realRoot);
}

export function editorSettingsUserRecordPath(stateDir: string): string {
  return join(stateDir, "editor-settings-user.json");
}

export function editorSettingsWorkspaceRecordPath(stateDir: string, realRoot: string): string {
  return join(stateDir, `editor-settings-${editorSettingsWorkspaceFingerprint(realRoot)}.json`);
}

export function emptyEditorSettingsUserRecord(): EditorSettingsUserRecord {
  return {
    kind: "user",
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    revision: 0,
    values: {},
    idempotency: [],
    events: [],
  };
}

export function emptyEditorSettingsWorkspaceRecord(
  realRoot: string,
): EditorSettingsWorkspaceRecord {
  return {
    kind: "workspace",
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    workspaceFingerprint: editorSettingsWorkspaceFingerprint(realRoot),
    revision: 0,
    values: {},
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

function parseIdempotencyRecord(value: unknown): EditorSettingsIdempotencyRecord | undefined {
  if (!isRecord(value)) return undefined;
  return validIdempotencyRecord(value)
    ? (value as unknown as EditorSettingsIdempotencyRecord)
    : undefined;
}

function validIdempotencyRecord(value: UnknownRecord): boolean {
  return (
    hasOnlyKeys(value, ["keyHash", "requestHash", "resultKind", "changed", "revision"]) &&
    validSha(value.keyHash) &&
    validSha(value.requestHash) &&
    (value.resultKind === "ok" || value.resultKind === "invalid") &&
    typeof value.changed === "boolean" &&
    isRevision(value.revision)
  );
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function parseIdempotency(value: unknown): readonly EditorSettingsIdempotencyRecord[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_IDEMPOTENCY_RECORDS) return undefined;
  const parsed = value.map(parseIdempotencyRecord);
  if (parsed.includes(undefined)) return undefined;
  return parsed as readonly EditorSettingsIdempotencyRecord[];
}

function parseEvent(value: unknown): EditorSettingsChangeEvent | undefined {
  if (!isRecord(value)) return undefined;
  return validEventRecord(value) ? (value as unknown as EditorSettingsChangeEvent) : undefined;
}

function validEventRecord(value: UnknownRecord): boolean {
  return (
    hasOnlyKeys(value, [
      "schemaVersion",
      "sequence",
      "scope",
      "action",
      "settingIds",
      "outcome",
      "reasonCode",
    ]) &&
    value.schemaVersion === EDITOR_M7_SCHEMA_VERSION &&
    isRevision(value.sequence) &&
    validEventScope(value.scope) &&
    validEventAction(value.action) &&
    validEventOutcome(value.outcome) &&
    Array.isArray(value.settingIds)
  );
}

function validEventScope(value: unknown): boolean {
  return value === "user" || value === "workspace";
}

function validEventAction(value: unknown): boolean {
  return value === "set" || value === "reset";
}

function validEventOutcome(value: unknown): boolean {
  return value === "accepted" || value === "noOp" || value === "rejected";
}

function parseEvents(value: unknown): readonly EditorSettingsChangeEvent[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_EVENTS) return undefined;
  const parsed = value.map(parseEvent);
  if (parsed.includes(undefined)) return undefined;
  return parsed as readonly EditorSettingsChangeEvent[];
}

function parseBase(
  value: UnknownRecord,
  scope: EditorM7SettingScope,
): EditorSettingsRecordBase | undefined {
  if (!isRevision(value.revision) || value.schemaVersion !== EDITOR_M7_SCHEMA_VERSION) {
    return undefined;
  }
  const values = parseEditorM7SettingPatch(scope, value.values);
  const idempotency = parseIdempotency(value.idempotency);
  const events = parseEvents(value.events);
  if (!values.ok || idempotency === undefined || events === undefined) return undefined;
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    revision: value.revision,
    values: values.value.values,
    idempotency,
    events,
  };
}

function parseUserRecord(value: unknown): EditorSettingsUserRecord | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, recordKeys("user")) || value.kind !== "user") {
    return undefined;
  }
  const base = parseBase(value, "user");
  return base === undefined ? undefined : { kind: "user", ...base };
}

function parseWorkspaceRecord(
  value: unknown,
  fingerprint: string,
): EditorSettingsWorkspaceRecord | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, recordKeys("workspace"))) return undefined;
  if (value.kind !== "workspace" || value.workspaceFingerprint !== fingerprint) return undefined;
  const base = parseBase(value, "workspace");
  return base === undefined
    ? undefined
    : { kind: "workspace", workspaceFingerprint: fingerprint, ...base };
}

function recordKeys(kind: "user" | "workspace"): readonly string[] {
  const keys = ["kind", "schemaVersion", "revision", "values", "idempotency", "events"];
  return kind === "workspace" ? [...keys, "workspaceFingerprint"] : keys;
}

function safeUserRecordPath(path: string): boolean {
  try {
    assertNoSymlinkedPathSegments(path);
    return true;
  } catch {
    return false;
  }
}

function safeWorkspaceRecordPath(path: string, stateDir: string, realRoot: string): boolean {
  if (containsPath(realRoot, stateDir)) return false;
  return safeUserRecordPath(path);
}

function loadJson(path: string, options: EditorSettingsStoreOptions): JsonLoadResult {
  if (!existsSync(path)) return { kind: "missing" };
  const size = options.size?.(path) ?? statSync(path).size;
  if (size > MAX_RECORD_BYTES) return { kind: "oversized" };
  return {
    kind: "value",
    value: JSON.parse(options.read?.(path) ?? readFileSync(path, "utf8")) as unknown,
  };
}

function loadUserRecord(
  options: EditorSettingsStoreOptions,
): EditorSettingsLoadResult<EditorSettingsUserRecord> {
  const empty = emptyEditorSettingsUserRecord();
  const path = editorSettingsUserRecordPath(options.stateDir);
  if (!safeUserRecordPath(path)) return { state: "unavailable", record: empty };
  try {
    const raw = loadJson(path, options);
    if (raw.kind === "missing") return { state: "absent", record: empty };
    if (raw.kind === "oversized") return { state: "unavailable", record: empty };
    const record = parseUserRecord(raw.value);
    return record === undefined
      ? { state: "unavailable", record: empty }
      : { state: "ready", record };
  } catch {
    return { state: "unavailable", record: empty };
  }
}

function loadWorkspaceRecord(
  realRoot: string,
  options: EditorSettingsStoreOptions,
): EditorSettingsLoadResult<EditorSettingsWorkspaceRecord> {
  const empty = emptyEditorSettingsWorkspaceRecord(realRoot);
  const path = editorSettingsWorkspaceRecordPath(options.stateDir, realRoot);
  if (!safeWorkspaceRecordPath(path, options.stateDir, realRoot)) {
    return { state: "unavailable", record: empty };
  }
  try {
    const raw = loadJson(path, options);
    if (raw.kind === "missing") return { state: "absent", record: empty };
    if (raw.kind === "oversized") return { state: "unavailable", record: empty };
    const record = parseWorkspaceRecord(raw.value, empty.workspaceFingerprint);
    return record === undefined
      ? { state: "unavailable", record: empty }
      : { state: "ready", record };
  } catch {
    return { state: "unavailable", record: empty };
  }
}

function recordForWrite(
  record: EditorSettingsUserRecord | EditorSettingsWorkspaceRecord,
): Record<string, unknown> {
  return {
    kind: record.kind,
    schemaVersion: record.schemaVersion,
    revision: record.revision,
    values: record.values,
    idempotency: record.idempotency,
    events: record.events,
    ...(record.kind === "workspace" ? { workspaceFingerprint: record.workspaceFingerprint } : {}),
  };
}

export function createEditorSettingsStore(
  options: EditorSettingsStoreOptions,
): EditorSettingsStore {
  const save = options.save ?? savePrivateJson;
  return {
    stateDir: options.stateDir,
    loadUser: (): EditorSettingsLoadResult<EditorSettingsUserRecord> => loadUserRecord(options),
    loadWorkspace: (realRoot): EditorSettingsLoadResult<EditorSettingsWorkspaceRecord> =>
      loadWorkspaceRecord(realRoot, options),
    commitUser: (record): void => {
      save(editorSettingsUserRecordPath(options.stateDir), recordForWrite(record));
    },
    commitWorkspace: (realRoot, record): void => {
      if (record.workspaceFingerprint !== editorSettingsWorkspaceFingerprint(realRoot)) {
        throw new Error("editor settings workspace identity mismatch");
      }
      if (containsPath(realRoot, options.stateDir)) {
        throw new Error("editor settings state directory must remain outside the workspace");
      }
      save(editorSettingsWorkspaceRecordPath(options.stateDir, realRoot), recordForWrite(record));
    },
  };
}
