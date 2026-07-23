import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  createLocalSecretVault,
  resolveLocalVaultKey,
  type LocalSecretVault,
  type LocalVaultKeychainAccess,
} from "@oscharko-dev/keiko-security/secret-vault";
import { containsPath } from "@oscharko-dev/keiko-git";
import {
  EDITOR_LOCAL_HISTORY_ENCRYPTION,
  EDITOR_LOCAL_HISTORY_MAX_ENTRIES,
  EDITOR_LOCAL_HISTORY_MAX_ENTRY_BYTES,
  EDITOR_LOCAL_HISTORY_MAX_PINNED_BYTES,
  EDITOR_LOCAL_HISTORY_MAX_TOTAL_BYTES,
  EDITOR_LOCAL_HISTORY_MAX_VERSIONS_PER_FILE,
  EDITOR_LOCAL_HISTORY_SCHEMA_VERSION,
  EDITOR_LOCAL_HISTORY_TTL_DAYS,
  isPortableWorkspaceRelativePath,
  planEditorLocalHistoryRetention,
  validateEditorLocalHistoryEntry,
  validateEditorLocalHistoryIndex,
} from "@oscharko-dev/keiko-contracts";
import type {
  EditorLocalHistoryEntry,
  EditorLocalHistoryIndex,
  EditorLocalHistoryOrigin,
  WorkspaceContentDigest,
  WorkspaceHistoryEntryRef,
  WorkspaceIsoInstant,
  WorkspacePathDigest,
  WorkspaceRootIdentityDigest,
  WorkspaceRootRef,
  WorkspaceVaultEntryRef,
} from "@oscharko-dev/keiko-contracts";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { assertNoSymlinkedPathSegments, savePrivateJson } from "../../private-json.js";

const HISTORY_SUBDIR = "editor-local-history";
const HISTORY_INDEX_FILE = "index.json";
const HISTORY_VAULT_FILE = "checkpoints.vault";
const HISTORY_KEYFILE = "editor-local-history-vault.key";
const HISTORY_KEY_ENV = "KEIKO_EDITOR_LOCAL_HISTORY_KEY";
const HISTORY_KEYCHAIN_SERVICE = "keiko-editor-local-history-vault";
const PAYLOAD_KIND = "editor-local-history-payload";
const PAYLOAD_SCHEMA_VERSION = 1 as const;
const DEFAULT_COALESCE_MS = 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type EditorLocalHistoryErrorCode =
  | "ENTRY_TOO_LARGE"
  | "ENTRY_NOT_FOUND"
  | "INDEX_UNAVAILABLE"
  | "CONTENT_UNAVAILABLE"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PINNED_CAPACITY_EXHAUSTED"
  | "PINNED_BYTE_LIMIT"
  | "INVALID_CAPTURE"
  | "VAULT_WRITE_FAILED";

export class EditorLocalHistoryError extends Error {
  public constructor(
    public readonly code: EditorLocalHistoryErrorCode,
    message: string,
    // Content-free guard token ("ROOT_UNRESOLVED", "IDENTITY_DRIFT", …) appended to the redacted
    // capture diagnostic so an operator can tell WHICH fail-closed guard rejected a capture
    // without any path or content leaving the process.
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "EditorLocalHistoryError";
  }
}

export interface EditorLocalHistoryCaptureInput {
  readonly workspaceId: string;
  readonly rootRef: WorkspaceRootRef;
  readonly rootIdentityDigest: WorkspaceRootIdentityDigest;
  readonly realRoot: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly content: string;
  readonly origin: EditorLocalHistoryOrigin;
  readonly nowMs?: number | undefined;
}

interface EditorLocalHistoryCaptureResult {
  readonly entry: EditorLocalHistoryEntry;
  readonly coalesced: boolean;
  readonly prunedEntryCount: number;
}

interface EditorLocalHistoryReadResult {
  readonly entry: EditorLocalHistoryEntry;
  readonly content: string;
}

export interface EditorLocalHistoryRootScope {
  readonly workspaceId: string;
  readonly rootRef: WorkspaceRootRef;
  readonly rootIdentityDigest: WorkspaceRootIdentityDigest;
}

