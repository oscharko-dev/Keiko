import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  EDITOR_M7_SCHEMA_VERSION,
  parseEditorM7SettingPatch,
  type EditorM11SettingScope,
  type EditorM7ReasonCode,
  type EditorM7SettingId,
  type EditorM7SettingScope,
  type EditorM7SettingValue,
} from "@oscharko-dev/keiko-contracts";
import { containsPath } from "@oscharko-dev/keiko-git";

import { assertNoSymlinkedPathSegments, savePrivateJson } from "../../private-json.js";
import { inspectWorkspaceRootIdentity } from "../../workspace-root-identity.js";

const MAX_RECORD_BYTES = 512 * 1024;
const MAX_IDEMPOTENCY_RECORDS = 64;
const MAX_EVENTS = 128;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type EditorSettingsStoreState = "absent" | "ready" | "unavailable";

/**
 * The root standing at this path is not the one the record was built for. Unlike the other
 * `commitRoot` guards, which catch programming errors, this one fires on a race a human can lose
 * innocently: replacing the directory between loading the record and persisting it. It is typed so
 * the control layer can answer with a structured mutation outcome instead of letting a raw error
 * reach the top-level handler as an opaque 500.
 */
export class EditorSettingsRootIdentityError extends Error {
  public constructor() {
    super("editor settings root identity mismatch");
    this.name = "EditorSettingsRootIdentityError";
  }
}

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
  readonly scope: EditorM11SettingScope;
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

export interface EditorSettingsRootRecord extends EditorSettingsRecordBase {
  readonly kind: "root";
  readonly rootFingerprint: string;
  /**
   * The filesystem identity the record was written against. The path fingerprint alone let settings
   * written for one directory apply to a different directory that later occupied the same path —
   * the ADR-0147 "root replacement at the same path" threat, and why root removal and replacement
   * must invalidate settings bindings (#2620). Binding the identity here makes the record
   * self-invalidating, so a missed invalidation signal still fails closed.
   */
  readonly rootIdentityDigest: string;
}

interface EditorSettingsLoadResult<T extends EditorSettingsRecordBase> {
  readonly state: EditorSettingsStoreState;
  readonly record: T;
}

