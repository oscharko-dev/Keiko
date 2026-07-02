import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  isValidScopePath,
  type RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
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

export const WORKSPACE_INDEX_SNAPSHOT_VERSION = 2;

export type WorkspaceIndexRecordKind = "text" | "binary" | "size-exceeded";

export interface WorkspaceIndexScopeKey {
  readonly workspaceRoot: string;
  readonly relativePaths: readonly string[];
  readonly policyMode: SearchPolicyMode;
  readonly applyGitignore: boolean;
  readonly omitLowValueWorkspaceFiles: boolean;
  readonly maxBytesPerFileScanned: number;
  readonly maxFilesScanned: number;
}

export interface WorkspaceIndexDiscoveredFile {
  readonly scopePath: string;
  readonly sizeBytes: number;
  readonly mtimeMs?: number | undefined;
}

export interface WorkspaceIndexLexicalLine {
  readonly startLine: number;
  readonly endLine: number;
  readonly termHashes: readonly string[];
}

export interface WorkspaceIndexLexicalRecord {
  readonly truncated: boolean;
  readonly termHashes: readonly string[];
  readonly lines: readonly WorkspaceIndexLexicalLine[];
}

export interface WorkspaceIndexDirectorySnapshot {
  readonly scopePath: string;
  readonly fingerprint: string;
  readonly mtimeMs?: number | undefined;
}

export interface WorkspaceIndexDiscoverySnapshot {
  readonly files: readonly WorkspaceIndexDiscoveredFile[];
  readonly directories: readonly WorkspaceIndexDirectorySnapshot[];
  readonly filesDiscovered: number;
  readonly ignoredByDiscovery: number;
  readonly deniedByDiscovery: number;
  readonly depthPrunedByDiscovery: number;
  readonly truncated: boolean;
}

export interface WorkspaceIndexRecord extends WorkspaceIndexDiscoveredFile {
  readonly kind: WorkspaceIndexRecordKind;
  readonly fingerprint?: string | undefined;
  readonly lexical?: WorkspaceIndexLexicalRecord | undefined;
}

export interface WorkspaceIndexSnapshot {
  readonly version: number;
  readonly relativePaths: readonly string[];
  readonly policyMode: SearchPolicyMode;
  readonly applyGitignore: boolean;
  readonly omitLowValueWorkspaceFiles: boolean;
  readonly maxBytesPerFileScanned: number;
  readonly maxFilesScanned: number;
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
  readonly workspaceRoot?: string | undefined;
  readonly allowWorkspaceLocalRuntimeDir?: boolean | undefined;
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
  readonly valid: boolean;
  readonly dirty: boolean;
  readonly entries: readonly PreparedWorkspaceIndexEntry[];
  readonly discovery: WorkspaceIndexDiscoverySnapshot;
  readonly report: WorkspaceIndexPreparationReport;
}

