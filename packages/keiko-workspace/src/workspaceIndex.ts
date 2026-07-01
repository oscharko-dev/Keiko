import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  isValidScopePath,
  type RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { redact } from "@oscharko-dev/keiko-security";
import type { WorkspaceFs, WorkspaceStat } from "./fs.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import {
  orderCandidatesForSearch,
  type SearchDiagnostics,
  type SearchPolicy,
  type SearchPolicyMode,
} from "./repoSearchPolicy.js";
import { containedRealPathInfo } from "./realpath.js";
import type { DiscoveredFile, WorkspaceInfo } from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export const WORKSPACE_INDEX_SNAPSHOT_VERSION = 1;

export type WorkspaceIndexRecordKind = "text" | "binary" | "size-exceeded";

export interface WorkspaceIndexScopeKey {
  readonly workspaceRoot: string;
  readonly relativePaths: readonly string[];
  readonly policyMode: SearchPolicyMode;
  readonly applyGitignore: boolean;
  readonly omitLowValueWorkspaceFiles: boolean;
  readonly maxBytesPerFileScanned: number;
}

export interface WorkspaceIndexDiscoveredFile {
  readonly scopePath: string;
  readonly sizeBytes: number;
  readonly mtimeMs?: number | undefined;
}

export interface WorkspaceIndexDiscoverySnapshot {
  readonly files: readonly WorkspaceIndexDiscoveredFile[];
  readonly filesDiscovered: number;
  readonly ignoredByDiscovery: number;
  readonly deniedByDiscovery: number;
  readonly depthPrunedByDiscovery: number;
  readonly truncated: boolean;
}

export interface WorkspaceIndexRecord extends WorkspaceIndexDiscoveredFile {
  readonly kind: WorkspaceIndexRecordKind;
  readonly content?: string | undefined;
}

export interface WorkspaceIndexSnapshot {
  readonly version: number;
  readonly relativePaths: readonly string[];
  readonly policyMode: SearchPolicyMode;
  readonly applyGitignore: boolean;
  readonly omitLowValueWorkspaceFiles: boolean;
  readonly maxBytesPerFileScanned: number;
  readonly discovery: WorkspaceIndexDiscoverySnapshot;
  readonly records: readonly WorkspaceIndexRecord[];
}

export interface WorkspaceIndexStore {
  readonly loadSnapshot: (storageKey: string) => MaybePromise<WorkspaceIndexSnapshot | undefined>;
  readonly saveSnapshot: (
    storageKey: string,
    snapshot: WorkspaceIndexSnapshot,
  ) => MaybePromise<void>;
}

export interface FileWorkspaceIndexStoreOptions {
  readonly runtimeDir: string;
  readonly maxSnapshotBytes?: number | undefined;
  readonly maxSnapshots?: number | undefined;
  readonly maxSnapshotEntries?: number | undefined;
}

export interface WorkspaceIndex {
  readonly loadSnapshot: (
    scopeKey: WorkspaceIndexScopeKey,
  ) => Promise<WorkspaceIndexSnapshot | undefined>;
  readonly saveSnapshot: (
    scopeKey: WorkspaceIndexScopeKey,
    snapshot: WorkspaceIndexSnapshot,
  ) => Promise<void>;
}

export interface PreparedWorkspaceIndexEntry {
  readonly scopePath: string;
  readonly absolutePath: string;
  readonly file: DiscoveredFile;
  readonly mtimeMs?: number | undefined;
  readonly record: WorkspaceIndexRecord | undefined;
  readonly stale: boolean;
}

export interface WorkspaceIndexPreparationReport {
  readonly discoveredEntries: number;
  readonly retainedEntries: number;
  readonly indexedRecords: number;
  readonly reusedRecords: number;
  readonly staleRecords: number;
  readonly skippedEntries: number;
  readonly deletedEntries: number;
  readonly droppedRecords: number;
}