export interface EditorLocalHistoryStore {
  readonly capture: (input: EditorLocalHistoryCaptureInput) => EditorLocalHistoryCaptureResult;
  readonly list: (
    scope: EditorLocalHistoryRootScope,
    relativePath?: string,
    nowMs?: number,
  ) => readonly EditorLocalHistoryEntry[];
  readonly entry: (
    scope: EditorLocalHistoryRootScope,
    entryRef: string,
    nowMs?: number,
  ) => EditorLocalHistoryEntry;
  readonly read: (
    scope: EditorLocalHistoryRootScope,
    entryRef: string,
    nowMs?: number,
  ) => EditorLocalHistoryReadResult;
  readonly setPinned: (
    scope: EditorLocalHistoryRootScope,
    entryRef: string,
    pinned: boolean,
    nowMs?: number,
  ) => EditorLocalHistoryEntry;
  readonly delete: (scope: EditorLocalHistoryRootScope, entryRef: string) => void;
}

interface EditorLocalHistoryLimits {
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPinnedBytes: number;
  readonly maxVersionsPerFile: number;
  readonly ttlMs: number;
  readonly coalesceMs: number;
}

interface HistoryPayload {
  readonly kind: typeof PAYLOAD_KIND;
  readonly schemaVersion: typeof PAYLOAD_SCHEMA_VERSION;
  readonly vaultEntryRef: WorkspaceVaultEntryRef;
  readonly entryRef: WorkspaceHistoryEntryRef;
  readonly workspaceId: string;
  readonly rootRef: WorkspaceRootRef;
  readonly rootIdentityDigest: WorkspaceRootIdentityDigest;
  readonly relativePathDigest: WorkspacePathDigest;
  readonly predecessor: EditorLocalHistoryEntry["predecessor"];
  readonly sequence: number;
  readonly origin: EditorLocalHistoryOrigin;
  readonly recordedAt: WorkspaceIsoInstant;
  readonly plaintextContentDigest: WorkspaceContentDigest;
  readonly plaintextByteLength: number;
  readonly payloadBindingDigest: WorkspaceContentDigest;
  readonly content: string;
}

type HistoryPayloadBase = Omit<HistoryPayload, "payloadBindingDigest" | "content">;

interface WorkspaceState {
  readonly indexPath: string;
  readonly vault: LocalSecretVault;
  index: EditorLocalHistoryIndex;
}

export interface CreateEditorLocalHistoryStoreOptions {
  readonly stateDir: string;
  readonly env: EnvSource;
  readonly keychainAccess?: LocalVaultKeychainAccess | undefined;
  readonly vaultFactory?: ((workspaceDir: string) => LocalSecretVault) | undefined;
  readonly saveIndex?: ((path: string, value: Record<string, unknown>) => void) | undefined;
  readonly limits?: Partial<EditorLocalHistoryLimits> | undefined;
}

function digest(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(`${String(domain.length)}:${domain}`);
  for (const part of parts) hash.update(`${String(part.length)}:${part}`);
  return hash.digest("hex");
}

function contentDigest(content: string): WorkspaceContentDigest {
  return createHash("sha256").update(content, "utf8").digest("hex") as WorkspaceContentDigest;
}

function pathDigest(path: string): WorkspacePathDigest {
  return digest("keiko.editor-local-history.path.v1", [path]) as WorkspacePathDigest;
}

function instant(nowMs: number): WorkspaceIsoInstant {
  return new Date(nowMs).toISOString() as WorkspaceIsoInstant;
}

function workspaceDirectory(rootDir: string, workspaceId: string): string {
  const ref = digest("keiko.editor-local-history.workspace.v1", [workspaceId]).slice(0, 40);
  return join(rootDir, `workspace-${ref}`);
}

function boundedPositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, fallback);
}

function boundedCoalesce(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return DEFAULT_COALESCE_MS;
  return value;
}

