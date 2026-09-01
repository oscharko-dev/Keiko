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
import { CONNECTED_CONTEXT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/connected-context";
import { redact } from "@oscharko-dev/keiko-security";
import {
  discoverCandidateInventory,
  readWorkspaceFileBytesPrefixForInternalUse,
  readWorkspaceFileTextForInternalUse,
  type WorkspaceContentLane,
} from "./discovery.js";
import { FileTooLargeError, PathDeniedError, PathEscapeError, WORKSPACE_CODES } from "./errors.js";
import {
  isWorkspacePathSnapshotCurrent,
  WorkspaceDescriptorReadError,
  type WorkspaceFs,
} from "./fs.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import {
  containedRealPathInfo,
  isCanonicalAllowedContainedPath,
  realRootIsDeniedViaSymlink,
} from "./realpath.js";
import { DEFAULT_BINARY_PROBE, decodeTextBytes, looksBinary } from "./binaryDetect.js";
import { collectFromEntries, validateSearchScopeRelativePaths } from "./repoSearchEntries.js";
import {
  bestCachedLexicalLines,
  cachedExactSymbolDefinitionMatches,
  cachedLexicalRecordDefinitelyDoesNotMatch,
  cachedLexicalRecordMatches,
  cachedLexicalRecordRequiresLiveMatch,
  prepareCachedLexicalQuery,
  type CachedLexicalQuery,
} from "./repoSearchCachedLexical.js";
import { collectBestLines, type ScoredLine } from "./repoSearchLineSelection.js";
import { evidenceAtomStableId } from "./stableId.js";
import { structuralLineLooksLikeSymbolDefinition, type LineMatcher } from "./repoSearchMatchers.js";
import {
  structuralExecutionStopped,
  type StructuralExecutionControl,
} from "./structuralExecution.js";
import { collectSemanticSearchDocument, type SemanticSearchSession } from "./repoSearchSemantic.js";
import { repositorySourceLines } from "./repoSearchSourceClassification.js";
import {
  extraIgnoreLinesForSearch,
  legacyDiscoveryPolicy,
  orderCandidatesForSearch,
  policyOmissionReason,
  resolveSearchPolicy,
  routeQueryTermsForSearch,
  scoreContentForSearch,
  shouldScoreContent,
  type SearchDiagnostics,
  type SearchPolicy,
} from "./repoSearchPolicy.js";
import type { DiscoveredFile, WorkspaceInfo } from "./types.js";
import type { WorkspaceDirectorySnapshot } from "./workspaceDirectorySnapshot.js";
import type {
  PreparedWorkspaceIndexEntry,
  WorkspaceIndexDiscoveredFile,
  WorkspaceIndexRecord,
} from "./workspaceIndex.js";
import {
  buildWorkspaceIndexLexicalRecord,
  isWorkspaceIndexRecordCurrent,
  workspaceIndexContentFingerprint,
  workspaceIndexFileMetadata,
} from "./workspaceIndex.js";

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
  executionControl?: StructuralExecutionControl,
): {
  readonly files: readonly DiscoveredFile[];
  readonly directories: readonly string[];
  readonly directorySnapshots?: readonly WorkspaceDirectorySnapshot[] | undefined;
  readonly skippedSymbolicLinks: readonly string[];
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
  const discoveryMaxFiles = candidateDiscoveryFileLimit(limits);
  const result = discoverCandidateInventory(
    workspace,
    {
      maxDepth: 40,
      maxFiles: discoveryMaxFiles,
      applyGitignore: policy.applyGitignore,
    },
    fs,
    executionControl,
  );
  const files = result.files;
  return {
    files,
    directories: result.directories,
    directorySnapshots: result.directorySnapshots,
    skippedSymbolicLinks: result.skippedSymbolicLinks,
    filesDiscovered: files.length,
    truncated: result.stats.maxFilesPruned > 0,
    ignored: result.stats.ignored,
    denied: result.stats.denied,
    depthPruned: result.stats.depthPruned,
    maxFilesPruned: result.stats.maxFilesPruned,
  };
}

export function candidateDiscoveryFileLimit(limits: LimitsShape): number {
  return Math.max(limits.maxFilesScanned * 25, limits.maxFilesScanned + 1);
}

