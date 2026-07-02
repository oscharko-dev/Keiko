// Candidate gathering and the per-file scan loop for the repo-search facade (Issue #179).
// Kept separate from the public API surface so repoSearch.ts stays inside the 400-LOC cap.
// Every file system touch goes through the injected WorkspaceFs port; nothing here calls
// node:fs directly.

import type {
  CandidateFile,
  CandidateOmissionReason,
  ContextCoverageTruncationReason,
  EvidenceAtom,
  EvidenceAtomProvenanceKind,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  isValidScopePath,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { discoverWithStats, readWorkspaceFile } from "./discovery.js";
import { FileTooLargeError, RepoSearchInvalidQueryError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo } from "./realpath.js";
import { looksBinary } from "./binaryDetect.js";
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

const BINARY_PROBE_BYTES = 512;
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
  readonly score: number;
  readonly emittedAtMs: number;
}

export function buildAtom(shape: AtomShape): EvidenceAtom {
  const stableId = evidenceAtomStableId({
    scopeId: shape.scopeId,
    scopePath: shape.scopePath,
    lineRange: shape.lineRange,
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
} {
  const extraIgnoreLines = extraIgnoreLinesForSearch(policy);
  const workspace =
    extraIgnoreLines.length === 0
      ? scope.workspace
      : { ...scope.workspace, ignoreLines: [...scope.workspace.ignoreLines, ...extraIgnoreLines] };
  const result = discoverWithStats(
    workspace,
    {
      maxDepth: 12,
      maxFiles: limits.maxFilesScanned + 1,
      applyGitignore: policy.applyGitignore,
    },
    fs,
  );
  const files = result.files;
  return {
    files: files.slice(0, limits.maxFilesScanned),
    directories: result.directories,
    filesDiscovered: files.length,
    truncated: files.length > limits.maxFilesScanned || result.stats.depthPruned > 0,
    ignored: result.stats.ignored,
    denied: result.stats.denied,
    depthPruned: result.stats.depthPruned,
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

function isRetrievalQuery(value: unknown): value is RetrievalQuery {
  return typeof value === "object" && value !== null && "kind" in value && "text" in value;
}

interface GatherInputs {
  readonly query: RetrievalQuery;
  readonly limits: LimitsShape;
  readonly fs: WorkspaceFs;
  readonly policy: SearchPolicy;
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
    };
  }
  return {
    query: DEFAULT_GATHER_QUERY,
    limits: queryOrLimits,
    fs: limitsOrFs as WorkspaceFs,
    policy: legacyDiscoveryPolicy(scope.relativePaths.length > 0),
  };
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
  // Defense in depth alongside the realpath gate: validate scope.relativePaths against the
  // contracts-layer shape rules (no absolute paths, no `..`, no drive letters, no backslashes).
  // resolveWithinWorkspace + assertContainedRealPath already provide a complete barrier; this
  // pre-check rejects shape-invalid inputs at the API boundary with a typed error rather than
  // letting a normalization quirk slip past unnoticed.
  for (const entry of scope.relativePaths) {
    if (!isValidScopePath(entry, { mustBeRelative: true })) {
      throw new RepoSearchInvalidQueryError(`invalid scope.relativePaths entry: ${entry}`);
    }
  }
  if (scope.relativePaths.length === 0) {
    const result = collectFromDirectory(scope, inputs.limits, inputs.fs, inputs.policy);
    const ordered = orderCandidatesForSearch(
      result.files,
      inputs.query,
      inputs.policy,
      result.ignored,
      result.denied,
      result.depthPruned,
    );
    return {
      files: ordered.files,
      directories: result.directories,
      truncated: result.truncated,
      diagnostics: {
        ...ordered.diagnostics,
        filesDiscovered: result.filesDiscovered,
        filesAfterPolicy: result.filesDiscovered,
      },
    };
  }
  const result = collectFromEntries(scope, inputs.limits, inputs.fs);
  const ordered = orderCandidatesForSearch(result.files, inputs.query, inputs.policy, 0, 0);
  return {
    files: ordered.files,
    directories: result.directories,
    truncated: result.truncated,
    diagnostics: {
      ...ordered.diagnostics,
      filesDiscovered: result.filesDiscovered,
      filesAfterPolicy: result.filesDiscovered,
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

function readForScan(
  runner: SearchTextRunner,
  relativePath: string,
  absolutePath: string | undefined,
  sizeBytes: number,
  candidates: CandidateFile[],
): string | undefined {
  try {
    const text = readWorkspaceFile(
      runner.scope.workspace,
      relativePath,
      { maxBytes: runner.limits.maxBytesPerFileScanned },
      runner.fs,
    ).text;
    if (absolutePath !== undefined) {
      persistWorkspaceIndexRecord(runner, {
        kind: "text",
        scopePath: relativePath,
        absolutePath,
        sizeBytes,
        content: text,
      });
    }
    return text;
  } catch (err) {
    if (err instanceof FileTooLargeError) {
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
    // TOCTOU: permissions or availability may change between discovery and read.
    // A single unreadable file must degrade to a skip, not crash the whole scan.
    if (isIoError(err)) {
      recordCandidateOmission(candidates, relativePath, "tool-unavailable");
      return undefined;
    }
    throw err;
  }
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

function scanLines(
  runner: SearchTextRunner,
  relativePath: string,
  text: string,
  state: RunState,
  atoms: EvidenceAtom[],
): void {
  emitBestLines(runner, relativePath, state, atoms, collectBestLines(runner, text, state));
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

function handleCachedRecord(
  runner: SearchTextRunner,
  file: DiscoveredFile,
  state: RunState,
  atoms: EvidenceAtom[],
  candidates: CandidateFile[],
): boolean {
  const cached = cachedRecord(runner, file.relativePath);
  if (cached === undefined) {
    return false;
  }
  if (cached.kind === "binary" || cached.kind === "size-exceeded") {
    recordCandidateOmission(candidates, file.relativePath, cached.kind);
    return true;
  }
  if (runner.semantic !== undefined) {
    return false;
  }
  if (abortScanFile(runner, state)) {
    return true;
  }
  const lexical = cachedLexicalRecord(runner, cached);
  if (lexical === undefined) {
    return false;
  }
  state.filesScanned += 1;
  if (!lexicalMatchesQuery(lexical.lexical, lexical.queryTermHashes)) {
    return true;
  }
  emitBestLines(
    runner,
    file.relativePath,
    state,
    atoms,
    bestCachedLines(lexical.lexical, lexical.queryTermHashes),
  );
  return true;
}

async function handleLiveRecord(
  runner: SearchTextRunner,
  file: DiscoveredFile,
  state: RunState,
  atoms: EvidenceAtom[],
  candidates: CandidateFile[],
  absolutePath: string | undefined,
): Promise<void> {
  const binary =
    absolutePath === undefined ? "binary" : await binaryOmission(runner, file, absolutePath);
  if (binary !== undefined) {
    if (binary === "binary" && absolutePath !== undefined) {
      persistWorkspaceIndexRecord(runner, {
        kind: "binary",
        scopePath: file.relativePath,
        absolutePath,
        sizeBytes: file.sizeBytes,
      });
    }
    recordCandidateOmission(candidates, file.relativePath, binary);
    return;
  }
  if (abortScanFile(runner, state)) {
    return;
  }
  state.filesScanned += 1;
  const text = readForScan(runner, file.relativePath, absolutePath, file.sizeBytes, candidates);
  if (text === undefined) {
    return;
  }
  collectSemanticSearchDocument(runner.semantic, { scopePath: file.relativePath, text });
  if (!shouldScoreContent(runner.query, text, runner.policy)) {
    return;
  }
  scanLines(runner, file.relativePath, text, state, atoms);
}

export async function scanFile(
  runner: SearchTextRunner,
  file: DiscoveredFile,
  state: RunState,
  atoms: EvidenceAtom[],
  candidates: CandidateFile[],
): Promise<void> {
  if (abortScanFile(runner, state)) {
    return;
  }
  const pathOmission = filePathPolicyOmission(runner, file);
  if (pathOmission !== undefined) {
    recordCandidateOmission(candidates, file.relativePath, pathOmission);
    return;
  }
  if (handleCachedRecord(runner, file, state, atoms, candidates)) {
    return;
  }
  const policy = filePolicyOmission(runner, file);
  if (policy.omitted !== undefined) {
    recordCandidateOmission(candidates, file.relativePath, policy.omitted);
    return;
  }
  await handleLiveRecord(runner, file, state, atoms, candidates, policy.path);
}