export interface PreparedWorkspaceIndexSnapshot {
  readonly entries: readonly PreparedWorkspaceIndexEntry[];
  readonly discovery: WorkspaceIndexDiscoverySnapshot;
  readonly report: WorkspaceIndexPreparationReport;
}

export interface WorkspaceIndexCandidateSet {
  readonly files: readonly DiscoveredFile[];
  readonly truncated: boolean;
  readonly diagnostics: SearchDiagnostics;
}

interface ScopeShape {
  readonly workspace: WorkspaceInfo;
  readonly relativePaths: readonly string[];
}

interface ScopeKeyShape {
  readonly relativePaths: readonly string[];
}

interface PolicyShape {
  readonly policyMode: SearchPolicyMode;
  readonly applyGitignore: boolean;
  readonly omitLowValueWorkspaceFiles: boolean;
}

interface MatchedWorkspaceIndexRecord {
  readonly path: string;
  readonly record: WorkspaceIndexRecord;
}

interface PreparedEntryOutcomeRetained {
  readonly kind: "retained";
  readonly entry: PreparedWorkspaceIndexEntry;
  readonly matchedRecordPath?: string | undefined;
}

interface PreparedEntryOutcomeSkipped {
  readonly kind: "skipped" | "deleted";
}

type PreparedEntryOutcome = PreparedEntryOutcomeRetained | PreparedEntryOutcomeSkipped;

const FILE_WORKSPACE_INDEX_PREFIX = "workspace-index-";
const FILE_WORKSPACE_INDEX_EXTENSION = ".json";
const FILE_WORKSPACE_INDEX_SEGMENT_RE =
  /^workspace-index-[0-9a-f]{64}\.json(?:\.[0-9a-f]{16}\.tmp)?$/u;
const DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOTS = 128;
const DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_ENTRIES = 4_096;

function isRetainedPreparedEntryOutcome(
  outcome: PreparedEntryOutcome,
): outcome is PreparedEntryOutcomeRetained {
  return outcome.kind === "retained";
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeScopePath(scopePath: string): string {
  return scopePath.split("\\").join("/");
}

function isSafeIndexScopePath(scopePath: string): boolean {
  return isValidScopePath(scopePath, { mustBeRelative: true }) && !isDenied(scopePath);
}

function normalizeRelativePaths(relativePaths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of relativePaths) {
    const scopePath = normalizeScopePath(entry);
    if (!isSafeIndexScopePath(scopePath) || seen.has(scopePath)) {
      continue;
    }
    seen.add(scopePath);
    normalized.push(scopePath);
  }
  normalized.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return normalized;
}

function normalizeWholeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value);
}

function normalizeSizeBytes(value: unknown): number | undefined {
  return normalizeWholeNumber(value);
}

function normalizeMtimeMs(value: unknown): number | undefined {
  return normalizeWholeNumber(value);
}

function normalizeDiscoveredFile(
  file: WorkspaceIndexDiscoveredFile,
): WorkspaceIndexDiscoveredFile | undefined {
  const scopePath = normalizeScopePath(file.scopePath);
  const sizeBytes = normalizeSizeBytes(file.sizeBytes);
  if (!isSafeIndexScopePath(scopePath) || sizeBytes === undefined) {
    return undefined;
  }
  const mtimeMs = normalizeMtimeMs(file.mtimeMs);
  return {
    scopePath,
    sizeBytes,
    ...(mtimeMs !== undefined ? { mtimeMs } : {}),
  };
}

function normalizeRecord(record: WorkspaceIndexRecord): WorkspaceIndexRecord | undefined {
  const base = normalizeDiscoveredFile(record);
  if (base === undefined) {
    return undefined;
  }
  if (record.kind === "text") {
    if (typeof record.content !== "string") {
      return undefined;
    }
    return { ...base, kind: "text", content: redact(record.content) };
  }
  return { ...base, kind: record.kind };
}

function sortByScopePath<T extends { readonly scopePath: string }>(values: readonly T[]): readonly T[] {
  return [...values].sort((a, b) => (a.scopePath < b.scopePath ? -1 : a.scopePath > b.scopePath ? 1 : 0));
}

