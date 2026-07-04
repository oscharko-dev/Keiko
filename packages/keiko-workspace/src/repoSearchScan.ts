// Candidate gathering and the per-file scan loop for the repo-search facade (Issue #179).
// Kept separate from the public API surface so repoSearch.ts stays inside the 400-LOC cap.
// Every file system touch goes through the injected WorkspaceFs port; nothing here calls
// node:fs directly.

import type {
  CandidateFile,
  CandidateOmissionReason,
  ContextCoverageTruncationReason,
  EvidenceAtom,
  EvidenceEdge,
  EvidenceAtomProvenanceKind,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  isValidScopePath,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { redact } from "@oscharko-dev/keiko-security";
import { discoverWithStats, readWorkspaceFile } from "./discovery.js";
import { FileTooLargeError, RepoSearchInvalidQueryError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo } from "./realpath.js";
import { DEFAULT_BINARY_PROBE, decodeTextBytes, looksBinary } from "./binaryDetect.js";
import { collectFromEntries } from "./repoSearchEntries.js";
import { collectBestLines, type ScoredLine } from "./repoSearchLineSelection.js";
import { evidenceAtomStableId } from "./stableId.js";
import type { LineMatcher } from "./repoSearchMatchers.js";
import { naturalLanguageContentTerms } from "./repoSearchMatchers.js";
import { collectSemanticSearchDocument, type SemanticSearchSession } from "./repoSearchSemantic.js";
import { expandedQueryTerms } from "./repoSearchQueryTerms.js";
import {
  extraIgnoreLinesForSearch,
  legacyDiscoveryPolicy,
  orderCandidatesForSearch,
  policyOmissionReason,
  resolveSearchPolicy,
  scoreContentForSearch,
  shouldScoreContent,
  type SearchDiagnostics,
  type SearchPolicy,
} from "./repoSearchPolicy.js";
import type { DiscoveredFile, WorkspaceInfo } from "./types.js";
import type {
  PreparedWorkspaceIndexEntry,
  WorkspaceIndexDiscoveredFile,
  WorkspaceIndexLexicalRecord,
  WorkspaceIndexRecord,
} from "./workspaceIndex.js";
import {
  buildWorkspaceIndexLexicalRecord,
  isWorkspaceIndexRecordCurrent,
  workspaceIndexContentFingerprint,
} from "./workspaceIndex.js";
import { createHash } from "node:crypto";

const BINARY_PROBE_BYTES = DEFAULT_BINARY_PROBE.maxProbeBytes;
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

function normalizeScopePath(scopePath: string): string {
  return scopePath.split("\\").join("/");
}

export function isImageScopePath(scopePath: string): boolean {
  const lastSlash = Math.max(scopePath.lastIndexOf("/"), scopePath.lastIndexOf("\\"));
  const basename = scopePath.slice(lastSlash + 1).toLowerCase();
  const dot = basename.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(basename.slice(dot));
}

export interface ScopeShape {
  readonly workspace: WorkspaceInfo;
  readonly scopeId: string;
  readonly relativePaths: readonly string[];
}

export interface LimitsShape {
  readonly maxFilesScanned: number;
  readonly maxMatchesReturned: number;
  readonly maxBytesPerFileScanned: number;
  readonly elapsedMsMax: number;
}

export interface AtomShape {
  readonly scopeId: string;
  readonly scopePath: string;
  readonly lineRange: { readonly startLine: number; readonly endLine: number } | undefined;
  readonly provenanceKind: EvidenceAtomProvenanceKind;
  readonly tool: string;
  readonly queryFingerprint: string;
  readonly edge?: EvidenceEdge | undefined;
  readonly score: number;
  readonly emittedAtMs: number;
}

export function buildAtom(shape: AtomShape): EvidenceAtom {
  const stableId = evidenceAtomStableId({
    scopeId: shape.scopeId,
    scopePath: shape.scopePath,
    lineRange: shape.lineRange,
    edge: shape.edge,
    provenanceKind: shape.provenanceKind,
    provenanceTool: shape.tool,
    queryFingerprint: shape.queryFingerprint,
  });
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId,
    scopePath: shape.scopePath,
    lineRange: shape.lineRange,
    score: shape.score,
    provenance: {
      kind: shape.provenanceKind,
      tool: shape.tool,
      queryFingerprint: shape.queryFingerprint,
    },
    edge: shape.edge,
    redactionState: "redacted",
    emittedAtMs: shape.emittedAtMs,
    ledgerRef: undefined,
  };
}