export interface EditorSettingsStore {
  readonly stateDir: string;
  readonly loadUser: () => EditorSettingsLoadResult<EditorSettingsUserRecord>;
  readonly loadWorkspace: (
    realRoot: string,
  ) => EditorSettingsLoadResult<EditorSettingsWorkspaceRecord>;
  readonly loadRoot: (realRoot: string) => EditorSettingsLoadResult<EditorSettingsRootRecord>;
  readonly commitUser: (record: EditorSettingsUserRecord) => void;
  readonly commitWorkspace: (realRoot: string, record: EditorSettingsWorkspaceRecord) => void;
  readonly commitRoot: (realRoot: string, record: EditorSettingsRootRecord) => void;
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

/**
 * The single source of truth for the `edm7` settings ETag grammar. The token is produced here and
 * parsed here so that a new precedence layer can never be added to the producer while a consumer
 * keeps an older shape — the exact drift that made debug activation unreachable once an editor
 * profile was active.
 */
const EDITOR_SETTINGS_ETAG_PATTERN =
  /^"edm7-(\d+)-(\d+)-(\d+)(?:-p(\d+))?-([A-Za-z0-9_-]{4,64})"$/u;

const EDITOR_SETTINGS_ROOT_TOKEN_CHARS = 24;

export interface EditorSettingsEtagParts {
  readonly userRevision: number;
  readonly workspaceRevision: number;
  readonly rootRevision: number;
  readonly profileRevision: number;
  readonly rootToken: string;
}

export function editorSettingsRootToken(realRoot: string | undefined): string {
  return realRoot === undefined
    ? "user"
    : editorSettingsWorkspaceFingerprint(realRoot).slice(0, EDITOR_SETTINGS_ROOT_TOKEN_CHARS);
}

export function formatEditorSettingsEtag(
  realRoot: string | undefined,
  parts: Omit<EditorSettingsEtagParts, "rootToken">,
): string {
  const profileToken = parts.profileRevision === 0 ? "" : `-p${String(parts.profileRevision)}`;
  return `"edm7-${String(parts.userRevision)}-${String(parts.workspaceRevision)}-${String(
    parts.rootRevision,
  )}${profileToken}-${editorSettingsRootToken(realRoot)}"`;
}

export function parseEditorSettingsEtag(
  value: string | undefined,
): EditorSettingsEtagParts | undefined {
  const match = value === undefined ? null : EDITOR_SETTINGS_ETAG_PATTERN.exec(value);
  if (match === null) return undefined;
  const userRevision = Number(match[1]);
  const workspaceRevision = Number(match[2]);
  const rootRevision = Number(match[3]);
  const profileRevision = match[4] === undefined ? 0 : Number(match[4]);
  const revisions = [userRevision, workspaceRevision, rootRevision, profileRevision];
  if (revisions.some((revision) => !Number.isSafeInteger(revision) || revision < 0)) {
    return undefined;
  }
  return {
    userRevision,
    workspaceRevision,
    rootRevision,
    profileRevision,
    rootToken: match[5] ?? "",
  };
}

export function editorSettingsUserRecordPath(stateDir: string): string {
  return join(stateDir, "editor-settings-user.json");
}

export function editorSettingsWorkspaceRecordPath(stateDir: string, realRoot: string): string {
  return join(stateDir, `editor-settings-${editorSettingsWorkspaceFingerprint(realRoot)}.json`);
}

export function editorSettingsRootRecordPath(stateDir: string, realRoot: string): string {
  return join(
    stateDir,
    `editor-settings-root-${editorSettingsWorkspaceFingerprint(realRoot)}.json`,
  );
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

/**
 * The live filesystem identity of a root, or `undefined` when it cannot be read — a removed root, a
 * path that is no longer a directory, or a symlink alias. `undefined` never equals a stored digest,
 * so an unreadable root fails closed: its record neither applies nor accepts a write.
 */
function editorSettingsRootIdentityDigest(realRoot: string): string | undefined {
  try {
    return inspectWorkspaceRootIdentity(realRoot).identityDigest;
  } catch {
    return undefined;
  }
}

export function emptyEditorSettingsRootRecord(realRoot: string): EditorSettingsRootRecord {
  return {
    kind: "root",
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    rootFingerprint: editorSettingsWorkspaceFingerprint(realRoot),
    rootIdentityDigest: editorSettingsRootIdentityDigest(realRoot) ?? "",
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
  return value === "user" || value === "workspace" || value === "root";
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

/**
 * The identity a stored record claims. Claiming none — a record written before the binding existed,
 * or one written for a root whose identity was unreadable — is the empty string, and readiness
 * requires a READABLE live identity, so a claim of none can never match one. Only a present but
 * malformed binding is a structural defect, and that rejects the whole record.
 */
function parsedRootIdentityBinding(value: unknown): string | undefined {
  if (value === undefined || value === "") return "";
  return validSha(value) ? value : undefined;
}

function parseRootRecord(
  value: unknown,
  fingerprint: string,
): EditorSettingsRootRecord | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, recordKeys("root"))) return undefined;
  if (value.kind !== "root" || value.rootFingerprint !== fingerprint) return undefined;
  const rootIdentityDigest = parsedRootIdentityBinding(value.rootIdentityDigest);
  const base = parseBase(value, "workspace");
  return base === undefined || rootIdentityDigest === undefined
    ? undefined
    : { kind: "root", rootFingerprint: fingerprint, rootIdentityDigest, ...base };
}

function recordKeys(kind: "user" | "workspace" | "root"): readonly string[] {
  const keys = ["kind", "schemaVersion", "revision", "values", "idempotency", "events"];
  if (kind === "workspace") return [...keys, "workspaceFingerprint"];
  return kind === "root" ? [...keys, "rootFingerprint", "rootIdentityDigest"] : keys;
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

function loadRootRecord(
  realRoot: string,
  options: EditorSettingsStoreOptions,
): EditorSettingsLoadResult<EditorSettingsRootRecord> {
  const empty = emptyEditorSettingsRootRecord(realRoot);
  const path = editorSettingsRootRecordPath(options.stateDir, realRoot);
  if (!safeWorkspaceRecordPath(path, options.stateDir, realRoot)) {
    return { state: "unavailable", record: empty };
  }
  try {
    const raw = loadJson(path, options);
    if (raw.kind === "missing") return { state: "absent", record: empty };
    if (raw.kind === "oversized") return { state: "unavailable", record: empty };
    const record = parseRootRecord(raw.value, empty.rootFingerprint);
    if (record === undefined) return { state: "unavailable", record: empty };
    // Ready demands BOTH a readable live identity and an exact match. Comparing against the empty
    // record's digest alone would let a record claiming no identity read as ready whenever the live
    // root is unreadable, because both collapse to the same sentinel — "claims no identity" and
    // "identity cannot be read" are different facts and must not alias.
    //
    // Anything else is ABSENT, not unavailable, and the distinction is load-bearing: `unavailable`
    // rejects every settings mutation carrying this root, user and workspace scope included, with
    // no way back through the API. `absent` contributes nothing and lets the next write supersede
    // the stale record with a correctly bound one (#2620, ADR-0147 D9 keeps the two tags distinct).
    const live = editorSettingsRootIdentityDigest(realRoot);
    return live !== undefined && record.rootIdentityDigest === live
      ? { state: "ready", record }
      : { state: "absent", record: empty };
  } catch {
    return { state: "unavailable", record: empty };
  }
}

function recordForWrite(
  record: EditorSettingsUserRecord | EditorSettingsWorkspaceRecord | EditorSettingsRootRecord,
): Record<string, unknown> {
  return {
    kind: record.kind,
    schemaVersion: record.schemaVersion,
    revision: record.revision,
    values: record.values,
    idempotency: record.idempotency,
    events: record.events,
    ...(record.kind === "workspace" ? { workspaceFingerprint: record.workspaceFingerprint } : {}),
    ...(record.kind === "root"
      ? { rootFingerprint: record.rootFingerprint, rootIdentityDigest: record.rootIdentityDigest }
      : {}),
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
    loadRoot: (realRoot): EditorSettingsLoadResult<EditorSettingsRootRecord> =>
      loadRootRecord(realRoot, options),
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
    commitRoot: (realRoot, record): void => {
      if (record.rootFingerprint !== editorSettingsWorkspaceFingerprint(realRoot)) {
        throw new Error("editor settings root identity mismatch");
      }
      // Refuse to persist a record bound to a root that is no longer the one on disk. Without this
      // a mutation racing a root replacement would write the new directory's file with the old
      // directory's binding, re-creating the very carry-over the binding exists to prevent.
      //
      // Both sides fall back to the same unreadable sentinel, so clearing the record of a root that
      // has left the disk stays possible. That sentinel is inert on load: readiness demands a
      // READABLE live identity, so a record carrying it applies to nothing.
      if (record.rootIdentityDigest !== (editorSettingsRootIdentityDigest(realRoot) ?? "")) {
        throw new EditorSettingsRootIdentityError();
      }
      if (containsPath(realRoot, options.stateDir)) {
        throw new Error("editor settings state directory must remain outside the workspace");
      }
      save(editorSettingsRootRecordPath(options.stateDir, realRoot), recordForWrite(record));
    },
  };
}