export function candidateInventoryFileLimit(
  scope: ScopeShape,
  query: RetrievalQuery,
  limits: LimitsShape,
): number {
  return scope.relativePaths.length === 0 ||
    query.kind === "natural-language" ||
    query.kind === "exact-symbol"
    ? candidateDiscoveryFileLimit(limits)
    : limits.maxFilesScanned;
}

export interface CandidateSet {
  readonly files: readonly DiscoveredFile[];
  readonly directories: readonly string[];
  readonly directorySnapshots?: readonly WorkspaceDirectorySnapshot[] | undefined;
  readonly skippedSymbolicLinks: readonly string[];
  readonly truncated: boolean;
  readonly diagnostics: SearchDiagnostics;
}

/**
 * Structural products parse a candidate at most once, so their filesystem work must obey the
 * caller's file-scan ceiling directly. Repository search deliberately discovers a larger pool for
 * query ranking; structural builders must never mistake that ranking pool for their scan budget.
 */
export function limitCandidateSetForStructuralBuild(
  candidateSet: CandidateSet,
  limits: LimitsShape,
  isEligible: (file: DiscoveredFile) => boolean,
): CandidateSet {
  const fileLimit = Math.max(0, limits.maxFilesScanned);
  const eligibleFiles = candidateSet.files.filter(isEligible);
  if (eligibleFiles.length <= fileLimit) {
    return { ...candidateSet, files: eligibleFiles };
  }
  return {
    ...candidateSet,
    files: eligibleFiles.slice(0, fileLimit),
    truncated: true,
  };
}

/**
 * Reorders one request-local inventory for a concrete query without rediscovering the workspace.
 * The caller must key the inventory by the exact discovery policy and maxFilesScanned ceiling;
 * only query-dependent ranking is recomputed here.
 */
export function deriveCandidateSetFromInventory(
  scope: ScopeShape,
  query: RetrievalQuery,
  limits: LimitsShape,
  fs: WorkspaceFs,
  policy: SearchPolicy,
  inventory: CandidateSet,
  candidatePathPredicate?: (scopePath: string) => boolean,
  contentPreviewFor?: CandidateContentPreviewProvider,
  executionControl?: StructuralExecutionControl,
  prescoreContent = shouldPrescoreContent(query),
): CandidateSet {
  return orderCollectedCandidates(
    scope,
    {
      query,
      limits,
      fs,
      policy,
      prescoreContent,
      ...(candidatePathPredicate === undefined ? {} : { candidatePathPredicate }),
      ...(contentPreviewFor === undefined ? {} : { contentPreviewFor }),
      ...(executionControl === undefined ? {} : { executionControl }),
    },
    {
      files: inventory.files,
      directories: inventory.directories,
      ...(inventory.directorySnapshots === undefined
        ? {}
        : { directorySnapshots: inventory.directorySnapshots }),
      skippedSymbolicLinks: inventory.skippedSymbolicLinks,
      filesDiscovered: inventory.diagnostics.filesDiscovered,
      truncated: inventory.truncated,
      depthPruned: inventory.diagnostics.depthPrunedByDiscovery,
      maxFilesPruned: inventory.diagnostics.maxFilesPrunedByDiscovery,
    },
    inventory.diagnostics.ignoredByDiscovery,
    inventory.diagnostics.deniedByDiscovery,
  );
}

const DEFAULT_GATHER_QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "generic repository search",
  caseSensitive: false,
  maxResults: 100,
  emittedAtMs: 0,
};

export const CONTENT_PRESCORE_MAX_BYTES = 65_536;
// Keep synchronous preview IO bounded well below the scan timer. Path-first selection still lets
// route/symbol-shaped files into this set; reading thousands of previews could consume the entire
// elapsed budget before the first candidate was actually scanned on large repositories.
const CONTENT_PRESCORE_MAX_FILES = 512;
const PROJECT_METADATA_CONTENT_PRESCORE_MAX_FILES = 256;
const ROUTE_PRESCORE_MAX_FILES = 64;
const ROUTE_REGISTRATION_PATH_RE =
  /(?:^|[/_.-])(?:api|controllers?|endpoints?|http|routers?|routes?|routing)(?:[/_.-]|$)/iu;