export interface WorkspaceIndexCandidateSet {
  readonly files: readonly DiscoveredFile[];
  readonly directories: readonly string[];
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
const RUNTIME_DIR_MARKER_SEGMENT = "workspace-index-runtime-id";
const DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOTS = 128;
const DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_ENTRIES = 16_384;

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
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function hashLexicalTerm(term: string): string {
  return sha256Hex(term);
}

function normalizeFingerprint(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : undefined;
}

export function workspaceIndexContentFingerprint(content: string): string {
  return sha256Hex(`workspace-index-content:v1\0${content}`);
}

function normalizeDirectoryPath(scopePath: string): string | undefined {
  const normalized = normalizeScopePath(scopePath);
  if (normalized.length === 0) {
    return "";
  }
  return isSafeIndexScopePath(normalized) ? normalized : undefined;
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

function normalizeLexicalLine(line: WorkspaceIndexLexicalLine): WorkspaceIndexLexicalLine | undefined {
  const startLine = normalizeWholeNumber(line.startLine);
  const endLine = normalizeWholeNumber(line.endLine);
  if (
    startLine === undefined ||
    endLine === undefined ||
    startLine === 0 ||
    endLine === 0 ||
    endLine < startLine
  ) {
    return undefined;
  }
  const termHashes = [...new Set(line.termHashes.filter((term) => typeof term === "string" && term.length > 0))].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return {
    startLine,
    endLine,
    termHashes,
  };
}

function normalizeLexicalRecord(
  lexical: WorkspaceIndexLexicalRecord,
): WorkspaceIndexLexicalRecord | undefined {
  const lines = lexical.lines
    .map((line) => normalizeLexicalLine(line))
    .filter((line): line is WorkspaceIndexLexicalLine => line !== undefined);
  const termHashes = [...new Set(lexical.termHashes.filter((term) => typeof term === "string" && term.length > 0))].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );
  if (termHashes.length === 0 && lines.length === 0) {
    return undefined;
  }
  return {
    truncated: lexical.truncated,
    termHashes,
    lines,
  };
}

function normalizeDirectorySnapshot(
  directory: WorkspaceIndexDirectorySnapshot,
): WorkspaceIndexDirectorySnapshot | undefined {
  const scopePath = normalizeDirectoryPath(directory.scopePath);
  if (scopePath === undefined) {
    return undefined;
  }
  const mtimeMs = normalizeMtimeMs(directory.mtimeMs);
  if (typeof directory.fingerprint !== "string" || directory.fingerprint.length === 0) {
    return undefined;
  }
  return {
    scopePath,
    fingerprint: directory.fingerprint,
    ...(mtimeMs !== undefined ? { mtimeMs } : {}),
  };
}

function normalizeRecord(record: WorkspaceIndexRecord): WorkspaceIndexRecord | undefined {
  const base = normalizeDiscoveredFile(record);
  if (base === undefined) {
    return undefined;
  }
  if (record.kind === "text") {
    const lexical = normalizeLexicalRecord(record.lexical ?? { truncated: false, termHashes: [], lines: [] });
    if (lexical === undefined) {
      return undefined;
    }
    const fingerprint = normalizeFingerprint(record.fingerprint);
    return {
      ...base,
      kind: "text",
      ...(fingerprint !== undefined ? { fingerprint } : {}),
      lexical,
    };
  }
  const fingerprint = normalizeFingerprint(record.fingerprint);
  return {
    ...base,
    kind: record.kind,
    ...(fingerprint !== undefined ? { fingerprint } : {}),
  };
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

function dedupeDirectories(
  directories: readonly WorkspaceIndexDirectorySnapshot[],
): readonly WorkspaceIndexDirectorySnapshot[] {
  const byPath = new Map<string, WorkspaceIndexDirectorySnapshot>();
  for (const directory of sortByScopePath(directories)) {
    if (!byPath.has(directory.scopePath)) {
      byPath.set(directory.scopePath, directory);
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
  const directories = dedupeDirectories(
    discovery.directories
      .map((directory) => normalizeDirectorySnapshot(directory))
      .filter((directory): directory is WorkspaceIndexDirectorySnapshot => directory !== undefined),
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
    directories,
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
  const maxFilesScanned = normalizeWholeNumber(snapshot.maxFilesScanned);
  if (
    maxBytesPerFileScanned === undefined ||
    maxBytesPerFileScanned === 0 ||
    maxFilesScanned === undefined ||
    maxFilesScanned === 0
  ) {
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
    maxFilesScanned,
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
      maxFilesScanned: scopeKey.maxFilesScanned,
    }),
  )}`;
}

export function buildWorkspaceIndexScopeKey(
  scope: ScopeShape,
  policy: PolicyShape,
  maxBytesPerFileScanned: number,
  maxFilesScanned: number,
): WorkspaceIndexScopeKey {
  return {
    workspaceRoot: scope.workspace.root,
    relativePaths: normalizeRelativePaths(scope.relativePaths),
    policyMode: policy.policyMode,
    applyGitignore: policy.applyGitignore,
    omitLowValueWorkspaceFiles: policy.omitLowValueWorkspaceFiles,
    maxBytesPerFileScanned,
    maxFilesScanned,
  };
}

interface FileWorkspaceIndexStoreConfig {
  readonly runtimeDir: string;
  readonly runtimeDirIdentity: RuntimeDirIdentity | undefined;
  readonly workspaceRoot: string | undefined;
  readonly allowWorkspaceLocalRuntimeDir: boolean;
  readonly maxSnapshotBytes: number;
  readonly maxSnapshots: number;
  readonly maxSnapshotEntries: number;
}

interface RuntimeDirIdentity {
  readonly realPath: string;
  readonly dev: number | undefined;
  readonly ino: number | undefined;
  readonly marker: string | undefined;
}

function runtimeDirIdentity(
  realPath: string,
  stat: { readonly dev?: number; readonly ino?: number },
  marker?: string,
): RuntimeDirIdentity {
  return {
    realPath,
    dev: typeof stat.dev === "number" ? stat.dev : undefined,
    ino: typeof stat.ino === "number" ? stat.ino : undefined,
    marker,
  };
}

function sameRuntimeDirIdentity(a: RuntimeDirIdentity, b: RuntimeDirIdentity): boolean {
  if (a.realPath !== b.realPath) {
    return false;
  }
  if (a.dev === undefined || a.ino === undefined || b.dev === undefined || b.ino === undefined) {
    return true;
  }
  if (a.dev !== b.dev || a.ino !== b.ino) {
    return false;
  }
  return a.marker === undefined || b.marker === undefined || a.marker === b.marker;
}

function resolvedRuntimeDirRealPath(
  runtimeDir: string,
  workspaceRoot: string | undefined,
  allowWorkspaceLocalRuntimeDir: boolean,
): string | undefined {
  try {
    const realPath = realpathSync(runtimeDir);
    if (
      workspaceRoot !== undefined &&
      !allowWorkspaceLocalRuntimeDir &&
      isRuntimeDirWithinWorkspace(realPath, existingRealPath(workspaceRoot))
    ) {
      return undefined;
    }
    return realPath;
  } catch {
    return undefined;
  }
}

function resolvedRuntimeDirIdentity(
  runtimeDir: string,
  workspaceRoot: string | undefined,
  allowWorkspaceLocalRuntimeDir: boolean,
): RuntimeDirIdentity | undefined {
  try {
    const dirStat = lstatSync(runtimeDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      return undefined;
    }
    const realPath = resolvedRuntimeDirRealPath(runtimeDir, workspaceRoot, allowWorkspaceLocalRuntimeDir);
    return realPath === undefined ? undefined : runtimeDirIdentity(realPath, dirStat);
  } catch {
    return undefined;
  }
}

function runtimeDirMarkerPath(runtimeDir: string): string {
  const markerPath = resolve(runtimeDir, RUNTIME_DIR_MARKER_SEGMENT);
  if (dirname(markerPath) !== runtimeDir) {
    throw new Error("workspace index runtime marker path escaped runtimeDir");
  }
  return markerPath;
}

function isRuntimeDirMarker(value: string): boolean {
  if (value.length !== 36) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isHyphen = [8, 13, 18, 23].includes(index) && code === 45;
    const isHex = (code >= 48 && code <= 57) || (code >= 97 && code <= 102);
    if (!isHyphen && !isHex) {
      return false;
    }
  }
  return true;
}

function parseRuntimeDirMarker(raw: string): string | undefined {
  const marker = raw.trim();
  return isRuntimeDirMarker(marker) ? marker : undefined;
}

async function readRuntimeDirMarker(realPath: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(runtimeDirMarkerPath(realPath), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const markerStat = await handle.stat();
    if (!markerStat.isFile() || markerStat.size > 128) {
      return undefined;
    }
    const raw = await readSnapshotHandleWithinLimit(handle, 128);
    return raw === undefined ? undefined : parseRuntimeDirMarker(raw.toString("utf8"));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensureRuntimeDirMarker(realPath: string): Promise<string | undefined> {
  const existing = await readRuntimeDirMarker(realPath);
  if (existing !== undefined) {
    return existing;
  }
  const marker = randomUUID();
  const markerPath = runtimeDirMarkerPath(realPath);
  try {
    await writeFile(markerPath, `${marker}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await bestEffortChmod(markerPath, 0o600);
    return marker;
  } catch {
    return await readRuntimeDirMarker(realPath);
  }
}

async function runtimeDirIdentityIfSafe(
  runtimeDir: string,
  workspaceRoot: string | undefined,
  allowWorkspaceLocalRuntimeDir: boolean,
): Promise<RuntimeDirIdentity | undefined> {
  try {
    const dirStat = await lstat(runtimeDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      return undefined;
    }
    const realPath = resolvedRuntimeDirRealPath(runtimeDir, workspaceRoot, allowWorkspaceLocalRuntimeDir);
    if (realPath === undefined) {
      return undefined;
    }
    const marker = await ensureRuntimeDirMarker(realPath);
    return runtimeDirIdentity(realPath, dirStat, marker);
  } catch {
    return undefined;
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  const normalized = normalizeWholeNumber(value);
  return normalized === undefined || normalized === 0 ? fallback : normalized;
}

function existingRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    try {
      return resolve(realpathSync(parent), basename(path));
    } catch {
      return resolve(path);
    }
  }
}