export function buildCandidate(
  scopePath: string,
  omitted: CandidateOmissionReason | undefined,
): CandidateFile {
  return { scopePath, score: 0, signals: [], omitted };
}

function collectFromDirectory(
  scope: ScopeShape,
  limits: LimitsShape,
  fs: WorkspaceFs,
  policy: SearchPolicy,
): {
  readonly files: readonly DiscoveredFile[];
  readonly directories: readonly string[];
  readonly filesDiscovered: number;
  readonly truncated: boolean;
  readonly ignored: number;
  readonly denied: number;
  readonly depthPruned: number;
  readonly maxFilesPruned: number;
} {
  const extraIgnoreLines = extraIgnoreLinesForSearch(policy);
  const workspace =
    extraIgnoreLines.length === 0
      ? scope.workspace
      : { ...scope.workspace, ignoreLines: [...scope.workspace.ignoreLines, ...extraIgnoreLines] };
  const discoveryMaxFiles = Math.max(limits.maxFilesScanned * 25, limits.maxFilesScanned + 1);
  const result = discoverWithStats(
    workspace,
    {
      maxDepth: 40,
      maxFiles: discoveryMaxFiles,
      applyGitignore: policy.applyGitignore,
    },
    fs,
  );
  const files = result.files;
  return {
    files,
    directories: result.directories,
    filesDiscovered: files.length,
    truncated: result.stats.maxFilesPruned > 0,
    ignored: result.stats.ignored,
    denied: result.stats.denied,
    depthPruned: result.stats.depthPruned,
    maxFilesPruned: result.stats.maxFilesPruned,
  };
}

export interface CandidateSet {
  readonly files: readonly DiscoveredFile[];
  readonly directories: readonly string[];
  readonly truncated: boolean;
  readonly diagnostics: SearchDiagnostics;
}

const DEFAULT_GATHER_QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "generic repository search",
  caseSensitive: false,
  maxResults: 100,
  emittedAtMs: 0,
};

const CONTENT_PRESCORE_MAX_BYTES = 65_536;
const CONTENT_PRESCORE_MAX_FILES = 5_000;
const PROJECT_METADATA_CONTENT_PRESCORE_MAX_FILES = 256;

function isRetrievalQuery(value: unknown): value is RetrievalQuery {
  return typeof value === "object" && value !== null && "kind" in value && "text" in value;
}

interface GatherInputs {
  readonly query: RetrievalQuery;
  readonly limits: LimitsShape;
  readonly fs: WorkspaceFs;
  readonly policy: SearchPolicy;
  readonly prescoreContent: boolean;
}

function shouldPrescoreContent(query: RetrievalQuery): boolean {
  return query.kind === "natural-language" || query.kind === "exact-symbol";
}

function contentPrescoreLimit(
  limits: LimitsShape,
  fileCount: number,
  policy: SearchPolicy,
): number {
  const defaultLimit = Math.min(
    fileCount,
    CONTENT_PRESCORE_MAX_FILES,
    Math.max(limits.maxFilesScanned * 25, 0),
  );
  return policy.intent === "project-metadata"
    ? Math.min(defaultLimit, PROJECT_METADATA_CONTENT_PRESCORE_MAX_FILES)
    : defaultLimit;
}

function readContentPreview(
  scope: ScopeShape,
  file: DiscoveredFile,
  fs: WorkspaceFs,
): string | undefined {
  if (file.sizeBytes > CONTENT_PRESCORE_MAX_BYTES) {
    return undefined;
  }
  try {
    return readWorkspaceFile(
      scope.workspace,
      file.relativePath,
      { maxBytes: CONTENT_PRESCORE_MAX_BYTES },
      fs,
    ).text;
  } catch {
    return undefined;
  }
}

function contentScoresForOrdering(
  scope: ScopeShape,
  files: readonly DiscoveredFile[],
  inputs: GatherInputs,
): ReadonlyMap<string, number> | undefined {
  if (!inputs.prescoreContent || !shouldPrescoreContent(inputs.query) || files.length === 0) {
    return undefined;
  }
  const scores = new Map<string, number>();
  const limit = contentPrescoreLimit(inputs.limits, files.length, inputs.policy);
  const prescoreFiles =
    inputs.policy.intent === "project-metadata" && files.length > limit
      ? orderCandidatesForSearch(files, inputs.query, inputs.policy, 0, 0).files.slice(0, limit)
      : files.slice(0, limit);
  for (const file of prescoreFiles) {
    const preview = readContentPreview(scope, file, inputs.fs);
    if (preview === undefined) {
      continue;
    }
    const score = scoreContentForSearch(inputs.query, preview, inputs.policy);
    if (score > 0) {
      scores.set(file.relativePath, score);
    }
  }
  return scores.size === 0 ? undefined : scores;
}