function dedupeDiscoveredFiles(
  files: readonly WorkspaceIndexDiscoveredFile[],
): readonly WorkspaceIndexDiscoveredFile[] {
  const byPath = new Map<string, WorkspaceIndexDiscoveredFile>();
  for (const file of sortByScopePath(files)) {
    if (!byPath.has(file.scopePath)) {
      byPath.set(file.scopePath, file);
    }
  }
  return [...byPath.values()];
}

function dedupeRecords(
  records: readonly WorkspaceIndexRecord[],
  allowedPaths: ReadonlySet<string>,
): readonly WorkspaceIndexRecord[] {
  const byPath = new Map<string, WorkspaceIndexRecord>();
  for (const record of sortByScopePath(records)) {
    if (!allowedPaths.has(record.scopePath) || byPath.has(record.scopePath)) {
      continue;
    }
    byPath.set(record.scopePath, record);
  }
  return [...byPath.values()];
}

function normalizeDiscoverySnapshot(
  discovery: WorkspaceIndexDiscoverySnapshot,
): WorkspaceIndexDiscoverySnapshot | undefined {
  const files = dedupeDiscoveredFiles(
    discovery.files
      .map((file) => normalizeDiscoveredFile(file))
      .filter((file): file is WorkspaceIndexDiscoveredFile => file !== undefined),
  );
  const filesDiscovered = normalizeWholeNumber(discovery.filesDiscovered);
  const ignoredByDiscovery = normalizeWholeNumber(discovery.ignoredByDiscovery);
  const deniedByDiscovery = normalizeWholeNumber(discovery.deniedByDiscovery);
  const depthPrunedByDiscovery = normalizeWholeNumber(discovery.depthPrunedByDiscovery);
  if (
    filesDiscovered === undefined ||
    ignoredByDiscovery === undefined ||
    deniedByDiscovery === undefined ||
    depthPrunedByDiscovery === undefined ||
    typeof discovery.truncated !== "boolean"
  ) {
    return undefined;
  }
  return {
    files,
    filesDiscovered: Math.max(files.length, filesDiscovered),
    ignoredByDiscovery,
    deniedByDiscovery,
    depthPrunedByDiscovery,
    truncated: discovery.truncated,
  };
}

function normalizeSnapshot(snapshot: WorkspaceIndexSnapshot): WorkspaceIndexSnapshot | undefined {
  if (
    normalizeWholeNumber(snapshot.version) !== WORKSPACE_INDEX_SNAPSHOT_VERSION ||
    typeof snapshot.applyGitignore !== "boolean" ||
    typeof snapshot.omitLowValueWorkspaceFiles !== "boolean"
  ) {
    return undefined;
  }
  const maxBytesPerFileScanned = normalizeWholeNumber(snapshot.maxBytesPerFileScanned);
  if (maxBytesPerFileScanned === undefined || maxBytesPerFileScanned === 0) {
    return undefined;
  }
  const discovery = normalizeDiscoverySnapshot(snapshot.discovery);
  if (discovery === undefined) {
    return undefined;
  }
  const relativePaths = normalizeRelativePaths(snapshot.relativePaths);
  const allowedPaths = new Set(discovery.files.map((file) => file.scopePath));
  const records = dedupeRecords(
    snapshot.records
      .map((record) => normalizeRecord(record))
      .filter((record): record is WorkspaceIndexRecord => record !== undefined),
    allowedPaths,
  );
  return {
    version: WORKSPACE_INDEX_SNAPSHOT_VERSION,
    relativePaths,
    policyMode: snapshot.policyMode,
    applyGitignore: snapshot.applyGitignore,
    omitLowValueWorkspaceFiles: snapshot.omitLowValueWorkspaceFiles,
    maxBytesPerFileScanned,
    discovery,
    records,
  };
}