function defaultLimits(
  overrides: Partial<EditorLocalHistoryLimits> = {},
): EditorLocalHistoryLimits {
  return {
    maxEntries: boundedPositive(overrides.maxEntries, EDITOR_LOCAL_HISTORY_MAX_ENTRIES),
    maxEntryBytes: boundedPositive(overrides.maxEntryBytes, EDITOR_LOCAL_HISTORY_MAX_ENTRY_BYTES),
    maxTotalBytes: boundedPositive(overrides.maxTotalBytes, EDITOR_LOCAL_HISTORY_MAX_TOTAL_BYTES),
    maxPinnedBytes: boundedPositive(
      overrides.maxPinnedBytes,
      EDITOR_LOCAL_HISTORY_MAX_PINNED_BYTES,
    ),
    maxVersionsPerFile: boundedPositive(
      overrides.maxVersionsPerFile,
      EDITOR_LOCAL_HISTORY_MAX_VERSIONS_PER_FILE,
    ),
    ttlMs: boundedPositive(overrides.ttlMs, EDITOR_LOCAL_HISTORY_TTL_DAYS * DAY_MS),
    coalesceMs: boundedCoalesce(overrides.coalesceMs),
  };
}

function emptyIndex(workspaceId: string): EditorLocalHistoryIndex {
  return {
    kind: "local-history-index",
    schemaVersion: EDITOR_LOCAL_HISTORY_SCHEMA_VERSION,
    workspaceId,
    revision: 0,
    maxEntries: EDITOR_LOCAL_HISTORY_MAX_ENTRIES,
    totalPlaintextBytes: 0,
    entries: [],
  };
}

function readIndex(path: string, workspaceId: string): EditorLocalHistoryIndex {
  assertNoSymlinkedPathSegments(path);
  if (!existsSync(path)) return emptyIndex(workspaceId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new EditorLocalHistoryError("INDEX_UNAVAILABLE", "Local-history index is unavailable.");
  }
  if (!validateEditorLocalHistoryIndex(parsed).ok) {
    throw new EditorLocalHistoryError("INDEX_UNAVAILABLE", "Local-history index is unavailable.");
  }
  const index = parsed as EditorLocalHistoryIndex;
  const pathsMatchDigests = index.entries.every(
    (entry): boolean => pathDigest(entry.relativePath) === entry.relativePathDigest,
  );
  if (index.workspaceId !== workspaceId || !pathsMatchDigests) {
    throw new EditorLocalHistoryError("INDEX_UNAVAILABLE", "Local-history index is unavailable.");
  }
  return index;
}

function createVault(options: CreateEditorLocalHistoryStoreOptions, dir: string): LocalSecretVault {
  if (options.vaultFactory !== undefined) return options.vaultFactory(dir);
  const resolved = resolveLocalVaultKey({
    env: options.env,
    vaultDir: dir,
    envVarName: HISTORY_KEY_ENV,
    keychainService: HISTORY_KEYCHAIN_SERVICE,
    keyfileName: HISTORY_KEYFILE,
    keychainAccess: options.keychainAccess,
  });
  return createLocalSecretVault({ key: resolved.key, storePath: join(dir, HISTORY_VAULT_FILE) });
}

function indexWithEntries(
  current: EditorLocalHistoryIndex,
  entries: readonly EditorLocalHistoryEntry[],
): EditorLocalHistoryIndex {
  const next: EditorLocalHistoryIndex = {
    ...current,
    revision: current.revision + 1,
    totalPlaintextBytes: entries.reduce(
      (total, entry): number => total + entry.plaintextByteLength,
      0,
    ),
    entries,
  };
  if (!validateEditorLocalHistoryIndex(next).ok) {
    throw new EditorLocalHistoryError("INDEX_UNAVAILABLE", "Local-history index is unavailable.");
  }
  return next;
}

type FileIdentity = Pick<
  EditorLocalHistoryEntry,
  "rootRef" | "rootIdentityDigest" | "relativePathDigest"
>;

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.rootRef === right.rootRef &&
    left.rootIdentityDigest === right.rootIdentityDigest &&
    left.relativePathDigest === right.relativePathDigest
  );
}

function retentionOrder(left: EditorLocalHistoryEntry, right: EditorLocalHistoryEntry): number {
  const byAccess = left.lastAccessedAt.localeCompare(right.lastAccessedAt);
  return byAccess === 0 ? left.entryRef.localeCompare(right.entryRef) : byAccess;
}