function resolveGatherInputs(
  scope: ScopeShape,
  queryOrLimits: RetrievalQuery | LimitsShape,
  limitsOrFs: LimitsShape | WorkspaceFs,
  fsOrPolicy?: WorkspaceFs | SearchPolicy,
  policy?: SearchPolicy,
): GatherInputs {
  if (isRetrievalQuery(queryOrLimits)) {
    return {
      query: queryOrLimits,
      limits: limitsOrFs as LimitsShape,
      fs: fsOrPolicy as WorkspaceFs,
      policy: policy ?? resolveSearchPolicy(scope.relativePaths.length > 0, undefined),
      prescoreContent: true,
    };
  }
  return {
    query: DEFAULT_GATHER_QUERY,
    limits: queryOrLimits,
    fs: limitsOrFs as WorkspaceFs,
    policy: legacyDiscoveryPolicy(scope.relativePaths.length > 0),
    prescoreContent: false,
  };
}

interface CollectedCandidates {
  readonly files: readonly DiscoveredFile[];
  readonly directories: readonly string[];
  readonly filesDiscovered: number;
  readonly truncated: boolean;
  readonly depthPruned: number;
  readonly maxFilesPruned: number;
}

export function gatherCandidates(
  scope: ScopeShape,
  limits: LimitsShape,
  fs: WorkspaceFs,
): CandidateSet;
export function gatherCandidates(
  scope: ScopeShape,
  query: RetrievalQuery,
  limits: LimitsShape,
  fs: WorkspaceFs,
  policy: SearchPolicy,
): CandidateSet;
export function gatherCandidates(
  scope: ScopeShape,
  queryOrLimits: RetrievalQuery | LimitsShape,
  limitsOrFs: LimitsShape | WorkspaceFs,
  fsOrPolicy?: WorkspaceFs | SearchPolicy,
  policy?: SearchPolicy,
): CandidateSet {
  const inputs = resolveGatherInputs(scope, queryOrLimits, limitsOrFs, fsOrPolicy, policy);
  return gatherCandidatesFromInputs(scope, inputs);
}

export function gatherCandidatesWithoutContentPrescore(
  scope: ScopeShape,
  query: RetrievalQuery,
  limits: LimitsShape,
  fs: WorkspaceFs,
  policy: SearchPolicy,
): CandidateSet {
  return gatherCandidatesFromInputs(scope, {
    query,
    limits,
    fs,
    policy,
    prescoreContent: false,
  });
}

function gatherCandidatesFromInputs(scope: ScopeShape, inputs: GatherInputs): CandidateSet {
  validateScopeEntries(scope.relativePaths);
  return scope.relativePaths.length === 0
    ? gatherDirectoryCandidates(scope, inputs)
    : gatherEntryCandidates(scope, inputs);
}

function validateScopeEntries(relativePaths: readonly string[]): void {
  for (const entry of relativePaths) {
    if (!isValidScopePath(entry, { mustBeRelative: true })) {
      throw new RepoSearchInvalidQueryError(`invalid scope.relativePaths entry: ${entry}`);
    }
  }
}

function gatherDirectoryCandidates(scope: ScopeShape, inputs: GatherInputs): CandidateSet {
  const result = collectFromDirectory(scope, inputs.limits, inputs.fs, inputs.policy);
  return orderCollectedCandidates(scope, inputs, result, result.ignored, result.denied);
}

function gatherEntryCandidates(scope: ScopeShape, inputs: GatherInputs): CandidateSet {
  const result = collectFromEntries(scope, inputs.limits, inputs.fs);
  return orderCollectedCandidates(scope, inputs, result, 0, 0);
}

function orderCollectedCandidates(
  scope: ScopeShape,
  inputs: GatherInputs,
  result: CollectedCandidates,
  ignoredByDiscovery: number,
  deniedByDiscovery: number,
): CandidateSet {
  const contentScores = contentScoresForOrdering(scope, result.files, inputs);
  const ordered = orderCandidatesForSearch(
    result.files,
    inputs.query,
    inputs.policy,
    ignoredByDiscovery,
    deniedByDiscovery,
    result.depthPruned,
    result.maxFilesPruned,
    contentScores,
  );
  return {
    files: ordered.files,
    directories: result.directories,
    truncated: result.truncated || result.depthPruned > 0 || result.maxFilesPruned > 0,
    diagnostics: {
      ...ordered.diagnostics,
      filesDiscovered: result.filesDiscovered,
    },
  };
}