function storageKey(scopeKey: WorkspaceIndexScopeKey): string {
  return `keiko-workspace-index:${sha256Hex(
    JSON.stringify({
      workspaceRoot: scopeKey.workspaceRoot,
      relativePaths: normalizeRelativePaths(scopeKey.relativePaths),
      policyMode: scopeKey.policyMode,
      applyGitignore: scopeKey.applyGitignore,
      omitLowValueWorkspaceFiles: scopeKey.omitLowValueWorkspaceFiles,
      maxBytesPerFileScanned: scopeKey.maxBytesPerFileScanned,
    }),
  )}`;
}

export function buildWorkspaceIndexScopeKey(
  scope: ScopeShape,
  policy: PolicyShape,
  maxBytesPerFileScanned: number,
): WorkspaceIndexScopeKey {
  return {
    workspaceRoot: scope.workspace.root,
    relativePaths: normalizeRelativePaths(scope.relativePaths),
    policyMode: policy.policyMode,
    applyGitignore: policy.applyGitignore,
    omitLowValueWorkspaceFiles: policy.omitLowValueWorkspaceFiles,
    maxBytesPerFileScanned,
  };
}

interface FileWorkspaceIndexStoreConfig {
  readonly runtimeDir: string;
  readonly maxSnapshotBytes: number;
  readonly maxSnapshots: number;
  readonly maxSnapshotEntries: number;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  const normalized = normalizeWholeNumber(value);
  return normalized === undefined || normalized === 0 ? fallback : normalized;
}

function assertValidRuntimeDir(runtimeDir: string): string {
  if (runtimeDir.length === 0 || runtimeDir.trim().length === 0) {
    throw new Error("workspace index runtimeDir must not be empty");
  }
  if (runtimeDir.includes("\u0000")) {
    throw new Error("workspace index runtimeDir must not contain NUL bytes");
  }
  return resolve(runtimeDir);
}

function fileWorkspaceIndexStoreConfig(
  options: FileWorkspaceIndexStoreOptions,
): FileWorkspaceIndexStoreConfig {
  return {
    runtimeDir: assertValidRuntimeDir(options.runtimeDir),
    maxSnapshotBytes: normalizeLimit(
      options.maxSnapshotBytes,
      DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_BYTES,
    ),
    maxSnapshots: normalizeLimit(
      options.maxSnapshots,
      DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOTS,
    ),
    maxSnapshotEntries: normalizeLimit(
      options.maxSnapshotEntries,
      DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_ENTRIES,
    ),
  };
}

function snapshotFileSegment(storageKey: string): string {
  return `${FILE_WORKSPACE_INDEX_PREFIX}${sha256Hex(storageKey)}${FILE_WORKSPACE_INDEX_EXTENSION}`;
}

function tempSnapshotFileSegment(finalSegment: string): string {
  return `${finalSegment}.${sha256Hex(`${finalSegment}:${Date.now().toString()}:${Math.random().toString()}`).slice(0, 16)}.tmp`;
}

function assertSafePathSegment(segment: string): string {
  if (
    segment.length === 0 ||
    segment.includes("\u0000") ||
    segment.includes("/") ||
    segment.includes("\\") ||
    !FILE_WORKSPACE_INDEX_SEGMENT_RE.test(segment)
  ) {
    throw new Error(`unsafe workspace index file segment: ${segment}`);
  }
  return segment;
}

function runtimeFilePath(runtimeDir: string, segment: string): string {
  const safeSegment = assertSafePathSegment(segment);
  const path = resolve(runtimeDir, safeSegment);
  if (dirname(path) !== runtimeDir) {
    throw new Error(`workspace index path escaped runtimeDir: ${safeSegment}`);
  }
  return path;
}

function snapshotPath(runtimeDir: string, storageKey: string): string {
  return runtimeFilePath(runtimeDir, snapshotFileSegment(storageKey));
}

function tempSnapshotPath(runtimeDir: string, storageKey: string): string {
  return runtimeFilePath(runtimeDir, tempSnapshotFileSegment(snapshotFileSegment(storageKey)));
}