function isRuntimeDirWithinWorkspace(runtimeDir: string, workspaceRoot: string): boolean {
  const rel = relative(workspaceRoot, runtimeDir);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertValidRuntimeDir(
  runtimeDir: string,
  workspaceRoot: string | undefined,
  allowWorkspaceLocalRuntimeDir: boolean,
): string {
  if (runtimeDir.length === 0 || runtimeDir.trim().length === 0) {
    throw new Error("workspace index runtimeDir must not be empty");
  }
  if (runtimeDir.includes("\u0000")) {
    throw new Error("workspace index runtimeDir must not contain NUL bytes");
  }
  const resolved = resolve(runtimeDir);
  if (
    workspaceRoot !== undefined &&
    !allowWorkspaceLocalRuntimeDir &&
    (isRuntimeDirWithinWorkspace(resolved, resolve(workspaceRoot)) ||
      isRuntimeDirWithinWorkspace(existingRealPath(resolved), existingRealPath(workspaceRoot)))
  ) {
    throw new Error("workspace index runtimeDir must not be inside the workspace root");
  }
  return resolved;
}

function fileWorkspaceIndexStoreConfig(
  options: FileWorkspaceIndexStoreOptions,
): FileWorkspaceIndexStoreConfig {
  const runtimeDir = assertValidRuntimeDir(
    options.runtimeDir,
    options.workspaceRoot,
    options.allowWorkspaceLocalRuntimeDir === true,
  );
  const workspaceRoot = options.workspaceRoot === undefined ? undefined : resolve(options.workspaceRoot);
  return {
    runtimeDir,
    runtimeDirIdentity: resolvedRuntimeDirIdentity(
      runtimeDir,
      workspaceRoot,
      options.allowWorkspaceLocalRuntimeDir === true,
    ),
    workspaceRoot,
    allowWorkspaceLocalRuntimeDir: options.allowWorkspaceLocalRuntimeDir === true,
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
  return (
    snapshot.relativePaths.length +
    snapshot.discovery.files.length +
    snapshot.discovery.directories.length +
    snapshot.records.length
  );
}

function snapshotFitsStoreBounds(
  snapshot: WorkspaceIndexSnapshot,
  maxSnapshotEntries: number,
): boolean {
  return (
    snapshot.relativePaths.length <= maxSnapshotEntries &&
    snapshot.discovery.files.length <= maxSnapshotEntries &&
    snapshot.discovery.directories.length <= maxSnapshotEntries &&
    snapshot.records.length <= maxSnapshotEntries &&
    countSnapshotEntries(snapshot) <= maxSnapshotEntries
  );
}

function bestEffortChmod(path: string, mode: number): Promise<void> {
  return chmod(path, mode).catch(() => undefined);
}

async function safeReadSnapshotFile(
  path: string,
  maxSnapshotBytes: number,
): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > maxSnapshotBytes) {
      return undefined;
    }
    const raw = await readSnapshotHandleWithinLimit(handle, maxSnapshotBytes);
    return raw === undefined ? undefined : raw.toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readSnapshotHandleWithinLimit(
  handle: FileHandle,
  maxSnapshotBytes: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= maxSnapshotBytes) {
    const readLimit = Math.min(64 * 1024, maxSnapshotBytes + 1 - totalBytes);
    const buffer = Buffer.allocUnsafe(readLimit);
    const { bytesRead } = await handle.read(buffer, 0, readLimit);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, totalBytes);
    }
    totalBytes += bytesRead;
    if (totalBytes > maxSnapshotBytes) {
      return undefined;
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return undefined;
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
      .filter((entry) => entry.isFile() && FILE_WORKSPACE_INDEX_SEGMENT_RE.test(entry.name))
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
  await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
  await bestEffortChmod(tempPath, 0o600);
  try {
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  await bestEffortChmod(path, 0o600);
}

type RuntimeDirGuard = () => Promise<string | undefined>;

function createRuntimeDirGuard(config: FileWorkspaceIndexStoreConfig): RuntimeDirGuard {
  let expectedRuntimeDirIdentity = config.runtimeDirIdentity;
  return async (): Promise<string | undefined> => {
    const current = await runtimeDirIdentityIfSafe(
      config.runtimeDir,
      config.workspaceRoot,
      config.allowWorkspaceLocalRuntimeDir,
    );
    if (current === undefined) {
      return undefined;
    }
    if (expectedRuntimeDirIdentity === undefined) {
      expectedRuntimeDirIdentity = current;
      return current.realPath;
    }
    if (
      expectedRuntimeDirIdentity.marker === undefined &&
      current.marker !== undefined &&
      sameRuntimeDirIdentity(expectedRuntimeDirIdentity, current)
    ) {
      expectedRuntimeDirIdentity = current;
      return current.realPath;
    }
    return sameRuntimeDirIdentity(expectedRuntimeDirIdentity, current) ? current.realPath : undefined;
  };
}

async function loadFileWorkspaceIndexSnapshot(
  config: FileWorkspaceIndexStoreConfig,
  safeRuntimeDir: RuntimeDirGuard,
  storageKey: string,
): Promise<WorkspaceIndexSnapshot | undefined> {
  const runtimeDir = await safeRuntimeDir();
  if (runtimeDir === undefined) {
    return undefined;
  }
  const raw = await safeReadSnapshotFile(
    snapshotPath(runtimeDir, storageKey),
    config.maxSnapshotBytes,
  );
  return raw === undefined ? undefined : parseStoredSnapshot(raw, config.maxSnapshotEntries);
}

async function saveFileWorkspaceIndexSnapshot(
  config: FileWorkspaceIndexStoreConfig,
  safeRuntimeDir: RuntimeDirGuard,
  storageKey: string,
  snapshot: WorkspaceIndexSnapshot,
): Promise<void> {
  const normalized = normalizeSnapshot(snapshot);
  if (normalized === undefined || !snapshotFitsStoreBounds(normalized, config.maxSnapshotEntries)) {
    return;
  }
  const raw = JSON.stringify(normalized);
  if (Buffer.byteLength(raw, "utf8") > config.maxSnapshotBytes) {
    return;
  }
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
  const runtimeDir = await safeRuntimeDir();
  if (runtimeDir === undefined) {
    return;
  }
  await bestEffortChmod(runtimeDir, 0o700);
  await atomicWriteSnapshotFile(
    snapshotPath(runtimeDir, storageKey),
    tempSnapshotPath(runtimeDir, storageKey),
    raw,
  );
  await pruneWorkspaceIndexSnapshots(runtimeDir, config.maxSnapshots);
}

export function createFileWorkspaceIndexStore(
  options: FileWorkspaceIndexStoreOptions,
): WorkspaceIndexStore {
  const config = fileWorkspaceIndexStoreConfig(options);
  const safeRuntimeDir = createRuntimeDirGuard(config);
  return {
    loadSnapshot: async (storageKey) =>
      loadFileWorkspaceIndexSnapshot(config, safeRuntimeDir, storageKey),
    saveSnapshot: async (storageKey, snapshot) =>
      saveFileWorkspaceIndexSnapshot(config, safeRuntimeDir, storageKey, snapshot),
  };
}

export interface InMemoryWorkspaceIndexStoreOptions {
  readonly maxSnapshots?: number | undefined;
}

export function createInMemoryWorkspaceIndexStore(
  options: InMemoryWorkspaceIndexStoreOptions = {},
): WorkspaceIndexStore {
  const maxSnapshots = normalizeLimit(options.maxSnapshots, DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOTS);
  const snapshots = new Map<string, WorkspaceIndexSnapshot>();
  return {
    loadSnapshot: (key: string): WorkspaceIndexSnapshot | undefined => {
      const snapshot = snapshots.get(key);
      if (snapshot === undefined) {
        return undefined;
      }
      snapshots.delete(key);
      snapshots.set(key, snapshot);
      return snapshot;
    },
    saveSnapshot: (key: string, snapshot: WorkspaceIndexSnapshot): void => {
      if (snapshots.has(key)) {
        snapshots.delete(key);
      }
      snapshots.set(key, snapshot);
      while (snapshots.size > maxSnapshots) {
        const oldestKey = snapshots.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        snapshots.delete(oldestKey);
      }
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

const WORKSPACE_INDEX_TEXT_TOKEN_RE = /[\p{L}\p{N}_$@./:-]+/gu;
const WORKSPACE_INDEX_TOKEN_SEPARATOR_RE = /[/@.:\-_]+/u;
const MAX_WORKSPACE_INDEX_LEXICAL_LINES = 256;
const MAX_WORKSPACE_INDEX_LEXICAL_TERMS_PER_LINE = 16;
const MAX_WORKSPACE_INDEX_LEXICAL_TERMS_PER_FILE = 512;

function isAsciiUpper(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 65 && code <= 90;
}

function isAsciiLower(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 97 && code <= 122;
}

function isAsciiDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function shouldSplitBefore(previous: string, current: string, next: string | undefined): boolean {
  if (!isAsciiUpper(current)) {
    return false;
  }
  if (isAsciiLower(previous) || isAsciiDigit(previous)) {
    return true;
  }
  return isAsciiUpper(previous) && next !== undefined && isAsciiLower(next);
}

function camelParts(token: string): readonly string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index] ?? "";
    if (current.length > 0 && shouldSplitBefore(token[index - 1] ?? "", char, token[index + 1])) {
      if (current.length >= 2) {
        parts.push(current);
      }
      current = char;
      continue;
    }
    current += char;
  }
  if (current.length >= 2) {
    parts.push(current);
  }
  return parts;
}

function stripTestSuffix(token: string): string | undefined {
  const stripped = token.replace(/(?:tests?|specs?)$/iu, "");
  return stripped.length >= 3 && stripped.length < token.length ? stripped : undefined;
}

function addTerm(out: string[], seen: Set<string>, term: string): void {
  const trimmed = term.trim();
  if (trimmed.length < 2 || !/[\p{L}\p{N}]/u.test(trimmed)) {
    return;
  }
  if (seen.has(trimmed)) {
    return;
  }
  seen.add(trimmed);
  out.push(trimmed);
}

function expandContentToken(token: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const normalized = token.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
  if (normalized.length === 0) {
    return out;
  }
  addTerm(out, seen, normalized.toLowerCase());
  const strippedTest = stripTestSuffix(normalized);
  if (strippedTest !== undefined) {
    addTerm(out, seen, strippedTest.toLowerCase());
  }
  for (const part of normalized.split(WORKSPACE_INDEX_TOKEN_SEPARATOR_RE).filter((part) => part.length > 0)) {
    addTerm(out, seen, part.toLowerCase());
    const derived = stripTestSuffix(part);
    if (derived !== undefined) {
      addTerm(out, seen, derived.toLowerCase());
    }
    for (const camel of camelParts(part)) {
      addTerm(out, seen, camel.toLowerCase());
    }
    if (derived !== undefined) {
      for (const camel of camelParts(derived)) {
        addTerm(out, seen, camel.toLowerCase());
      }
    }
  }
  return out;
}

interface WorkspaceIndexLineTerms {
  readonly terms: readonly string[];
  readonly truncated: boolean;
}

function lexicalTermsForLine(line: string): WorkspaceIndexLineTerms {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of line.matchAll(WORKSPACE_INDEX_TEXT_TOKEN_RE)) {
    for (const term of expandContentToken(match[0])) {
      if (seen.has(term)) {
        continue;
      }
      if (terms.length >= MAX_WORKSPACE_INDEX_LEXICAL_TERMS_PER_LINE) {
        return { terms, truncated: true };
      }
      seen.add(term);
      terms.push(term);
    }
  }
  return { terms, truncated: false };
}