export async function probeBinary(fs: WorkspaceFs, abs: string, size: number): Promise<boolean> {
  const cap = Math.min(BINARY_PROBE_BYTES, size);
  if (cap === 0) {
    return false;
  }
  if (fs.readFileBytes !== undefined) {
    return looksBinary(await fs.readFileBytes(abs, cap));
  }
  const text = fs.readFileUtf8(abs);
  return looksBinary(new TextEncoder().encode(text.slice(0, cap)));
}

export interface SearchTextRunner {
  readonly scope: ScopeShape;
  readonly limits: LimitsShape;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly startMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly matcher: LineMatcher;
  readonly fingerprint: string;
  readonly policy: SearchPolicy;
  readonly query: RetrievalQuery;
  readonly workspaceIndex?:
    | {
        readonly entries: ReadonlyMap<string, PreparedWorkspaceIndexEntry>;
        readonly onRecord: (record: WorkspaceIndexRecord) => void;
        readonly onStale: (scopePath: string) => void;
      }
    | undefined;
  readonly semantic?: SemanticSearchSession | undefined;
}

export interface RunState {
  filesScanned: number;
  matchesReturned: number;
  oversizedFilesScanned?: number | undefined;
  truncated: boolean;
  truncationReasons?: Set<ContextCoverageTruncationReason> | undefined;
}

export function elapsed(runner: SearchTextRunner): number {
  return runner.nowMs() - runner.startMs;
}

function isRunnerAborted(runner: SearchTextRunner): boolean {
  return runner.signal?.aborted === true;
}

function markTruncated(state: RunState, reason: ContextCoverageTruncationReason): void {
  state.truncated = true;
  state.truncationReasons?.add(reason);
}

export function hitLimit(runner: SearchTextRunner, state: RunState): boolean {
  if (isRunnerAborted(runner)) {
    markTruncated(state, "aborted");
    return true;
  }
  if (state.filesScanned >= runner.limits.maxFilesScanned) {
    markTruncated(state, "file-cap");
    return true;
  }
  if (state.matchesReturned >= runner.limits.maxMatchesReturned) {
    markTruncated(state, "match-cap");
    return true;
  }
  if (elapsed(runner) > runner.limits.elapsedMsMax) {
    markTruncated(state, "timeout");
    return true;
  }
  return false;
}

export function hitScanLimit(runner: SearchTextRunner, state: RunState): boolean {
  if (isRunnerAborted(runner)) {
    markTruncated(state, "aborted");
    return true;
  }
  if (state.filesScanned >= runner.limits.maxFilesScanned) {
    markTruncated(state, "file-cap");
    return true;
  }
  if (elapsed(runner) > runner.limits.elapsedMsMax) {
    markTruncated(state, "timeout");
    return true;
  }
  return false;
}

function hitEmissionLimit(runner: SearchTextRunner, state: RunState): boolean {
  if (isRunnerAborted(runner)) {
    markTruncated(state, "aborted");
    return true;
  }
  if (state.matchesReturned >= runner.limits.maxMatchesReturned) {
    markTruncated(state, "match-cap");
    return true;
  }
  if (elapsed(runner) > runner.limits.elapsedMsMax) {
    markTruncated(state, "timeout");
    return true;
  }
  return false;
}

// Returns true for NodeJS.ErrnoException (EACCES, ENOENT, EIO, …). Checked by the presence of a
// string `code` property so TypeError and other programmer errors are NOT swallowed.
export function isIoError(err: unknown): boolean {
  if (err === null || typeof err !== "object" || !("code" in err)) {
    return false;
  }
  const { code } = err as Record<"code", unknown>;
  return typeof code === "string";
}

function currentRecordMetadata(
  runner: SearchTextRunner,
  scopePath: string,
  absolutePath: string,
  fallbackSizeBytes: number,
): WorkspaceIndexDiscoveredFile {
  const stat = safeStat(runner, absolutePath);
  return {
    scopePath,
    sizeBytes: stat?.size ?? fallbackSizeBytes,
    ...(stat?.mtimeMs !== undefined ? { mtimeMs: stat.mtimeMs } : {}),
  };
}

function hashTerm(term: string): string {
  return createHash("sha256").update(term).digest("hex");
}