function countSnapshotEntries(snapshot: WorkspaceIndexSnapshot): number {
  return snapshot.relativePaths.length + snapshot.discovery.files.length + snapshot.records.length;
}

function snapshotFitsStoreBounds(
  snapshot: WorkspaceIndexSnapshot,
  maxSnapshotEntries: number,
): boolean {
  return (
    snapshot.relativePaths.length <= maxSnapshotEntries &&
    snapshot.discovery.files.length <= maxSnapshotEntries &&
    snapshot.records.length <= maxSnapshotEntries &&
    countSnapshotEntries(snapshot) <= maxSnapshotEntries
  );
}

async function safeReadSnapshotFile(
  path: string,
  maxSnapshotBytes: number,
): Promise<string | undefined> {
  let fileStat;
  try {
    fileStat = await stat(path);
  } catch {
    return undefined;
  }
  if (!fileStat.isFile() || fileStat.size > maxSnapshotBytes) {
    return undefined;
  }
  try {
    const raw = await readFile(path, "utf8");
    return Buffer.byteLength(raw, "utf8") > maxSnapshotBytes ? undefined : raw;
  } catch {
    return undefined;
  }
}

function parseStoredSnapshot(
  raw: string,
  maxSnapshotEntries: number,
): WorkspaceIndexSnapshot | undefined {
  try {
    const parsed = JSON.parse(raw) as WorkspaceIndexSnapshot;
    const normalized = normalizeSnapshot(parsed);
    if (normalized === undefined || !snapshotFitsStoreBounds(normalized, maxSnapshotEntries)) {
      return undefined;
    }
    return normalized;
  } catch {
    return undefined;
  }
}

async function pruneWorkspaceIndexSnapshots(
  runtimeDir: string,
  maxSnapshots: number,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(runtimeDir, { withFileTypes: true });
  } catch {
    return;
  }
  const files = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          FILE_WORKSPACE_INDEX_SEGMENT_RE.test(entry.name) &&
          entry.name.endsWith(FILE_WORKSPACE_INDEX_EXTENSION),
      )
      .map(async (entry) => ({
        path: runtimeFilePath(runtimeDir, entry.name),
        stat: await stat(runtimeFilePath(runtimeDir, entry.name)),
      })),
  );
  const excess = files
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(maxSnapshots);
  await Promise.all(excess.map(async (entry) => rm(entry.path, { force: true })));
}