export function buildWorkspaceIndexLexicalRecord(content: string): WorkspaceIndexLexicalRecord {
  const lines = content.split("\n");
  const lexicalLines: WorkspaceIndexLexicalLine[] = [];
  const termHashes = new Set<string>();
  let truncated = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineLexical = lexicalTermsForLine(line);
    const lineTerms = lineLexical.terms;
    if (lineTerms.length === 0) {
      continue;
    }
    if (lineLexical.truncated) {
      truncated = true;
    }
    if (lexicalLines.length >= MAX_WORKSPACE_INDEX_LEXICAL_LINES) {
      truncated = true;
      break;
    }
    const hashed = [...new Set(lineTerms.map((term) => hashLexicalTerm(term)))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const termHash of hashed) {
      if (termHashes.size >= MAX_WORKSPACE_INDEX_LEXICAL_TERMS_PER_FILE) {
        truncated = true;
        break;
      }
      termHashes.add(termHash);
    }
    lexicalLines.push({
      startLine: index + 1,
      endLine: index + 1,
      termHashes: hashed,
    });
    if (truncated) {
      break;
    }
  }
  return {
    truncated,
    termHashes: [...termHashes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    lines: lexicalLines,
  };
}

function dirFingerprint(entries: readonly { readonly name: string; readonly isDirectory: boolean; readonly isFile: boolean }[]): string {
  return sha256Hex(
    JSON.stringify(
      entries
        .map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory,
          isFile: entry.isFile,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    ),
  );
}