function queryLexicalTerms(query: RetrievalQuery): readonly string[] {
  if (query.kind === "regex" || query.kind === "file-pattern") {
    return [];
  }
  if (query.kind === "exact-symbol") {
    return expandedQueryTerms(query.text, query.caseSensitive);
  }
  return naturalLanguageContentTerms(query.text, query.caseSensitive);
}

function queryLexicalTermHashes(query: RetrievalQuery): readonly string[] {
  return [...new Set(queryLexicalTerms(query).map((term) => hashTerm(term)))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

function lexicalMatchesQuery(
  record: WorkspaceIndexLexicalRecord,
  queryTermHashes: ReadonlySet<string>,
): boolean {
  if (record.truncated || queryTermHashes.size === 0) {
    return false;
  }
  return record.termHashes.some((termHash) => queryTermHashes.has(termHash));
}

function bestCachedLines(
  record: WorkspaceIndexLexicalRecord,
  queryTermHashes: ReadonlySet<string>,
): readonly ScoredLine[] {
  const best: ScoredLine[] = [];
  for (const line of record.lines) {
    let score = 0;
    for (const termHash of line.termHashes) {
      if (queryTermHashes.has(termHash)) {
        score += 1;
      }
    }
    if (score === 0) {
      continue;
    }
    best.push({
      line: line.startLine,
      startLine: line.startLine,
      endLine: line.endLine,
      score,
    });
  }
  return best
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.startLine - b.startLine))
    .slice(0, 3)
    .sort((a, b) =>
      a.startLine === b.startLine ? a.endLine - b.endLine : a.startLine - b.startLine,
    );
}

function safeStat(
  runner: SearchTextRunner,
  absolutePath: string,
): ReturnType<WorkspaceFs["stat"]> | undefined {
  try {
    return runner.fs.stat(absolutePath);
  } catch {
    return undefined;
  }
}

function cachedRecordMetadata(
  runner: SearchTextRunner,
  entry: PreparedWorkspaceIndexEntry,
  relativePath: string,
): WorkspaceIndexDiscoveredFile | undefined {
  const stat = safeStat(runner, entry.absolutePath);
  if (stat?.isFile !== true) {
    return undefined;
  }
  return {
    scopePath: relativePath,
    sizeBytes: stat.size,
    ...(stat.mtimeMs !== undefined ? { mtimeMs: stat.mtimeMs } : {}),
  };
}

function cachedRecord(
  runner: SearchTextRunner,
  relativePath: string,
): WorkspaceIndexRecord | undefined {
  const entry = runner.workspaceIndex?.entries.get(relativePath);
  if (entry?.stale !== false || entry.record === undefined) {
    return undefined;
  }
  const metadata = cachedRecordMetadata(runner, entry, relativePath);
  if (metadata === undefined) {
    runner.workspaceIndex?.onStale(relativePath);
    return undefined;
  }
  if (!isWorkspaceIndexRecordCurrent(entry.record, metadata)) {
    runner.workspaceIndex?.onStale(relativePath);
    return undefined;
  }
  return entry.record;
}

function recordCandidateOmission(
  candidates: CandidateFile[],
  relativePath: string,
  omitted: CandidateOmissionReason,
): void {
  candidates.push(buildCandidate(relativePath, omitted));
}

function persistWorkspaceIndexRecord(
  runner: SearchTextRunner,
  record:
    | {
        readonly kind: "binary" | "size-exceeded";
        readonly scopePath: string;
        readonly absolutePath: string;
        readonly sizeBytes: number;
      }
    | {
        readonly kind: "text";
        readonly scopePath: string;
        readonly absolutePath: string;
        readonly sizeBytes: number;
        readonly content: string;
      },
): void {
  const metadata = currentRecordMetadata(
    runner,
    record.scopePath,
    record.absolutePath,
    record.sizeBytes,
  );
  if (record.kind === "text") {
    runner.workspaceIndex?.onRecord({
      ...metadata,
      kind: "text",
      fingerprint: workspaceIndexContentFingerprint(record.content),
      lexical: buildWorkspaceIndexLexicalRecord(record.content),
    });
    return;
  }
  runner.workspaceIndex?.onRecord({ ...metadata, kind: record.kind });
}

function recordSizeExceeded(
  runner: SearchTextRunner,
  relativePath: string,
  absolutePath: string | undefined,
  sizeBytes: number,
  candidates: CandidateFile[],
): undefined {
  if (absolutePath !== undefined) {
    persistWorkspaceIndexRecord(runner, {
      kind: "size-exceeded",
      scopePath: relativePath,
      absolutePath,
      sizeBytes,
    });
  }
  recordCandidateOmission(candidates, relativePath, "size-exceeded");
  return undefined;
}