function payloadBinding(input: HistoryPayloadBase): WorkspaceContentDigest {
  return digest("keiko.editor-local-history.payload-binding.v1", [
    input.vaultEntryRef,
    input.entryRef,
    input.workspaceId,
    input.rootRef,
    input.rootIdentityDigest,
    input.relativePathDigest,
    JSON.stringify(input.predecessor),
    String(input.sequence),
    input.origin,
    input.recordedAt,
    input.plaintextContentDigest,
    String(input.plaintextByteLength),
  ]) as WorkspaceContentDigest;
}

function opaqueReferences(input: {
  readonly workspaceId: string;
  readonly rootRef: WorkspaceRootRef;
  readonly relativePathDigest: WorkspacePathDigest;
  readonly sequence: number;
  readonly recordedAt: WorkspaceIsoInstant;
  readonly contentDigest: WorkspaceContentDigest;
}): {
  readonly entryRef: WorkspaceHistoryEntryRef;
  readonly vaultEntryRef: WorkspaceVaultEntryRef;
} {
  const suffix = digest("keiko.editor-local-history.checkpoint.v1", [
    input.workspaceId,
    input.rootRef,
    input.relativePathDigest,
    String(input.sequence),
    input.recordedAt,
    input.contentDigest,
  ]).slice(0, 48);
  return {
    entryRef: `history-${suffix}` as WorkspaceHistoryEntryRef,
    vaultEntryRef: `vault-${suffix}` as WorkspaceVaultEntryRef,
  };
}

function latestForFile(
  entries: readonly EditorLocalHistoryEntry[],
  identity: FileIdentity,
): EditorLocalHistoryEntry | undefined {
  return entries
    .filter((entry): boolean => sameFile(entry, identity))
    .sort((left, right): number => right.sequence - left.sequence)[0];
}

function buildPayloadBase(
  input: EditorLocalHistoryCaptureInput,
  entries: readonly EditorLocalHistoryEntry[],
  nowMs: number,
): HistoryPayloadBase {
  const relativePathDigest = pathDigest(input.relativePath);
  const previous = latestForFile(entries, {
    rootRef: input.rootRef,
    rootIdentityDigest: input.rootIdentityDigest,
    relativePathDigest,
  });
  const sequence = (previous?.sequence ?? 0) + 1;
  const recordedAt = instant(nowMs);
  const plaintextContentDigest = contentDigest(input.content);
  const plaintextByteLength = Buffer.byteLength(input.content, "utf8");
  const refs = opaqueReferences({
    workspaceId: input.workspaceId,
    rootRef: input.rootRef,
    relativePathDigest,
    sequence,
    recordedAt,
    contentDigest: plaintextContentDigest,
  });
  return {
    kind: PAYLOAD_KIND,
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    ...refs,
    workspaceId: input.workspaceId,
    rootRef: input.rootRef,
    rootIdentityDigest: input.rootIdentityDigest,
    relativePathDigest,
    predecessor:
      previous === undefined
        ? { outcome: "absent" }
        : { outcome: "known", value: previous.entryRef },
    sequence,
    origin: input.origin,
    recordedAt,
    plaintextContentDigest,
    plaintextByteLength,
  };
}

function entryFromPayloadBase(
  input: EditorLocalHistoryCaptureInput,
  base: HistoryPayloadBase,
  payloadBindingDigest: WorkspaceContentDigest,
): EditorLocalHistoryEntry {
  const entry: EditorLocalHistoryEntry = {
    kind: "local-history-entry",
    schemaVersion: EDITOR_LOCAL_HISTORY_SCHEMA_VERSION,
    entryRef: base.entryRef,
    workspaceId: input.workspaceId,
    rootRef: input.rootRef,
    rootIdentityDigest: input.rootIdentityDigest,
    relativePath: input.relativePath,
    relativePathDigest: base.relativePathDigest,
    predecessor: base.predecessor,
    sequence: base.sequence,
    origin: input.origin,
    recordedAt: base.recordedAt,
    lastAccessedAt: base.recordedAt,
    plaintextContentDigest: base.plaintextContentDigest,
    plaintextByteLength: base.plaintextByteLength,
    payloadBindingDigest,
    encryptedContent: {
      kind: "vault-reference",
      vaultEntryRef: base.vaultEntryRef,
      encryption: EDITOR_LOCAL_HISTORY_ENCRYPTION,
    },
    pinned: false,
    pinnedAt: { outcome: "absent" },
  };
  if (!validateEditorLocalHistoryEntry(entry).ok) {
    throw new EditorLocalHistoryError("INVALID_CAPTURE", "Local-history capture is invalid.");
  }
  return entry;
}