async function atomicWriteSnapshotFile(path: string, tempPath: string, content: string): Promise<void> {
  await writeFile(tempPath, content, "utf8");
  try {
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export function createFileWorkspaceIndexStore(
  options: FileWorkspaceIndexStoreOptions,
): WorkspaceIndexStore {
  const config = fileWorkspaceIndexStoreConfig(options);
  return {
    loadSnapshot: async (storageKey: string): Promise<WorkspaceIndexSnapshot | undefined> => {
      const raw = await safeReadSnapshotFile(
        snapshotPath(config.runtimeDir, storageKey),
        config.maxSnapshotBytes,
      );
      return raw === undefined
        ? undefined
        : parseStoredSnapshot(raw, config.maxSnapshotEntries);
    },
    saveSnapshot: async (storageKey: string, snapshot: WorkspaceIndexSnapshot): Promise<void> => {
      const normalized = normalizeSnapshot(snapshot);
      if (
        normalized === undefined ||
        !snapshotFitsStoreBounds(normalized, config.maxSnapshotEntries)
      ) {
        return;
      }
      const raw = JSON.stringify(normalized);
      if (Buffer.byteLength(raw, "utf8") > config.maxSnapshotBytes) {
        return;
      }
      await mkdir(config.runtimeDir, { recursive: true });
      await atomicWriteSnapshotFile(
        snapshotPath(config.runtimeDir, storageKey),
        tempSnapshotPath(config.runtimeDir, storageKey),
        raw,
      );
      await pruneWorkspaceIndexSnapshots(config.runtimeDir, config.maxSnapshots);
    },
  };
}

export function createInMemoryWorkspaceIndexStore(): WorkspaceIndexStore {
  const snapshots = new Map<string, WorkspaceIndexSnapshot>();
  return {
    loadSnapshot: (key: string): WorkspaceIndexSnapshot | undefined => snapshots.get(key),
    saveSnapshot: (key: string, snapshot: WorkspaceIndexSnapshot): void => {
      snapshots.set(key, snapshot);
    },
  };
}

export function createWorkspaceIndex(
  store: WorkspaceIndexStore = createInMemoryWorkspaceIndexStore(),
): WorkspaceIndex {
  return {
    loadSnapshot: async (
      scopeKey: WorkspaceIndexScopeKey,
    ): Promise<WorkspaceIndexSnapshot | undefined> => {
      const snapshot = await store.loadSnapshot(storageKey(scopeKey));
      return snapshot === undefined ? undefined : normalizeSnapshot(snapshot);
    },
    saveSnapshot: async (
      scopeKey: WorkspaceIndexScopeKey,
      snapshot: WorkspaceIndexSnapshot,
    ): Promise<void> => {
      const normalized = normalizeSnapshot(snapshot);
      if (normalized === undefined) {
        return;
      }
      await store.saveSnapshot(storageKey(scopeKey), normalized);
    },
  };
}

function currentMetadata(scopePath: string, stat: WorkspaceStat): WorkspaceIndexDiscoveredFile {
  const mtimeMs = normalizeMtimeMs(stat.mtimeMs);
  return {
    scopePath,
    sizeBytes: stat.size,
    ...(mtimeMs !== undefined ? { mtimeMs } : {}),
  };
}

function sameRecordMetadata(
  record: WorkspaceIndexRecord | undefined,
  metadata: WorkspaceIndexDiscoveredFile,
): boolean {
  if (record === undefined) {
    return false;
  }
  return record.sizeBytes === metadata.sizeBytes && record.mtimeMs === metadata.mtimeMs;
}

function emptyPreparationReport(): WorkspaceIndexPreparationReport {
  return {
    discoveredEntries: 0,
    retainedEntries: 0,
    indexedRecords: 0,
    reusedRecords: 0,
    staleRecords: 0,
    skippedEntries: 0,
    deletedEntries: 0,
    droppedRecords: 0,
  };
}

function emptyPreparedWorkspaceIndexSnapshot(): PreparedWorkspaceIndexSnapshot {
  return {
    entries: [],
    discovery: {
      files: [],
      filesDiscovered: 0,
      ignoredByDiscovery: 0,
      deniedByDiscovery: 0,
      depthPrunedByDiscovery: 0,
      truncated: false,
    },
    report: emptyPreparationReport(),
  };
}

function preparedDiscoveryFile(entry: PreparedWorkspaceIndexEntry): WorkspaceIndexDiscoveredFile {
  return {
    scopePath: entry.scopePath,
    sizeBytes: entry.file.sizeBytes,
    ...(entry.mtimeMs !== undefined ? { mtimeMs: entry.mtimeMs } : {}),
  };
}

function matchedRecord(
  recordByPath: ReadonlyMap<string, WorkspaceIndexRecord>,
  scopePath: string,
  requestedPath: string,
): MatchedWorkspaceIndexRecord | undefined {
  const direct = recordByPath.get(scopePath);
  if (direct !== undefined) {
    return { path: scopePath, record: direct };
  }
  if (scopePath === requestedPath) {
    return undefined;
  }
  const requested = recordByPath.get(requestedPath);
  return requested === undefined ? undefined : { path: requestedPath, record: requested };
}

function statFile(fs: WorkspaceFs, absolutePath: string): WorkspaceStat | undefined {
  try {
    return fs.stat(absolutePath);
  } catch {
    return undefined;
  }
}

function retainedPreparedEntry(
  containedPath: string,
  scopePath: string,
  metadata: WorkspaceIndexDiscoveredFile,
  matched: MatchedWorkspaceIndexRecord | undefined,
): PreparedEntryOutcomeRetained {
  return {
    kind: "retained",
    entry: {
      scopePath,
      absolutePath: containedPath,
      file: { relativePath: scopePath, sizeBytes: metadata.sizeBytes },
      ...(metadata.mtimeMs !== undefined ? { mtimeMs: metadata.mtimeMs } : {}),
      record: matched?.record,
      stale: !sameRecordMetadata(matched?.record, metadata),
    },
    matchedRecordPath: matched?.path,
  };
}

function prepareWorkspaceIndexEntry(
  discovered: WorkspaceIndexDiscoveredFile,
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  seen: Set<string>,
  recordByPath: ReadonlyMap<string, WorkspaceIndexRecord>,
): PreparedEntryOutcome {
  const requestedPath = discovered.scopePath;
  if (!isSafeIndexScopePath(requestedPath)) {
    return { kind: "skipped" };
  }
  const absolutePath = resolveWithinWorkspace(workspace.root, requestedPath);
  if (!fs.exists(absolutePath)) {
    return { kind: "deleted" };
  }
  const contained = containedRealPathInfo(fs, workspace.root, absolutePath);
  const scopePath = normalizeScopePath(contained.realRelative);
  if (!isSafeIndexScopePath(scopePath) || seen.has(scopePath)) {
    return { kind: "skipped" };
  }
  const stat = statFile(fs, contained.path);
  if (stat?.isFile !== true) {
    return { kind: "skipped" };
  }
  seen.add(scopePath);
  return retainedPreparedEntry(
    contained.path,
    scopePath,
    currentMetadata(scopePath, stat),
    matchedRecord(recordByPath, scopePath, requestedPath),
  );
}

function updatePreparationReport(
  report: WorkspaceIndexPreparationReport,
  outcome: PreparedEntryOutcome,
): WorkspaceIndexPreparationReport {
  if (outcome.kind === "deleted") {
    return { ...report, deletedEntries: report.deletedEntries + 1 };
  }
  if (outcome.kind === "skipped") {
    return { ...report, skippedEntries: report.skippedEntries + 1 };
  }
  if (!isRetainedPreparedEntryOutcome(outcome)) {
    return report;
  }
  const entry = outcome.entry;
  const hasRecord = entry.record !== undefined;
  const indexedRecords = report.indexedRecords + (hasRecord ? 1 : 0);
  const reusedRecords = report.reusedRecords + (hasRecord && !entry.stale ? 1 : 0);
  const staleRecords = report.staleRecords + (hasRecord && entry.stale ? 1 : 0);
  return {
    ...report,
    retainedEntries: report.retainedEntries + 1,
    indexedRecords,
    reusedRecords,
    staleRecords,
  };
}

function preparedDiscoverySnapshot(
  normalized: WorkspaceIndexSnapshot,
  entries: readonly PreparedWorkspaceIndexEntry[],
): WorkspaceIndexDiscoverySnapshot {
  const files = entries.map((entry) => preparedDiscoveryFile(entry));
  return {
    files,
    filesDiscovered: normalized.discovery.truncated ? normalized.discovery.filesDiscovered : files.length,
    ignoredByDiscovery: normalized.discovery.ignoredByDiscovery,
    deniedByDiscovery: normalized.discovery.deniedByDiscovery,
    depthPrunedByDiscovery: normalized.discovery.depthPrunedByDiscovery,
    truncated: normalized.discovery.truncated,
  };
}

function finalizePreparationReport(
  report: WorkspaceIndexPreparationReport,
  usedRecordPaths: ReadonlySet<string>,
  normalized: WorkspaceIndexSnapshot,
): WorkspaceIndexPreparationReport {
  return {
    ...report,
    discoveredEntries: normalized.discovery.files.length,
    droppedRecords: normalized.records.filter((record) => !usedRecordPaths.has(record.scopePath)).length,
  };
}

export function prepareWorkspaceIndexSnapshot(
  snapshot: WorkspaceIndexSnapshot,
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
): PreparedWorkspaceIndexSnapshot {
  const normalized = normalizeSnapshot(snapshot);
  if (normalized === undefined) {
    return emptyPreparedWorkspaceIndexSnapshot();
  }
  const entries: PreparedWorkspaceIndexEntry[] = [];
  let report = emptyPreparationReport();
  const recordByPath = new Map(normalized.records.map((record) => [record.scopePath, record] as const));
  const seen = new Set<string>();
  const usedRecordPaths = new Set<string>();
  for (const discovered of normalized.discovery.files) {
    const outcome = prepareWorkspaceIndexEntry(discovered, workspace, fs, seen, recordByPath);
    report = updatePreparationReport(report, outcome);
    if (outcome.kind !== "retained") {
      continue;
    }
    entries.push(outcome.entry);
    if (outcome.matchedRecordPath !== undefined) {
      usedRecordPaths.add(outcome.matchedRecordPath);
    }
  }
  entries.sort((a, b) => (a.scopePath < b.scopePath ? -1 : a.scopePath > b.scopePath ? 1 : 0));
  return {
    entries,
    discovery: preparedDiscoverySnapshot(normalized, entries),
    report: finalizePreparationReport(report, usedRecordPaths, normalized),
  };
}

export function workspaceIndexCandidateSet(
  prepared: PreparedWorkspaceIndexSnapshot,
  query: RetrievalQuery,
  policy: SearchPolicy,
): WorkspaceIndexCandidateSet {
  const files: readonly DiscoveredFile[] = prepared.discovery.files.map((file) => ({
    relativePath: file.scopePath,
    sizeBytes: file.sizeBytes,
  }));
  const ordered = orderCandidatesForSearch(
    files,
    query,
    policy,
    prepared.discovery.ignoredByDiscovery,
    prepared.discovery.deniedByDiscovery,
    prepared.discovery.depthPrunedByDiscovery,
  );
  return {
    files: ordered.files,
    truncated: prepared.discovery.truncated,
    diagnostics: {
      ...ordered.diagnostics,
      filesDiscovered: prepared.discovery.filesDiscovered,
      filesAfterPolicy: ordered.diagnostics.filesAfterPolicy,
    },
  };
}

export interface BuildWorkspaceIndexSnapshotInput {
  readonly scope: ScopeKeyShape;
  readonly policy: PolicyShape;
  readonly maxBytesPerFileScanned: number;
  readonly discovery: WorkspaceIndexDiscoverySnapshot;
  readonly records: Iterable<WorkspaceIndexRecord>;
}

export function buildWorkspaceIndexSnapshot(
  input: BuildWorkspaceIndexSnapshotInput,
): WorkspaceIndexSnapshot {
  const discovery = normalizeDiscoverySnapshot(input.discovery) ?? {
    files: [],
    filesDiscovered: 0,
    ignoredByDiscovery: 0,
    deniedByDiscovery: 0,
    depthPrunedByDiscovery: 0,
    truncated: false,
  };
  const allowedPaths = new Set(discovery.files.map((file) => file.scopePath));
  const records = dedupeRecords(
    [...input.records]
      .map((record) => normalizeRecord(record))
      .filter((record): record is WorkspaceIndexRecord => record !== undefined),
    allowedPaths,
  );
  return {
    version: WORKSPACE_INDEX_SNAPSHOT_VERSION,
    relativePaths: normalizeRelativePaths(input.scope.relativePaths),
    policyMode: input.policy.policyMode,
    applyGitignore: input.policy.applyGitignore,
    omitLowValueWorkspaceFiles: input.policy.omitLowValueWorkspaceFiles,
    maxBytesPerFileScanned: input.maxBytesPerFileScanned,
    discovery,
    records,
  };
}