function isRetrievalQuery(value: unknown): value is RetrievalQuery {
  return typeof value === "object" && value !== null && "kind" in value && "text" in value;
}

interface GatherInputs {
  readonly query: RetrievalQuery;
  readonly limits: LimitsShape;
  readonly fs: WorkspaceFs;
  readonly policy: SearchPolicy;
  readonly prescoreContent: boolean;
  readonly candidatePathPredicate?: ((scopePath: string) => boolean) | undefined;
  readonly contentPreviewFor?: CandidateContentPreviewProvider | undefined;
  readonly executionControl?: StructuralExecutionControl | undefined;
}

export type CandidateContentPreviewProvider = (file: DiscoveredFile) => string | undefined;

function candidateGatheringStopped(inputs: GatherInputs): boolean {
  return (
    inputs.executionControl !== undefined && structuralExecutionStopped(inputs.executionControl)
  );
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

export function selectContentPrescoreFiles(
  files: readonly DiscoveredFile[],
  query: RetrievalQuery,
  policy: SearchPolicy,
  limit: number,
): readonly DiscoveredFile[] {
  if (files.length <= limit) return files;
  const ordered = orderCandidatesForSearch({
    files,
    query,
    policy,
    ignoredByDiscovery: 0,
    deniedByDiscovery: 0,
  }).files;
  if (routeQueryTermsForSearch(query) === undefined || limit <= 0) {
    return ordered.slice(0, limit);
  }
  const reservedLimit = Math.min(ROUTE_PRESCORE_MAX_FILES, Math.max(1, Math.floor(limit / 8)));
  const routeCandidates = ordered
    .filter((file) => ROUTE_REGISTRATION_PATH_RE.test(file.relativePath))
    .slice(0, reservedLimit);
  const reservedPaths = new Set(routeCandidates.map((file) => file.relativePath));
  return [
    ...routeCandidates,
    ...ordered.filter((file) => !reservedPaths.has(file.relativePath)),
  ].slice(0, limit);
}

export interface CandidateContentPreviewRead {
  readonly content: string | undefined;
  readonly metadata: WorkspaceIndexDiscoveredFile | undefined;
}

export function readCandidateContentPreviewWithMetadata(
  scope: ScopeShape,
  file: DiscoveredFile,
  fs: WorkspaceFs,
): CandidateContentPreviewRead {
  if (file.sizeBytes > CONTENT_PRESCORE_MAX_BYTES) {
    return { content: undefined, metadata: undefined };
  }
  try {
    const read = readWorkspaceFileTextForInternalUse(
      scope.workspace,
      file.relativePath,
      { maxBytes: CONTENT_PRESCORE_MAX_BYTES },
      fs,
      "evidence",
    );
    return {
      content: read.content,
      metadata: workspaceIndexFileMetadata(file.relativePath, read.stat),
    };
  } catch {
    return { content: undefined, metadata: undefined };
  }
}

export function readCandidateContentPreview(
  scope: ScopeShape,
  file: DiscoveredFile,
  fs: WorkspaceFs,
): string | undefined {
  return readCandidateContentPreviewWithMetadata(scope, file, fs).content;
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
  const prescoreFiles = selectContentPrescoreFiles(files, inputs.query, inputs.policy, limit);
  for (const file of prescoreFiles) {
    if (candidateGatheringStopped(inputs)) break;
    const preview =
      inputs.contentPreviewFor === undefined
        ? readCandidateContentPreview(scope, file, inputs.fs)
        : inputs.contentPreviewFor(file);
    if (preview === undefined) {
      continue;
    }
    const score = scoreContentForSearch(inputs.query, preview, inputs.policy, file.relativePath);
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
  candidatePathPredicate?: (scopePath: string) => boolean,
  executionControl?: StructuralExecutionControl,
): GatherInputs {
  if (isRetrievalQuery(queryOrLimits)) {
    return {
      query: queryOrLimits,
      limits: limitsOrFs as LimitsShape,
      fs: fsOrPolicy as WorkspaceFs,
      policy: policy ?? resolveSearchPolicy(scope.relativePaths.length > 0, undefined),
      prescoreContent: true,
      ...(candidatePathPredicate === undefined ? {} : { candidatePathPredicate }),
      ...(executionControl === undefined ? {} : { executionControl }),
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
  readonly directorySnapshots?: readonly WorkspaceDirectorySnapshot[] | undefined;
  readonly skippedSymbolicLinks: readonly string[];
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
  candidatePathPredicate?: (scopePath: string) => boolean,
  executionControl?: StructuralExecutionControl,
): CandidateSet;
export function gatherCandidates(
  scope: ScopeShape,
  queryOrLimits: RetrievalQuery | LimitsShape,
  limitsOrFs: LimitsShape | WorkspaceFs,
  fsOrPolicy?: WorkspaceFs | SearchPolicy,
  policy?: SearchPolicy,
  candidatePathPredicate?: (scopePath: string) => boolean,
  executionControl?: StructuralExecutionControl,
): CandidateSet {
  const inputs = resolveGatherInputs(
    scope,
    queryOrLimits,
    limitsOrFs,
    fsOrPolicy,
    policy,
    candidatePathPredicate,
    executionControl,
  );
  return gatherCandidatesFromInputs(scope, inputs);
}

export function gatherCandidatesWithoutContentPrescore(
  scope: ScopeShape,
  query: RetrievalQuery,
  limits: LimitsShape,
  fs: WorkspaceFs,
  policy: SearchPolicy,
  executionControl?: StructuralExecutionControl,
): CandidateSet {
  return gatherCandidatesFromInputs(scope, {
    query,
    limits,
    fs,
    policy,
    prescoreContent: false,
    ...(executionControl === undefined ? {} : { executionControl }),
  });
}

export function gatherCandidatesWithControl(
  scope: ScopeShape,
  limits: LimitsShape,
  fs: WorkspaceFs,
  executionControl: StructuralExecutionControl,
): CandidateSet {
  return gatherCandidatesFromInputs(scope, {
    query: DEFAULT_GATHER_QUERY,
    limits,
    fs,
    policy: legacyDiscoveryPolicy(scope.relativePaths.length > 0),
    prescoreContent: false,
    executionControl,
  });
}

function gatherCandidatesFromInputs(scope: ScopeShape, inputs: GatherInputs): CandidateSet {
  validateSearchScopeRelativePaths(scope.relativePaths);
  if (candidateGatheringStopped(inputs)) {
    return orderCollectedCandidates(
      scope,
      inputs,
      {
        files: [],
        directories: [],
        skippedSymbolicLinks: [],
        filesDiscovered: 0,
        truncated: true,
        depthPruned: 0,
        maxFilesPruned: 0,
      },
      0,
      0,
    );
  }
  return scope.relativePaths.length === 0
    ? gatherDirectoryCandidates(scope, inputs)
    : gatherEntryCandidates(scope, inputs);
}

function gatherDirectoryCandidates(scope: ScopeShape, inputs: GatherInputs): CandidateSet {
  const result = collectFromDirectory(
    scope,
    inputs.limits,
    inputs.fs,
    inputs.policy,
    inputs.executionControl,
  );
  return orderCollectedCandidates(scope, inputs, result, result.ignored, result.denied);
}

function gatherEntryCandidates(scope: ScopeShape, inputs: GatherInputs): CandidateSet {
  const maxFilesScanned = candidateInventoryFileLimit(scope, inputs.query, inputs.limits);
  const result = collectFromEntries(
    scope,
    { ...inputs.limits, maxFilesScanned },
    inputs.fs,
    inputs.executionControl,
  );
  return orderCollectedCandidates(scope, inputs, { ...result, skippedSymbolicLinks: [] }, 0, 0);
}

function orderCollectedCandidates(
  scope: ScopeShape,
  inputs: GatherInputs,
  result: CollectedCandidates,
  ignoredByDiscovery: number,
  deniedByDiscovery: number,
): CandidateSet {
  const files =
    inputs.candidatePathPredicate === undefined
      ? result.files
      : result.files.filter((file) => inputs.candidatePathPredicate?.(file.relativePath) === true);
  const contentScores = contentScoresForOrdering(scope, files, inputs);
  const ordered = orderCandidatesForSearch({
    files,
    query: inputs.query,
    policy: inputs.policy,
    ignoredByDiscovery,
    deniedByDiscovery,
    depthPrunedByDiscovery: result.depthPruned,
    maxFilesPrunedByDiscovery: result.maxFilesPruned,
    contentScores,
  });
  return {
    files: ordered.files,
    directories: result.directories,
    ...(result.directorySnapshots === undefined
      ? {}
      : { directorySnapshots: result.directorySnapshots }),
    skippedSymbolicLinks: result.skippedSymbolicLinks,
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
  const expected = fs.stat(abs);
  if (fs.readFileBytes !== undefined) {
    const bytes = await fs.readFileBytes(abs, cap, "reject", expected);
    if (!isWorkspacePathSnapshotCurrent(fs, abs, abs, expected)) {
      throw new WorkspaceDescriptorReadError("changed");
    }
    return looksBinary(bytes);
  }
  const text = fs.readFileUtf8(abs);
  if (!isWorkspacePathSnapshotCurrent(fs, abs, abs, expected)) {
    throw new WorkspaceDescriptorReadError("changed");
  }
  return looksBinary(new TextEncoder().encode(text.slice(0, cap)));
}

export interface SearchTextRunner {
  readonly scope: ScopeShape;
  readonly limits: LimitsShape;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly startMs: number;
  readonly deadlineAtMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly matcher: LineMatcher;
  readonly fingerprint: string;
  readonly policy: SearchPolicy;
  readonly query: RetrievalQuery;
  // Which bytes the per-file matcher sees. REQUIRED, never defaulted here: every runner has to state
  // its lane so a new call site cannot inherit the wrong one silently.
  //   "evidence" — text is redacted at the IO boundary (context packs, grounded answers, evidence
  //                atoms, the persisted workspace index). The default for every non-editor caller.
  //   "editor"   — RAW bytes. The editor's own search/replace surface must match what the user can
  //                see in the editor and must address the real file's lines and columns, because the
  //                same coordinates drive a WRITE. Redaction collapsed multi-line PEM blocks and
  //                changed the width of same-line secrets, so redacted coordinates addressed text
  //                that is not in the file.
  readonly contentLane: WorkspaceContentLane;
  readonly candidatePathGlobs?:
    | {
        readonly include: readonly string[];
        readonly exclude: readonly string[];
      }
    | undefined;
  readonly candidateContentFor?: ((scopePath: string) => string | undefined) | undefined;
  readonly candidatePathPredicate?: ((scopePath: string) => boolean) | undefined;
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

export function isRunnerTimedOut(runner: SearchTextRunner): boolean {
  const currentMs = runner.nowMs();
  return (
    (runner.deadlineAtMs !== undefined && currentMs >= runner.deadlineAtMs) ||
    currentMs - runner.startMs > runner.limits.elapsedMsMax
  );
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
  if (isRunnerTimedOut(runner)) {
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
  if (isRunnerTimedOut(runner)) {
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
  if (isRunnerTimedOut(runner)) {
    markTruncated(state, "timeout");
    return true;
  }
  return false;
}

function isHardTrustDenial(err: unknown, code: unknown): boolean {
  return (
    err instanceof PathEscapeError ||
    err instanceof PathDeniedError ||
    code === WORKSPACE_CODES.PATH_ESCAPE ||
    code === WORKSPACE_CODES.PATH_DENIED
  );
}

// Returns true for NodeJS.ErrnoException (EACCES, ENOENT, EIO, …). Workspace path escapes and
// deny decisions also carry string codes, but are trust-boundary failures and must always escape
// the per-candidate availability catches instead of being downgraded to `tool-unavailable`.
export function isIoError(err: unknown): boolean {
  if (err === null || typeof err !== "object" || !("code" in err)) {
    return false;
  }
  const { code } = err as Record<"code", unknown>;
  return typeof code === "string" && !isHardTrustDenial(err, code);
}

function safeStat(
  runner: SearchTextRunner,
  absolutePath: string,
): ReturnType<WorkspaceFs["stat"]> | undefined {
  try {
    return runner.fs.stat(absolutePath);
  } catch (error) {
    if (isIoError(error)) {
      return undefined;
    }
    throw error;
  }
}

function cachedRecordPathIsDenied(
  runner: SearchTextRunner,
  contained: ReturnType<typeof containedRealPathInfo>,
  relativePath: string,
): boolean {
  const realRelative = contained.realRelative.replaceAll("\\", "/");
  return (
    isDenied(relativePath) ||
    isDenied(realRelative) ||
    realRootIsDeniedViaSymlink(contained.realBase, runner.scope.workspace.root)
  );
}

function cachedRecordMetadata(
  runner: SearchTextRunner,
  entry: PreparedWorkspaceIndexEntry,
  relativePath: string,
): WorkspaceIndexDiscoveredFile | undefined {
  const absolutePath = resolveWithinWorkspace(runner.scope.workspace.root, relativePath);
  const contained = containedRealPathInfo(runner.fs, runner.scope.workspace.root, absolutePath);
  if (cachedRecordPathIsDenied(runner, contained, relativePath)) {
    throw new PathDeniedError(
      `refusing cached metadata beneath a denied workspace path: ${relativePath}`,
      relativePath,
    );
  }
  if (
    !isCanonicalAllowedContainedPath(contained, runner.scope.workspace.root, relativePath) ||
    contained.path !== entry.absolutePath
  ) {
    return undefined;
  }
  const stat = safeStat(runner, contained.path);
  if (
    stat?.isFile !== true ||
    (stat.hardLinkCount !== undefined && stat.hardLinkCount > 1) ||
    typeof stat.mtimeMs !== "number"
  ) {
    return undefined;
  }
  return workspaceIndexFileMetadata(relativePath, stat);
}

function revalidatedCachedRecordMetadata(
  runner: SearchTextRunner,
  entry: PreparedWorkspaceIndexEntry,
  relativePath: string,
): WorkspaceIndexDiscoveredFile | undefined {
  try {
    return cachedRecordMetadata(runner, entry, relativePath);
  } catch (error) {
    if (error instanceof PathEscapeError || error instanceof PathDeniedError) {
      runner.workspaceIndex?.onStale(relativePath);
    }
    throw error;
  }
}

// The persisted workspace index is an evidence-lane artifact: its lexical records are built from
// REDACTED text. Reading one back in the editor lane would reintroduce exactly the under-reporting
// the raw lane fixes, and writing a raw-derived record into it would put secret-shaped tokens in a
// persisted store. `searchText` already refuses to open an index session for the editor lane; these
// two guards fail closed so a future wiring mistake degrades to "no cache" instead of leaking.
function usesWorkspaceIndex(runner: SearchTextRunner): boolean {
  return runner.contentLane !== "editor";
}

function reusableCachedEntry(
  runner: SearchTextRunner,
  relativePath: string,
): PreparedWorkspaceIndexEntry | undefined {
  if (!usesWorkspaceIndex(runner)) {
    return undefined;
  }
  if (runner.signal?.aborted === true || isRunnerTimedOut(runner)) {
    return undefined;
  }
  const entry = runner.workspaceIndex?.entries.get(relativePath);
  if (entry?.stale !== false || entry.record === undefined) {
    return undefined;
  }
  return entry;
}

function currentCachedRecord(
  runner: SearchTextRunner,
  entry: PreparedWorkspaceIndexEntry,
  relativePath: string,
): WorkspaceIndexRecord | undefined {
  const metadata = revalidatedCachedRecordMetadata(runner, entry, relativePath);
  if (metadata === undefined || !isWorkspaceIndexRecordCurrent(entry.record, metadata)) {
    runner.workspaceIndex?.onStale(relativePath);
    return undefined;
  }
  return entry.record;
}

function cachedRecord(
  runner: SearchTextRunner,
  relativePath: string,
): WorkspaceIndexRecord | undefined {
  const entry = reusableCachedEntry(runner, relativePath);
  return entry === undefined ? undefined : currentCachedRecord(runner, entry, relativePath);
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
        readonly kind: "binary";
        readonly scopePath: string;
        readonly metadata: WorkspaceIndexDiscoveredFile;
      }
    | {
        readonly kind: "text";
        readonly scopePath: string;
        readonly metadata: WorkspaceIndexDiscoveredFile;
        readonly content: string;
      },
): void {
  if (!usesWorkspaceIndex(runner)) {
    return;
  }
  if (record.kind === "text") {
    runner.workspaceIndex?.onRecord({
      ...record.metadata,
      kind: "text",
      fingerprint: workspaceIndexContentFingerprint(record.content),
      lexical: buildWorkspaceIndexLexicalRecord(record.content, record.scopePath),
    });
    return;
  }
  runner.workspaceIndex?.onRecord({ ...record.metadata, kind: record.kind });
}

function recordSizeExceeded(relativePath: string, candidates: CandidateFile[]): undefined {
  recordCandidateOmission(candidates, relativePath, "size-exceeded");
  return undefined;
}

// The lane switch for every byte the matcher sees. The evidence lane redacts here, at the IO
// boundary, so no secret-shaped byte can reach an evidence atom, the persisted index, or a grounded
// answer. The editor lane keeps the raw bytes: see `SearchTextRunner.contentLane`.
function laneText(runner: SearchTextRunner, text: string): string {
  return runner.contentLane === "editor" ? text : redact(text);
}

async function readRawTextForScan(
  runner: SearchTextRunner,
  relativePath: string,
  state: RunState,
  candidates: CandidateFile[],
): Promise<string | undefined> {
  try {
    return await readBoundedRawText(runner, relativePath, state, candidates);
  } catch (err) {
    if (isIoError(err)) {
      recordCandidateOmission(candidates, relativePath, "tool-unavailable");
      return undefined;
    }
    throw err;
  }
}

async function readBoundedRawText(
  runner: SearchTextRunner,
  relativePath: string,
  state: RunState,
  candidates: CandidateFile[],
): Promise<string | undefined> {
  const read = await readWorkspaceFileBytesPrefixForInternalUse(
    runner.scope.workspace,
    relativePath,
    runner.limits.maxBytesPerFileScanned,
    runner.fs,
  );
  const decoded = decodeTextBytes(
    read.bytes,
    undefined,
    read.complete ? undefined : { allowIncompleteTail: true },
  );
  if (decoded === undefined) {
    recordCandidateOmission(candidates, relativePath, "binary");
    return undefined;
  }
  const text = laneText(runner, decoded.text);
  if (!read.complete) {
    markTruncated(state, "file-cap");
    state.oversizedFilesScanned = (state.oversizedFilesScanned ?? 0) + 1;
    return text;
  }
  persistWorkspaceIndexRecord(runner, {
    kind: "text",
    scopePath: relativePath,
    metadata: workspaceIndexFileMetadata(relativePath, read.stat),
    content: text,
  });
  return text;
}

// The guarded-read variant of `laneText`: both lanes run the same containment/deny/size chain, the
// editor lane just keeps the bytes it returns.
function readLaneText(
  runner: SearchTextRunner,
  relativePath: string,
): ReturnType<typeof readWorkspaceFileTextForInternalUse> {
  const opts = { maxBytes: runner.limits.maxBytesPerFileScanned };
  return readWorkspaceFileTextForInternalUse(
    runner.scope.workspace,
    relativePath,
    opts,
    runner.fs,
    runner.contentLane,
  );
}

function readUtf8TextForScan(
  runner: SearchTextRunner,
  relativePath: string,
  state: RunState,
  candidates: CandidateFile[],
): string | undefined {
  try {
    const read = readLaneText(runner, relativePath);
    persistWorkspaceIndexRecord(runner, {
      kind: "text",
      scopePath: relativePath,
      metadata: workspaceIndexFileMetadata(relativePath, read.stat),
      content: read.content,
    });
    return read.content;
  } catch (err) {
    if (err instanceof FileTooLargeError) {
      return readOversizedUtf8Text(relativePath, state, candidates);
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

function readOversizedUtf8Text(
  relativePath: string,
  state: RunState,
  candidates: CandidateFile[],
): string | undefined {
  markTruncated(state, "file-cap");
  recordSizeExceeded(relativePath, candidates);
  return undefined;
}

async function readForScan(
  runner: SearchTextRunner,
  relativePath: string,
  state: RunState,
  candidates: CandidateFile[],
): Promise<string | undefined> {
  if (runner.fs.readFileBytes !== undefined) {
    return await readRawTextForScan(runner, relativePath, state, candidates);
  }
  return readUtf8TextForScan(runner, relativePath, state, candidates);
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
  readonly definitionMatch?: boolean | undefined;
}

function maxLineScore(best: readonly ScoredLine[]): number {
  return best.reduce((max, line) => Math.max(max, line.score), 0);
}

function scanLines(
  runner: SearchTextRunner,
  text: string,
  state: RunState,
  scopePath: string,
): readonly ScoredLine[] {
  return collectBestLines(runner, text, state, scopePath);
}

function abortScanFile(runner: SearchTextRunner, state: RunState): boolean {
  if (isRunnerAborted(runner)) {
    markTruncated(state, "aborted");
    return true;
  }
  if (isRunnerTimedOut(runner)) {
    markTruncated(state, "timeout");
    return true;
  }
  return false;
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
  if (!isCanonicalAllowedContainedPath(contained, runner.scope.workspace.root, file.relativePath)) {
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
    if (runner.fs.readFileBytes === undefined) {
      return (await probeBinary(runner.fs, path, file.sizeBytes)) ? "binary" : undefined;
    }
    const read = await readWorkspaceFileBytesPrefixForInternalUse(
      runner.scope.workspace,
      file.relativePath,
      BINARY_PROBE_BYTES,
      runner.fs,
    );
    if (!looksBinary(read.bytes)) return undefined;
    persistWorkspaceIndexRecord(runner, {
      kind: "binary",
      scopePath: file.relativePath,
      metadata: workspaceIndexFileMetadata(file.relativePath, read.stat),
    });
    return "binary";
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
      readonly lexical: NonNullable<WorkspaceIndexRecord["lexical"]>;
      readonly query: CachedLexicalQuery;
    }
  | undefined {
  const lexical = cached.lexical;
  if (lexical === undefined || lexical.truncated) {
    return undefined;
  }
  const query = prepareCachedLexicalQuery(runner.query);
  return query === undefined ? undefined : { lexical, query };
}

function cachedPreviewFileMatches(
  runner: SearchTextRunner,
  file: DiscoveredFile,
  state: RunState,
  order: number,
): FileMatches | "handled" | undefined {
  const content = runner.candidateContentFor?.(file.relativePath);
  if (content === undefined) return undefined;
  state.filesScanned += 1;
  return textFileMatches(runner, file, state, order, content) ?? "handled";
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
  if (cachedLexicalRecordRequiresLiveMatch(lexical.lexical, lexical.query)) {
    return cachedPreviewFileMatches(runner, file, state, order);
  }
  if (!cachedLexicalRecordMatches(lexical.lexical, lexical.query)) {
    if (cachedLexicalRecordDefinitelyDoesNotMatch(lexical.lexical, lexical.query)) {
      state.filesScanned += 1;
      return "handled";
    }
    return cachedPreviewFileMatches(runner, file, state, order);
  }
  state.filesScanned += 1;
  const best = bestCachedLexicalLines(lexical.lexical, lexical.query);
  return {
    relativePath: file.relativePath,
    order,
    best,
    maxScore: maxLineScore(best),
    definitionMatch: cachedExactSymbolDefinitionMatches(
      lexical.lexical,
      lexical.query.exactSymbolHash,
    ),
  };
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
  const text = await readForScan(runner, file.relativePath, state, candidates);
  return text === undefined || abortScanFile(runner, state)
    ? undefined
    : textFileMatches(runner, file, state, order, text);
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
  const best = scanLines(runner, text, state, file.relativePath);
  if (best.length === 0) {
    return undefined;
  }
  return {
    relativePath: file.relativePath,
    order,
    best,
    maxScore: maxLineScore(best),
    definitionMatch:
      runner.query.kind === "exact-symbol" &&
      repositorySourceLines(text, file.relativePath).some((line) =>
        structuralLineLooksLikeSymbolDefinition(
          line.structural,
          runner.query.text,
          runner.query.caseSensitive,
        ),
      ),
  };
}

export function emitFileMatches(
  runner: SearchTextRunner,
  state: RunState,
  atoms: EvidenceAtom[],
  matches: FileMatches,
): void {
  emitBestLines(runner, matches.relativePath, state, atoms, matches.best);
}