async function readTextPrefixForScan(
  runner: SearchTextRunner,
  absolutePath: string,
): Promise<string | undefined> {
  const readFileBytes = runner.fs.readFileBytes;
  if (readFileBytes === undefined) {
    return undefined;
  }
  const bytes = await readFileBytes(absolutePath, runner.limits.maxBytesPerFileScanned);
  const decoded = decodeTextBytes(bytes, undefined, { allowIncompleteTail: true });
  return decoded === undefined ? undefined : redact(decoded.text);
}

async function readRawTextForScan(
  runner: SearchTextRunner,
  relativePath: string,
  absolutePath: string,
  sizeBytes: number,
  state: RunState,
  candidates: CandidateFile[],
): Promise<string | undefined> {
  if (sizeBytes > runner.limits.maxBytesPerFileScanned) {
    return await readOversizedRawText(
      runner,
      relativePath,
      absolutePath,
      sizeBytes,
      state,
      candidates,
    );
  }
  try {
    return await readBoundedRawText(runner, relativePath, absolutePath, sizeBytes, candidates);
  } catch (err) {
    if (isIoError(err)) {
      recordCandidateOmission(candidates, relativePath, "tool-unavailable");
      return undefined;
    }
    throw err;
  }
}

async function readOversizedRawText(
  runner: SearchTextRunner,
  relativePath: string,
  absolutePath: string,
  sizeBytes: number,
  state: RunState,
  candidates: CandidateFile[],
): Promise<string | undefined> {
  markTruncated(state, "file-cap");
  try {
    const prefix = await readTextPrefixForScan(runner, absolutePath);
    if (prefix !== undefined) {
      state.oversizedFilesScanned = (state.oversizedFilesScanned ?? 0) + 1;
      return prefix;
    }
  } catch (err) {
    if (!isIoError(err)) {
      throw err;
    }
  }
  recordSizeExceeded(runner, relativePath, absolutePath, sizeBytes, candidates);
  return undefined;
}

async function readBoundedRawText(
  runner: SearchTextRunner,
  relativePath: string,
  absolutePath: string,
  sizeBytes: number,
  candidates: CandidateFile[],
): Promise<string | undefined> {
  const bytes = await runner.fs.readFileBytes?.(absolutePath, sizeBytes);
  const decoded = bytes === undefined ? undefined : decodeTextBytes(bytes);
  if (decoded === undefined) {
    recordCandidateOmission(candidates, relativePath, "binary");
    return undefined;
  }
  const text = redact(decoded.text);
  persistWorkspaceIndexRecord(runner, {
    kind: "text",
    scopePath: relativePath,
    absolutePath,
    sizeBytes,
    content: text,
  });
  return text;
}

async function readUtf8TextForScan(
  runner: SearchTextRunner,
  relativePath: string,
  absolutePath: string,
  sizeBytes: number,
  state: RunState,
  candidates: CandidateFile[],
): Promise<string | undefined> {
  try {
    const text = readWorkspaceFile(
      runner.scope.workspace,
      relativePath,
      { maxBytes: runner.limits.maxBytesPerFileScanned },
      runner.fs,
    ).text;
    persistWorkspaceIndexRecord(runner, {
      kind: "text",
      scopePath: relativePath,
      absolutePath,
      sizeBytes,
      content: text,
    });
    return text;
  } catch (err) {
    if (err instanceof FileTooLargeError) {
      return await readOversizedUtf8Text(
        runner,
        relativePath,
        absolutePath,
        sizeBytes,
        state,
        candidates,
      );
    }
    // TOCTOU: permissions or availability may change between discovery and read.
    // A single unreadable file must degrade to a skip, not crash the whole scan.
    if (isIoError(err)) {
      recordCandidateOmission(candidates, relativePath, "tool-unavailable");
      return undefined;
    }
    throw err;
  }
}

async function readOversizedUtf8Text(
  runner: SearchTextRunner,
  relativePath: string,
  absolutePath: string,
  sizeBytes: number,
  state: RunState,
  candidates: CandidateFile[],
): Promise<string | undefined> {
  return await readOversizedRawText(
    runner,
    relativePath,
    absolutePath,
    sizeBytes,
    state,
    candidates,
  );
}