function buildCheckpoint(
  input: EditorLocalHistoryCaptureInput,
  entries: readonly EditorLocalHistoryEntry[],
  nowMs: number,
): { readonly entry: EditorLocalHistoryEntry; readonly payload: HistoryPayload } {
  const base = buildPayloadBase(input, entries, nowMs);
  const payloadBindingDigest = payloadBinding(base);
  const entry = entryFromPayloadBase(input, base, payloadBindingDigest);
  return { entry, payload: { ...base, payloadBindingDigest, content: input.content } };
}

function assertCapturePath(input: EditorLocalHistoryCaptureInput): void {
  if (!isPortableWorkspaceRelativePath(input.relativePath)) {
    throw new EditorLocalHistoryError("INVALID_CAPTURE", "Local-history capture is invalid.");
  }
  let realRoot: string;
  let realFile: string;
  let expected: string;
  try {
    realRoot = realpathSync(input.realRoot);
    realFile = realpathSync(input.absolutePath);
    expected = realpathSync(resolve(realRoot, ...input.relativePath.split("/")));
  } catch {
    throw new EditorLocalHistoryError(
      "PATH_OUTSIDE_WORKSPACE",
      "Local-history path is outside the workspace.",
    );
  }
  if (!containsPath(realRoot, realFile) || relative(expected, realFile) !== "") {
    throw new EditorLocalHistoryError(
      "PATH_OUTSIDE_WORKSPACE",
      "Local-history path is outside the workspace.",
    );
  }
}

function expired(entry: EditorLocalHistoryEntry, nowMs: number, ttlMs: number): boolean {
  return !entry.pinned && nowMs - Date.parse(entry.recordedAt) > ttlMs;
}

function coalescedEntry(
  entries: readonly EditorLocalHistoryEntry[],
  candidate: EditorLocalHistoryEntry,
  nowMs: number,
  coalesceMs: number,
): EditorLocalHistoryEntry | undefined {
  const latest = latestForFile(entries, candidate);
  if (latest?.origin !== candidate.origin) return undefined;
  const age = nowMs - Date.parse(latest.recordedAt);
  return age >= 0 &&
    age <= coalesceMs &&
    latest.plaintextContentDigest === candidate.plaintextContentDigest
    ? latest
    : undefined;
}

function perFileEvictions(
  entries: readonly EditorLocalHistoryEntry[],
  candidate: EditorLocalHistoryEntry,
  limit: number,
): readonly WorkspaceHistoryEntryRef[] {
  const versions = entries.filter((entry): boolean => sameFile(entry, candidate));
  const required = Math.max(0, versions.length + 1 - limit);
  const refs = versions
    .filter((entry): boolean => !entry.pinned)
    .sort(retentionOrder)
    .slice(0, required)
    .map((entry): WorkspaceHistoryEntryRef => entry.entryRef);
  if (refs.length < required) {
    throw new EditorLocalHistoryError(
      "PINNED_CAPACITY_EXHAUSTED",
      "Pinned local-history entries prevent bounded capture.",
    );
  }
  return refs;
}

function retentionEvictions(
  entries: readonly EditorLocalHistoryEntry[],
  candidate: EditorLocalHistoryEntry,
  limits: EditorLocalHistoryLimits,
): readonly WorkspaceHistoryEntryRef[] {
  const perFile = perFileEvictions(entries, candidate, limits.maxVersionsPerFile);
  const selected = new Set<WorkspaceHistoryEntryRef>(perFile);
  const remaining = entries.filter((entry): boolean => !selected.has(entry.entryRef));
  const remainingBytes = remaining.reduce(
    (total, entry): number => total + entry.plaintextByteLength,
    0,
  );
  const plan = planEditorLocalHistoryRetention(remaining, {
    requiredEntryCount: Math.max(0, remaining.length + 1 - limits.maxEntries),
    requiredByteCount: Math.max(
      0,
      remainingBytes + candidate.plaintextByteLength - limits.maxTotalBytes,
    ),
  });
  if (!plan.ok) {
    throw new EditorLocalHistoryError(
      "PINNED_CAPACITY_EXHAUSTED",
      "Pinned local-history entries prevent bounded capture.",
    );
  }
  for (const ref of plan.entryRefs) selected.add(ref);
  return [...selected];
}

function payloadRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PAYLOAD_KEYS = [
  "kind",
  "schemaVersion",
  "vaultEntryRef",
  "entryRef",
  "workspaceId",
  "rootRef",
  "rootIdentityDigest",
  "relativePathDigest",
  "predecessor",
  "sequence",
  "origin",
  "recordedAt",
  "plaintextContentDigest",
  "plaintextByteLength",
  "payloadBindingDigest",
  "content",
] as const;

function payloadMatchesEntry(
  payload: Record<string, unknown>,
  entry: EditorLocalHistoryEntry,
): boolean {
  const exactKeys = Object.keys(payload).every((key): boolean =>
    PAYLOAD_KEYS.some((allowed): boolean => allowed === key),
  );
  return [
    exactKeys,
    Object.keys(payload).length === PAYLOAD_KEYS.length,
    payload.kind === PAYLOAD_KIND,
    payload.schemaVersion === PAYLOAD_SCHEMA_VERSION,
    payload.vaultEntryRef === entry.encryptedContent.vaultEntryRef,
    payload.entryRef === entry.entryRef,
    payload.workspaceId === entry.workspaceId,
    payload.rootRef === entry.rootRef,
    payload.rootIdentityDigest === entry.rootIdentityDigest,
    payload.relativePathDigest === entry.relativePathDigest,
    JSON.stringify(payload.predecessor) === JSON.stringify(entry.predecessor),
    payload.sequence === entry.sequence,
    payload.origin === entry.origin,
    payload.recordedAt === entry.recordedAt,
    payload.plaintextContentDigest === entry.plaintextContentDigest,
    payload.plaintextByteLength === entry.plaintextByteLength,
    payload.payloadBindingDigest === entry.payloadBindingDigest,
    typeof payload.content === "string",
  ].every(Boolean);
}

function checkedPayload(raw: string | undefined, entry: EditorLocalHistoryEntry): HistoryPayload {
  let parsed: unknown;
  try {
    parsed = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!payloadRecord(parsed) || !payloadMatchesEntry(parsed, entry)) {
    throw new EditorLocalHistoryError(
      "CONTENT_UNAVAILABLE",
      "Local-history content is unavailable.",
    );
  }
  const payload = parsed as unknown as HistoryPayload;
  const base: HistoryPayloadBase = {
    kind: payload.kind,
    schemaVersion: payload.schemaVersion,
    vaultEntryRef: payload.vaultEntryRef,
    entryRef: payload.entryRef,
    workspaceId: payload.workspaceId,
    rootRef: payload.rootRef,
    rootIdentityDigest: payload.rootIdentityDigest,
    relativePathDigest: payload.relativePathDigest,
    predecessor: payload.predecessor,
    sequence: payload.sequence,
    origin: payload.origin,
    recordedAt: payload.recordedAt,
    plaintextContentDigest: payload.plaintextContentDigest,
    plaintextByteLength: payload.plaintextByteLength,
  };
  const validContent =
    contentDigest(payload.content) === payload.plaintextContentDigest &&
    Buffer.byteLength(payload.content, "utf8") === payload.plaintextByteLength;
  if (!validContent || payloadBinding(base) !== payload.payloadBindingDigest) {
    throw new EditorLocalHistoryError(
      "CONTENT_UNAVAILABLE",
      "Local-history content is unavailable.",
    );
  }
  return payload;
}

function scopeMatches(entry: EditorLocalHistoryEntry, scope: EditorLocalHistoryRootScope): boolean {
  return (
    entry.workspaceId === scope.workspaceId &&
    entry.rootRef === scope.rootRef &&
    entry.rootIdentityDigest === scope.rootIdentityDigest
  );
}

