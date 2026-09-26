import { createHash, createHmac, hkdfSync, randomUUID } from "node:crypto";
import { constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  isValidScopePath,
  type RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { openString, sealString } from "@oscharko-dev/keiko-security";
import type { WorkspaceFs, WorkspaceStat } from "./fs.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import { cachedContentScores } from "./repoSearchCachedLexical.js";
import { canonicalSearchScopeRelativePaths } from "./repoSearchEntries.js";
import { enclosingLineRangesForIndices } from "./repoSearchLineSelection.js";
import { stripTestIdentifierSuffix } from "./repoSearchIdentifier.js";
import { definitionSymbolsInStructuralLine } from "./repoSearchMatchers.js";
import {
  REPOSITORY_ROUTE_DECLARATION_WINDOW_LINES,
  repositoryRouteDeclarationMarkers,
} from "./repoSearchRoutes.js";
import { repositorySourceLines } from "./repoSearchSourceClassification.js";
import {
  orderCandidatesForSearch,
  type SearchDiagnostics,
  type SearchPolicy,
  type SearchPolicyMode,
} from "./repoSearchPolicy.js";
import { containedRealPathInfo, isCanonicalAllowedContainedPath } from "./realpath.js";
import type { DiscoveredFile, WorkspaceInfo } from "./types.js";
import { workspaceDirectoryFingerprint } from "./workspaceDirectorySnapshot.js";

type MaybePromise<T> = T | Promise<T>;

export const WORKSPACE_INDEX_SNAPSHOT_VERSION = 5;

export interface WorkspaceIndexCandidatePathPolicy {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export type WorkspaceIndexRecordKind = "text" | "binary" | "size-exceeded";

export interface WorkspaceIndexScopeKey {
  readonly workspaceRoot: string;
  readonly relativePaths: readonly string[];
  readonly ignorePolicySha256: string;
  readonly candidatePathPolicySha256: string;
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
  readonly fileIdentityHash?: string | undefined;
  readonly mtimeNs?: string | undefined;
  readonly ctimeNs?: string | undefined;
  readonly hardLinkCount?: number | undefined;
}

export interface WorkspaceIndexLexicalLine {
  readonly startLine: number;
  readonly endLine: number;
  readonly termHashes: readonly string[];
  readonly definitionTermHashes?: readonly string[] | undefined;
}

export interface WorkspaceIndexLexicalRecord {
  readonly truncated: boolean;
  readonly termHashes: readonly string[];
  readonly maxTermLength?: number | undefined;
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
  readonly ignorePolicySha256: string;
  readonly candidatePathPolicySha256: string;
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
  /** Dedicated 32-byte at-rest key; the server resolves it outside this package. */
  readonly encryptionKey: Uint8Array;
  readonly workspaceRoot?: string | undefined;
  readonly allowWorkspaceLocalRuntimeDir?: boolean | undefined;
  readonly maxSnapshotBytes?: number | undefined;
  readonly maxSnapshots?: number | undefined;
  readonly maxSnapshotEntries?: number | undefined;
  /** Server-owned key-generation fence. Omit only for generation-isolated low-level stores. */
  readonly isGenerationActive?: (() => boolean) | undefined;
  readonly onLoadFailure?:
    | ((failure: { readonly reason: "authentication-or-corruption" | "invalid-snapshot" }) => void)
    | undefined;
  readonly onSaveFailure?:
    ((failure: { readonly reason: "write-or-cleanup-failure" }) => void) | undefined;
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
  readonly fileIdentityHash?: string | undefined;
  readonly mtimeNs?: string | undefined;
  readonly ctimeNs?: string | undefined;
  readonly hardLinkCount?: number | undefined;
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
  readonly directorySnapshots: readonly WorkspaceIndexDirectorySnapshot[];
  readonly truncated: boolean;
  readonly diagnostics: SearchDiagnostics;
}

interface ScopeShape {
  readonly workspace: WorkspaceInfo;
  readonly relativePaths: readonly string[];
}

interface ScopeKeyShape {
  readonly relativePaths: readonly string[];
  readonly workspace?: Pick<WorkspaceInfo, "ignoreLines"> | undefined;
  readonly candidatePathGlobs?: WorkspaceIndexCandidatePathPolicy | undefined;
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

const FILE_WORKSPACE_INDEX_PREFIX = "workspace-index-v2-";
const FILE_WORKSPACE_INDEX_EXTENSION = ".json";
const FILE_WORKSPACE_INDEX_SEGMENT_RE =
  /^workspace-index-v2-([0-9a-f]{64})-[0-9a-f]{64}\.json(?:\.[0-9a-f]{16}\.tmp)?$/u;
const LEGACY_FILE_WORKSPACE_INDEX_SEGMENT_RE =
  /^workspace-index-(?:[0-9a-f]{64}-)?[0-9a-f]{64}\.json(?:\.[0-9a-f]{16}\.tmp)?$/u;
const RUNTIME_DIR_MARKER_SEGMENT = "workspace-index-runtime-id";
const FILE_WORKSPACE_INDEX_ENVELOPE_VERSION = 2;
const FILE_WORKSPACE_INDEX_LOCATOR_SALT = "keiko-workspace-index:file-locator-salt:v2";
const FILE_WORKSPACE_INDEX_LOCATOR_INFO = "keiko-workspace-index:scope-locator:v2";
const FILE_WORKSPACE_INDEX_GENERATION_INFO = "keiko-workspace-index:key-generation:v2";
const FILE_WORKSPACE_INDEX_TEMP_MAX_AGE_MS = 15 * 60 * 1000;
const FILE_WORKSPACE_INDEX_TEMP_PRESSURE_MIN_AGE_MS = 30 * 1000;
const FILE_WORKSPACE_INDEX_MAX_TEMP_FILES = 32;
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

export function workspaceIgnorePolicyFingerprint(ignoreLines: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update("keiko-workspace-index:ignore-policy:v1\0");
  for (const line of ignoreLines) {
    const encoded = Buffer.from(line, "utf8");
    hash.update(`${String(encoded.byteLength)}:`);
    hash.update(encoded);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function workspaceCandidatePathPolicyFingerprint(
  policy: WorkspaceIndexCandidatePathPolicy | undefined,
): string {
  const hash = createHash("sha256");
  hash.update("keiko-workspace-index:candidate-path-policy:v1\0");
  for (const [kind, patterns] of [
    ["include", policy?.include ?? []],
    ["exclude", policy?.exclude ?? []],
  ] as const) {
    hash.update(`${kind}\0`);
    // S2871: the comparator must stay code-unit stable, not locale-collated -- this ordering
    // feeds a persisted candidate-path policy fingerprint, so `compareStrings` reproduces the
    // exact order a bare `.sort()` produced and keeps every already-stored fingerprint valid.
    for (const pattern of [...new Set(patterns)].sort(compareStrings)) {
      const encoded = Buffer.from(pattern, "utf8");
      hash.update(`${String(encoded.byteLength)}:`);
      hash.update(encoded);
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function normalizeScopePath(scopePath: string): string {
  return scopePath.replaceAll("\\", "/");
}

function isSafeIndexScopePath(scopePath: string): boolean {
  return isValidScopePath(scopePath, { mustBeRelative: true }) && !isDenied(scopePath);
}

function normalizeRelativePaths(relativePaths: readonly string[]): readonly string[] {
  return canonicalSearchScopeRelativePaths(
    relativePaths.filter((entry) => isSafeIndexScopePath(normalizeScopePath(entry))),
  );
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

function normalizeFileIdentityHash(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : undefined;
}

function normalizeNanoseconds(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,30})$/u.test(value)) {
    return undefined;
  }
  return value;
}

function normalizeHardLinkCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function bodyFreeFileIdentityHash(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    return undefined;
  }
  return sha256Hex(`workspace-index-file-identity:v1\0${value}`);
}

export function workspaceIndexFileMetadata(
  scopePath: string,
  stat: WorkspaceStat,
): WorkspaceIndexDiscoveredFile {
  const mtimeMs = normalizeMtimeMs(stat.mtimeMs);
  const fileIdentityHash = bodyFreeFileIdentityHash(stat.fileIdentity);
  const mtimeNs = normalizeNanoseconds(stat.mtimeNs);
  const ctimeNs = normalizeNanoseconds(stat.ctimeNs);
  const hardLinkCount = normalizeHardLinkCount(stat.hardLinkCount);
  return {
    scopePath,
    sizeBytes: stat.size,
    ...(mtimeMs !== undefined ? { mtimeMs } : {}),
    ...(fileIdentityHash !== undefined ? { fileIdentityHash } : {}),
    ...(mtimeNs !== undefined ? { mtimeNs } : {}),
    ...(ctimeNs !== undefined ? { ctimeNs } : {}),
    ...(hardLinkCount !== undefined ? { hardLinkCount } : {}),
  };
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
  const fileIdentityHash = normalizeFileIdentityHash(file.fileIdentityHash);
  const mtimeNs = normalizeNanoseconds(file.mtimeNs);
  const ctimeNs = normalizeNanoseconds(file.ctimeNs);
  const hardLinkCount = normalizeHardLinkCount(file.hardLinkCount);
  return {
    scopePath,
    sizeBytes,
    ...(mtimeMs !== undefined ? { mtimeMs } : {}),
    ...(fileIdentityHash !== undefined ? { fileIdentityHash } : {}),
    ...(mtimeNs !== undefined ? { mtimeNs } : {}),
    ...(ctimeNs !== undefined ? { ctimeNs } : {}),
    ...(hardLinkCount !== undefined ? { hardLinkCount } : {}),
  };
}

function normalizeLexicalLine(
  line: WorkspaceIndexLexicalLine,
): WorkspaceIndexLexicalLine | undefined {
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
  const termHashes = [
    ...new Set(line.termHashes.filter((term) => typeof term === "string" && term.length > 0)),
  ].sort(compareStrings);
  const definitionTermHashes = [
    ...new Set(
      (Array.isArray(line.definitionTermHashes) ? line.definitionTermHashes : []).filter(
        (term) => typeof term === "string" && term.length > 0,
      ),
    ),
  ].sort(compareStrings);
  return {
    startLine,
    endLine,
    termHashes,
    ...(definitionTermHashes.length === 0 ? {} : { definitionTermHashes }),
  };
}

function normalizeLexicalRecord(
  lexical: WorkspaceIndexLexicalRecord,
): WorkspaceIndexLexicalRecord | undefined {
  const lines = lexical.lines
    .map((line) => normalizeLexicalLine(line))
    .filter((line): line is WorkspaceIndexLexicalLine => line !== undefined);
  const termHashes = [
    ...new Set(lexical.termHashes.filter((term) => typeof term === "string" && term.length > 0)),
  ].sort(compareStrings);
  const maxTermLength = normalizeWholeNumber(lexical.maxTermLength);
  if (termHashes.length === 0 && lines.length === 0) {
    return undefined;
  }
  return {
    truncated: lexical.truncated,
    termHashes,
    ...(maxTermLength === undefined || maxTermLength === 0 ? {} : { maxTermLength }),
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
    const lexical = normalizeLexicalRecord(
      record.lexical ?? { truncated: false, termHashes: [], lines: [] },
    );
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

function sortByScopePath<T extends { readonly scopePath: string }>(
  values: readonly T[],
): readonly T[] {
  return [...values].sort((a, b) => compareStrings(a.scopePath, b.scopePath));
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

interface NormalizedWorkspaceIndexHeader {
  readonly maxBytesPerFileScanned: number;
  readonly maxFilesScanned: number;
  readonly ignorePolicySha256: string;
  readonly candidatePathPolicySha256: string;
}

function normalizeWorkspaceIndexHeader(
  snapshot: WorkspaceIndexSnapshot,
): NormalizedWorkspaceIndexHeader | undefined {
  if (
    normalizeWholeNumber(snapshot.version) !== WORKSPACE_INDEX_SNAPSHOT_VERSION ||
    typeof snapshot.applyGitignore !== "boolean" ||
    typeof snapshot.omitLowValueWorkspaceFiles !== "boolean"
  ) {
    return undefined;
  }
  const maxBytesPerFileScanned = normalizeWholeNumber(snapshot.maxBytesPerFileScanned);
  const maxFilesScanned = normalizeWholeNumber(snapshot.maxFilesScanned);
  const ignorePolicySha256 = normalizeFingerprint(snapshot.ignorePolicySha256);
  const candidatePathPolicySha256 = normalizeFingerprint(snapshot.candidatePathPolicySha256);
  if (
    ignorePolicySha256 === undefined ||
    candidatePathPolicySha256 === undefined ||
    maxBytesPerFileScanned === undefined ||
    maxBytesPerFileScanned === 0 ||
    maxFilesScanned === undefined ||
    maxFilesScanned === 0
  ) {
    return undefined;
  }
  return {
    maxBytesPerFileScanned,
    maxFilesScanned,
    ignorePolicySha256,
    candidatePathPolicySha256,
  };
}

function normalizeSnapshot(snapshot: WorkspaceIndexSnapshot): WorkspaceIndexSnapshot | undefined {
  const header = normalizeWorkspaceIndexHeader(snapshot);
  if (header === undefined) return undefined;
  const { maxBytesPerFileScanned, maxFilesScanned, ignorePolicySha256, candidatePathPolicySha256 } =
    header;
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
    ignorePolicySha256,
    candidatePathPolicySha256,
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
      ignorePolicySha256: scopeKey.ignorePolicySha256,
      candidatePathPolicySha256: scopeKey.candidatePathPolicySha256,
      policyMode: scopeKey.policyMode,
      applyGitignore: scopeKey.applyGitignore,
      omitLowValueWorkspaceFiles: scopeKey.omitLowValueWorkspaceFiles,
      maxBytesPerFileScanned: scopeKey.maxBytesPerFileScanned,
      maxFilesScanned: scopeKey.maxFilesScanned,
    }),
  )}`;
}

function snapshotMatchesScopeKey(
  snapshot: WorkspaceIndexSnapshot,
  scopeKey: WorkspaceIndexScopeKey,
): boolean {
  const relativePaths = normalizeRelativePaths(scopeKey.relativePaths);
  return (
    snapshot.ignorePolicySha256 === scopeKey.ignorePolicySha256 &&
    snapshot.candidatePathPolicySha256 === scopeKey.candidatePathPolicySha256 &&
    snapshot.policyMode === scopeKey.policyMode &&
    snapshot.applyGitignore === scopeKey.applyGitignore &&
    snapshot.omitLowValueWorkspaceFiles === scopeKey.omitLowValueWorkspaceFiles &&
    snapshot.maxBytesPerFileScanned === scopeKey.maxBytesPerFileScanned &&
    snapshot.maxFilesScanned === scopeKey.maxFilesScanned &&
    snapshot.relativePaths.length === relativePaths.length &&
    snapshot.relativePaths.every((entry, index) => entry === relativePaths[index])
  );
}

export function buildWorkspaceIndexScopeKey(
  scope: ScopeShape,
  policy: PolicyShape,
  maxBytesPerFileScanned: number,
  maxFilesScanned: number,
  candidatePathGlobs?: WorkspaceIndexCandidatePathPolicy,
): WorkspaceIndexScopeKey {
  return {
    workspaceRoot: scope.workspace.root,
    relativePaths: normalizeRelativePaths(scope.relativePaths),
    ignorePolicySha256: workspaceIgnorePolicyFingerprint(scope.workspace.ignoreLines),
    candidatePathPolicySha256: workspaceCandidatePathPolicyFingerprint(candidatePathGlobs),
    policyMode: policy.policyMode,
    applyGitignore: policy.applyGitignore,
    omitLowValueWorkspaceFiles: policy.omitLowValueWorkspaceFiles,
    maxBytesPerFileScanned,
    maxFilesScanned,
  };
}

interface FileWorkspaceIndexStoreConfig {
  readonly runtimeDir: string;
  readonly encryptionKey: Buffer;
  readonly encryptionKeyId: string;
  readonly locatorKey: Buffer;
  readonly storageGenerationId: string;
  readonly runtimeDirIdentity: RuntimeDirIdentity | undefined;
  readonly workspaceRoot: string | undefined;
  readonly allowWorkspaceLocalRuntimeDir: boolean;
  readonly maxSnapshotBytes: number;
  readonly maxSnapshots: number;
  readonly maxSnapshotEntries: number;
  readonly isGenerationActive: FileWorkspaceIndexStoreOptions["isGenerationActive"];
  readonly onLoadFailure: FileWorkspaceIndexStoreOptions["onLoadFailure"];
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
    const realPath = resolvedRuntimeDirRealPath(
      runtimeDir,
      workspaceRoot,
      allowWorkspaceLocalRuntimeDir,
    );
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
    const code = value.codePointAt(index) ?? 0;
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
    handle = await open(
      runtimeDirMarkerPath(realPath),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
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
    const realPath = resolvedRuntimeDirRealPath(
      runtimeDir,
      workspaceRoot,
      allowWorkspaceLocalRuntimeDir,
    );
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
  const workspaceRoot =
    options.workspaceRoot === undefined ? undefined : resolve(options.workspaceRoot);
  if (options.encryptionKey.byteLength !== 32) {
    throw new Error("workspace index encryption key must contain exactly 32 bytes");
  }
  const encryptionKey = Buffer.from(options.encryptionKey);
  const encryptionKeyId = createHash("sha256").update(encryptionKey).digest("hex");
  const locatorKey = deriveWorkspaceIndexHmacKey(encryptionKey, FILE_WORKSPACE_INDEX_LOCATOR_INFO);
  const generationKey = deriveWorkspaceIndexHmacKey(
    encryptionKey,
    FILE_WORKSPACE_INDEX_GENERATION_INFO,
  );
  const storageGenerationId = hmacHex(generationKey, FILE_WORKSPACE_INDEX_GENERATION_INFO);
  generationKey.fill(0);
  return {
    runtimeDir,
    encryptionKey,
    encryptionKeyId,
    locatorKey,
    storageGenerationId,
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
    maxSnapshots: normalizeLimit(options.maxSnapshots, DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOTS),
    maxSnapshotEntries: normalizeLimit(
      options.maxSnapshotEntries,
      DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_ENTRIES,
    ),
    isGenerationActive: options.isGenerationActive,
    onLoadFailure: options.onLoadFailure,
  };
}

function deriveWorkspaceIndexHmacKey(encryptionKey: Buffer, info: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", encryptionKey, FILE_WORKSPACE_INDEX_LOCATOR_SALT, info, 32),
  );
}

function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function snapshotFileSegment(
  storageKey: string,
  storageGenerationId: string,
  locatorKey: Buffer,
): string {
  const locator = hmacHex(locatorKey, `${FILE_WORKSPACE_INDEX_LOCATOR_INFO}\0${storageKey}`);
  return `${FILE_WORKSPACE_INDEX_PREFIX}${storageGenerationId}-${locator}${FILE_WORKSPACE_INDEX_EXTENSION}`;
}

function tempSnapshotFileSegment(finalSegment: string): string {
  const nonce = `${finalSegment}:${randomUUID()}`;
  return `${finalSegment}.${sha256Hex(nonce).slice(0, 16)}.tmp`;
}

function assertSafePathSegment(segment: string): string {
  if (
    segment.length === 0 ||
    segment.includes("\u0000") ||
    segment.includes("/") ||
    segment.includes("\\") ||
    !isSafeWorkspaceIndexSegment(segment)
  ) {
    throw new Error(`unsafe workspace index file segment: ${segment}`);
  }
  return segment;
}

function isSafeWorkspaceIndexSegment(segment: string): boolean {
  return (
    FILE_WORKSPACE_INDEX_SEGMENT_RE.test(segment) ||
    LEGACY_FILE_WORKSPACE_INDEX_SEGMENT_RE.test(segment)
  );
}

function runtimeFilePath(runtimeDir: string, segment: string): string {
  const safeSegment = assertSafePathSegment(segment);
  const path = resolve(runtimeDir, safeSegment);
  if (dirname(path) !== runtimeDir) {
    throw new Error(`workspace index path escaped runtimeDir: ${safeSegment}`);
  }
  return path;
}

function snapshotPath(
  runtimeDir: string,
  storageKey: string,
  storageGenerationId: string,
  locatorKey: Buffer,
): string {
  return runtimeFilePath(
    runtimeDir,
    snapshotFileSegment(storageKey, storageGenerationId, locatorKey),
  );
}

function tempSnapshotPath(
  runtimeDir: string,
  storageKey: string,
  storageGenerationId: string,
  locatorKey: Buffer,
): string {
  return runtimeFilePath(
    runtimeDir,
    tempSnapshotFileSegment(snapshotFileSegment(storageKey, storageGenerationId, locatorKey)),
  );
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

// Bind parsed cache entries to the complete ciphertext bytes. Filesystem metadata is not a
// content identity: an atomic replacement can deliberately preserve both size and mtime.
interface SnapshotFileFingerprint {
  readonly ciphertextDigest: string;
}

interface SnapshotReadResult {
  readonly raw: string;
  readonly fingerprint: SnapshotFileFingerprint;
}

async function safeReadSnapshotFile(
  path: string,
  maxSnapshotBytes: number,
): Promise<SnapshotReadResult | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > maxSnapshotBytes) {
      return undefined;
    }
    const raw = await readSnapshotHandleWithinLimit(handle, maxSnapshotBytes);
    return raw === undefined
      ? undefined
      : {
          raw: raw.toString("utf8"),
          fingerprint: {
            ciphertextDigest: createHash("sha256").update(raw).digest("hex"),
          },
        };
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

type StoredSnapshotParseResult =
  | { readonly status: "loaded"; readonly snapshot: WorkspaceIndexSnapshot }
  | { readonly status: "stale-format" }
  | {
      readonly status: "rejected";
      readonly reason: "authentication-or-corruption" | "invalid-snapshot";
    };

function isLegacyUnwrappedSnapshot(value: object): boolean {
  const candidate = value as {
    readonly version?: unknown;
    readonly discovery?: unknown;
    readonly records?: unknown;
  };
  return (
    typeof candidate.version === "number" &&
    candidate.version < WORKSPACE_INDEX_SNAPSHOT_VERSION &&
    typeof candidate.discovery === "object" &&
    candidate.discovery !== null &&
    Array.isArray(candidate.records)
  );
}

function storedSnapshotEnvelopeMatches(
  value: object,
  runtimeDirBinding: string,
  storageKey: string,
): value is { readonly snapshot?: unknown } {
  const envelope = value as {
    readonly version?: unknown;
    readonly runtimeDirBinding?: unknown;
    readonly storageKeyHash?: unknown;
    readonly snapshot?: unknown;
  };
  return (
    envelope.version === FILE_WORKSPACE_INDEX_ENVELOPE_VERSION &&
    envelope.runtimeDirBinding === runtimeDirBinding &&
    envelope.storageKeyHash === sha256Hex(storageKey)
  );
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isStaleSnapshotFormat(value: unknown): boolean {
  return isObject(value) && isLegacyUnwrappedSnapshot(value);
}

function parseStoredSnapshotObject(
  parsed: unknown,
  maxSnapshotEntries: number,
  runtimeDirBinding: string,
  storageKey: string,
): StoredSnapshotParseResult {
  if (!isObject(parsed)) {
    return { status: "rejected", reason: "authentication-or-corruption" };
  }
  if (isLegacyUnwrappedSnapshot(parsed)) return { status: "stale-format" };
  if (!storedSnapshotEnvelopeMatches(parsed, runtimeDirBinding, storageKey)) {
    return { status: "rejected", reason: "authentication-or-corruption" };
  }
  if (isStaleSnapshotFormat(parsed.snapshot)) return { status: "stale-format" };
  const normalized = normalizeSnapshot(parsed.snapshot as WorkspaceIndexSnapshot);
  if (normalized === undefined || !snapshotFitsStoreBounds(normalized, maxSnapshotEntries)) {
    return { status: "rejected", reason: "invalid-snapshot" };
  }
  return { status: "loaded", snapshot: normalized };
}

function parseStoredSnapshot(
  raw: string,
  encryptionKey: Buffer,
  maxSnapshotEntries: number,
  runtimeDirBinding: string,
  storageKey: string,
): StoredSnapshotParseResult {
  let plaintext: string;
  try {
    plaintext = openString(encryptionKey, raw);
  } catch {
    return { status: "rejected", reason: "authentication-or-corruption" };
  }
  try {
    const parsed: unknown = JSON.parse(plaintext);
    return parseStoredSnapshotObject(parsed, maxSnapshotEntries, runtimeDirBinding, storageKey);
  } catch {
    return { status: "rejected", reason: "invalid-snapshot" };
  }
}

function sealStoredSnapshot(
  encryptionKey: Buffer,
  snapshot: WorkspaceIndexSnapshot,
  runtimeDirBinding: string,
  storageKey: string,
): string {
  return sealString(
    encryptionKey,
    JSON.stringify({
      version: FILE_WORKSPACE_INDEX_ENVELOPE_VERSION,
      runtimeDirBinding,
      storageKeyHash: sha256Hex(storageKey),
      snapshot,
    }),
  );
}

// GEN-PERF-CHAT-003: the grounded-ask path reloads the same workspace snapshot per request
// (createWorkspaceIndex is memoized per (root,runtimeDir) but holds no parsed snapshot), so
// every ask re-read the file, re-ran JSON.parse and the O(records) normalizeSnapshot. We
// memoize the parsed + normalized snapshot per resolved snapshot-file path, keyed by the
// complete ciphertext digest. A cache hit therefore reuses only bytes that were previously
// authenticated with the same key and runtime binding. The cache holds already-parsed snapshots
// in process memory only; disk remains AES-256-GCM sealed. It is bounded by an LRU over file paths.
const MAX_PARSED_SNAPSHOT_CACHE_ENTRIES = 32;
const FILE_STORE_MUTATION_TAILS = new Map<string, Promise<void>>();

interface ParsedSnapshotCacheEntry {
  readonly fingerprint: SnapshotFileFingerprint;
  readonly encryptionKeyId: string;
  readonly maxSnapshotEntries: number;
  readonly runtimeDirBinding: string;
  readonly snapshot: WorkspaceIndexSnapshot | undefined;
}

const PARSED_SNAPSHOT_CACHE = new Map<string, ParsedSnapshotCacheEntry>();

async function runSerializedFileStoreMutation<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = FILE_STORE_MUTATION_TAILS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  FILE_STORE_MUTATION_TAILS.set(key, gate);
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (FILE_STORE_MUTATION_TAILS.get(key) === gate) FILE_STORE_MUTATION_TAILS.delete(key);
  }
}

function sameSnapshotFingerprint(a: SnapshotFileFingerprint, b: SnapshotFileFingerprint): boolean {
  return a.ciphertextDigest === b.ciphertextDigest;
}

function readParsedSnapshotCache(
  path: string,
  fingerprint: SnapshotFileFingerprint,
  encryptionKeyId: string,
  maxSnapshotEntries: number,
  runtimeDirBinding: string,
): ParsedSnapshotCacheEntry | undefined {
  const entry = PARSED_SNAPSHOT_CACHE.get(path);
  if (
    entry?.encryptionKeyId !== encryptionKeyId ||
    entry.maxSnapshotEntries !== maxSnapshotEntries ||
    entry.runtimeDirBinding !== runtimeDirBinding ||
    !sameSnapshotFingerprint(entry.fingerprint, fingerprint)
  ) {
    return undefined;
  }
  // LRU touch.
  PARSED_SNAPSHOT_CACHE.delete(path);
  PARSED_SNAPSHOT_CACHE.set(path, entry);
  return entry;
}

function writeParsedSnapshotCache(path: string, entry: ParsedSnapshotCacheEntry): void {
  PARSED_SNAPSHOT_CACHE.delete(path);
  PARSED_SNAPSHOT_CACHE.set(path, entry);
  while (PARSED_SNAPSHOT_CACHE.size > MAX_PARSED_SNAPSHOT_CACHE_ENTRIES) {
    const oldest = PARSED_SNAPSHOT_CACHE.keys().next().value;
    if (oldest === undefined) break;
    PARSED_SNAPSHOT_CACHE.delete(oldest);
  }
}

interface SnapshotPruneCandidate extends SnapshotFileIdentity {
  readonly segment: string;
  readonly generationId: string | undefined;
  readonly mtimeMs: number;
  readonly temporary: boolean;
}

function snapshotSegmentGenerationId(segment: string): string | undefined {
  return FILE_WORKSPACE_INDEX_SEGMENT_RE.exec(segment)?.[1];
}

async function inspectSnapshotPruneCandidate(
  runtimeDir: string,
  segment: string,
): Promise<SnapshotPruneCandidate | undefined> {
  const path = runtimeFilePath(runtimeDir, segment);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
  return {
    path,
    segment,
    generationId: snapshotSegmentGenerationId(segment),
    mtimeMs: stat.mtimeMs,
    temporary: segment.endsWith(".tmp"),
    dev: stat.dev,
    ino: stat.ino,
  };
}

function comparePruneRetention(
  currentGenerationId: string,
  protectedPath: string,
  a: SnapshotPruneCandidate,
  b: SnapshotPruneCandidate,
): number {
  const protectedOrder = Number(b.path === protectedPath) - Number(a.path === protectedPath);
  if (protectedOrder !== 0) return protectedOrder;
  const generationOrder =
    Number(b.generationId === currentGenerationId) - Number(a.generationId === currentGenerationId);
  if (generationOrder !== 0) return generationOrder;
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  return compareStrings(a.segment, b.segment);
}

function orphanTempBudget(maxSnapshots: number): number {
  return Math.max(4, Math.min(maxSnapshots, FILE_WORKSPACE_INDEX_MAX_TEMP_FILES));
}

function orphanTempIsPrunable(
  candidate: SnapshotPruneCandidate,
  retentionIndex: number,
  maxSnapshots: number,
  nowMs: number,
): boolean {
  const ageMs = Math.max(0, nowMs - candidate.mtimeMs);
  return (
    ageMs >= FILE_WORKSPACE_INDEX_TEMP_MAX_AGE_MS ||
    (retentionIndex >= orphanTempBudget(maxSnapshots) &&
      ageMs >= FILE_WORKSPACE_INDEX_TEMP_PRESSURE_MIN_AGE_MS)
  );
}

async function listSnapshotPruneCandidates(
  runtimeDir: string,
): Promise<readonly SnapshotPruneCandidate[]> {
  let entries;
  try {
    entries = await readdir(runtimeDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: SnapshotPruneCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isSafeWorkspaceIndexSegment(entry.name)) continue;
    const candidate = await inspectSnapshotPruneCandidate(runtimeDir, entry.name);
    if (candidate !== undefined) candidates.push(candidate);
  }
  return candidates;
}

async function removePruneCandidates(
  candidates: readonly SnapshotPruneCandidate[],
  config: FileWorkspaceIndexStoreConfig,
  safeRuntimeDir: RuntimeDirGuard,
  guarded: GuardedRuntimeDir,
): Promise<void> {
  for (const candidate of candidates) {
    assertWorkspaceIndexGenerationActive(config);
    if (!(await runtimeDirStillGuarded(safeRuntimeDir, guarded))) return;
    if (!(await removeExactSnapshotFile(candidate))) {
      throw new Error("workspace index prune candidate identity changed");
    }
  }
}

async function pruneWorkspaceIndexSnapshots(
  config: FileWorkspaceIndexStoreConfig,
  runtimeDir: string,
  protectedPath: string,
  safeRuntimeDir: RuntimeDirGuard,
  guarded: GuardedRuntimeDir,
): Promise<void> {
  assertWorkspaceIndexGenerationActive(config);
  if (!(await runtimeDirStillGuarded(safeRuntimeDir, guarded))) return;
  const candidates = await listSnapshotPruneCandidates(runtimeDir);
  assertWorkspaceIndexGenerationActive(config);
  if (!(await runtimeDirStillGuarded(safeRuntimeDir, guarded))) return;
  const scopedFinals = candidates.filter(
    (candidate) =>
      !candidate.temporary &&
      candidate.generationId !== undefined &&
      (config.isGenerationActive !== undefined ||
        candidate.generationId === config.storageGenerationId),
  );
  scopedFinals.sort((a, b) =>
    comparePruneRetention(config.storageGenerationId, protectedPath, a, b),
  );
  const tempFiles = candidates.filter((candidate) => candidate.temporary);
  tempFiles.sort((a, b) => comparePruneRetention(config.storageGenerationId, "", a, b));
  const expiredTemps = tempFiles.filter((candidate, index) =>
    orphanTempIsPrunable(candidate, index, config.maxSnapshots, Date.now()),
  );
  const legacyFinals =
    config.isGenerationActive === undefined
      ? []
      : candidates.filter(
          (candidate) => !candidate.temporary && candidate.generationId === undefined,
        );
  await removePruneCandidates(
    [...scopedFinals.slice(config.maxSnapshots), ...legacyFinals, ...expiredTemps],
    config,
    safeRuntimeDir,
    guarded,
  );
}

interface SnapshotFileIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

interface OpenSnapshotTempFile extends SnapshotFileIdentity {
  readonly handle: FileHandle;
}

async function createSnapshotTempFile(tempPath: string): Promise<OpenSnapshotTempFile> {
  const handle = await open(
    tempPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error("workspace index temp snapshot is not a regular file");
    }
    return { handle, path: tempPath, dev: fileStat.dev, ino: fileStat.ino };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function writeSnapshotTempFile(temp: OpenSnapshotTempFile, content: string): Promise<void> {
  await temp.handle.writeFile(content, { encoding: "utf8" });
  await temp.handle.sync();
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function snapshotPathMatchesIdentity(snapshot: SnapshotFileIdentity): Promise<boolean> {
  let pathStat;
  try {
    pathStat = await lstat(snapshot.path);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
  return pathStat.isFile() && pathStat.dev === snapshot.dev && pathStat.ino === snapshot.ino;
}

function snapshotQuarantinePath(path: string): string {
  const segment = basename(path);
  const extensionEnd = segment.indexOf(FILE_WORKSPACE_INDEX_EXTENSION);
  if (extensionEnd < 0) throw new Error("workspace index snapshot path has no file extension");
  const finalSegment = segment.slice(0, extensionEnd + FILE_WORKSPACE_INDEX_EXTENSION.length);
  return runtimeFilePath(dirname(path), tempSnapshotFileSegment(finalSegment));
}

async function removeExactSnapshotFile(snapshot: SnapshotFileIdentity): Promise<boolean> {
  if (!(await snapshotPathMatchesIdentity(snapshot))) return false;
  const quarantinePath = snapshotQuarantinePath(snapshot.path);
  try {
    await rename(snapshot.path, quarantinePath);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
  const quarantined = { ...snapshot, path: quarantinePath };
  if (!(await snapshotPathMatchesIdentity(quarantined))) return false;
  await unlink(quarantinePath);
  return true;
}

async function committedSnapshotMatches(
  snapshot: SnapshotFileIdentity,
  expectedRaw: string,
): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(snapshot.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    const expected = Buffer.from(expectedRaw, "utf8");
    if (
      !stat.isFile() ||
      stat.dev !== snapshot.dev ||
      stat.ino !== snapshot.ino ||
      stat.size !== expected.byteLength
    ) {
      return false;
    }
    const actual = await readSnapshotHandleWithinLimit(handle, expected.byteLength);
    if (actual?.byteLength !== expected.byteLength) return false;
    const expectedDigest = createHash("sha256").update(expected).digest("hex");
    const actualDigest = createHash("sha256").update(actual).digest("hex");
    return actualDigest === expectedDigest;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function abandonSnapshotTempFile(temp: OpenSnapshotTempFile, cause: unknown): Promise<never> {
  const failures: unknown[] = [cause];
  try {
    await temp.handle.truncate(0);
  } catch (error) {
    failures.push(error);
  }
  try {
    await temp.handle.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    if (!(await removeExactSnapshotFile(temp))) {
      failures.push(new Error("workspace index temp snapshot path changed before cleanup"));
    }
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) {
    throw cause;
  }
  throw new AggregateError(failures, "workspace index temp snapshot cleanup failed");
}

async function commitSnapshotTempFile(path: string, tempPath: string): Promise<void> {
  await rename(tempPath, path);
}

interface GuardedRuntimeDir {
  readonly identity: RuntimeDirIdentity;
  readonly binding: string;
}

type RuntimeDirGuard = () => Promise<GuardedRuntimeDir | undefined>;

function runtimeDirBinding(identity: RuntimeDirIdentity): string {
  return sha256Hex(
    JSON.stringify({
      realPath: identity.realPath,
      dev: identity.dev ?? null,
      ino: identity.ino ?? null,
      marker: identity.marker ?? null,
    }),
  );
}

function guardedRuntimeDir(identity: RuntimeDirIdentity): GuardedRuntimeDir {
  return { identity, binding: runtimeDirBinding(identity) };
}

function createRuntimeDirGuard(config: FileWorkspaceIndexStoreConfig): RuntimeDirGuard {
  let expectedRuntimeDirIdentity = config.runtimeDirIdentity;
  return async (): Promise<GuardedRuntimeDir | undefined> => {
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
      return guardedRuntimeDir(current);
    }
    if (
      expectedRuntimeDirIdentity.marker === undefined &&
      current.marker !== undefined &&
      sameRuntimeDirIdentity(expectedRuntimeDirIdentity, current)
    ) {
      expectedRuntimeDirIdentity = current;
      return guardedRuntimeDir(current);
    }
    return sameRuntimeDirIdentity(expectedRuntimeDirIdentity, current)
      ? guardedRuntimeDir(current)
      : undefined;
  };
}

async function runtimeDirStillGuarded(
  safeRuntimeDir: RuntimeDirGuard,
  expected: GuardedRuntimeDir,
): Promise<boolean> {
  const current = await safeRuntimeDir();
  return current?.binding === expected.binding;
}

function workspaceIndexGenerationIsActive(config: FileWorkspaceIndexStoreConfig): boolean {
  return config.isGenerationActive?.() !== false;
}

function inactiveWorkspaceIndexGenerationError(): Error {
  return new Error("workspace index storage generation is no longer active");
}

function assertWorkspaceIndexGenerationActive(config: FileWorkspaceIndexStoreConfig): void {
  if (!workspaceIndexGenerationIsActive(config)) {
    throw inactiveWorkspaceIndexGenerationError();
  }
}

function parseAndCacheStoredSnapshot(
  config: FileWorkspaceIndexStoreConfig,
  path: string,
  read: SnapshotReadResult,
  runtimeDirBinding: string,
  storageKey: string,
): WorkspaceIndexSnapshot | undefined {
  const parsed = parseStoredSnapshot(
    read.raw,
    config.encryptionKey,
    config.maxSnapshotEntries,
    runtimeDirBinding,
    storageKey,
  );
  if (!workspaceIndexGenerationIsActive(config)) return undefined;
  const snapshot = parsed.status === "loaded" ? parsed.snapshot : undefined;
  if (parsed.status === "rejected") config.onLoadFailure?.({ reason: parsed.reason });
  writeParsedSnapshotCache(path, {
    fingerprint: read.fingerprint,
    encryptionKeyId: config.encryptionKeyId,
    maxSnapshotEntries: config.maxSnapshotEntries,
    runtimeDirBinding,
    snapshot,
  });
  return snapshot;
}

async function loadFileWorkspaceIndexSnapshot(
  config: FileWorkspaceIndexStoreConfig,
  safeRuntimeDir: RuntimeDirGuard,
  storageKey: string,
): Promise<WorkspaceIndexSnapshot | undefined> {
  if (!workspaceIndexGenerationIsActive(config)) return undefined;
  const guarded = await safeRuntimeDir();
  if (guarded === undefined) {
    return undefined;
  }
  const path = snapshotPath(
    guarded.identity.realPath,
    storageKey,
    config.storageGenerationId,
    config.locatorKey,
  );
  const read = await safeReadSnapshotFile(path, config.maxSnapshotBytes);
  if (read === undefined) {
    return undefined;
  }
  if (!(await runtimeDirStillGuarded(safeRuntimeDir, guarded))) {
    return undefined;
  }
  const cached = readParsedSnapshotCache(
    path,
    read.fingerprint,
    config.encryptionKeyId,
    config.maxSnapshotEntries,
    guarded.binding,
  );
  if (cached !== undefined) {
    return workspaceIndexGenerationIsActive(config) ? cached.snapshot : undefined;
  }
  const snapshot = parseAndCacheStoredSnapshot(config, path, read, guarded.binding, storageKey);
  return workspaceIndexGenerationIsActive(config) ? snapshot : undefined;
}

async function writeAndCommitGuardedSnapshot(
  config: FileWorkspaceIndexStoreConfig,
  safeRuntimeDir: RuntimeDirGuard,
  guarded: GuardedRuntimeDir,
  path: string,
  tempPath: string,
  raw: string,
): Promise<SnapshotFileIdentity> {
  assertWorkspaceIndexGenerationActive(config);
  const temp = await createSnapshotTempFile(tempPath);
  if (!workspaceIndexGenerationIsActive(config)) {
    await abandonSnapshotTempFile(temp, inactiveWorkspaceIndexGenerationError());
  }
  if (!(await runtimeDirStillGuarded(safeRuntimeDir, guarded))) {
    await abandonSnapshotTempFile(
      temp,
      new Error("workspace index runtime directory identity changed before snapshot write"),
    );
  }
  try {
    await writeSnapshotTempFile(temp, raw);
  } catch (error) {
    await abandonSnapshotTempFile(temp, error);
  }
  if (!workspaceIndexGenerationIsActive(config)) {
    await abandonSnapshotTempFile(temp, inactiveWorkspaceIndexGenerationError());
  }
  if (!(await runtimeDirStillGuarded(safeRuntimeDir, guarded))) {
    await abandonSnapshotTempFile(
      temp,
      new Error("workspace index runtime directory identity changed after snapshot write"),
    );
  }
  const committed = await commitWrittenSnapshot(temp, path, tempPath, raw);
  const generationActive = workspaceIndexGenerationIsActive(config);
  const runtimeDirGuarded = await runtimeDirStillGuarded(safeRuntimeDir, guarded);
  if (!generationActive || !runtimeDirGuarded) {
    if (!(await removeExactSnapshotFile(committed))) {
      throw new Error("workspace index committed snapshot path changed before cleanup");
    }
    if (!generationActive) throw inactiveWorkspaceIndexGenerationError();
    throw new Error("workspace index runtime directory identity changed after snapshot commit");
  }
  return committed;
}

async function rejectCommittedSnapshotFromRetiredGeneration(
  config: FileWorkspaceIndexStoreConfig,
  committed: SnapshotFileIdentity,
): Promise<void> {
  if (workspaceIndexGenerationIsActive(config)) return;
  if (!(await removeExactSnapshotFile(committed))) {
    throw new Error("workspace index retired snapshot path changed before cleanup");
  }
  throw inactiveWorkspaceIndexGenerationError();
}

function normalizeSnapshotWithinBounds(
  config: FileWorkspaceIndexStoreConfig,
  snapshot: WorkspaceIndexSnapshot,
): WorkspaceIndexSnapshot | undefined {
  const normalized = normalizeSnapshot(snapshot);
  return normalized !== undefined && snapshotFitsStoreBounds(normalized, config.maxSnapshotEntries)
    ? normalized
    : undefined;
}

function sealedSnapshotWithinBounds(
  config: FileWorkspaceIndexStoreConfig,
  snapshot: WorkspaceIndexSnapshot,
  runtimeDirBinding: string,
  storageKey: string,
): string | undefined {
  const raw = sealStoredSnapshot(config.encryptionKey, snapshot, runtimeDirBinding, storageKey);
  return Buffer.byteLength(raw, "utf8") <= config.maxSnapshotBytes ? raw : undefined;
}

function snapshotStorePaths(
  config: FileWorkspaceIndexStoreConfig,
  runtimeDir: string,
  storageKey: string,
): { readonly path: string; readonly tempPath: string } {
  const path = snapshotPath(runtimeDir, storageKey, config.storageGenerationId, config.locatorKey);
  const tempPath = tempSnapshotPath(
    runtimeDir,
    storageKey,
    config.storageGenerationId,
    config.locatorKey,
  );
  return { path, tempPath };
}

async function pruneCommittedSnapshot(
  config: FileWorkspaceIndexStoreConfig,
  safeRuntimeDir: RuntimeDirGuard,
  guarded: GuardedRuntimeDir,
  committed: SnapshotFileIdentity,
): Promise<void> {
  try {
    await pruneWorkspaceIndexSnapshots(
      config,
      guarded.identity.realPath,
      committed.path,
      safeRuntimeDir,
      guarded,
    );
  } catch (error) {
    if (!workspaceIndexGenerationIsActive(config)) {
      await rejectCommittedSnapshotFromRetiredGeneration(config, committed);
    }
    throw error;
  }
  await rejectCommittedSnapshotFromRetiredGeneration(config, committed);
}

async function commitWrittenSnapshot(
  temp: OpenSnapshotTempFile,
  path: string,
  tempPath: string,
  raw: string,
): Promise<SnapshotFileIdentity> {
  try {
    await temp.handle.close();
  } catch (error) {
    await abandonSnapshotTempFile(temp, error);
  }
  if (!(await snapshotPathMatchesIdentity(temp))) {
    throw new Error("workspace index temp snapshot identity changed before commit");
  }
  try {
    await commitSnapshotTempFile(path, tempPath);
  } catch (error) {
    if (!(await removeExactSnapshotFile(temp))) {
      throw new AggregateError(
        [error, new Error("workspace index temp snapshot path changed before cleanup")],
        "workspace index commit and temp cleanup both failed",
        { cause: error },
      );
    }
    throw error;
  }
  const committed = { ...temp, path };
  if (!(await committedSnapshotMatches(committed, raw))) {
    throw new Error("workspace index committed snapshot identity changed");
  }
  return committed;
}

async function saveFileWorkspaceIndexSnapshot(
  config: FileWorkspaceIndexStoreConfig,
  safeRuntimeDir: RuntimeDirGuard,
  storageKey: string,
  snapshot: WorkspaceIndexSnapshot,
): Promise<void> {
  assertWorkspaceIndexGenerationActive(config);
  const normalized = normalizeSnapshotWithinBounds(config, snapshot);
  if (normalized === undefined) return;
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
  assertWorkspaceIndexGenerationActive(config);
  const guarded = await safeRuntimeDir();
  if (guarded === undefined) return;
  const runtimeDir = guarded.identity.realPath;
  const raw = sealedSnapshotWithinBounds(config, normalized, guarded.binding, storageKey);
  if (raw === undefined) return;
  await bestEffortChmod(runtimeDir, 0o700);
  const { path, tempPath } = snapshotStorePaths(config, runtimeDir, storageKey);
  const committed = await writeAndCommitGuardedSnapshot(
    config,
    safeRuntimeDir,
    guarded,
    path,
    tempPath,
    raw,
  );
  await rejectCommittedSnapshotFromRetiredGeneration(config, committed);
  // Avoid retaining the prior parsed object even when an idempotent write produces identical
  // ciphertext bytes through a deterministic test double.
  PARSED_SNAPSHOT_CACHE.delete(path);
  await pruneCommittedSnapshot(config, safeRuntimeDir, guarded, committed);
}

export function createFileWorkspaceIndexStore(
  options: FileWorkspaceIndexStoreOptions,
): WorkspaceIndexStore {
  const config = fileWorkspaceIndexStoreConfig(options);
  const safeRuntimeDir = createRuntimeDirGuard(config);
  const mutationRuntimeDir =
    config.runtimeDirIdentity?.realPath ?? existingRealPath(config.runtimeDir);
  const mutationScope =
    config.isGenerationActive === undefined ? config.storageGenerationId : "active-generation";
  const mutationKey = `${mutationRuntimeDir}\u0000${mutationScope}`;
  return {
    loadSnapshot: async (storageKey) =>
      loadFileWorkspaceIndexSnapshot(config, safeRuntimeDir, storageKey),
    saveSnapshot: async (storageKey, snapshot): Promise<void> => {
      try {
        await runSerializedFileStoreMutation(mutationKey, () =>
          saveFileWorkspaceIndexSnapshot(config, safeRuntimeDir, storageKey, snapshot),
        );
      } catch (error) {
        if (!workspaceIndexGenerationIsActive(config)) throw error;
        try {
          options.onSaveFailure?.({ reason: "write-or-cleanup-failure" });
        } catch (reportingError) {
          throw new AggregateError(
            [error, reportingError],
            "workspace index save and failure reporting both failed",
            { cause: reportingError },
          );
        }
        throw error;
      }
    },
  };
}

export interface InMemoryWorkspaceIndexStoreOptions {
  readonly maxSnapshots?: number | undefined;
}

export function createInMemoryWorkspaceIndexStore(
  options: InMemoryWorkspaceIndexStoreOptions = {},
): WorkspaceIndexStore {
  const maxSnapshots = normalizeLimit(
    options.maxSnapshots,
    DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOTS,
  );
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
      // Normalize on write so the store's read side always returns a normalized snapshot —
      // this is the invariant that lets the WorkspaceIndex wrapper (GEN-PERF-CHAT-003) skip
      // a redundant re-normalize on every load. A snapshot that fails normalization is
      // dropped rather than stored, matching the file store's parse-time rejection.
      const normalized = normalizeSnapshot(snapshot);
      if (normalized === undefined) {
        return;
      }
      if (snapshots.has(key)) {
        snapshots.delete(key);
      }
      snapshots.set(key, normalized);
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
      // GEN-PERF-CHAT-003: both built-in stores return an already-normalized snapshot (the
      // file store via parseStoredSnapshot, the in-memory store via its normalizing save),
      // so a second normalizeSnapshot here would be a redundant O(records) pass on the
      // grounded-ask hot path. normalizeSnapshot is idempotent, so returning the store's
      // snapshot directly is behavior-preserving.
      const snapshot = await store.loadSnapshot(storageKey(scopeKey));
      return snapshot?.version === WORKSPACE_INDEX_SNAPSHOT_VERSION &&
        snapshotMatchesScopeKey(snapshot, scopeKey)
        ? snapshot
        : undefined;
    },
    saveSnapshot: async (
      scopeKey: WorkspaceIndexScopeKey,
      snapshot: WorkspaceIndexSnapshot,
    ): Promise<void> => {
      const normalized = normalizeSnapshot(snapshot);
      if (normalized === undefined) {
        return;
      }
      if (!snapshotMatchesScopeKey(normalized, scopeKey)) {
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
  const code = char.codePointAt(0) ?? 0;
  return code >= 65 && code <= 90;
}

function isAsciiLower(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 97 && code <= 122;
}

function isAsciiDigit(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
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

const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;

// SonarCloud S8786: `/[^\p{L}\p{N}]+$/u` is anchored at the end but not the start, so an unanchored
// engine retries every start position looking for a trailing non-letter/non-number run that
// reaches the true end of the string -- quadratic whenever that run isn't at the very end (e.g. a
// token content-tokenized from a line full of separator punctuation with one trailing letter). The
// leading `^[^\p{L}\p{N}]+` sibling is unaffected (anchored at the start, so only one position is
// ever tried) and is left as a regex. Code points are iterated (not UTF-16 units) to match how
// `\p{L}`/`\p{N}` classify astral characters under the `u` flag.
export function stripTrailingNonWordChars(value: string): string {
  const chars = Array.from(value);
  let end = chars.length;
  while (end > 0) {
    const char = chars[end - 1];
    if (char !== undefined && LETTER_OR_NUMBER.test(char)) {
      break;
    }
    end -= 1;
  }
  return chars.slice(0, end).join("");
}

function expandContentToken(token: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const normalized = stripTrailingNonWordChars(token.replace(/^[^\p{L}\p{N}]+/u, ""));
  if (normalized.length === 0) {
    return out;
  }
  addTerm(out, seen, normalized.toLowerCase());
  const strippedTest = stripTestIdentifierSuffix(normalized);
  if (strippedTest !== undefined) {
    addTerm(out, seen, strippedTest.toLowerCase());
  }
  for (const part of normalized
    .split(WORKSPACE_INDEX_TOKEN_SEPARATOR_RE)
    .filter((part) => part.length > 0)) {
    addTerm(out, seen, part.toLowerCase());
    const derived = stripTestIdentifierSuffix(part);
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

function lexicalTermsForLine(
  line: string,
  routeMarkers: readonly string[],
): WorkspaceIndexLineTerms {
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
  for (const marker of routeMarkers) {
    if (seen.has(marker)) continue;
    if (terms.length >= MAX_WORKSPACE_INDEX_LEXICAL_TERMS_PER_LINE) {
      return { terms, truncated: true };
    }
    seen.add(marker);
    terms.push(marker);
  }
  return { terms, truncated: false };
}

function routeMarkersAt(
  sourceLines: ReturnType<typeof repositorySourceLines>,
  index: number,
): readonly string[] {
  const window = sourceLines.slice(index, index + REPOSITORY_ROUTE_DECLARATION_WINDOW_LINES);
  return repositoryRouteDeclarationMarkers(
    window.map((line) => line.code).join("\n"),
    window.map((line) => line.structural).join("\n"),
  );
}

interface PreparedLexicalLine {
  readonly definitionTermHashes: readonly string[];
  readonly termHashes: readonly string[];
  readonly maxTermLength: number;
  readonly truncated: boolean;
}

function prepareLexicalLine(
  line: string,
  structuralLine: string,
  routeMarkers: readonly string[],
): PreparedLexicalLine | undefined {
  const lexical = lexicalTermsForLine(line, routeMarkers);
  if (lexical.terms.length === 0) return undefined;
  const termHashes = [...new Set(lexical.terms.map((term) => hashLexicalTerm(term)))].sort(
    compareStrings,
  );
  const maxTermLength = lexical.terms.reduce((max, term) => Math.max(max, term.length), 0);
  const definitions = new Set(
    definitionSymbolsInStructuralLine(structuralLine).map((symbol) => symbol.toLowerCase()),
  );
  const definitionTermHashes = lexical.terms
    .filter((term) => definitions.has(term.toLowerCase()))
    .map((term) => hashLexicalTerm(term))
    .sort(compareStrings);
  return { definitionTermHashes, termHashes, maxTermLength, truncated: lexical.truncated };
}

function addFileTermHashes(hashes: readonly string[], target: Set<string>): boolean {
  for (const hash of hashes) {
    if (target.size >= MAX_WORKSPACE_INDEX_LEXICAL_TERMS_PER_FILE) return false;
    target.add(hash);
  }
  return true;
}

function lexicalLineRecord(
  prepared: PreparedLexicalLine,
  index: number,
  range: { readonly startLine: number; readonly endLine: number } | undefined,
): WorkspaceIndexLexicalLine {
  return {
    startLine: range?.startLine ?? index + 1,
    endLine: range?.endLine ?? index + 1,
    termHashes: prepared.termHashes,
    ...(prepared.definitionTermHashes.length === 0
      ? {}
      : { definitionTermHashes: prepared.definitionTermHashes }),
  };
}

export function buildWorkspaceIndexLexicalRecord(
  content: string,
  scopePath?: string,
): WorkspaceIndexLexicalRecord {
  const lines = content.split("\n");
  const sourceLines = repositorySourceLines(content, scopePath);
  const lexicalLines: WorkspaceIndexLexicalLine[] = [];
  const preparedLines: { readonly index: number; readonly value: PreparedLexicalLine }[] = [];
  const termHashes = new Set<string>();
  let maxTermLength = 0;
  let truncated = false;
  for (let index = 0; index < lines.length; index += 1) {
    const prepared = prepareLexicalLine(
      lines[index] ?? "",
      sourceLines[index]?.structural ?? "",
      routeMarkersAt(sourceLines, index),
    );
    if (prepared === undefined) continue;
    if (prepared.truncated) truncated = true;
    if (preparedLines.length >= MAX_WORKSPACE_INDEX_LEXICAL_LINES) {
      truncated = true;
      break;
    }
    if (!addFileTermHashes(prepared.termHashes, termHashes)) truncated = true;
    maxTermLength = Math.max(maxTermLength, prepared.maxTermLength);
    preparedLines.push({ index, value: prepared });
    if (truncated) {
      break;
    }
  }
  const enclosingRanges = enclosingLineRangesForIndices(
    content,
    preparedLines.map((line) => line.index),
  );
  lexicalLines.push(
    ...preparedLines.map((line) =>
      lexicalLineRecord(line.value, line.index, enclosingRanges.get(line.index)),
    ),
  );
  return {
    truncated,
    termHashes: [...termHashes].sort(compareStrings),
    maxTermLength,
    lines: lexicalLines,
  };
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
  readonly snapshots: readonly WorkspaceIndexDirectorySnapshot[];
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
  const rest =
    directoryScopePath.length === 0 ? scopePath : scopePath.slice(directoryScopePath.length + 1);
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
  return removed.sort(compareStrings);
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
  return added.sort(compareStrings);
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

function oldDirectoryChildKind(
  files: readonly WorkspaceIndexDiscoveredFile[],
  directoryScopePath: string,
  childName: string,
): "directory" | "file" | undefined {
  const childPath = childScopePath(directoryScopePath, childName);
  if (files.some((file) => file.scopePath === childPath)) return "file";
  return files.some((file) => file.scopePath.startsWith(`${childPath}/`)) ? "directory" : undefined;
}

function directoryChildTypeChanged(
  files: readonly WorkspaceIndexDiscoveredFile[],
  directoryScopePath: string,
  newChildren: ReadonlyMap<string, WorkspaceIndexDirectoryEntryShape>,
): boolean {
  for (const [name, entry] of newChildren) {
    const oldKind = oldDirectoryChildKind(files, directoryScopePath, name);
    if (oldKind === "file" && entry.isDirectory) return true;
    if (oldKind === "directory" && entry.isFile) return true;
  }
  return false;
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
  const removedPaths = removedDirectoryFiles(
    normalized.discovery.files,
    directory.scopePath,
    removedNames,
  );
  const rescanDirectory =
    directoryChildTypeChanged(normalized.discovery.files, directory.scopePath, newChildren) ||
    (addedPaths.length === 0 && removedPaths.length === 0);
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
  maxEntries: number,
): {
  readonly valid: boolean;
  readonly changed: boolean;
  readonly entries: readonly WorkspaceIndexDirectoryEntryShape[];
} {
  try {
    const entries = fs.readDir(absolutePath, maxEntries + 1);
    if (entries.length > maxEntries) return { valid: false, changed: true, entries: [] };
    return {
      valid: true,
      changed: workspaceDirectoryFingerprint(entries) !== directory.fingerprint,
      entries,
    };
  } catch {
    return { valid: false, changed: true, entries: [] };
  }
}

function workspaceIndexDirectoryEntryBudget(maxFilesScanned: number): number {
  return Math.max(maxFilesScanned * 25, maxFilesScanned + 1);
}

function workspaceIndexDirectoryAbsolutePath(workspaceRoot: string, scopePath: string): string {
  return scopePath.length === 0 ? workspaceRoot : resolveWithinWorkspace(workspaceRoot, scopePath);
}

function isSafeWorkspaceIndexDirectoryScopePath(scopePath: string): boolean {
  return scopePath.length === 0 || isSafeIndexScopePath(scopePath);
}

export function resolveContainedWorkspaceIndexDirectory(
  workspaceRoot: string,
  scopePath: string,
  fs: WorkspaceFs,
): string | undefined {
  const normalized = normalizeScopePath(scopePath);
  if (normalized !== scopePath || !isSafeWorkspaceIndexDirectoryScopePath(normalized)) {
    return undefined;
  }
  try {
    const absolutePath = workspaceIndexDirectoryAbsolutePath(workspaceRoot, normalized);
    const contained = containedRealPathInfo(fs, workspaceRoot, absolutePath);
    if (!isCanonicalAllowedContainedPath(contained, workspaceRoot, normalized)) {
      return undefined;
    }
    const stat = fs.stat(contained.path);
    return stat.isDirectory && !stat.isSymbolicLink ? contained.path : undefined;
  } catch {
    return undefined;
  }
}

interface InspectedWorkspaceIndexDirectory {
  readonly valid: boolean;
  readonly entriesRead: number;
  readonly delta?: WorkspaceIndexDirectoryDelta | undefined;
  readonly snapshot?: WorkspaceIndexDirectorySnapshot | undefined;
}

function inspectWorkspaceIndexDirectory(
  normalized: WorkspaceIndexSnapshot,
  directory: WorkspaceIndexDirectorySnapshot,
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  remainingEntries: number,
): InspectedWorkspaceIndexDirectory {
  const absolutePath = resolveContainedWorkspaceIndexDirectory(
    workspace.root,
    directory.scopePath,
    fs,
  );
  if (absolutePath === undefined) return { valid: false, entriesRead: 0 };
  const result = directoryChanged(directory, absolutePath, fs, remainingEntries);
  if (!result.valid) return { valid: false, entriesRead: 0 };
  const snapshot = {
    scopePath: directory.scopePath,
    fingerprint: workspaceDirectoryFingerprint(result.entries),
  };
  if (!result.changed) return { valid: true, entriesRead: result.entries.length, snapshot };
  const delta =
    result.entries.length === 0
      ? {
          scopePath: directory.scopePath,
          addedPaths: [],
          removedPaths: normalized.discovery.files
            .filter((file) => isWithinDirectory(file.scopePath, directory.scopePath))
            .map((file) => file.scopePath),
          rescanDirectory: false,
        }
      : directoryDelta(normalized, directory, result.entries);
  return {
    valid: true,
    entriesRead: result.entries.length,
    snapshot,
    ...(delta === undefined ? {} : { delta }),
  };
}

function fixedFileSelectionPaths(
  normalized: WorkspaceIndexSnapshot,
): readonly string[] | undefined {
  if (
    normalized.relativePaths.length === 0 ||
    normalized.discovery.directories.length > 0 ||
    normalized.discovery.truncated ||
    normalized.discovery.filesDiscovered !== normalized.discovery.files.length
  ) {
    return undefined;
  }
  const discoveredPaths = new Set(normalized.discovery.files.map((file) => file.scopePath));
  if (
    discoveredPaths.size !== normalized.relativePaths.length ||
    normalized.relativePaths.some((scopePath) => !discoveredPaths.has(scopePath))
  ) {
    return undefined;
  }
  return normalized.relativePaths;
}

function fixedFileIsCurrent(scopePath: string, workspace: WorkspaceInfo, fs: WorkspaceFs): boolean {
  try {
    const absolutePath = resolveWithinWorkspace(workspace.root, scopePath);
    const contained = containedRealPathInfo(fs, workspace.root, absolutePath);
    if (!isCanonicalAllowedContainedPath(contained, workspace.root, scopePath)) return false;
    const stat = fs.stat(contained.path);
    return (
      stat.isFile &&
      !stat.isSymbolicLink &&
      (stat.hardLinkCount === undefined || stat.hardLinkCount <= 1)
    );
  } catch {
    return false;
  }
}

function fixedFileSelectionIsCurrent(
  normalized: WorkspaceIndexSnapshot,
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  shouldContinue: () => boolean,
): boolean {
  const scopePaths = fixedFileSelectionPaths(normalized);
  if (scopePaths === undefined) return false;
  for (const scopePath of scopePaths) {
    if (!shouldContinue() || !fixedFileIsCurrent(scopePath, workspace, fs)) return false;
  }
  return true;
}

export function inspectWorkspaceIndexDirectories(
  snapshot: WorkspaceIndexSnapshot,
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  shouldContinue: () => boolean = () => true,
): WorkspaceIndexDirectoryInspection {
  const normalized = normalizeSnapshot(snapshot);
  if (normalized === undefined) {
    return { valid: false, deltas: [], snapshots: [] };
  }
  if (normalized.discovery.directories.length === 0) {
    return {
      valid: fixedFileSelectionIsCurrent(normalized, workspace, fs, shouldContinue),
      deltas: [],
      snapshots: [],
    };
  }
  const deltas: WorkspaceIndexDirectoryDelta[] = [];
  const snapshots: WorkspaceIndexDirectorySnapshot[] = [];
  let remainingEntries = workspaceIndexDirectoryEntryBudget(normalized.maxFilesScanned);
  for (const directory of normalized.discovery.directories) {
    if (!shouldContinue() || remainingEntries <= 0) {
      return { valid: false, deltas: [], snapshots: [] };
    }
    const result = inspectWorkspaceIndexDirectory(
      normalized,
      directory,
      workspace,
      fs,
      remainingEntries,
    );
    if (!result.valid || result.snapshot === undefined) {
      return { valid: false, deltas: [], snapshots: [] };
    }
    remainingEntries -= result.entriesRead;
    snapshots.push(result.snapshot);
    if (result.delta !== undefined) deltas.push(result.delta);
  }
  return { valid: true, deltas, snapshots };
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
  if (normalized.discovery.directories.length === 0) {
    return fixedFileSelectionIsCurrent(normalized, workspace, fs, () => true);
  }
  let remainingEntries = workspaceIndexDirectoryEntryBudget(normalized.maxFilesScanned);
  for (const directory of normalized.discovery.directories) {
    if (remainingEntries <= 0) return false;
    const absolutePath = resolveContainedWorkspaceIndexDirectory(
      workspace.root,
      directory.scopePath,
      fs,
    );
    if (absolutePath === undefined) return false;
    try {
      const entries = fs.readDir(absolutePath, remainingEntries + 1);
      if (entries.length > remainingEntries) return false;
      remainingEntries -= entries.length;
      if (workspaceDirectoryFingerprint(entries) !== directory.fingerprint) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function currentMetadata(scopePath: string, stat: WorkspaceStat): WorkspaceIndexDiscoveredFile {
  return workspaceIndexFileMetadata(scopePath, stat);
}

function sameStrongFileIdentity(
  record: WorkspaceIndexDiscoveredFile,
  metadata: WorkspaceIndexDiscoveredFile,
): boolean {
  if (
    record.fileIdentityHash === undefined ||
    record.mtimeNs === undefined ||
    record.ctimeNs === undefined
  ) {
    return false;
  }
  return (
    record.fileIdentityHash === metadata.fileIdentityHash &&
    record.mtimeNs === metadata.mtimeNs &&
    record.ctimeNs === metadata.ctimeNs &&
    record.hardLinkCount === 1 &&
    metadata.hardLinkCount === 1
  );
}

export function isWorkspaceIndexFileMetadataCurrent(
  previous: WorkspaceIndexDiscoveredFile | undefined,
  current: WorkspaceIndexDiscoveredFile,
): boolean {
  if (previous === undefined) return false;
  return (
    previous.sizeBytes === current.sizeBytes &&
    previous.mtimeMs === current.mtimeMs &&
    sameStrongFileIdentity(previous, current)
  );
}

function sameRecordMetadata(
  record: WorkspaceIndexRecord | undefined,
  metadata: WorkspaceIndexDiscoveredFile,
): boolean {
  if (record === undefined) {
    return false;
  }
  return isWorkspaceIndexFileMetadataCurrent(record, metadata);
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
    ...(entry.fileIdentityHash !== undefined ? { fileIdentityHash: entry.fileIdentityHash } : {}),
    ...(entry.mtimeNs !== undefined ? { mtimeNs: entry.mtimeNs } : {}),
    ...(entry.ctimeNs !== undefined ? { ctimeNs: entry.ctimeNs } : {}),
    ...(entry.hardLinkCount !== undefined ? { hardLinkCount: entry.hardLinkCount } : {}),
  };
}

function matchedRecord(
  recordByPath: ReadonlyMap<string, WorkspaceIndexRecord>,
  scopePath: string,
): MatchedWorkspaceIndexRecord | undefined {
  const direct = recordByPath.get(scopePath);
  return direct === undefined ? undefined : { path: scopePath, record: direct };
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
      ...(metadata.fileIdentityHash !== undefined
        ? { fileIdentityHash: metadata.fileIdentityHash }
        : {}),
      ...(metadata.mtimeNs !== undefined ? { mtimeNs: metadata.mtimeNs } : {}),
      ...(metadata.ctimeNs !== undefined ? { ctimeNs: metadata.ctimeNs } : {}),
      ...(metadata.hardLinkCount !== undefined ? { hardLinkCount: metadata.hardLinkCount } : {}),
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
  const contained = containedRealPathInfo(fs, workspace.root, absolutePath);
  const scopePath = normalizeScopePath(contained.realRelative);
  const canonicalPathIsSafe =
    isCanonicalAllowedContainedPath(contained, workspace.root, requestedPath) &&
    isSafeIndexScopePath(scopePath) &&
    !seen.has(scopePath);
  if (!canonicalPathIsSafe && contained.path !== absolutePath) {
    return { kind: "skipped" };
  }
  const stat = statFile(fs, contained.path);
  if (stat === undefined) {
    return { kind: "deleted" };
  }
  if (!canonicalPathIsSafe || !stat.isFile) {
    return { kind: "skipped" };
  }
  seen.add(scopePath);
  return retainedPreparedEntry(
    contained.path,
    scopePath,
    currentMetadata(scopePath, stat),
    matchedRecord(recordByPath, scopePath),
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
    filesDiscovered: normalized.discovery.truncated
      ? normalized.discovery.filesDiscovered
      : files.length,
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
    droppedRecords: normalized.records.filter((record) => !usedRecordPaths.has(record.scopePath))
      .length,
  };
}

interface CollectedPreparedWorkspaceIndexEntries {
  readonly entries: PreparedWorkspaceIndexEntry[];
  readonly report: WorkspaceIndexPreparationReport;
  readonly usedRecordPaths: ReadonlySet<string>;
}

function collectPreparedWorkspaceIndexEntries(
  normalized: WorkspaceIndexSnapshot,
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  shouldContinue: () => boolean,
): CollectedPreparedWorkspaceIndexEntries | undefined {
  const entries: PreparedWorkspaceIndexEntry[] = [];
  let report = emptyPreparationReport();
  const recordByPath = new Map(
    normalized.records.map((record) => [record.scopePath, record] as const),
  );
  const seen = new Set<string>();
  const usedRecordPaths = new Set<string>();
  for (const discovered of normalized.discovery.files) {
    if (!shouldContinue()) return undefined;
    const outcome = prepareWorkspaceIndexEntry(discovered, workspace, fs, seen, recordByPath);
    report = updatePreparationReport(report, outcome);
    if (outcome.kind !== "retained") continue;
    entries.push(outcome.entry);
    if (outcome.matchedRecordPath !== undefined) usedRecordPaths.add(outcome.matchedRecordPath);
  }
  return { entries, report, usedRecordPaths };
}

export function prepareWorkspaceIndexSnapshot(
  snapshot: WorkspaceIndexSnapshot,
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  shouldContinue: () => boolean = () => true,
): PreparedWorkspaceIndexSnapshot {
  if (!shouldContinue()) return emptyPreparedWorkspaceIndexSnapshot();
  const normalized = normalizeSnapshot(snapshot);
  if (normalized === undefined || !shouldContinue()) {
    return emptyPreparedWorkspaceIndexSnapshot();
  }
  const collected = collectPreparedWorkspaceIndexEntries(normalized, workspace, fs, shouldContinue);
  if (collected === undefined) return emptyPreparedWorkspaceIndexSnapshot();
  if (!shouldContinue()) return emptyPreparedWorkspaceIndexSnapshot();
  const { entries, report, usedRecordPaths } = collected;
  entries.sort((a, b) => compareStrings(a.scopePath, b.scopePath));
  return {
    valid: true,
    dirty: report.deletedEntries > 0 || report.skippedEntries > 0 || report.staleRecords > 0,
    entries,
    discovery: preparedDiscoverySnapshot(normalized, entries),
    report: finalizePreparationReport(report, usedRecordPaths, normalized),
  };
}

function cachedPreparedEntry(
  file: WorkspaceIndexDiscoveredFile,
  record: WorkspaceIndexRecord | undefined,
  workspace: WorkspaceInfo,
): PreparedWorkspaceIndexEntry {
  return {
    scopePath: file.scopePath,
    absolutePath: resolveWithinWorkspace(workspace.root, file.scopePath),
    file: { relativePath: file.scopePath, sizeBytes: file.sizeBytes },
    ...(file.mtimeMs !== undefined ? { mtimeMs: file.mtimeMs } : {}),
    ...(file.fileIdentityHash !== undefined ? { fileIdentityHash: file.fileIdentityHash } : {}),
    ...(file.mtimeNs !== undefined ? { mtimeNs: file.mtimeNs } : {}),
    ...(file.ctimeNs !== undefined ? { ctimeNs: file.ctimeNs } : {}),
    ...(file.hardLinkCount !== undefined ? { hardLinkCount: file.hardLinkCount } : {}),
    record,
    stale: record === undefined,
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
  const recordByPath = new Map(
    normalized.records.map((record) => [record.scopePath, record] as const),
  );
  const entries: PreparedWorkspaceIndexEntry[] = [];
  const usedRecordPaths = new Set<string>();
  for (const file of normalized.discovery.files) {
    const record = recordByPath.get(file.scopePath);
    if (record !== undefined) {
      usedRecordPaths.add(record.scopePath);
    }
    entries.push(cachedPreparedEntry(file, record, workspace));
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
    droppedRecords: normalized.records.filter((record) => !usedRecordPaths.has(record.scopePath))
      .length,
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
  const contentScores = cachedContentScores(prepared.entries, query, policy);
  const ordered = orderCandidatesForSearch({
    files,
    query,
    policy,
    ignoredByDiscovery: prepared.discovery.ignoredByDiscovery,
    deniedByDiscovery: prepared.discovery.deniedByDiscovery,
    depthPrunedByDiscovery: prepared.discovery.depthPrunedByDiscovery,
    maxFilesPrunedByDiscovery: 0,
    contentScores,
  });
  return {
    files: ordered.files,
    directories: prepared.discovery.directories.map((directory) => directory.scopePath),
    directorySnapshots: prepared.discovery.directories,
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
    ignorePolicySha256: workspaceIgnorePolicyFingerprint(input.scope.workspace?.ignoreLines ?? []),
    candidatePathPolicySha256: workspaceCandidatePathPolicyFingerprint(
      input.scope.candidatePathGlobs,
    ),
    policyMode: input.policy.policyMode,
    applyGitignore: input.policy.applyGitignore,
    omitLowValueWorkspaceFiles: input.policy.omitLowValueWorkspaceFiles,
    maxBytesPerFileScanned: input.maxBytesPerFileScanned,
    maxFilesScanned: input.maxFilesScanned,
    discovery,
    records,
  };
}