export interface WorkspaceIndexDirectoryDelta {
  readonly scopePath: string;
  readonly addedPaths: readonly string[];
  readonly removedPaths: readonly string[];
  readonly rescanDirectory: boolean;
}

export interface WorkspaceIndexDirectoryInspection {
  readonly valid: boolean;
  readonly deltas: readonly WorkspaceIndexDirectoryDelta[];
}

interface WorkspaceIndexDirectoryEntryShape {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink?: boolean;
}

function childScopePath(directoryScopePath: string, childName: string): string {
  return directoryScopePath.length === 0 ? childName : `${directoryScopePath}/${childName}`;
}

function isWithinDirectory(scopePath: string, directoryScopePath: string): boolean {
  if (directoryScopePath.length === 0) {
    return true;
  }
  return scopePath === directoryScopePath || scopePath.startsWith(`${directoryScopePath}/`);
}

function immediateDirectoryChild(
  scopePath: string,
  directoryScopePath: string,
): string | undefined {
  if (!isWithinDirectory(scopePath, directoryScopePath)) {
    return undefined;
  }
  const rest = directoryScopePath.length === 0
    ? scopePath
    : scopePath.slice(directoryScopePath.length + 1);
  if (rest.length === 0) {
    return undefined;
  }
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

function oldDirectoryChildren(
  files: readonly WorkspaceIndexDiscoveredFile[],
  directoryScopePath: string,
): ReadonlySet<string> {
  const children = new Set<string>();
  for (const file of files) {
    const child = immediateDirectoryChild(file.scopePath, directoryScopePath);
    if (child !== undefined) {
      children.add(child);
    }
  }
  return children;
}

function removedDirectoryFiles(
  files: readonly WorkspaceIndexDiscoveredFile[],
  directoryScopePath: string,
  removedChildNames: ReadonlySet<string>,
): readonly string[] {
  const removed: string[] = [];
  for (const file of files) {
    const child = immediateDirectoryChild(file.scopePath, directoryScopePath);
    if (child !== undefined && removedChildNames.has(child)) {
      removed.push(file.scopePath);
    }
  }
  return removed.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function addedDirectoryPaths(
  oldChildren: ReadonlySet<string>,
  directoryScopePath: string,
  newChildren: ReadonlyMap<string, WorkspaceIndexDirectoryEntryShape>,
): readonly string[] {
  const added: string[] = [];
  for (const [name, entry] of newChildren) {
    if (oldChildren.has(name) || entry.isSymbolicLink === true) {
      continue;
    }
    const childPath = childScopePath(directoryScopePath, name);
    if (isSafeIndexScopePath(childPath)) {
      added.push(childPath);
    }
  }
  return added.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function removedDirectoryNames(
  oldChildren: ReadonlySet<string>,
  newChildren: ReadonlyMap<string, WorkspaceIndexDirectoryEntryShape>,
): ReadonlySet<string> {
  const removed = new Set<string>();
  for (const name of oldChildren) {
    if (!newChildren.has(name)) {
      removed.add(name);
    }
  }
  return removed;
}

function directoryDelta(
  normalized: WorkspaceIndexSnapshot,
  directory: WorkspaceIndexDirectorySnapshot,
  entries: readonly WorkspaceIndexDirectoryEntryShape[],
): WorkspaceIndexDirectoryDelta | undefined {
  const oldChildren = oldDirectoryChildren(normalized.discovery.files, directory.scopePath);
  const newChildren = new Map(entries.map((entry) => [entry.name, entry] as const));
  const addedPaths = addedDirectoryPaths(oldChildren, directory.scopePath, newChildren);
  const removedNames = removedDirectoryNames(oldChildren, newChildren);
  const removedPaths = removedDirectoryFiles(normalized.discovery.files, directory.scopePath, removedNames);
  const rescanDirectory = addedPaths.length === 0 && removedPaths.length === 0;
  return {
    scopePath: directory.scopePath,
    addedPaths,
    removedPaths,
    rescanDirectory,
  };
}

function directoryChanged(
  directory: WorkspaceIndexDirectorySnapshot,
  absolutePath: string,
  fs: WorkspaceFs,
): {
  readonly changed: boolean;
  readonly entries?: readonly WorkspaceIndexDirectoryEntryShape[] | undefined;
} {
  try {
    const current = fs.stat(absolutePath);
    if (
      directory.mtimeMs !== undefined &&
      typeof current.mtimeMs === "number" &&
      current.mtimeMs === directory.mtimeMs
    ) {
      return { changed: false };
    }
    const entries = fs.readDir(absolutePath);
    return { changed: dirFingerprint(entries) !== directory.fingerprint, entries };
  } catch {
    return { changed: true, entries: [] };
  }
}

export function inspectWorkspaceIndexDirectories(
  snapshot: WorkspaceIndexSnapshot,
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
): WorkspaceIndexDirectoryInspection {
  const normalized = normalizeSnapshot(snapshot);
  if (normalized === undefined || normalized.discovery.directories.length === 0) {
    return { valid: false, deltas: [] };
  }
  const deltas: WorkspaceIndexDirectoryDelta[] = [];
  for (const directory of normalized.discovery.directories) {
    const absolutePath = directory.scopePath.length === 0
      ? workspace.root
      : resolveWithinWorkspace(workspace.root, directory.scopePath);
    const { changed, entries } = directoryChanged(directory, absolutePath, fs);
    if (!changed) {
      continue;
    }
    if (entries === undefined || entries.length === 0) {
      deltas.push({
        scopePath: directory.scopePath,
        addedPaths: [],
        removedPaths: normalized.discovery.files
          .filter((file) => isWithinDirectory(file.scopePath, directory.scopePath))
          .map((file) => file.scopePath),
        rescanDirectory: false,
      });
      continue;
    }
    const delta = directoryDelta(normalized, directory, entries);
    if (delta !== undefined) {
      deltas.push(delta);
    }
  }
  return { valid: true, deltas };
}

export function isWorkspaceIndexSnapshotFresh(
  snapshot: WorkspaceIndexSnapshot,
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
): boolean {
  const normalized = normalizeSnapshot(snapshot);
  if (normalized === undefined) {
    return false;
  }
  for (const directory of normalized.discovery.directories) {
    const absolutePath = directory.scopePath.length === 0
      ? workspace.root
      : resolveWithinWorkspace(workspace.root, directory.scopePath);
    try {
      const entries = fs.readDir(absolutePath);
      if (dirFingerprint(entries) !== directory.fingerprint) {
        return false;
      }
      if (directory.mtimeMs !== undefined) {
        const current = fs.stat(absolutePath);
        if (
          typeof current.mtimeMs !== "number" ||
          Math.trunc(current.mtimeMs) !== directory.mtimeMs
        ) {
          return false;
        }
      }
    } catch {
      return false;
    }
  }
  return true;
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

export function isWorkspaceIndexRecordCurrent(
  record: WorkspaceIndexRecord | undefined,
  metadata: WorkspaceIndexDiscoveredFile,
): boolean {
  return sameRecordMetadata(record, metadata);
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
    valid: false,
    dirty: false,
    entries: [],
    discovery: {
      files: [],
      directories: [],
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
    directories: normalized.discovery.directories,
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
    valid: true,
    dirty: report.deletedEntries > 0 || report.skippedEntries > 0 || report.staleRecords > 0,
    entries,
    discovery: preparedDiscoverySnapshot(normalized, entries),
    report: finalizePreparationReport(report, usedRecordPaths, normalized),
  };
}

export function prepareCachedWorkspaceIndexSnapshot(
  snapshot: WorkspaceIndexSnapshot,
  workspace: WorkspaceInfo,
): PreparedWorkspaceIndexSnapshot {
  const normalized = normalizeSnapshot(snapshot);
  if (normalized === undefined) {
    return emptyPreparedWorkspaceIndexSnapshot();
  }
  const recordByPath = new Map(normalized.records.map((record) => [record.scopePath, record] as const));
  const entries: PreparedWorkspaceIndexEntry[] = [];
  const usedRecordPaths = new Set<string>();
  for (const file of normalized.discovery.files) {
    const record = recordByPath.get(file.scopePath);
    if (record !== undefined) {
      usedRecordPaths.add(record.scopePath);
    }
    entries.push({
      scopePath: file.scopePath,
      absolutePath: resolveWithinWorkspace(workspace.root, file.scopePath),
      file: { relativePath: file.scopePath, sizeBytes: file.sizeBytes },
      ...(file.mtimeMs !== undefined ? { mtimeMs: file.mtimeMs } : {}),
      record,
      stale: record === undefined,
    });
  }
  const indexedRecords = entries.filter((entry) => entry.record !== undefined).length;
  const report: WorkspaceIndexPreparationReport = {
    discoveredEntries: normalized.discovery.files.length,
    retainedEntries: entries.length,
    indexedRecords,
    reusedRecords: indexedRecords,
    staleRecords: entries.length - indexedRecords,
    skippedEntries: 0,
    deletedEntries: 0,
    droppedRecords: normalized.records.filter((record) => !usedRecordPaths.has(record.scopePath)).length,
  };
  return {
    valid: true,
    dirty: false,
    entries,
    discovery: normalized.discovery,
    report,
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
    directories: prepared.discovery.directories.map((directory) => directory.scopePath),
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
  readonly maxFilesScanned: number;
  readonly discovery: WorkspaceIndexDiscoverySnapshot;
  readonly records: Iterable<WorkspaceIndexRecord>;
}

export function buildWorkspaceIndexSnapshot(
  input: BuildWorkspaceIndexSnapshotInput,
): WorkspaceIndexSnapshot {
  const discovery = normalizeDiscoverySnapshot(input.discovery) ?? {
    files: [],
    directories: [],
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
    maxFilesScanned: input.maxFilesScanned,
    discovery,
    records,
  };
}