// eslint-disable-next-line max-lines-per-function -- one closure owns the workspace cache and atomic index/vault commit helpers.
export function createEditorLocalHistoryStore(
  options: CreateEditorLocalHistoryStoreOptions,
): EditorLocalHistoryStore {
  const rootDir = join(options.stateDir, HISTORY_SUBDIR);
  const states = new Map<string, WorkspaceState>();
  const limits = defaultLimits(options.limits);
  const save = options.saveIndex ?? savePrivateJson;

  const stateFor = (workspaceId: string): WorkspaceState => {
    const cached = states.get(workspaceId);
    if (cached !== undefined) return cached;
    const dir = workspaceDirectory(rootDir, workspaceId);
    const indexPath = join(dir, HISTORY_INDEX_FILE);
    const state = {
      indexPath,
      vault: createVault(options, dir),
      index: readIndex(indexPath, workspaceId),
    };
    states.set(workspaceId, state);
    return state;
  };

  const persist = (state: WorkspaceState, index: EditorLocalHistoryIndex): void => {
    save(state.indexPath, index as unknown as Record<string, unknown>);
    state.index = index;
  };

  const removeVaultEntries = (
    state: WorkspaceState,
    entries: readonly EditorLocalHistoryEntry[],
  ): void => {
    for (const entry of entries) {
      try {
        state.vault.delete(entry.encryptedContent.vaultEntryRef);
      } catch {
        // The committed metadata no longer references this body; orphan cleanup is best effort.
      }
    }
  };

  const pruneExpired = (state: WorkspaceState, nowMs: number): void => {
    const removed = state.index.entries.filter((entry): boolean =>
      expired(entry, nowMs, limits.ttlMs),
    );
    if (removed.length === 0) return;
    const refs = new Set(removed.map((entry): WorkspaceHistoryEntryRef => entry.entryRef));
    const retained = state.index.entries.filter((entry): boolean => !refs.has(entry.entryRef));
    persist(state, indexWithEntries(state.index, retained));
    removeVaultEntries(state, removed);
  };

  const requireEntry = (
    state: WorkspaceState,
    scope: EditorLocalHistoryRootScope,
    entryRef: string,
  ): EditorLocalHistoryEntry => {
    const found = state.index.entries.find(
      (entry): boolean => entry.entryRef === entryRef && scopeMatches(entry, scope),
    );
    if (found === undefined) {
      throw new EditorLocalHistoryError("ENTRY_NOT_FOUND", "Local-history entry was not found.");
    }
    return found;
  };

  return {
    capture(input): EditorLocalHistoryCaptureResult {
      assertCapturePath(input);
      const byteLength = Buffer.byteLength(input.content, "utf8");
      if (byteLength > limits.maxEntryBytes) {
        throw new EditorLocalHistoryError("ENTRY_TOO_LARGE", "Local-history entry is too large.");
      }
      const nowMs = input.nowMs ?? Date.now();
      if (!Number.isFinite(nowMs)) {
        throw new EditorLocalHistoryError("INVALID_CAPTURE", "Local-history capture is invalid.");
      }
      const state = stateFor(input.workspaceId);
      pruneExpired(state, nowMs);
      const built = buildCheckpoint(input, state.index.entries, nowMs);
      const coalesced = coalescedEntry(state.index.entries, built.entry, nowMs, limits.coalesceMs);
      if (coalesced !== undefined) {
        return { entry: coalesced, coalesced: true, prunedEntryCount: 0 };
      }
      const evictedRefs = new Set(retentionEvictions(state.index.entries, built.entry, limits));
      const evicted = state.index.entries.filter((entry): boolean =>
        evictedRefs.has(entry.entryRef),
      );
      const retained = state.index.entries.filter(
        (entry): boolean => !evictedRefs.has(entry.entryRef),
      );
      const next = indexWithEntries(state.index, [...retained, built.entry]);
      try {
        state.vault.set(built.payload.vaultEntryRef, JSON.stringify(built.payload));
      } catch {
        throw new EditorLocalHistoryError(
          "VAULT_WRITE_FAILED",
          "Local-history encrypted content could not be stored.",
        );
      }
      try {
        persist(state, next);
      } catch (error) {
        try {
          state.vault.delete(built.payload.vaultEntryRef);
        } catch {
          // Best-effort rollback of an unindexed encrypted body.
        }
        throw error;
      }
      removeVaultEntries(state, evicted);
      return { entry: built.entry, coalesced: false, prunedEntryCount: evicted.length };
    },

    list(scope, relativePath, nowMs = Date.now()): readonly EditorLocalHistoryEntry[] {
      const state = stateFor(scope.workspaceId);
      pruneExpired(state, nowMs);
      const digestFilter = relativePath === undefined ? undefined : pathDigest(relativePath);
      return state.index.entries
        .filter(
          (entry): boolean =>
            scopeMatches(entry, scope) &&
            (digestFilter === undefined || entry.relativePathDigest === digestFilter),
        )
        .sort((left, right): number => {
          const byTime = right.recordedAt.localeCompare(left.recordedAt);
          return byTime === 0 ? right.entryRef.localeCompare(left.entryRef) : byTime;
        });
    },

    entry(scope, entryRef, nowMs = Date.now()): EditorLocalHistoryEntry {
      const state = stateFor(scope.workspaceId);
      pruneExpired(state, nowMs);
      return requireEntry(state, scope, entryRef);
    },

    read(scope, entryRef, nowMs = Date.now()): EditorLocalHistoryReadResult {
      const state = stateFor(scope.workspaceId);
      pruneExpired(state, nowMs);
      const entry = requireEntry(state, scope, entryRef);
      let payload: HistoryPayload;
      try {
        payload = checkedPayload(state.vault.get(entry.encryptedContent.vaultEntryRef), entry);
      } catch (error) {
        if (error instanceof EditorLocalHistoryError) throw error;
        throw new EditorLocalHistoryError(
          "CONTENT_UNAVAILABLE",
          "Local-history content is unavailable.",
        );
      }
      const accessTime = Math.max(nowMs, Date.parse(entry.recordedAt));
      const accessed: EditorLocalHistoryEntry = { ...entry, lastAccessedAt: instant(accessTime) };
      const entries = state.index.entries.map((candidate): EditorLocalHistoryEntry =>
        candidate.entryRef === entry.entryRef ? accessed : candidate,
      );
      persist(state, indexWithEntries(state.index, entries));
      return { entry: accessed, content: payload.content };
    },

    setPinned(scope, entryRef, pinned, nowMs = Date.now()): EditorLocalHistoryEntry {
      const state = stateFor(scope.workspaceId);
      pruneExpired(state, nowMs);
      const entry = requireEntry(state, scope, entryRef);
      const pinnedBytes = state.index.entries.reduce(
        (total, candidate): number =>
          total + (candidate.pinned ? candidate.plaintextByteLength : 0),
        0,
      );
      if (
        pinned &&
        !entry.pinned &&
        pinnedBytes + entry.plaintextByteLength > limits.maxPinnedBytes
      ) {
        throw new EditorLocalHistoryError("PINNED_BYTE_LIMIT", "Local-history pin limit reached.");
      }
      const updated: EditorLocalHistoryEntry = {
        ...entry,
        pinned,
        pinnedAt: pinned ? { outcome: "known", value: instant(nowMs) } : { outcome: "absent" },
      };
      const entries = state.index.entries.map((candidate): EditorLocalHistoryEntry =>
        candidate.entryRef === entry.entryRef ? updated : candidate,
      );
      persist(state, indexWithEntries(state.index, entries));
      return updated;
    },

    delete(scope, entryRef): void {
      const state = stateFor(scope.workspaceId);
      const entry = requireEntry(state, scope, entryRef);
      const entries = state.index.entries.filter(
        (candidate): boolean => candidate.entryRef !== entryRef,
      );
      try {
        state.vault.delete(entry.encryptedContent.vaultEntryRef);
      } catch {
        throw new EditorLocalHistoryError(
          "VAULT_WRITE_FAILED",
          "Local-history encrypted content could not be deleted.",
        );
      }
      persist(state, indexWithEntries(state.index, entries));
    },
  };
}