async function readForScan(
  runner: SearchTextRunner,
  relativePath: string,
  absolutePath: string,
  sizeBytes: number,
  state: RunState,
  candidates: CandidateFile[],
): Promise<string | undefined> {
  if (runner.fs.readFileBytes !== undefined) {
    return await readRawTextForScan(
      runner,
      relativePath,
      absolutePath,
      sizeBytes,
      state,
      candidates,
    );
  }
  return await readUtf8TextForScan(
    runner,
    relativePath,
    absolutePath,
    sizeBytes,
    state,
    candidates,
  );
}

function emitBestLines(
  runner: SearchTextRunner,
  relativePath: string,
  state: RunState,
  atoms: EvidenceAtom[],
  best: readonly ScoredLine[],
): void {
  for (const match of best) {
    if (hitEmissionLimit(runner, state)) {
      return;
    }
    atoms.push(
      buildAtom({
        scopeId: runner.scope.scopeId,
        scopePath: relativePath,
        lineRange: { startLine: match.startLine, endLine: match.endLine },
        provenanceKind: "lexical-search",
        tool: "repo.searchText",
        queryFingerprint: runner.fingerprint,
        score: match.score,
        emittedAtMs: runner.nowMs(),
      }),
    );
    state.matchesReturned += 1;
  }
}

export interface FileMatches {
  readonly relativePath: string;
  readonly order: number;
  readonly best: readonly ScoredLine[];
  readonly maxScore: number;
}

function maxLineScore(best: readonly ScoredLine[]): number {
  return best.reduce((max, line) => Math.max(max, line.score), 0);
}

function scanLines(runner: SearchTextRunner, text: string, state: RunState): readonly ScoredLine[] {
  return collectBestLines(runner, text, state);
}

function abortScanFile(runner: SearchTextRunner, state: RunState): boolean {
  if (!isRunnerAborted(runner)) {
    return false;
  }
  markTruncated(state, "aborted");
  return true;
}

function filePathPolicyOmission(
  runner: SearchTextRunner,
  file: DiscoveredFile,
): CandidateOmissionReason | undefined {
  if (isImageScopePath(file.relativePath)) {
    return "binary";
  }
  if (isDenied(file.relativePath)) {
    return "ignored";
  }
  return policyOmissionReason(file.relativePath, runner.policy);
}

function filePolicyOmission(
  runner: SearchTextRunner,
  file: DiscoveredFile,
): { readonly omitted?: CandidateOmissionReason | undefined; readonly path?: string | undefined } {
  const pathOmission = filePathPolicyOmission(runner, file);
  if (pathOmission !== undefined) {
    return { omitted: pathOmission };
  }
  const abs = resolveWithinWorkspace(runner.scope.workspace.root, file.relativePath);
  const contained = containedRealPathInfo(runner.fs, runner.scope.workspace.root, abs);
  const realRel = normalizeScopePath(contained.realRelative);
  if (isDenied(realRel)) {
    return { omitted: "ignored" };
  }
  try {
    const stat = runner.fs.stat(contained.path);
    if (stat.hardLinkCount !== undefined && stat.hardLinkCount > 1) {
      return { omitted: "ignored" };
    }
  } catch (err) {
    if (isIoError(err)) {
      return { omitted: "tool-unavailable" };
    }
    throw err;
  }
  return { omitted: policyOmissionReason(file.relativePath, runner.policy), path: contained.path };
}

async function binaryOmission(
  runner: SearchTextRunner,
  file: DiscoveredFile,
  path: string,
): Promise<CandidateOmissionReason | undefined> {
  try {
    return (await probeBinary(runner.fs, path, file.sizeBytes)) ? "binary" : undefined;
  } catch (err) {
    // TOCTOU: file may have become unreadable (EACCES, ENOENT, …) between discovery and probe.
    if (isIoError(err)) {
      return "tool-unavailable";
    }
    throw err;
  }
}

function cachedLexicalRecord(
  runner: SearchTextRunner,
  cached: WorkspaceIndexRecord,
):
  | {
      readonly lexical: WorkspaceIndexLexicalRecord;
      readonly queryTermHashes: ReadonlySet<string>;
    }
  | undefined {
  if (
    runner.query.kind === "regex" ||
    runner.query.kind === "file-pattern" ||
    runner.query.caseSensitive
  ) {
    return undefined;
  }
  const lexical = cached.lexical;
  if (lexical === undefined || lexical.truncated) {
    return undefined;
  }
  const queryTermHashes = new Set(queryLexicalTermHashes(runner.query));
  return queryTermHashes.size === 0 ? undefined : { lexical, queryTermHashes };
}

function cachedFileMatches(
  runner: SearchTextRunner,
  file: DiscoveredFile,
  state: RunState,
  candidates: CandidateFile[],
  order: number,
): FileMatches | "handled" | undefined {
  const cached = cachedRecord(runner, file.relativePath);
  if (cached === undefined) {
    return undefined;
  }
  if (cached.kind === "binary" || cached.kind === "size-exceeded") {
    recordCandidateOmission(candidates, file.relativePath, cached.kind);
    return "handled";
  }
  if (runner.semantic !== undefined) {
    return undefined;
  }
  if (abortScanFile(runner, state)) {
    return "handled";
  }
  const lexical = cachedLexicalRecord(runner, cached);
  if (lexical === undefined) {
    return undefined;
  }
  state.filesScanned += 1;
  if (!lexicalMatchesQuery(lexical.lexical, lexical.queryTermHashes)) {
    return "handled";
  }
  const best = bestCachedLines(lexical.lexical, lexical.queryTermHashes);
  return { relativePath: file.relativePath, order, best, maxScore: maxLineScore(best) };
}

export async function scanFile(
  runner: SearchTextRunner,
  file: DiscoveredFile,
  state: RunState,
  atoms: EvidenceAtom[],
  candidates: CandidateFile[],
): Promise<void> {
  const matches = await collectFileMatches(runner, file, state, candidates, 0);
  if (matches !== undefined) {
    emitFileMatches(runner, state, atoms, matches);
  }
}

export async function collectFileMatches(
  runner: SearchTextRunner,
  file: DiscoveredFile,
  state: RunState,
  candidates: CandidateFile[],
  order: number,
): Promise<FileMatches | undefined> {
  if (abortScanFile(runner, state)) {
    return undefined;
  }
  const pathOmission = filePathPolicyOmission(runner, file);
  if (pathOmission !== undefined) {
    recordCandidateOmission(candidates, file.relativePath, pathOmission);
    return undefined;
  }
  const cached = cachedFileMatches(runner, file, state, candidates, order);
  if (cached === "handled") {
    return undefined;
  }
  if (cached !== undefined) {
    return cached;
  }
  return await collectLiveFileMatches(runner, file, state, candidates, order);
}

async function collectLiveFileMatches(
  runner: SearchTextRunner,
  file: DiscoveredFile,
  state: RunState,
  candidates: CandidateFile[],
  order: number,
): Promise<FileMatches | undefined> {
  const policyPath = await readablePolicyPath(runner, file, candidates);
  if (policyPath === undefined || abortScanFile(runner, state)) {
    return undefined;
  }
  state.filesScanned += 1;
  const text = await readForScan(
    runner,
    file.relativePath,
    policyPath,
    file.sizeBytes,
    state,
    candidates,
  );
  return text === undefined ? undefined : textFileMatches(runner, file, state, order, text);
}

async function readablePolicyPath(
  runner: SearchTextRunner,
  file: DiscoveredFile,
  candidates: CandidateFile[],
): Promise<string | undefined> {
  const policy = filePolicyOmission(runner, file);
  if (policy.omitted !== undefined) {
    recordCandidateOmission(candidates, file.relativePath, policy.omitted);
    return undefined;
  }
  const binary =
    policy.path === undefined ? "binary" : await binaryOmission(runner, file, policy.path);
  if (binary !== undefined) {
    if (binary === "binary" && policy.path !== undefined) {
      persistWorkspaceIndexRecord(runner, {
        kind: "binary",
        scopePath: file.relativePath,
        absolutePath: policy.path,
        sizeBytes: file.sizeBytes,
      });
    }
    recordCandidateOmission(candidates, file.relativePath, binary);
    return undefined;
  }
  return policy.path;
}

function textFileMatches(
  runner: SearchTextRunner,
  file: DiscoveredFile,
  state: RunState,
  order: number,
  text: string,
): FileMatches | undefined {
  collectSemanticSearchDocument(runner.semantic, { scopePath: file.relativePath, text });
  if (!shouldScoreContent(runner.query, text, runner.policy)) {
    return undefined;
  }
  const best = scanLines(runner, text, state);
  if (best.length === 0) {
    return undefined;
  }
  return { relativePath: file.relativePath, order, best, maxScore: maxLineScore(best) };
}

export function emitFileMatches(
  runner: SearchTextRunner,
  state: RunState,
  atoms: EvidenceAtom[],
  matches: FileMatches,
): void {
  emitBestLines(runner, matches.relativePath, state, atoms, matches.best);
}
