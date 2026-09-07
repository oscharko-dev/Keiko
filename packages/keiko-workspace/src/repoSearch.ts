// Governed, deterministic, audit-friendly repository search facade (Epic #177, Issue #179).
// Composes the existing workspace primitives — discovery, deny policy, realpath gate,
// readWorkspaceFile, plus the new binaryDetect and stableId modules — into three public
// APIs that emit normalized EvidenceAtom output: searchText, findFiles, readExcerpt.
// Pure JS (no subprocess, no ripgrep — deferred). Every fs touch goes through the
// WorkspaceFs port. Stable IDs are reproducible across runs given the same inputs.

import type {
  CandidateFile,
  ContextCoverageDiagnostics,
  ContextCoverageTruncationReason,
  EvidenceAtom,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import {
  isValidScopePath,
  validateRetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { redact } from "@oscharko-dev/keiko-security";
import {
  readWorkspaceFile,
  readWorkspaceFileForEditing,
  type WorkspaceContentLane,
} from "./discovery.js";
import {
  FileTooLargeError,
  RepoSearchInvalidQueryError,
  RepoSearchInvalidRangeError,
  RepoSearchUnsupportedFileError,
  WorkspaceReadError,
} from "./errors.js";
import {
  isWorkspacePathSnapshotCurrent,
  nodeWorkspaceFs,
  WorkspaceDescriptorReadError,
  type WorkspaceFs,
  type WorkspaceStat,
} from "./fs.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo, isCanonicalAllowedContainedPath } from "./realpath.js";
import {
  buildMatcher,
  compileGlob,
  fingerprintFor,
  type LiteralQueryInterpretation,
} from "./repoSearchMatchers.js";
import {
  cachedLexicalRecordRequiresLiveMatch,
  prepareCachedLexicalQuery,
} from "./repoSearchCachedLexical.js";
import { validateSearchScopeRelativePaths } from "./repoSearchEntries.js";
import {
  buildAtom,
  buildCandidate,
  candidateDiscoveryFileLimit,
  collectFileMatches,
  emitFileMatches,
  elapsed,
  gatherCandidates,
  gatherCandidatesWithoutContentPrescore,
  hitScanLimit,
  isImageScopePath,
  isIoError,
  isRunnerTimedOut,
  probeBinary,
  type CandidateSet,
  type FileMatches,
  type RunState,
  type SearchTextRunner,
} from "./repoSearchScan.js";
import {
  createSemanticSearchSession,
  runSemanticSearchSession,
  semanticSearchTool,
  type SemanticSearchMatch,
  type SemanticSearchProvider,
} from "./repoSearchSemantic.js";
import {
  lowValueRescuePolicy,
  policyOmissionReason,
  resolveSearchPolicy,
  routeQueryTermsForSearch,
  withSemanticRankingDiagnostics,
  type SearchDiagnostics,
  type SearchHints,
  type SearchPolicy,
} from "./repoSearchPolicy.js";
import type { WorkspaceInfo } from "./types.js";
import {
  assertStructuralExecutionActive,
  executionControlledWorkspaceFs,
  StructuralExecutionStoppedError,
  type StructuralExecutionControl,
} from "./structuralExecution.js";
import { workspaceDirectoryFingerprint } from "./workspaceDirectorySnapshot.js";
import {
  buildWorkspaceIndexScopeKey,
  buildWorkspaceIndexSnapshot,
  createWorkspaceIndex,
  inspectWorkspaceIndexDirectories,
  prepareCachedWorkspaceIndexSnapshot,
  prepareWorkspaceIndexSnapshot,
  resolveContainedWorkspaceIndexDirectory,
  workspaceIndexCandidateSet,
  type PreparedWorkspaceIndexEntry,
  type PreparedWorkspaceIndexSnapshot,
  type WorkspaceIndexDirectoryDelta,
  type WorkspaceIndexDirectorySnapshot,
  type WorkspaceIndexPreparationReport,
  type WorkspaceIndex,
  type WorkspaceIndexDiscoverySnapshot,
  type WorkspaceIndexDiscoveredFile,
  type WorkspaceIndexRecord,
  type WorkspaceIndexSnapshot,
} from "./workspaceIndex.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SearchScope {
  readonly workspace: WorkspaceInfo;
  readonly scopeId: string;
  readonly relativePaths: readonly string[];
}

export interface SearchLimits {
  readonly maxFilesScanned: number;
  readonly maxMatchesReturned: number;
  readonly maxBytesPerFileScanned: number;
  readonly elapsedMsMax: number;
}

export const DEFAULT_SEARCH_LIMITS: SearchLimits = {
  maxFilesScanned: 2_000,
  maxMatchesReturned: 200,
  maxBytesPerFileScanned: 524_288,
  elapsedMsMax: 5_000,
} as const;

// Upper bound (2 MiB) on how many bytes of a file readExcerpt will load to reach a requested line
// window. The returned excerpt content is still clamped to the caller's request.maxBytes; this cap
// only governs how deep into a file we can slice. Decoupling it from request.maxBytes lets excerpts
// be read from files far larger than a single excerpt budget (a 16 KiB doc was previously unreadable
// and crashed the grounded request — Epic #177). Kept in step with the planner's 2 MiB scan cap so
// any file the search can match can also be excerpted. Files larger than this raise
// FileTooLargeError, which callers handle as a graceful omission.
const MAX_EXCERPT_FILE_BYTES = 2_097_152;

export interface SearchResult {
  readonly atoms: readonly EvidenceAtom[];
  readonly candidates: readonly CandidateFile[];
  readonly filesScanned: number;
  readonly oversizedFilesScanned: number;
  readonly elapsedMs: number;
  readonly truncated: boolean;
  readonly diagnostics: SearchDiagnostics | undefined;
  readonly coverage: ContextCoverageDiagnostics;
  readonly workspaceIndex?: WorkspaceIndexPreparationReport | undefined;
}

export interface ReadExcerptRequest {
  readonly scopePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly maxBytes: number;
}

export interface ReadExcerptResult {
  readonly atom: EvidenceAtom;
  readonly content: string;
  readonly truncated: boolean;
}

interface FacadeDeps {
  readonly queryInterpretation?: LiteralQueryInterpretation | undefined;
  readonly fs?: WorkspaceFs;
  readonly nowMs?: () => number;
  // Internal absolute request ceiling. Public callers normally use elapsedMsMax; the request-local
  // structural context supplies this so cache hits cannot reset the parent request clock.
  readonly deadlineAtMs?: number | undefined;
  readonly candidatePathGlobs?:
    | {
        readonly include: readonly string[];
        readonly exclude: readonly string[];
      }
    | undefined;
  readonly searchHints?: SearchHints | undefined;
  readonly signal?: AbortSignal;
  readonly workspaceIndex?: WorkspaceIndex | undefined;
  readonly semanticSearchProvider?: SemanticSearchProvider | undefined;
  // Request-local exact-policy discovery provider supplied by the owning workspace context. It is
  // never persisted; the provider keys snapshots by every discovery-affecting policy/limit field.
  readonly candidateSetFor?: CandidateSetProvider | undefined;
  readonly candidateContentFor?: ((scopePath: string) => string | undefined) | undefined;
  readonly validateCachedCandidateContent?: (() => void) | undefined;
  readonly drainStaleCandidateContentPaths?: (() => readonly string[]) | undefined;
  readonly reconcileCandidateContentEntries?:
    | ((entries: readonly WorkspaceIndexDiscoveredFile[], missingPaths: readonly string[]) => void)
    | undefined;
  // Defaults to "evidence" (redacted bytes) for every caller that does not say otherwise. Only the
  // editor's own search/replace surface passes "editor" — see `SearchTextRunner.contentLane` and
  // `@oscharko-dev/keiko-workspace/internal/editor-read`.
  readonly contentLane?: WorkspaceContentLane | undefined;
}

type CandidateSetProvider = (
  query: RetrievalQuery,
  limits: SearchLimits,
  policy: SearchPolicy,
  candidatePathPredicate?: (scopePath: string) => boolean,
  prescoreContent?: boolean,
) => CandidateSet;

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Exported so callers that must clamp a byte budget outside the searchText/readExcerpt facade
// (e.g. the coding-repository H1 excerpt projection, which redacts before this final clamp) reuse
// this exact UTF-8-boundary-safe truncation instead of re-deriving it.
export function clampToBytes(
  text: string,
  maxBytes: number,
): { excerpt: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { excerpt: "", truncated: true };
  }
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) {
    return { excerpt: text, truncated: false };
  }
  const buffer = encoded.subarray(0, maxBytes);
  const excerpt = new TextDecoder("utf-8", { fatal: false }).decode(buffer).replace(/\uFFFD$/u, "");
  return { excerpt, truncated: true };
}

function decodeUtf8Prefix(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\uFFFD$/u, "");
}

function assertQuery(query: RetrievalQuery): void {
  const result = validateRetrievalQuery(query);
  if (!result.ok) {
    throw new RepoSearchInvalidQueryError(`query invalid: ${result.reasons.join(", ")}`);
  }
}

function assertWorkspaceRoot(workspace: WorkspaceInfo): void {
  if (workspace.root.length === 0) {
    throw new RepoSearchInvalidQueryError("scope.workspace.root is empty");
  }
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function coverageReasons(
  reasons: ReadonlySet<ContextCoverageTruncationReason>,
): readonly ContextCoverageTruncationReason[] {
  const ordered: ContextCoverageTruncationReason[] = [];
  for (const reason of ["aborted", "file-cap", "match-cap", "timeout", "depth-pruned"] as const) {
    if (reasons.has(reason)) {
      ordered.push(reason);
    }
  }
  return ordered;
}

interface CoverageInputs {
  readonly diagnostics: SearchDiagnostics | undefined;
  readonly filesScanned: number;
  readonly oversizedFilesScanned: number;
  readonly matchesReturned: number;
  readonly elapsedMs: number;
  readonly limits: SearchLimits;
  readonly candidates: readonly CandidateFile[];
  readonly candidateTruncated: boolean;
  readonly truncationReasons: ReadonlySet<ContextCoverageTruncationReason>;
}

interface CoverageStats {
  readonly filesDiscovered: number;
  readonly filesAfterPolicy: number;
  readonly ignoredByDiscovery: number;
  readonly deniedByDiscovery: number;
  readonly depthPrunedByDiscovery: number;
  readonly maxFilesPrunedByDiscovery: number;
  readonly lowValueRescueFilesDiscovered: number;
  readonly lowValueRescueFilesScanned: number;
}

const EMPTY_COVERAGE_STATS: CoverageStats = {
  filesDiscovered: 0,
  filesAfterPolicy: 0,
  ignoredByDiscovery: 0,
  deniedByDiscovery: 0,
  depthPrunedByDiscovery: 0,
  maxFilesPrunedByDiscovery: 0,
  lowValueRescueFilesDiscovered: 0,
  lowValueRescueFilesScanned: 0,
};

function coverageStats(diagnostics: SearchDiagnostics | undefined): CoverageStats {
  if (diagnostics === undefined) {
    return EMPTY_COVERAGE_STATS;
  }
  return {
    filesDiscovered: diagnostics.filesDiscovered,
    filesAfterPolicy: diagnostics.filesAfterPolicy,
    ignoredByDiscovery: diagnostics.ignoredByDiscovery,
    deniedByDiscovery: diagnostics.deniedByDiscovery,
    depthPrunedByDiscovery: diagnostics.depthPrunedByDiscovery,
    maxFilesPrunedByDiscovery: diagnostics.maxFilesPrunedByDiscovery,
    lowValueRescueFilesDiscovered: diagnostics.lowValueRescueFilesDiscovered ?? 0,
    lowValueRescueFilesScanned: diagnostics.lowValueRescueFilesScanned ?? 0,
  };
}

function inferredCoverageReasons(
  inputs: CoverageInputs,
  stats: CoverageStats,
): Set<ContextCoverageTruncationReason> {
  const reasons = new Set(inputs.truncationReasons);
  if (stats.depthPrunedByDiscovery > 0) {
    reasons.add("depth-pruned");
  }
  if (
    inputs.candidateTruncated &&
    (stats.depthPrunedByDiscovery === 0 || stats.filesDiscovered >= inputs.limits.maxFilesScanned)
  ) {
    reasons.add("file-cap");
  }
  if (inputs.elapsedMs > inputs.limits.elapsedMsMax) {
    reasons.add("timeout");
  }
  return reasons;
}

function omittedCandidateCount(candidates: readonly CandidateFile[]): number {
  return candidates.filter((candidate) => candidate.omitted !== undefined).length;
}

function unvisitedCandidateCount(
  inputs: CoverageInputs,
  stats: CoverageStats,
  omittedCount: number,
): number {
  return Math.max(0, stats.filesAfterPolicy - inputs.filesScanned - omittedCount);
}

function skippedFileCount(inputs: CoverageInputs, stats: CoverageStats): number {
  const omittedCount = omittedCandidateCount(inputs.candidates);
  return (
    omittedCount +
    unvisitedCandidateCount(inputs, stats, omittedCount) +
    stats.ignoredByDiscovery +
    stats.deniedByDiscovery +
    stats.depthPrunedByDiscovery
  );
}

function buildCoverageDiagnostics(inputs: CoverageInputs): ContextCoverageDiagnostics {
  const stats = coverageStats(inputs.diagnostics);
  const orderedReasons = coverageReasons(inferredCoverageReasons(inputs, stats));
  return {
    incomplete: orderedReasons.length > 0,
    reasons: orderedReasons,
    filesDiscovered: stats.filesDiscovered,
    filesAfterPolicy: stats.filesAfterPolicy,
    filesScanned: inputs.filesScanned,
    filesSkipped: skippedFileCount(inputs, stats),
    oversizedFilesScanned: inputs.oversizedFilesScanned,
    lowValueRescueFilesDiscovered: stats.lowValueRescueFilesDiscovered,
    lowValueRescueFilesScanned: stats.lowValueRescueFilesScanned,
    truncated: orderedReasons.length > 0,
    ignoredByDiscovery: stats.ignoredByDiscovery,
    deniedByDiscovery: stats.deniedByDiscovery,
    depthPrunedByDiscovery: stats.depthPrunedByDiscovery,
    maxFilesPrunedByDiscovery: stats.maxFilesPrunedByDiscovery,
    matchesReturned: inputs.matchesReturned,
    elapsedMs: inputs.elapsedMs,
    limits: {
      maxFilesScanned: inputs.limits.maxFilesScanned,
      maxMatchesReturned: inputs.limits.maxMatchesReturned,
      elapsedMsMax: inputs.limits.elapsedMsMax,
    },
  };
}

function stoppedSearchResult(
  reason: "aborted" | "timeout",
  elapsedMs: number,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
  diagnostics?: SearchDiagnostics,
  candidateTruncated = false,
): SearchResult {
  const truncationReasons = new Set<ContextCoverageTruncationReason>([reason]);
  return {
    atoms: [],
    candidates: [],
    filesScanned: 0,
    oversizedFilesScanned: 0,
    elapsedMs,
    truncated: true,
    diagnostics,
    coverage: buildCoverageDiagnostics({
      diagnostics,
      filesScanned: 0,
      oversizedFilesScanned: 0,
      matchesReturned: 0,
      elapsedMs,
      limits,
      candidates: [],
      candidateTruncated,
      truncationReasons,
    }),
    workspaceIndex: undefined,
  };
}

function abortedSearchResult(
  elapsedMs: number,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
  diagnostics?: SearchDiagnostics,
  candidateTruncated = false,
): SearchResult {
  return stoppedSearchResult("aborted", elapsedMs, limits, diagnostics, candidateTruncated);
}

function timedOutSearchResult(
  elapsedMs: number,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
  diagnostics?: SearchDiagnostics,
  candidateTruncated = false,
): SearchResult {
  return stoppedSearchResult("timeout", elapsedMs, limits, diagnostics, candidateTruncated);
}

function absoluteDeadlineReached(nowMs: () => number, deadlineAtMs: number | undefined): boolean {
  return deadlineAtMs !== undefined && nowMs() >= deadlineAtMs;
}

function compareAtoms(a: EvidenceAtom, b: EvidenceAtom): number {
  return (
    b.score - a.score ||
    a.scopePath.localeCompare(b.scopePath) ||
    a.stableId.localeCompare(b.stableId)
  );
}

function mergeSearchAtoms(
  lexical: readonly EvidenceAtom[],
  semantic: readonly EvidenceAtom[],
  cap: number,
): readonly EvidenceAtom[] {
  if (semantic.length === 0) {
    return lexical;
  }
  const out: EvidenceAtom[] = [];
  const seen = new Set<string>();
  for (const atom of [...lexical, ...semantic].sort(compareAtoms)) {
    if (out.length >= cap) {
      break;
    }
    if (seen.has(atom.stableId)) {
      continue;
    }
    seen.add(atom.stableId);
    out.push(atom);
  }
  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Yields to the event loop every SCAN_YIELD_INTERVAL files so a large cold NFS/SMB workspace
// cannot block the event loop for multiple seconds. discoverFiles() itself remains synchronous
// (sync walk is load-bearing for importGraph/testSourcePairing callers); the yield here covers
// the already-async per-file scan pass where the loop overhead is measurable.
const SCAN_YIELD_INTERVAL = 32;
const PROJECT_METADATA_SCAN_MIN_FILES = 256;
const PROJECT_METADATA_SCAN_MAX_FILES = 512;

interface SearchTextCollection {
  readonly atoms: readonly EvidenceAtom[];
  readonly lexicalAtoms: readonly EvidenceAtom[];
  readonly semanticMatches: readonly SemanticSearchMatch[];
  readonly candidates: readonly CandidateFile[];
  readonly state: RunState;
}

function effectiveScanCandidateLimit(runner: SearchTextRunner, candidateCount: number): number {
  if (runner.policy.intent !== "project-metadata") {
    return candidateCount;
  }
  const matchScaledLimit = Math.max(
    PROJECT_METADATA_SCAN_MIN_FILES,
    runner.limits.maxMatchesReturned * 4,
  );
  return Math.min(
    candidateCount,
    runner.limits.maxFilesScanned,
    PROJECT_METADATA_SCAN_MAX_FILES,
    matchScaledLimit,
  );
}

type SearchTextRunnerDeps = Required<Pick<FacadeDeps, "fs" | "nowMs">> &
  Pick<
    FacadeDeps,
    | "candidatePathGlobs"
    | "searchHints"
    | "signal"
    | "semanticSearchProvider"
    | "contentLane"
    | "deadlineAtMs"
    | "candidateContentFor"
    | "queryInterpretation"
  >;

function buildSearchTextRunner(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  deps: SearchTextRunnerDeps,
): SearchTextRunner {
  const candidatePathPredicate = buildCandidatePathPredicate(deps.candidatePathGlobs);
  return {
    scope,
    limits: {
      ...limits,
      maxMatchesReturned: Math.min(limits.maxMatchesReturned, query.maxResults),
    },
    fs: deps.fs,
    nowMs: deps.nowMs,
    startMs: deps.nowMs(),
    ...(deps.deadlineAtMs === undefined ? {} : { deadlineAtMs: deps.deadlineAtMs }),
    signal: deps.signal,
    matcher: buildMatcher(query, deps.queryInterpretation),
    fingerprint: fingerprintFor(query, deps.queryInterpretation),
    policy: resolveSearchPolicy(scope.relativePaths.length > 0, deps.searchHints),
    query,
    contentLane: deps.contentLane ?? "evidence",
    ...(deps.candidatePathGlobs === undefined
      ? {}
      : { candidatePathGlobs: deps.candidatePathGlobs }),
    ...(deps.candidateContentFor === undefined
      ? {}
      : { candidateContentFor: deps.candidateContentFor }),
    ...(candidatePathPredicate === undefined ? {} : { candidatePathPredicate }),
    // A semantic session ships file text to an embedding provider — an evidence-lane egress path.
    // The editor lane reads RAW bytes and is lexical only, so it never opens one: fail closed here so
    // a future caller cannot combine the raw lane with a provider and turn a read into an egress.
    semantic:
      deps.contentLane === "editor"
        ? undefined
        : createSemanticSearchSession(deps.semanticSearchProvider, query),
  };
}

function buildCandidatePathPredicate(
  globs: FacadeDeps["candidatePathGlobs"],
): ((scopePath: string) => boolean) | undefined {
  if (globs === undefined || (globs.include.length === 0 && globs.exclude.length === 0)) {
    return undefined;
  }
  const includes = globs.include.map((glob) => compileGlob(glob, true));
  const excludes = globs.exclude.map((glob) => compileGlob(glob, true));
  return (scopePath: string): boolean => {
    const included = includes.length === 0 || includes.some((pattern) => pattern.test(scopePath));
    return included && !excludes.some((pattern) => pattern.test(scopePath));
  };
}

interface SearchWorkspaceIndexSession {
  candidateSet: CandidateSet;
  readonly preparedEntries: Map<string, PreparedWorkspaceIndexEntry>;
  readonly recordByPath: Map<string, WorkspaceIndexRecord>;
  readonly discoveryByPath: Map<string, WorkspaceIndexDiscoveredFile>;
  readonly invalidatedCachedRecords: Set<string>;
  readonly rebuiltCachedRecords: Set<string>;
  readonly newlyIndexedRecords: Set<string>;
  readonly pendingValidatedPaths: Set<string>;
  readonly pendingMissingPaths: Set<string>;
  dirty: boolean;
  report: WorkspaceIndexPreparationReport | undefined;
  readonly persist: (runner: SearchTextRunner) => Promise<void>;
}

type SearchWorkspaceIndexSessionState = Omit<SearchWorkspaceIndexSession, "persist">;

type WorkspaceIndexMetadataSource = Pick<
  WorkspaceIndexDiscoveredFile,
  "mtimeMs" | "fileIdentityHash" | "mtimeNs" | "ctimeNs" | "hardLinkCount"
>;

function workspaceIndexMetadataFields(
  metadata?: WorkspaceIndexMetadataSource,
): WorkspaceIndexMetadataSource {
  if (metadata === undefined) {
    return {};
  }
  return {
    ...(metadata.mtimeMs !== undefined ? { mtimeMs: metadata.mtimeMs } : {}),
    ...(metadata.fileIdentityHash !== undefined
      ? { fileIdentityHash: metadata.fileIdentityHash }
      : {}),
    ...(metadata.mtimeNs !== undefined ? { mtimeNs: metadata.mtimeNs } : {}),
    ...(metadata.ctimeNs !== undefined ? { ctimeNs: metadata.ctimeNs } : {}),
    ...(metadata.hardLinkCount !== undefined ? { hardLinkCount: metadata.hardLinkCount } : {}),
  };
}

function discoveredFileSnapshot(
  scopePath: string,
  sizeBytes: number,
  metadata?: WorkspaceIndexMetadataSource,
): WorkspaceIndexDiscoveredFile {
  return {
    scopePath,
    sizeBytes,
    ...workspaceIndexMetadataFields(metadata),
  };
}

function candidateSetDiscoverySnapshot(
  candidateSet: CandidateSet,
  discoveryFiles: readonly WorkspaceIndexDiscoveredFile[],
  directories: readonly WorkspaceIndexDirectorySnapshot[],
): WorkspaceIndexDiscoverySnapshot {
  return {
    files: discoveryFiles,
    directories,
    filesDiscovered: candidateSet.diagnostics.filesDiscovered,
    ignoredByDiscovery: candidateSet.diagnostics.ignoredByDiscovery,
    deniedByDiscovery: candidateSet.diagnostics.deniedByDiscovery,
    depthPrunedByDiscovery: candidateSet.diagnostics.depthPrunedByDiscovery,
    truncated: candidateSet.truncated,
  };
}

function ancestorDirectoryPaths(scopePath: string): readonly string[] {
  const normalized = scopePath.replaceAll("\\", "/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  const paths: string[] = [""];
  let current = "";
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current.length === 0 ? (parts[index] ?? "") : `${current}/${parts[index] ?? ""}`;
    paths.push(current);
  }
  return [...new Set(paths)];
}

function parentDirectoryPath(scopePath: string): string {
  const normalized = scopePath.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "" : normalized.slice(0, slash);
}

function selectedDirectoryPath(
  workspaceRoot: string,
  scopePath: string,
  fs: WorkspaceFs,
): string | undefined {
  const normalized = scopePath.replaceAll("\\", "/");
  if (normalized.length === 0) {
    return "";
  }
  if (!isValidScopePath(normalized, { mustBeRelative: true }) || isDenied(normalized)) {
    return undefined;
  }
  const absolutePath = resolveWithinWorkspace(workspaceRoot, normalized);
  let contained;
  try {
    contained = containedRealPathInfo(fs, workspaceRoot, absolutePath);
  } catch {
    return undefined;
  }
  if (!isCanonicalAllowedContainedPath(contained, workspaceRoot, normalized)) {
    return undefined;
  }
  const realScopePath = normalizeScopePath(contained.realRelative);
  try {
    const stat = fs.stat(contained.path);
    return stat.isDirectory ? realScopePath : parentDirectoryPath(realScopePath);
  } catch {
    return parentDirectoryPath(realScopePath);
  }
}

function buildWorkspaceIndexDirectories(
  workspaceRoot: string,
  discoveryByPath: ReadonlyMap<string, WorkspaceIndexDiscoveredFile>,
  fs: WorkspaceFs,
  relativePaths: readonly string[],
  visitedDirectories: readonly string[],
  limits: SearchLimits,
  shouldContinue: () => boolean,
): readonly WorkspaceIndexDirectorySnapshot[] {
  const directories = new Set<string>();
  addVisitedWorkspaceIndexDirectories(directories, visitedDirectories);
  addSelectedWorkspaceIndexDirectories(directories, workspaceRoot, fs, relativePaths);
  addIndexedWorkspaceIndexAncestors(directories, discoveryByPath);
  const snapshots: WorkspaceIndexDirectorySnapshot[] = [];
  let remainingEntries = candidateDiscoveryFileLimit(limits);
  for (const scopePath of [...directories].sort(compareStrings)) {
    if (!shouldContinue() || remainingEntries <= 0) return [];
    const absolutePath = resolveContainedWorkspaceIndexDirectory(workspaceRoot, scopePath, fs);
    if (absolutePath === undefined) return [];
    try {
      const entries = fs.readDir(absolutePath, remainingEntries + 1);
      if (entries.length > remainingEntries) return [];
      remainingEntries -= entries.length;
      if (!shouldContinue()) return [];
      const stat = fs.stat(absolutePath);
      snapshots.push({
        scopePath,
        fingerprint: workspaceDirectoryFingerprint(entries),
        ...(typeof stat.mtimeMs === "number" ? { mtimeMs: stat.mtimeMs } : {}),
      });
    } catch {
      return [];
    }
  }
  return snapshots;
}

function workspaceIndexDirectoriesAreCoherent(
  candidateSet: CandidateSet,
  current: readonly WorkspaceIndexDirectorySnapshot[],
): boolean {
  const discovered = candidateSet.directorySnapshots;
  if (discovered === undefined || discovered.length === 0) return false;
  const discoveredByPath = new Map(
    discovered.map((directory) => [directory.scopePath, directory.fingerprint] as const),
  );
  if (candidateSet.directories.some((scopePath) => !discoveredByPath.has(scopePath))) return false;
  const currentByPath = new Map(
    current.map((directory) => [directory.scopePath, directory.fingerprint] as const),
  );
  return [...discoveredByPath].every(
    ([scopePath, fingerprint]) => currentByPath.get(scopePath) === fingerprint,
  );
}

function normalizedFixedFileScopePaths(scope: SearchScope): ReadonlySet<string> | undefined {
  if (scope.relativePaths.length === 0) return undefined;
  const scopePaths = new Set<string>();
  for (const entry of scope.relativePaths) {
    const scopePath = normalizeScopePath(entry);
    if (!isValidScopePath(scopePath, { mustBeRelative: true }) || isDenied(scopePath)) {
      return undefined;
    }
    scopePaths.add(scopePath);
  }
  return scopePaths;
}

function candidateSetIsFixedFileSelection(
  scope: SearchScope,
  candidateSet: CandidateSet,
  discoveryByPath: ReadonlyMap<string, WorkspaceIndexDiscoveredFile>,
): boolean {
  const scopePaths = normalizedFixedFileScopePaths(scope);
  if (
    scopePaths === undefined ||
    candidateSet.truncated ||
    candidateSet.directories.length > 0 ||
    (candidateSet.directorySnapshots?.length ?? 0) > 0 ||
    candidateSet.diagnostics.filesDiscovered !== scopePaths.size ||
    candidateSet.files.length !== scopePaths.size ||
    discoveryByPath.size !== scopePaths.size
  ) {
    return false;
  }
  return candidateSet.files.every(
    (file) => scopePaths.has(file.relativePath) && discoveryByPath.has(file.relativePath),
  );
}

function addVisitedWorkspaceIndexDirectories(
  directories: Set<string>,
  visitedDirectories: readonly string[],
): void {
  for (const directory of visitedDirectories) {
    if (isValidScopePath(directory, { mustBeRelative: true }) && !isDenied(directory)) {
      directories.add(directory);
    }
  }
}

function addSelectedWorkspaceIndexDirectories(
  directories: Set<string>,
  workspaceRoot: string,
  fs: WorkspaceFs,
  relativePaths: readonly string[],
): void {
  if (relativePaths.length === 0) {
    directories.add("");
    return;
  }
  for (const scopePath of relativePaths) {
    const directory = selectedDirectoryPath(workspaceRoot, scopePath, fs);
    if (directory !== undefined) {
      directories.add(directory);
    }
  }
}

function addIndexedWorkspaceIndexAncestors(
  directories: Set<string>,
  discoveryByPath: ReadonlyMap<string, WorkspaceIndexDiscoveredFile>,
): void {
  for (const scopePath of discoveryByPath.keys()) {
    for (const ancestor of ancestorDirectoryPaths(scopePath)) {
      directories.add(ancestor);
    }
  }
}

function sameWorkspaceIndexRecord(
  a: WorkspaceIndexRecord | undefined,
  b: WorkspaceIndexRecord | undefined,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameDiscoveryFile(
  a: WorkspaceIndexDiscoveredFile | undefined,
  b: WorkspaceIndexDiscoveredFile,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function workspaceIndexPolicyShape(runner: SearchTextRunner): {
  readonly policyMode: SearchTextRunner["policy"]["mode"];
  readonly applyGitignore: boolean;
  readonly omitLowValueWorkspaceFiles: boolean;
} {
  return {
    policyMode: runner.policy.mode,
    applyGitignore: runner.policy.applyGitignore,
    omitLowValueWorkspaceFiles: runner.policy.omitLowValueWorkspaceFiles,
  };
}

function workspaceIndexCompatibleRun(runner: SearchTextRunner): boolean {
  // The index persists lexical records built from REDACTED text. The editor lane matches RAW bytes,
  // so sharing one index across both lanes would either poison a persisted evidence artifact with
  // secret-shaped tokens or hand the editor lane back the very redacted text it was fixed to stop
  // matching on. The editor lane therefore always runs uncached.
  if (runner.contentLane === "editor") {
    return false;
  }
  return runner.policy.lowValuePathAllowlist.length === 0 && runner.policy.recentPaths.length === 0;
}

function workspaceIndexScopeKey(
  scope: SearchScope,
  runner: SearchTextRunner,
): ReturnType<typeof buildWorkspaceIndexScopeKey> {
  return buildWorkspaceIndexScopeKey(
    scope,
    workspaceIndexPolicyShape(runner),
    runner.limits.maxBytesPerFileScanned,
    runner.limits.maxFilesScanned,
    runner.candidatePathGlobs,
  );
}

function workspaceIndexSnapshotScope(
  scope: SearchScope,
  runner: SearchTextRunner,
): SearchScope & { readonly candidatePathGlobs?: SearchTextRunner["candidatePathGlobs"] } {
  return {
    ...scope,
    ...(runner.candidatePathGlobs === undefined
      ? {}
      : { candidatePathGlobs: runner.candidatePathGlobs }),
  };
}

function seedWorkspaceIndexCaches(
  prepared: PreparedWorkspaceIndexSnapshot | undefined,
  candidateSet: CandidateSet,
): Pick<SearchWorkspaceIndexSession, "preparedEntries" | "recordByPath" | "discoveryByPath"> {
  const preparedEntries = new Map<string, PreparedWorkspaceIndexEntry>();
  const recordByPath = new Map<string, WorkspaceIndexRecord>();
  const discoveryByPath = new Map<string, WorkspaceIndexDiscoveredFile>();
  if (prepared === undefined) {
    for (const file of candidateSet.files) {
      discoveryByPath.set(
        file.relativePath,
        discoveredFileSnapshot(file.relativePath, file.sizeBytes),
      );
    }
    return { preparedEntries, recordByPath, discoveryByPath };
  }
  for (const entry of prepared.entries) {
    preparedEntries.set(entry.scopePath, entry);
    discoveryByPath.set(
      entry.scopePath,
      discoveredFileSnapshot(entry.scopePath, entry.file.sizeBytes, entry),
    );
    if (entry.record !== undefined) {
      recordByPath.set(entry.scopePath, entry.record);
    }
  }
  return { preparedEntries, recordByPath, discoveryByPath };
}

function sortedDiscoveryFiles(
  discoveryByPath: ReadonlyMap<string, WorkspaceIndexDiscoveredFile>,
): readonly WorkspaceIndexDiscoveredFile[] {
  return [...discoveryByPath.values()].sort((a, b) => compareStrings(a.scopePath, b.scopePath));
}

function preparedFromSessionState(
  discovery: WorkspaceIndexDiscoverySnapshot,
  preparedEntries: ReadonlyMap<string, PreparedWorkspaceIndexEntry>,
  discoveryByPath: ReadonlyMap<string, WorkspaceIndexDiscoveredFile>,
  report: WorkspaceIndexPreparationReport,
): PreparedWorkspaceIndexSnapshot {
  return {
    valid: true,
    dirty: false,
    entries: [...preparedEntries.values()].sort((a, b) => compareStrings(a.scopePath, b.scopePath)),
    discovery: {
      ...discovery,
      files: sortedDiscoveryFiles(discoveryByPath),
      filesDiscovered: discovery.truncated ? discovery.filesDiscovered : discoveryByPath.size,
    },
    report,
  };
}

function removeWorkspaceIndexPath(
  scopePath: string,
  preparedEntries: Map<string, PreparedWorkspaceIndexEntry>,
  recordByPath: Map<string, WorkspaceIndexRecord>,
  discoveryByPath: Map<string, WorkspaceIndexDiscoveredFile>,
): boolean {
  const hadEntry = preparedEntries.delete(scopePath);
  const hadRecord = recordByPath.delete(scopePath);
  const hadDiscovery = discoveryByPath.delete(scopePath);
  return hadEntry || hadRecord || hadDiscovery;
}

function removeWorkspaceIndexDirectory(
  directoryScopePath: string,
  preparedEntries: Map<string, PreparedWorkspaceIndexEntry>,
  recordByPath: Map<string, WorkspaceIndexRecord>,
  discoveryByPath: Map<string, WorkspaceIndexDiscoveredFile>,
): number {
  const paths = [...discoveryByPath.keys()].filter(
    (scopePath) =>
      directoryScopePath.length === 0 ||
      scopePath === directoryScopePath ||
      scopePath.startsWith(`${directoryScopePath}/`),
  );
  let removed = 0;
  for (const scopePath of paths) {
    if (removeWorkspaceIndexPath(scopePath, preparedEntries, recordByPath, discoveryByPath)) {
      removed += 1;
    }
  }
  return removed;
}

function deltaScanPaths(delta: WorkspaceIndexDirectoryDelta): readonly string[] {
  return delta.rescanDirectory ? [delta.scopePath] : delta.addedPaths;
}

function prepareAffectedWorkspaceIndexSnapshot(
  scope: SearchScope,
  query: RetrievalQuery,
  runner: SearchTextRunner,
  limits: SearchLimits,
  scanPaths: readonly string[],
  records: Iterable<WorkspaceIndexRecord>,
  candidateSetFor: CandidateSetProvider | undefined,
): PreparedWorkspaceIndexSnapshot | undefined {
  if (scanPaths.length === 0 || runnerExecutionStopped(runner)) {
    return undefined;
  }
  const affectedScope: SearchScope = {
    ...scope,
    relativePaths: scanPaths.length === 1 && scanPaths[0] === "" ? [] : scanPaths,
  };
  const gathered =
    candidateSetFor === undefined
      ? gatherCandidatesWithoutContentPrescore(
          affectedScope,
          query,
          limits,
          runner.fs,
          runner.policy,
          runnerExecutionControl(runner),
        )
      : candidateSetFor(query, limits, runner.policy, runner.candidatePathPredicate, false);
  const candidateSet = affectedCandidateSet(gathered, scanPaths, runner.candidatePathPredicate);
  if (runnerExecutionStopped(runner)) return undefined;
  const discoveryFiles = candidateSet.files.map((file) =>
    discoveredFileSnapshot(file.relativePath, file.sizeBytes),
  );
  return prepareWorkspaceIndexSnapshot(
    buildWorkspaceIndexSnapshot({
      scope: workspaceIndexSnapshotScope(affectedScope, runner),
      policy: workspaceIndexPolicyShape(runner),
      maxBytesPerFileScanned: runner.limits.maxBytesPerFileScanned,
      maxFilesScanned: runner.limits.maxFilesScanned,
      discovery: candidateSetDiscoverySnapshot(candidateSet, discoveryFiles, []),
      records,
    }),
    scope.workspace,
    runner.fs,
    () => !runnerExecutionStopped(runner),
  );
}

function pathIsAffected(scopePath: string, scanPaths: readonly string[]): boolean {
  return scanPaths.some(
    (scanPath) =>
      scanPath.length === 0 || scopePath === scanPath || scopePath.startsWith(`${scanPath}/`),
  );
}

function affectedCandidateSet(
  candidateSet: CandidateSet,
  scanPaths: readonly string[],
  candidatePathPredicate: ((scopePath: string) => boolean) | undefined,
): CandidateSet {
  const files = candidateSet.files.filter(
    (file) =>
      pathIsAffected(file.relativePath, scanPaths) &&
      (candidatePathPredicate?.(file.relativePath) ?? true),
  );
  return {
    ...candidateSet,
    files,
    directories: candidateSet.directories.filter((path) => pathIsAffected(path, scanPaths)),
    diagnostics: {
      ...candidateSet.diagnostics,
      filesDiscovered: files.length,
      filesAfterPolicy: files.length,
    },
  };
}

function applyAffectedPreparedEntries(
  prepared: PreparedWorkspaceIndexSnapshot | undefined,
  preparedEntries: Map<string, PreparedWorkspaceIndexEntry>,
  recordByPath: Map<string, WorkspaceIndexRecord>,
  discoveryByPath: Map<string, WorkspaceIndexDiscoveredFile>,
): WorkspaceIndexPreparationReport {
  const empty = {
    discoveredEntries: 0,
    retainedEntries: 0,
    indexedRecords: 0,
    reusedRecords: 0,
    staleRecords: 0,
    skippedEntries: 0,
    deletedEntries: 0,
    droppedRecords: 0,
  };
  if (prepared === undefined) {
    return empty;
  }
  for (const entry of prepared.entries) {
    preparedEntries.set(entry.scopePath, entry);
    discoveryByPath.set(
      entry.scopePath,
      discoveredFileSnapshot(entry.scopePath, entry.file.sizeBytes, entry),
    );
    if (entry.record !== undefined) {
      recordByPath.set(entry.scopePath, entry.record);
    }
  }
  return prepared.report;
}

function reconciledWorkspaceIndexReport(inputs: {
  readonly preparedEntries: ReadonlyMap<string, PreparedWorkspaceIndexEntry>;
  readonly discoveryByPath: ReadonlyMap<string, WorkspaceIndexDiscoveredFile>;
  readonly recordByPath: ReadonlyMap<string, WorkspaceIndexRecord>;
  readonly baseReport: WorkspaceIndexPreparationReport;
  readonly affectedReport: WorkspaceIndexPreparationReport;
  readonly deletedByReconciliation: number;
  readonly droppedByReconciliation: number;
}): WorkspaceIndexPreparationReport {
  const currentEntries = [...inputs.preparedEntries.values()];
  const staleRecords = currentEntries.filter(
    (entry) => entry.record !== undefined && entry.stale,
  ).length;
  const reusedRecords = currentEntries.filter(
    (entry) => entry.record !== undefined && !entry.stale,
  ).length;
  return {
    discoveredEntries: inputs.discoveryByPath.size,
    retainedEntries: inputs.discoveryByPath.size,
    indexedRecords: inputs.recordByPath.size,
    reusedRecords,
    staleRecords,
    skippedEntries: inputs.baseReport.skippedEntries + inputs.affectedReport.skippedEntries,
    deletedEntries:
      inputs.baseReport.deletedEntries +
      inputs.affectedReport.deletedEntries +
      inputs.deletedByReconciliation,
    droppedRecords:
      inputs.baseReport.droppedRecords +
      inputs.affectedReport.droppedRecords +
      inputs.droppedByReconciliation,
  };
}

function emptyWorkspaceIndexPreparationReport(): WorkspaceIndexPreparationReport {
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

function addWorkspaceIndexPreparationReport(
  a: WorkspaceIndexPreparationReport,
  b: WorkspaceIndexPreparationReport,
): WorkspaceIndexPreparationReport {
  return {
    discoveredEntries: a.discoveredEntries + b.discoveredEntries,
    retainedEntries: a.retainedEntries + b.retainedEntries,
    indexedRecords: a.indexedRecords + b.indexedRecords,
    reusedRecords: a.reusedRecords + b.reusedRecords,
    staleRecords: a.staleRecords + b.staleRecords,
    skippedEntries: a.skippedEntries + b.skippedEntries,
    deletedEntries: a.deletedEntries + b.deletedEntries,
    droppedRecords: a.droppedRecords + b.droppedRecords,
  };
}

async function loadWorkspaceIndexSnapshot(
  workspaceIndex: WorkspaceIndex,
  scope: SearchScope,
  runner: SearchTextRunner,
): Promise<WorkspaceIndexSnapshot | undefined> {
  try {
    return await workspaceIndex.loadSnapshot(workspaceIndexScopeKey(scope, runner));
  } catch {
    return undefined;
  }
}

function queryRequiresContentRanking(query: RetrievalQuery, runner: SearchTextRunner): boolean {
  return (
    query.kind === "exact-symbol" ||
    query.kind === "natural-language" ||
    routeQueryTermsForSearch(query) !== undefined ||
    runner.policy.intent === "targeted-code-search" ||
    runner.policy.intent === "diagnostic-search"
  );
}

function needsLiveWorkspaceIndexCandidates(
  query: RetrievalQuery,
  runner: SearchTextRunner,
  prepared: PreparedWorkspaceIndexSnapshot | undefined,
): boolean {
  // Cached lexical records intentionally store only hashes of whole terms. Exact-symbol and
  // natural-language matching also support substring hits, so the persisted representation cannot
  // rank those queries soundly. Re-run content prescoring; the request-local context reuses its
  // descriptor-validated preview cache, so repeated grounded anchors still perform no byte reads.
  if (!queryRequiresContentRanking(query, runner)) return false;
  const cachedQuery = prepareCachedLexicalQuery(query);
  if (prepared === undefined || cachedQuery === undefined) return true;
  return prepared.entries.some((entry) => {
    const lexical = entry.record?.lexical;
    return (
      entry.stale ||
      lexical === undefined ||
      lexical.truncated ||
      cachedLexicalRecordRequiresLiveMatch(lexical, cachedQuery)
    );
  });
}

function initialWorkspaceIndexCandidateSet(
  scope: SearchScope,
  query: RetrievalQuery,
  runner: SearchTextRunner,
  limits: SearchLimits,
  prepared: PreparedWorkspaceIndexSnapshot | undefined,
  candidateSetFor: CandidateSetProvider | undefined,
): CandidateSet {
  if (needsLiveWorkspaceIndexCandidates(query, runner, prepared)) {
    return liveWorkspaceIndexCandidateSet(scope, query, runner, limits, candidateSetFor);
  }
  if (prepared === undefined) {
    return candidateSetFor === undefined
      ? gatherCandidates(
          scope,
          query,
          limits,
          runner.fs,
          runner.policy,
          runner.candidatePathPredicate,
          runnerExecutionControl(runner),
        )
      : candidateSetFor(query, limits, runner.policy, runner.candidatePathPredicate);
  }
  return {
    ...workspaceIndexCandidateSet(prepared, query, runner.policy),
    skippedSymbolicLinks: [],
  };
}

function liveWorkspaceIndexCandidateSet(
  scope: SearchScope,
  query: RetrievalQuery,
  runner: SearchTextRunner,
  limits: SearchLimits,
  candidateSetFor: CandidateSetProvider | undefined,
): CandidateSet {
  return candidateSetFor === undefined
    ? gatherCandidates(
        scope,
        query,
        limits,
        runner.fs,
        runner.policy,
        runner.candidatePathPredicate,
        runnerExecutionControl(runner),
      )
    : candidateSetFor(query, limits, runner.policy, runner.candidatePathPredicate);
}

function initialWorkspaceIndexSessionState(
  scope: SearchScope,
  query: RetrievalQuery,
  runner: SearchTextRunner,
  limits: SearchLimits,
  prepared: PreparedWorkspaceIndexSnapshot | undefined,
  candidateSetFor: CandidateSetProvider | undefined,
): SearchWorkspaceIndexSessionState {
  const candidateSet = initialWorkspaceIndexCandidateSet(
    scope,
    query,
    runner,
    limits,
    prepared,
    candidateSetFor,
  );
  return {
    candidateSet,
    ...seedWorkspaceIndexCaches(prepared, candidateSet),
    invalidatedCachedRecords: new Set<string>(),
    rebuiltCachedRecords: new Set<string>(),
    newlyIndexedRecords: new Set<string>(),
    pendingValidatedPaths: new Set<string>(),
    pendingMissingPaths: new Set<string>(),
    dirty: prepared === undefined,
    report: prepared?.report,
  };
}

interface WorkspaceIndexDeltaInputs {
  readonly scope: SearchScope;
  readonly query: RetrievalQuery;
  readonly runner: SearchTextRunner;
  readonly limits: SearchLimits;
  readonly candidateSetFor: CandidateSetProvider | undefined;
}

interface WorkspaceIndexDeltaResult {
  readonly deletedEntries: number;
  readonly droppedRecords: number;
  readonly affectedReport: WorkspaceIndexPreparationReport;
}

function applyWorkspaceIndexDelta(
  delta: WorkspaceIndexDirectoryDelta,
  state: SearchWorkspaceIndexSessionState,
  inputs: WorkspaceIndexDeltaInputs,
): WorkspaceIndexDeltaResult {
  const deletedEntries = delta.removedPaths.filter((scopePath) =>
    state.discoveryByPath.has(scopePath),
  ).length;
  let droppedRecords = delta.removedPaths.filter((scopePath) =>
    state.recordByPath.has(scopePath),
  ).length;
  removeWorkspaceIndexPaths(delta.removedPaths, state);
  if (delta.rescanDirectory) {
    droppedRecords += [...state.recordByPath].filter(([scopePath]) =>
      pathIsAffected(scopePath, [delta.scopePath]),
    ).length;
    removeWorkspaceIndexDirectory(
      delta.scopePath,
      state.preparedEntries,
      state.recordByPath,
      state.discoveryByPath,
    );
  }
  const affected = prepareAffectedWorkspaceIndexSnapshot(
    inputs.scope,
    inputs.query,
    inputs.runner,
    inputs.limits,
    deltaScanPaths(delta),
    state.recordByPath.values(),
    inputs.candidateSetFor,
  );
  return {
    deletedEntries,
    droppedRecords,
    affectedReport: applyAffectedPreparedEntries(
      affected,
      state.preparedEntries,
      state.recordByPath,
      state.discoveryByPath,
    ),
  };
}

function removeWorkspaceIndexPaths(
  scopePaths: readonly string[],
  state: SearchWorkspaceIndexSessionState,
): number {
  let removed = 0;
  for (const scopePath of scopePaths) {
    if (
      removeWorkspaceIndexPath(
        scopePath,
        state.preparedEntries,
        state.recordByPath,
        state.discoveryByPath,
      )
    ) {
      removed += 1;
    }
  }
  return removed;
}

function applyWorkspaceIndexDeltas(
  state: SearchWorkspaceIndexSessionState,
  prepared: PreparedWorkspaceIndexSnapshot,
  deltas: readonly WorkspaceIndexDirectoryDelta[],
  inputs: {
    readonly scope: SearchScope;
    readonly query: RetrievalQuery;
    readonly runner: SearchTextRunner;
    readonly limits: SearchLimits;
    readonly candidateSetFor: CandidateSetProvider | undefined;
  },
): boolean {
  let deletedByReconciliation = 0;
  let droppedByReconciliation = 0;
  let affectedReport = emptyWorkspaceIndexPreparationReport();
  for (const delta of deltas) {
    if (runnerExecutionStopped(inputs.runner)) return false;
    const applied = applyWorkspaceIndexDelta(delta, state, inputs);
    if (runnerExecutionStopped(inputs.runner)) return false;
    deletedByReconciliation += applied.deletedEntries;
    droppedByReconciliation += applied.droppedRecords;
    affectedReport = addWorkspaceIndexPreparationReport(affectedReport, applied.affectedReport);
  }
  const report = reconciledWorkspaceIndexReport({
    preparedEntries: state.preparedEntries,
    discoveryByPath: state.discoveryByPath,
    recordByPath: state.recordByPath,
    baseReport: prepared.report,
    affectedReport,
    deletedByReconciliation,
    droppedByReconciliation,
  });
  const reconciled = preparedFromSessionState(
    prepared.discovery,
    state.preparedEntries,
    state.discoveryByPath,
    report,
  );
  state.candidateSet = initialWorkspaceIndexCandidateSet(
    inputs.scope,
    inputs.query,
    inputs.runner,
    inputs.limits,
    reconciled,
    inputs.candidateSetFor,
  );
  state.report = report;
  state.dirty = true;
  return true;
}

interface WorkspaceIndexPersistenceMembership {
  readonly directories: readonly WorkspaceIndexDirectorySnapshot[];
  readonly fixedFileSelection: boolean;
}

function workspaceIndexPersistenceMembership(
  scope: SearchScope,
  session: Omit<SearchWorkspaceIndexSession, "persist">,
  runner: SearchTextRunner,
): WorkspaceIndexPersistenceMembership | undefined {
  if (candidateSetIsFixedFileSelection(scope, session.candidateSet, session.discoveryByPath)) {
    return { directories: [], fixedFileSelection: true };
  }
  const directories = buildWorkspaceIndexDirectories(
    scope.workspace.root,
    session.discoveryByPath,
    runner.fs,
    scope.relativePaths,
    session.candidateSet.directories,
    runner.limits,
    () => !runnerExecutionStopped(runner),
  );
  if (
    directories.length === 0 ||
    !workspaceIndexDirectoriesAreCoherent(session.candidateSet, directories)
  ) {
    return undefined;
  }
  return { directories, fixedFileSelection: false };
}

function workspaceIndexSessionSnapshot(
  scope: SearchScope,
  runner: SearchTextRunner,
  session: Omit<SearchWorkspaceIndexSession, "persist">,
  directories: readonly WorkspaceIndexDirectorySnapshot[],
): WorkspaceIndexSnapshot {
  return buildWorkspaceIndexSnapshot({
    scope: workspaceIndexSnapshotScope(scope, runner),
    policy: workspaceIndexPolicyShape(runner),
    maxBytesPerFileScanned: runner.limits.maxBytesPerFileScanned,
    maxFilesScanned: runner.limits.maxFilesScanned,
    discovery: candidateSetDiscoverySnapshot(
      session.candidateSet,
      [...session.discoveryByPath.values()],
      directories,
    ),
    records: session.recordByPath.values(),
  });
}

function fixedFileSnapshotIsCoherent(
  snapshot: WorkspaceIndexSnapshot,
  scope: SearchScope,
  runner: SearchTextRunner,
): boolean {
  const prepared = prepareWorkspaceIndexSnapshot(
    snapshot,
    scope.workspace,
    runner.fs,
    () => !runnerExecutionStopped(runner),
  );
  return (
    prepared.valid && !prepared.dirty && prepared.entries.length === snapshot.discovery.files.length
  );
}

// A persist attempt, once the caller below has committed to it (session dirty, runner still
// within budget, membership coherent), must settle -- successfully or by throwing -- inside this
// search's own lifetime rather than being abandoned mid-flight. Racing the await against the
// runner's derived elapsed-time deadline (the old behavior, shared with the load path via
// awaitRunnerOperation) only stops *awaiting* workspaceIndex.saveSnapshot; it cannot cancel the
// write already handed to the store. A 30ms-budget search whose save took 100ms was observed to
// report "timeout" at ~31ms while the commit landed on the backing store afterward, unseen by the
// caller that had already moved on (#3347, "Do not let index effects outlive a timed-out
// search"). Bound the wait only by an explicit external abort -- the same signal this runner
// already threads everywhere else -- never by the soft, derived elapsed-time deadline that a slow
// but healthy store can legitimately exceed. An abort still cannot cancel a write already in
// flight, so its eventual settlement is tracked here (never left an unhandled floating promise)
// and always reported as not-committed to the caller, which fences `session.dirty` against ever
// crediting a generation this attempt already gave up on.
async function awaitPersistedSave(
  signal: AbortSignal | undefined,
  operation: () => Promise<void>,
): Promise<boolean> {
  if (signal?.aborted === true) return false;
  const settled = operation().then(
    () => true,
    () => false,
  );
  if (signal === undefined) return await settled;
  return await new Promise<boolean>((resolvePersist) => {
    const onAbort = (): void => {
      resolvePersist(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void settled.then((ok) => {
      signal.removeEventListener("abort", onAbort);
      resolvePersist(ok);
    });
  });
}

function persistWorkspaceIndexSession(
  workspaceIndex: WorkspaceIndex,
  scope: SearchScope,
  session: Omit<SearchWorkspaceIndexSession, "persist">,
): (runner: SearchTextRunner) => Promise<void> {
  return async (runner): Promise<void> => {
    if (!session.dirty || runnerExecutionStopped(runner)) {
      return;
    }
    const scopeKey = workspaceIndexScopeKey(scope, runner);
    const membership = workspaceIndexPersistenceMembership(scope, session, runner);
    if (membership === undefined || runnerExecutionStopped(runner)) return;
    const snapshot = workspaceIndexSessionSnapshot(scope, runner, session, membership.directories);
    if (
      (membership.fixedFileSelection && !fixedFileSnapshotIsCoherent(snapshot, scope, runner)) ||
      runnerExecutionStopped(runner)
    ) {
      return;
    }
    try {
      const committed = await awaitPersistedSave(runner.signal, () =>
        workspaceIndex.saveSnapshot(scopeKey, snapshot),
      );
      if (committed) session.dirty = false;
    } catch {
      // The workspace index is an opportunistic acceleration layer; search correctness must not
      // depend on the runtime cache directory being writable.
    }
  };
}

function runnerExecutionStopped(runner: SearchTextRunner): boolean {
  return runner.signal?.aborted === true || isRunnerTimedOut(runner);
}

type RunnerOperationResult<T> =
  { readonly status: "completed"; readonly value: T } | { readonly status: "stopped" };

async function awaitRunnerOperation<T>(
  runner: SearchTextRunner,
  operation: () => Promise<T>,
): Promise<RunnerOperationResult<T>> {
  const remainingMs = remainingRunnerTimeMs(runner);
  if (runner.signal?.aborted === true || remainingMs <= 0) return { status: "stopped" };
  let removeAbortListener = (): void => undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<RunnerOperationResult<T>>((resolve) => {
    const onAbort = (): void => {
      resolve({ status: "stopped" });
    };
    runner.signal?.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = (): void => {
      runner.signal?.removeEventListener("abort", onAbort);
    };
    if (runner.signal?.aborted === true) onAbort();
    timeout = setTimeout(onAbort, Math.min(Math.ceil(remainingMs), 2_147_483_647));
    timeout.unref();
  });
  const completed = Promise.resolve().then(async (): Promise<RunnerOperationResult<T>> => {
    if (runnerExecutionStopped(runner)) return { status: "stopped" };
    const value = await operation();
    return runnerExecutionStopped(runner) ? { status: "stopped" } : { status: "completed", value };
  });
  try {
    return await Promise.race([completed, stopped]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbortListener();
  }
}

interface LoadedWorkspaceIndexState {
  readonly prepared: PreparedWorkspaceIndexSnapshot | undefined;
  readonly deltas: readonly WorkspaceIndexDirectoryDelta[];
  readonly directorySnapshots: readonly WorkspaceIndexDirectorySnapshot[];
}

function prepareLoadedWorkspaceIndex(
  snapshot: WorkspaceIndexSnapshot | undefined,
  scope: SearchScope,
  runner: SearchTextRunner,
): LoadedWorkspaceIndexState | undefined {
  if (snapshot === undefined) return { prepared: undefined, deltas: [], directorySnapshots: [] };
  const shouldContinue = (): boolean => !runnerExecutionStopped(runner);
  const livePrepared = prepareWorkspaceIndexSnapshot(
    snapshot,
    scope.workspace,
    runner.fs,
    shouldContinue,
  );
  if (!shouldContinue()) return undefined;
  const inspection = inspectWorkspaceIndexDirectories(
    snapshot,
    scope.workspace,
    runner.fs,
    shouldContinue,
  );
  if (!shouldContinue()) return undefined;
  return {
    prepared: livePrepared.valid && inspection.valid ? livePrepared : undefined,
    deltas: inspection.deltas,
    directorySnapshots: inspection.snapshots,
  };
}

async function buildSearchWorkspaceIndexSession(
  scope: SearchScope,
  query: RetrievalQuery,
  runner: SearchTextRunner,
  limits: SearchLimits,
  workspaceIndex: WorkspaceIndex,
  candidateSetFor?: CandidateSetProvider,
): Promise<SearchWorkspaceIndexSession | undefined> {
  const loaded = await awaitRunnerOperation(runner, () =>
    loadWorkspaceIndexSnapshot(workspaceIndex, scope, runner),
  );
  if (loaded.status === "stopped") return undefined;
  if (runnerExecutionStopped(runner)) return undefined;
  const loadedState = prepareLoadedWorkspaceIndex(loaded.value, scope, runner);
  if (loadedState === undefined) return undefined;
  const { prepared, deltas, directorySnapshots } = loadedState;
  const session = initialWorkspaceIndexSessionState(
    scope,
    query,
    runner,
    limits,
    prepared,
    candidateSetFor,
  );
  if (prepared !== undefined && deltas.length > 0) {
    const applied = applyWorkspaceIndexDeltas(session, prepared, deltas, {
      scope,
      query,
      runner,
      limits,
      candidateSetFor,
    });
    if (!applied) return undefined;
  }
  if (prepared !== undefined && directorySnapshots.length > 0) {
    session.candidateSet = { ...session.candidateSet, directorySnapshots };
  }
  if (runnerExecutionStopped(runner)) return undefined;
  return Object.assign(session, {
    persist: persistWorkspaceIndexSession(workspaceIndex, scope, session),
  });
}

const MATCH_DIVERSITY_FILE_RESERVE = 12;

interface FileMatchEmissionPlan {
  readonly reserved: readonly FileMatches[];
  readonly remaining: readonly FileMatches[];
}

function strongestFileLine(match: FileMatches): FileMatches["best"][number] | undefined {
  return [...match.best].sort(
    (a, b) => b.score - a.score || a.startLine - b.startLine || a.endLine - b.endLine,
  )[0];
}

function fileLineMaxScore(lines: FileMatches["best"]): number {
  return lines.reduce((max, line) => Math.max(max, line.score), 0);
}

function shouldReserveFileDiversity(runner: SearchTextRunner): boolean {
  return (
    runner.query.kind === "natural-language" &&
    (runner.policy.intent === "targeted-code-search" ||
      runner.policy.intent === "diagnostic-search")
  );
}

function planFileMatchEmission(
  matches: readonly FileMatches[],
  runner: SearchTextRunner,
): FileMatchEmissionPlan {
  if (!shouldReserveFileDiversity(runner)) return { reserved: [], remaining: matches };
  const reserveCount = Math.min(
    MATCH_DIVERSITY_FILE_RESERVE,
    runner.limits.maxMatchesReturned,
    matches.length,
  );
  const reserved: FileMatches[] = [];
  const remaining: FileMatches[] = [];
  const byCandidateOrder = [...matches].sort((a, b) => a.order - b.order);
  for (const [index, match] of byCandidateOrder.entries()) {
    const strongest = index < reserveCount ? strongestFileLine(match) : undefined;
    if (strongest === undefined) {
      remaining.push(match);
      continue;
    }
    reserved.push({ ...match, best: [strongest], maxScore: strongest.score });
    const rest = match.best.filter((line) => line !== strongest);
    if (rest.length > 0) remaining.push({ ...match, best: rest, maxScore: fileLineMaxScore(rest) });
  }
  return { reserved, remaining };
}

async function runScanLoop(
  runner: SearchTextRunner,
  candidateSet: CandidateSet,
  state: RunState,
  atoms: EvidenceAtom[],
  candidates: CandidateFile[],
): Promise<void> {
  const matches: FileMatches[] = [];
  let loopIndex = 0;
  const scanLimit = effectiveScanCandidateLimit(runner, candidateSet.files.length);
  if (scanLimit < candidateSet.files.length) {
    state.truncated = true;
  }
  for (const file of candidateSet.files.slice(0, scanLimit)) {
    if (hitScanLimit(runner, state)) {
      break;
    }
    loopIndex += 1;
    if (loopIndex % SCAN_YIELD_INTERVAL === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (hitScanLimit(runner, state)) {
        break;
      }
    }
    const fileMatches = await collectFileMatches(runner, file, state, candidates, loopIndex);
    if (fileMatches !== undefined) {
      matches.push(fileMatches);
    }
  }
  const emission = planFileMatchEmission(matches, runner);
  for (const fileMatches of emission.reserved) {
    emitFileMatches(runner, state, atoms, fileMatches);
  }
  const remaining = [...emission.remaining].sort(
    (a, b) =>
      Number(b.definitionMatch === true) - Number(a.definitionMatch === true) ||
      b.maxScore - a.maxScore ||
      a.order - b.order,
  );
  for (const fileMatches of remaining) {
    emitFileMatches(runner, state, atoms, fileMatches);
  }
}

function assertSearchTextQuery(query: RetrievalQuery): void {
  assertQuery(query);
  if (query.kind === "file-pattern") {
    throw new RepoSearchInvalidQueryError("searchText does not accept file-pattern queries");
  }
}

function buildRunState(candidateSet: CandidateSet): RunState {
  return {
    filesScanned: 0,
    matchesReturned: 0,
    oversizedFilesScanned: 0,
    truncated: candidateSet.truncated,
  };
}

function remainingRunnerTimeMs(runner: SearchTextRunner): number {
  const currentMs = runner.nowMs();
  return Math.max(0, runnerDeadlineAtMs(runner) - currentMs);
}

function runnerDeadlineAtMs(runner: SearchTextRunner): number {
  const relativeDeadlineAtMs = runner.startMs + Math.max(0, runner.limits.elapsedMsMax);
  return Math.min(runner.deadlineAtMs ?? relativeDeadlineAtMs, relativeDeadlineAtMs);
}

function runnerExecutionControl(runner: SearchTextRunner): {
  readonly nowMs: () => number;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal | undefined;
} {
  return {
    nowMs: runner.nowMs,
    deadlineAtMs: runnerDeadlineAtMs(runner),
    ...(runner.signal === undefined ? {} : { signal: runner.signal }),
  };
}

function runnerStopReason(runner: SearchTextRunner): "aborted" | "timeout" | undefined {
  if (runner.signal?.aborted === true) return "aborted";
  return remainingRunnerTimeMs(runner) <= 0 ? "timeout" : undefined;
}

function markRunnerStop(state: RunState, reason: "aborted" | "timeout"): void {
  state.truncated = true;
  state.truncationReasons ??= new Set<ContextCoverageTruncationReason>();
  state.truncationReasons.add(reason);
}

async function collectSearchTextAtoms(
  runner: SearchTextRunner,
  candidateSet: CandidateSet,
  state: RunState = buildRunState(candidateSet),
): Promise<SearchTextCollection> {
  const atoms: EvidenceAtom[] = [];
  const candidates: CandidateFile[] = [];
  await runScanLoop(runner, candidateSet, state, atoms, candidates);
  const lexicalAtoms = [...atoms];
  const stoppedAfterScan = runnerStopReason(runner);
  if (stoppedAfterScan !== undefined) markRunnerStop(state, stoppedAfterScan);
  const semanticState = { timedOut: false };
  const semanticMatches =
    stoppedAfterScan === undefined
      ? await runSemanticSearchSession(runner.semantic, runner.query, runner.signal, {
          timeoutMs: remainingRunnerTimeMs(runner),
          onTimeout: (): void => {
            semanticState.timedOut = true;
          },
        })
      : [];
  const stoppedAfterSemantic = semanticState.timedOut ? "timeout" : runnerStopReason(runner);
  if (stoppedAfterSemantic !== undefined) markRunnerStop(state, stoppedAfterSemantic);
  const acceptedSemanticMatches = stoppedAfterSemantic === undefined ? semanticMatches : [];
  const semanticAtoms = acceptedSemanticMatches.map((match) => semanticAtom(runner, match));
  const cap = Math.min(runner.limits.maxMatchesReturned, runner.query.maxResults);
  const mergedAtoms = mergeSearchAtoms(lexicalAtoms, semanticAtoms, cap);
  if (lexicalAtoms.length + semanticAtoms.length > mergedAtoms.length) {
    state.truncated = true;
  }
  state.matchesReturned = mergedAtoms.length;
  return {
    atoms: mergedAtoms,
    lexicalAtoms,
    semanticMatches: acceptedSemanticMatches,
    candidates,
    state,
  };
}

function shouldConsiderLowValueRescue(
  runner: SearchTextRunner,
  primary: SearchTextCollection,
): boolean {
  if (!runner.policy.omitLowValueWorkspaceFiles || primary.atoms.length > 0) {
    return false;
  }
  if (primary.state.filesScanned >= runner.limits.maxFilesScanned) {
    return false;
  }
  if (runner.query.kind === "exact-symbol") {
    return true;
  }
  return (
    runner.query.kind === "natural-language" &&
    runner.policy.intent !== "repository-overview" &&
    runner.policy.intent !== "project-metadata"
  );
}

function hasLowValueEvidenceSkipped(
  primary: SearchTextCollection,
  diagnostics: SearchDiagnostics,
): boolean {
  return (
    diagnostics.ignoredByDiscovery > 0 ||
    primary.candidates.some((candidate) => candidate.omitted === "generated")
  );
}

function remainingScanLimit(runner: SearchTextRunner, primary: SearchTextCollection): number {
  return Math.max(0, runner.limits.maxFilesScanned - primary.state.filesScanned);
}

function lowValueOnlyCandidateSet(
  candidateSet: CandidateSet,
  primaryPolicy: SearchPolicy,
): CandidateSet {
  return {
    ...candidateSet,
    files: candidateSet.files.filter(
      (file) => policyOmissionReason(file.relativePath, primaryPolicy) === "generated",
    ),
  };
}

function rescueRunner(runner: SearchTextRunner, maxFilesScanned: number): SearchTextRunner {
  return {
    ...runner,
    limits: { ...runner.limits, maxFilesScanned },
    policy: lowValueRescuePolicy(runner.policy),
    semantic: createSemanticSearchSession(runner.semantic?.provider, runner.query),
  };
}

function combineStates(primary: RunState, rescue: RunState): RunState {
  const truncationReasons = new Set<ContextCoverageTruncationReason>([
    ...(primary.truncationReasons ?? []),
    ...(rescue.truncationReasons ?? []),
  ]);
  return {
    filesScanned: primary.filesScanned + rescue.filesScanned,
    matchesReturned: primary.matchesReturned + rescue.matchesReturned,
    oversizedFilesScanned:
      (primary.oversizedFilesScanned ?? 0) + (rescue.oversizedFilesScanned ?? 0),
    truncated: primary.truncated || rescue.truncated,
    ...(truncationReasons.size > 0 ? { truncationReasons } : {}),
  };
}

function diagnosticsWithLowValueRescue(
  diagnostics: SearchDiagnostics,
  rescueFilesDiscovered: number,
  rescueFilesScanned: number,
): SearchDiagnostics {
  return {
    ...diagnostics,
    lowValueRescueFilesDiscovered: rescueFilesDiscovered,
    lowValueRescueFilesScanned: rescueFilesScanned,
  };
}

function mergeCollections(
  runner: SearchTextRunner,
  primary: SearchTextCollection,
  rescue: SearchTextCollection,
): SearchTextCollection {
  const cap = Math.min(runner.limits.maxMatchesReturned, runner.query.maxResults);
  const atoms = mergeSearchAtoms(primary.atoms, rescue.atoms, cap);
  const selectedPaths = new Set(atoms.map((atom) => atom.scopePath));
  return {
    atoms,
    lexicalAtoms: [...primary.lexicalAtoms, ...rescue.lexicalAtoms],
    semanticMatches: [...primary.semanticMatches, ...rescue.semanticMatches],
    candidates: [...primary.candidates, ...rescue.candidates].filter(
      (candidate) => !selectedPaths.has(candidate.scopePath),
    ),
    state: combineStates(primary.state, rescue.state),
  };
}

async function rescueLowValueEvidence(
  runner: SearchTextRunner,
  primarySet: CandidateSet,
  primary: SearchTextCollection,
  candidateSetFor: CandidateSetProvider | undefined,
): Promise<{ readonly collection: SearchTextCollection; readonly candidateSet: CandidateSet }> {
  const stopped = runnerStopReason(runner);
  if (stopped !== undefined) {
    markRunnerStop(primary.state, stopped);
    return { collection: primary, candidateSet: primarySet };
  }
  if (
    !shouldConsiderLowValueRescue(runner, primary) ||
    !hasLowValueEvidenceSkipped(primary, primarySet.diagnostics)
  ) {
    return { collection: primary, candidateSet: primarySet };
  }
  const maxFilesScanned = remainingScanLimit(runner, primary);
  const lowValueRunner = rescueRunner(runner, maxFilesScanned);
  const gatheredSet =
    candidateSetFor === undefined
      ? gatherCandidates(
          runner.scope,
          runner.query,
          lowValueRunner.limits,
          runner.fs,
          lowValueRunner.policy,
          runner.candidatePathPredicate,
          runnerExecutionControl(lowValueRunner),
        )
      : candidateSetFor(
          runner.query,
          lowValueRunner.limits,
          lowValueRunner.policy,
          runner.candidatePathPredicate,
        );
  const lowValueSet = lowValueOnlyCandidateSet(gatheredSet, runner.policy);
  if (lowValueSet.files.length === 0) {
    return emptyLowValueRescue(primarySet, primary);
  }
  const rescue = await collectSearchTextAtoms(
    lowValueRunner,
    lowValueSet,
    lowValueRescueState(lowValueSet, primary),
  );
  return {
    collection: mergeCollections(runner, primary, rescue),
    candidateSet: rescueCandidateSet(primarySet, lowValueSet, rescue),
  };
}

function emptyLowValueRescue(
  primarySet: CandidateSet,
  primary: SearchTextCollection,
): { readonly collection: SearchTextCollection; readonly candidateSet: CandidateSet } {
  return {
    collection: primary,
    candidateSet: {
      ...primarySet,
      diagnostics: diagnosticsWithLowValueRescue(primarySet.diagnostics, 0, 0),
    },
  };
}

function lowValueRescueState(lowValueSet: CandidateSet, primary: SearchTextCollection): RunState {
  return {
    filesScanned: 0,
    matchesReturned: 0,
    oversizedFilesScanned: 0,
    truncated: lowValueSet.truncated,
    truncationReasons: primary.state.truncationReasons,
  };
}

function rescueCandidateSet(
  primarySet: CandidateSet,
  lowValueSet: CandidateSet,
  rescue: SearchTextCollection,
): CandidateSet {
  return {
    ...primarySet,
    diagnostics: diagnosticsWithLowValueRescue(
      primarySet.diagnostics,
      lowValueSet.files.length,
      rescue.state.filesScanned,
    ),
  };
}

interface CompletedSearchResultInputs {
  readonly atoms: readonly EvidenceAtom[];
  readonly candidates: readonly CandidateFile[];
  readonly filesScanned: number;
  readonly oversizedFilesScanned: number;
  readonly matchesReturned: number;
  readonly elapsedMs: number;
  readonly truncated: boolean;
  readonly diagnostics: SearchDiagnostics;
  readonly limits: SearchLimits;
  readonly candidateTruncated: boolean;
  readonly truncationReasons: ReadonlySet<ContextCoverageTruncationReason>;
  readonly workspaceIndex: WorkspaceIndexPreparationReport | undefined;
}

function completedSearchResult(inputs: CompletedSearchResultInputs): SearchResult {
  return {
    atoms: inputs.atoms,
    candidates: inputs.candidates,
    filesScanned: inputs.filesScanned,
    oversizedFilesScanned: inputs.oversizedFilesScanned,
    elapsedMs: inputs.elapsedMs,
    truncated: inputs.truncated,
    diagnostics: inputs.diagnostics,
    coverage: buildCoverageDiagnostics({
      diagnostics: inputs.diagnostics,
      filesScanned: inputs.filesScanned,
      oversizedFilesScanned: inputs.oversizedFilesScanned,
      matchesReturned: inputs.matchesReturned,
      elapsedMs: inputs.elapsedMs,
      limits: inputs.limits,
      candidates: inputs.candidates,
      candidateTruncated: inputs.candidateTruncated,
      truncationReasons: inputs.truncationReasons,
    }),
    workspaceIndex: inputs.workspaceIndex,
  };
}

function buildSearchTextDeps(deps: FacadeDeps): SearchTextRunnerDeps {
  return {
    queryInterpretation: deps.queryInterpretation,
    fs: deps.fs ?? nodeWorkspaceFs,
    nowMs: deps.nowMs ?? Date.now,
    ...(deps.candidatePathGlobs === undefined
      ? {}
      : { candidatePathGlobs: deps.candidatePathGlobs }),
    ...(deps.candidateContentFor === undefined
      ? {}
      : { candidateContentFor: deps.candidateContentFor }),
    ...(deps.searchHints !== undefined ? { searchHints: deps.searchHints } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    ...(deps.deadlineAtMs !== undefined ? { deadlineAtMs: deps.deadlineAtMs } : {}),
    ...(deps.semanticSearchProvider !== undefined
      ? { semanticSearchProvider: deps.semanticSearchProvider }
      : {}),
    ...(deps.contentLane !== undefined ? { contentLane: deps.contentLane } : {}),
  };
}

function searchTextRunner(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  deps: FacadeDeps,
): SearchTextRunner {
  const runner = buildSearchTextRunner(scope, query, limits, buildSearchTextDeps(deps));
  return {
    ...runner,
    fs: executionControlledWorkspaceFs(runner.fs, runnerExecutionControl(runner)),
  };
}

function candidateSetForSearch(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  runner: SearchTextRunner,
  session: SearchWorkspaceIndexSession | undefined,
  candidateSetFor: CandidateSetProvider | undefined,
): CandidateSet {
  if (session !== undefined) {
    return filterCandidateSet(session.candidateSet, runner.candidatePathPredicate);
  }
  return candidateSetFor === undefined
    ? gatherCandidates(
        scope,
        query,
        limits,
        runner.fs,
        runner.policy,
        runner.candidatePathPredicate,
        runnerExecutionControl(runner),
      )
    : candidateSetFor(query, limits, runner.policy, runner.candidatePathPredicate);
}

function filterCandidateSet(
  candidateSet: CandidateSet,
  predicate: SearchTextRunner["candidatePathPredicate"],
): CandidateSet {
  if (predicate === undefined) return candidateSet;
  const files = candidateSet.files.filter((file) => predicate(file.relativePath));
  return {
    ...candidateSet,
    files,
    diagnostics: { ...candidateSet.diagnostics, filesAfterPolicy: files.length },
  };
}

function preparedEntryForRecord(
  runner: SearchTextRunner,
  record: WorkspaceIndexRecord,
): PreparedWorkspaceIndexEntry {
  return {
    scopePath: record.scopePath,
    absolutePath: resolveWithinWorkspace(runner.scope.workspace.root, record.scopePath),
    file: { relativePath: record.scopePath, sizeBytes: record.sizeBytes },
    ...(record.mtimeMs === undefined ? {} : { mtimeMs: record.mtimeMs }),
    ...(record.fileIdentityHash === undefined ? {} : { fileIdentityHash: record.fileIdentityHash }),
    ...(record.mtimeNs === undefined ? {} : { mtimeNs: record.mtimeNs }),
    ...(record.ctimeNs === undefined ? {} : { ctimeNs: record.ctimeNs }),
    ...(record.hardLinkCount === undefined ? {} : { hardLinkCount: record.hardLinkCount }),
    record,
    stale: false,
  };
}

function sessionDiscoveryFiles(
  session: SearchWorkspaceIndexSession,
): readonly WorkspaceIndexDiscoveredFile[] {
  return session.candidateSet.files.map(
    (file) =>
      session.discoveryByPath.get(file.relativePath) ??
      discoveredFileSnapshot(file.relativePath, file.sizeBytes),
  );
}

function snapshotForSessionRanking(
  scope: SearchScope,
  runner: SearchTextRunner,
  session: SearchWorkspaceIndexSession,
): WorkspaceIndexSnapshot {
  return buildWorkspaceIndexSnapshot({
    scope: workspaceIndexSnapshotScope(scope, runner),
    policy: workspaceIndexPolicyShape(runner),
    maxBytesPerFileScanned: runner.limits.maxBytesPerFileScanned,
    maxFilesScanned: runner.limits.maxFilesScanned,
    discovery: candidateSetDiscoverySnapshot(
      session.candidateSet,
      sessionDiscoveryFiles(session),
      session.candidateSet.directorySnapshots ?? [],
    ),
    records: session.recordByPath.values(),
  });
}

function preparedSessionRankingSnapshot(
  scope: SearchScope,
  runner: SearchTextRunner,
  session: SearchWorkspaceIndexSession,
): PreparedWorkspaceIndexSnapshot {
  return prepareCachedWorkspaceIndexSnapshot(
    snapshotForSessionRanking(scope, runner, session),
    scope.workspace,
  );
}

function preserveCandidateMembership(ranked: CandidateSet, membership: CandidateSet): CandidateSet {
  const memberPaths = new Set(membership.files.map((file) => file.relativePath));
  const files = ranked.files.filter((file) => memberPaths.has(file.relativePath));
  return {
    ...ranked,
    files,
    directories: membership.directories,
    directorySnapshots: membership.directorySnapshots,
    skippedSymbolicLinks: membership.skippedSymbolicLinks,
    truncated: membership.truncated,
    diagnostics: {
      ...ranked.diagnostics,
      filesDiscovered: membership.diagnostics.filesDiscovered,
      filesAfterPolicy: files.length,
      ignoredByDiscovery: membership.diagnostics.ignoredByDiscovery,
      deniedByDiscovery: membership.diagnostics.deniedByDiscovery,
      depthPrunedByDiscovery: membership.diagnostics.depthPrunedByDiscovery,
      maxFilesPrunedByDiscovery: membership.diagnostics.maxFilesPrunedByDiscovery,
    },
  };
}

function invalidateStaleCandidateContent(
  session: SearchWorkspaceIndexSession,
  drain: FacadeDeps["drainStaleCandidateContentPaths"],
): void {
  for (const scopePath of drain?.() ?? []) invalidateWorkspaceIndexEntry(session, scopePath);
}

function validateAndInvalidateCachedCandidateContent(
  session: SearchWorkspaceIndexSession,
  validate: FacadeDeps["validateCachedCandidateContent"],
  drain: FacadeDeps["drainStaleCandidateContentPaths"],
): void {
  try {
    validate?.();
  } finally {
    invalidateStaleCandidateContent(session, drain);
  }
}

interface WorkspaceIndexCandidateRefreshInputs {
  readonly scope: SearchScope;
  readonly query: RetrievalQuery;
  readonly limits: SearchLimits;
  readonly runner: SearchTextRunner;
  readonly session: SearchWorkspaceIndexSession;
  readonly candidateSetFor: CandidateSetProvider | undefined;
  readonly validateCachedCandidateContent: FacadeDeps["validateCachedCandidateContent"];
  readonly drainStaleCandidateContentPaths: FacadeDeps["drainStaleCandidateContentPaths"];
}

function refreshWorkspaceIndexCandidateSet(inputs: WorkspaceIndexCandidateRefreshInputs): boolean {
  const { scope, query, limits, runner, session, drainStaleCandidateContentPaths } = inputs;
  if (runnerExecutionStopped(runner)) return false;
  validateAndInvalidateCachedCandidateContent(
    session,
    inputs.validateCachedCandidateContent,
    drainStaleCandidateContentPaths,
  );
  if (runnerExecutionStopped(runner)) return false;
  const prepared = preparedSessionRankingSnapshot(scope, runner, session);
  const membership = session.candidateSet;
  const candidateSetFor = inputs.candidateSetFor;
  let ranked: CandidateSet;
  try {
    ranked =
      candidateSetFor !== undefined && needsLiveWorkspaceIndexCandidates(query, runner, prepared)
        ? candidateSetFor(query, limits, runner.policy, runner.candidatePathPredicate)
        : {
            ...workspaceIndexCandidateSet(prepared, query, runner.policy),
            skippedSymbolicLinks: membership.skippedSymbolicLinks,
          };
  } finally {
    invalidateStaleCandidateContent(session, drainStaleCandidateContentPaths);
  }
  if (runnerExecutionStopped(runner)) return false;
  session.candidateSet = preserveCandidateMembership(ranked, membership);
  return true;
}

function recordWorkspaceIndexEntry(
  runner: SearchTextRunner,
  session: SearchWorkspaceIndexSession,
  record: WorkspaceIndexRecord,
): void {
  const previousRecord = session.recordByPath.get(record.scopePath);
  const previousPrepared = session.preparedEntries.get(record.scopePath);
  const discovery = discoveredFileSnapshot(record.scopePath, record.sizeBytes, record);
  const previousDiscovery = session.discoveryByPath.get(record.scopePath);
  const invalidatedCachedRecord = session.invalidatedCachedRecords.delete(record.scopePath);
  const rebuiltCachedRecord =
    invalidatedCachedRecord || (previousPrepared?.record !== undefined && previousPrepared.stale);
  if (previousRecord === undefined && !rebuiltCachedRecord) {
    session.newlyIndexedRecords.add(record.scopePath);
  }
  if (
    rebuiltCachedRecord ||
    !sameWorkspaceIndexRecord(previousRecord, record) ||
    !sameDiscoveryFile(previousDiscovery, discovery)
  ) {
    if (rebuiltCachedRecord) session.rebuiltCachedRecords.add(record.scopePath);
    session.dirty = true;
    session.report = undefined;
  }
  session.recordByPath.set(record.scopePath, record);
  session.discoveryByPath.set(record.scopePath, discovery);
  session.preparedEntries.set(record.scopePath, preparedEntryForRecord(runner, record));
  session.pendingMissingPaths.delete(record.scopePath);
  session.pendingValidatedPaths.add(record.scopePath);
}

function invalidateWorkspaceIndexEntry(
  session: SearchWorkspaceIndexSession,
  scopePath: string,
): void {
  session.pendingValidatedPaths.delete(scopePath);
  session.pendingMissingPaths.add(scopePath);
  session.newlyIndexedRecords.delete(scopePath);
  const previousPrepared = session.preparedEntries.get(scopePath);
  const removedRecord = session.recordByPath.delete(scopePath);
  const removedPrepared = session.preparedEntries.delete(scopePath);
  if (removedRecord || previousPrepared?.record !== undefined) {
    session.invalidatedCachedRecords.add(scopePath);
  }
  if (removedRecord || removedPrepared) {
    session.dirty = true;
    session.report = undefined;
  }
}

function reconcileValidatedCandidateContent(
  session: SearchWorkspaceIndexSession | undefined,
  reconcile: FacadeDeps["reconcileCandidateContentEntries"],
): void {
  if (session === undefined) return;
  const entries = [...session.pendingValidatedPaths]
    .map((scopePath) => session.discoveryByPath.get(scopePath))
    .filter((entry): entry is WorkspaceIndexDiscoveredFile => entry !== undefined);
  const missingPaths = [...session.pendingMissingPaths];
  session.pendingValidatedPaths.clear();
  session.pendingMissingPaths.clear();
  if (reconcile !== undefined && (entries.length > 0 || missingPaths.length > 0)) {
    reconcile(entries, missingPaths);
  }
}

async function finalizeWorkspaceIndexSession(
  runner: SearchTextRunner,
  session: SearchWorkspaceIndexSession | undefined,
  deps: FacadeDeps,
): Promise<void> {
  reconcileValidatedCandidateContent(session, deps.reconcileCandidateContentEntries);
  await persistSearchTextSession(runner, session);
}

function indexedSearchRunner(
  runner: SearchTextRunner,
  session: SearchWorkspaceIndexSession | undefined,
): SearchTextRunner {
  if (session === undefined) return runner;
  return {
    ...runner,
    workspaceIndex: {
      entries: session.preparedEntries,
      onRecord: (record): void => {
        recordWorkspaceIndexEntry(runner, session, record);
      },
      onStale: (scopePath): void => {
        invalidateWorkspaceIndexEntry(session, scopePath);
      },
    },
  };
}

function searchRunState(candidateSet: CandidateSet): {
  readonly state: RunState;
  readonly truncationReasons: Set<ContextCoverageTruncationReason>;
} {
  const truncationReasons = new Set<ContextCoverageTruncationReason>();
  return {
    state: {
      filesScanned: 0,
      matchesReturned: 0,
      oversizedFilesScanned: 0,
      truncated: candidateSet.truncated,
      truncationReasons,
    },
    truncationReasons,
  };
}

function completedSearchTextResult(
  runner: SearchTextRunner,
  candidateSet: CandidateSet,
  state: RunState,
  atoms: readonly EvidenceAtom[],
  candidates: readonly CandidateFile[],
  truncationReasons: ReadonlySet<ContextCoverageTruncationReason>,
  workspaceIndex: WorkspaceIndexPreparationReport | undefined,
): SearchResult {
  return completedSearchResult({
    atoms,
    candidates,
    filesScanned: state.filesScanned,
    oversizedFilesScanned: state.oversizedFilesScanned ?? 0,
    matchesReturned: state.matchesReturned,
    elapsedMs: elapsed(runner),
    truncated: state.truncated,
    diagnostics: candidateSet.diagnostics,
    limits: runner.limits,
    candidateTruncated: candidateSet.truncated,
    truncationReasons,
    workspaceIndex,
  });
}

function finalizedSearchTextResult(
  runner: SearchTextRunner,
  rescued: Awaited<ReturnType<typeof rescueLowValueEvidence>>,
  truncationReasons: ReadonlySet<ContextCoverageTruncationReason>,
  workspaceIndexSession: SearchWorkspaceIndexSession | undefined,
): SearchResult {
  const diagnostics = withSemanticRankingDiagnostics(
    rescued.candidateSet.diagnostics,
    bestLexicalAtomsByPath(rescued.collection.lexicalAtoms),
    rescued.collection.semanticMatches,
  );
  const result = completedSearchTextResult(
    runner,
    { ...rescued.candidateSet, diagnostics },
    rescued.collection.state,
    rescued.collection.atoms,
    rescued.collection.candidates,
    truncationReasons,
    workspaceIndexReport(workspaceIndexSession),
  );
  rollForwardWorkspaceIndexReport(workspaceIndexSession);
  return result;
}

async function executeSearchTextWithSession(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  deps: FacadeDeps,
  runner: SearchTextRunner,
  workspaceIndexSession: SearchWorkspaceIndexSession | undefined,
): Promise<SearchResult> {
  const searchRunner = indexedSearchRunner(runner, workspaceIndexSession);
  if (searchRunner.signal?.aborted === true) {
    return abortedSearchResult(elapsed(searchRunner), limits);
  }
  if (isRunnerTimedOut(searchRunner)) {
    return timedOutSearchResult(elapsed(searchRunner), limits);
  }
  const candidateSet = candidateSetForSearch(
    scope,
    query,
    limits,
    runner,
    workspaceIndexSession,
    deps.candidateSetFor,
  );
  if (isAborted(deps.signal)) {
    return abortedSearchResult(
      elapsed(searchRunner),
      limits,
      candidateSet.diagnostics,
      candidateSet.truncated,
    );
  }
  if (isRunnerTimedOut(searchRunner)) {
    return timedOutSearchResult(
      elapsed(searchRunner),
      limits,
      candidateSet.diagnostics,
      candidateSet.truncated,
    );
  }
  const { state, truncationReasons } = searchRunState(candidateSet);
  const primary = await collectSearchTextAtoms(searchRunner, candidateSet, state);
  const rescued = await rescueLowValueEvidence(
    searchRunner,
    candidateSet,
    primary,
    deps.candidateSetFor,
  );
  await finalizeWorkspaceIndexSession(searchRunner, workspaceIndexSession, deps);
  return finalizedSearchTextResult(searchRunner, rescued, truncationReasons, workspaceIndexSession);
}

async function executeSearchText(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  deps: FacadeDeps,
  runner: SearchTextRunner,
): Promise<SearchResult> {
  const workspaceIndexSession =
    deps.workspaceIndex === undefined || !workspaceIndexCompatibleRun(runner)
      ? undefined
      : await buildSearchWorkspaceIndexSession(
          scope,
          query,
          runner,
          limits,
          deps.workspaceIndex,
          deps.candidateSetFor,
        );
  return executeSearchTextWithSession(scope, query, limits, deps, runner, workspaceIndexSession);
}

interface SerializedWorkspaceIndexSession {
  session?: SearchWorkspaceIndexSession | undefined;
  tail: Promise<void>;
}

interface FailedRequestLocalSearchTextSessionPool {
  readonly error: unknown;
}

export interface RequestLocalSearchTextSessionPool {
  readonly searchText: (
    scope: SearchScope,
    query: RetrievalQuery,
    limits: SearchLimits,
    deps?: FacadeDeps,
  ) => Promise<SearchResult>;
}

function requestLocalSessionKey(
  scope: SearchScope,
  limits: SearchLimits,
  deps: FacadeDeps,
): string | undefined {
  const policy = resolveSearchPolicy(scope.relativePaths.length > 0, deps.searchHints);
  if (
    deps.contentLane === "editor" ||
    policy.lowValuePathAllowlist.length > 0 ||
    policy.recentPaths.length > 0
  ) {
    return undefined;
  }
  return JSON.stringify([
    buildWorkspaceIndexScopeKey(
      scope,
      {
        policyMode: policy.mode,
        applyGitignore: policy.applyGitignore,
        omitLowValueWorkspaceFiles: policy.omitLowValueWorkspaceFiles,
      },
      limits.maxBytesPerFileScanned,
      limits.maxFilesScanned,
    ),
    deps.candidatePathGlobs ?? null,
  ]);
}

function enqueueWorkspaceIndexSearch<T>(
  entry: SerializedWorkspaceIndexSession,
  task: () => Promise<T>,
): Promise<T> {
  const result = entry.tail.then(task, task);
  entry.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

class DefaultRequestLocalSearchTextSessionPool implements RequestLocalSearchTextSessionPool {
  private readonly fallbackWorkspaceIndex = createWorkspaceIndex();
  private readonly sessions = new WeakMap<
    WorkspaceFs,
    WeakMap<WorkspaceIndex, Map<string, SerializedWorkspaceIndexSession>>
  >();
  private failed: FailedRequestLocalSearchTextSessionPool | undefined;

  private assertActive(): void {
    if (this.failed !== undefined) throw this.failed.error;
  }

  private fail(
    entry: SerializedWorkspaceIndexSession | undefined,
    error: unknown,
  ): FailedRequestLocalSearchTextSessionPool {
    if (entry !== undefined) entry.session = undefined;
    this.failed ??= { error };
    return this.failed;
  }
  private entry(
    fs: WorkspaceFs,
    workspaceIndex: WorkspaceIndex,
    key: string,
  ): SerializedWorkspaceIndexSession {
    let byIndex = this.sessions.get(fs);
    if (byIndex === undefined) {
      byIndex = new WeakMap();
      this.sessions.set(fs, byIndex);
    }
    let byKey = byIndex.get(workspaceIndex);
    if (byKey === undefined) {
      byKey = new Map();
      byIndex.set(workspaceIndex, byKey);
    }
    const existing = byKey.get(key);
    if (existing !== undefined) return existing;
    const created: SerializedWorkspaceIndexSession = { tail: Promise.resolve() };
    byKey.set(key, created);
    return created;
  }

  private async runQueuedSearch(
    entry: SerializedWorkspaceIndexSession,
    scope: SearchScope,
    query: RetrievalQuery,
    limits: SearchLimits,
    deps: FacadeDeps,
    workspaceIndex: WorkspaceIndex,
  ): Promise<SearchResult> {
    let runner: SearchTextRunner | undefined;
    try {
      this.assertActive();
      runner = searchTextRunner(scope, query, limits, deps);
      if (isAborted(deps.signal)) return abortedSearchResult(elapsed(runner), limits);
      if (isRunnerTimedOut(runner)) return timedOutSearchResult(elapsed(runner), limits);
      if (entry.session === undefined) {
        entry.session = await buildSearchWorkspaceIndexSession(
          scope,
          query,
          runner,
          limits,
          workspaceIndex,
          deps.candidateSetFor,
        );
      } else if (
        !refreshWorkspaceIndexCandidateSet({
          scope,
          query,
          limits,
          runner,
          session: entry.session,
          candidateSetFor: deps.candidateSetFor,
          validateCachedCandidateContent: deps.validateCachedCandidateContent,
          drainStaleCandidateContentPaths: deps.drainStaleCandidateContentPaths,
        })
      ) {
        return stoppedSearchResult(runnerStopReason(runner) ?? "timeout", elapsed(runner), limits);
      }
      return await executeSearchTextWithSession(scope, query, limits, deps, runner, entry.session);
    } catch (error) {
      if (error instanceof StructuralExecutionStoppedError && runner !== undefined) {
        return stoppedSearchResult(error.reason, elapsed(runner), limits);
      }
      throw this.fail(entry, error).error;
    }
  }

  public async searchText(
    scope: SearchScope,
    query: RetrievalQuery,
    limits: SearchLimits,
    deps: FacadeDeps = {},
  ): Promise<SearchResult> {
    try {
      this.assertActive();
      assertWorkspaceRoot(scope.workspace);
      assertSearchTextQuery(query);
      validateSearchScopeRelativePaths(scope.relativePaths);
      const fs = deps.fs ?? nodeWorkspaceFs;
      const key = requestLocalSessionKey(scope, limits, deps);
      const workspaceIndex = deps.workspaceIndex ?? this.fallbackWorkspaceIndex;
      if (key === undefined) {
        return await searchText(scope, query, limits, deps);
      }
      const entry = this.entry(fs, workspaceIndex, key);
      return await enqueueWorkspaceIndexSearch(entry, () =>
        this.runQueuedSearch(entry, scope, query, limits, deps, workspaceIndex),
      );
    } catch (error) {
      if (error instanceof StructuralExecutionStoppedError) throw error;
      throw this.fail(undefined, error).error;
    }
  }
}

export function createRequestLocalSearchTextSessionPool(): RequestLocalSearchTextSessionPool {
  return new DefaultRequestLocalSearchTextSessionPool();
}

function bestLexicalAtomsByPath(
  atoms: readonly EvidenceAtom[],
): readonly { readonly scopePath: string; readonly score: number }[] {
  const best = new Map<string, number>();
  for (const atom of atoms) {
    if (atom.provenance.kind !== "lexical-search") {
      continue;
    }
    best.set(atom.scopePath, Math.max(best.get(atom.scopePath) ?? 0, atom.score));
  }
  return [...best.entries()].map(([scopePath, score]) => ({ scopePath, score }));
}

function semanticAtomLineRange(
  match: SemanticSearchMatch,
): { readonly startLine: number; readonly endLine: number } | undefined {
  return match.line === undefined ? undefined : { startLine: match.line, endLine: match.line };
}

function semanticAtom(runner: SearchTextRunner, match: SemanticSearchMatch): EvidenceAtom {
  const tool = semanticSearchTool(runner.semantic?.provider.name ?? "disabled");
  return buildAtom({
    scopeId: runner.scope.scopeId,
    scopePath: match.scopePath,
    lineRange: semanticAtomLineRange(match),
    provenanceKind: "model-rerank",
    tool,
    queryFingerprint: runner.fingerprint,
    score: match.score,
    emittedAtMs: runner.nowMs(),
  });
}

async function persistSearchTextSession(
  runner: SearchTextRunner,
  session: SearchWorkspaceIndexSession | undefined,
): Promise<void> {
  if (session !== undefined && runner.signal?.aborted !== true && !isRunnerTimedOut(runner)) {
    await session.persist(runner);
  }
}

function workspaceIndexReport(
  session: SearchWorkspaceIndexSession | undefined,
): WorkspaceIndexPreparationReport | undefined {
  if (session === undefined) {
    return undefined;
  }
  if (
    session.report !== undefined &&
    (!session.dirty ||
      session.report.deletedEntries > 0 ||
      session.report.droppedRecords > 0 ||
      session.report.staleRecords > 0)
  ) {
    return session.report;
  }
  const reusedRecords = [...session.preparedEntries.values()].filter(
    (entry) =>
      entry.record !== undefined &&
      !entry.stale &&
      session.recordByPath.has(entry.scopePath) &&
      !session.rebuiltCachedRecords.has(entry.scopePath) &&
      !session.invalidatedCachedRecords.has(entry.scopePath) &&
      !session.newlyIndexedRecords.has(entry.scopePath),
  ).length;
  const staleRecords = new Set([
    ...session.rebuiltCachedRecords,
    ...session.invalidatedCachedRecords,
    ...[...session.preparedEntries.values()]
      .filter((entry) => entry.record !== undefined && entry.stale)
      .map((entry) => entry.scopePath),
  ]).size;
  return {
    discoveredEntries: session.candidateSet.diagnostics.filesDiscovered,
    retainedEntries: session.discoveryByPath.size,
    indexedRecords: session.recordByPath.size,
    reusedRecords,
    staleRecords,
    skippedEntries: Math.max(
      0,
      session.candidateSet.diagnostics.filesDiscovered - session.discoveryByPath.size,
    ),
    deletedEntries: 0,
    droppedRecords: 0,
  };
}

function rollForwardWorkspaceIndexReport(session: SearchWorkspaceIndexSession | undefined): void {
  if (session === undefined) return;
  session.invalidatedCachedRecords.clear();
  session.rebuiltCachedRecords.clear();
  session.newlyIndexedRecords.clear();
  session.report = undefined;
}

export async function searchText(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
  deps: FacadeDeps = {},
): Promise<SearchResult> {
  assertWorkspaceRoot(scope.workspace);
  assertSearchTextQuery(query);
  validateSearchScopeRelativePaths(scope.relativePaths);
  const runner = searchTextRunner(scope, query, limits, deps);
  if (isAborted(deps.signal)) {
    return abortedSearchResult(elapsed(runner), limits);
  }
  if (isRunnerTimedOut(runner)) {
    return timedOutSearchResult(elapsed(runner), limits);
  }
  try {
    return await executeSearchText(scope, query, limits, deps, runner);
  } catch (error) {
    if (error instanceof StructuralExecutionStoppedError) {
      return stoppedSearchResult(error.reason, elapsed(runner), limits);
    }
    throw error;
  }
}

interface FindFilesContext {
  readonly scope: SearchScope;
  readonly regex: RegExp;
  readonly fingerprint: string;
  readonly nowMs: () => number;
}

interface FindFilesState {
  readonly atoms: EvidenceAtom[];
  readonly candidates: CandidateFile[];
  filesScanned: number;
  truncated: boolean;
  readonly truncationReasons: Set<ContextCoverageTruncationReason>;
}

function emitFileListing(ctx: FindFilesContext, relativePath: string, atoms: EvidenceAtom[]): void {
  atoms.push(
    buildAtom({
      scopeId: ctx.scope.scopeId,
      scopePath: relativePath,
      lineRange: undefined,
      provenanceKind: "file-listing",
      tool: "repo.findFiles",
      queryFingerprint: ctx.fingerprint,
      score: 1,
      emittedAtMs: ctx.nowMs(),
    }),
  );
}

function hitFileListingLimit(
  state: FindFilesState,
  maxMatches: number,
  startMs: number,
  nowMs: () => number,
  limits: SearchLimits,
  deadlineAtMs: number | undefined,
  signal?: AbortSignal,
): boolean {
  if (isAborted(signal)) {
    state.truncationReasons.add("aborted");
    return true;
  }
  if (state.filesScanned >= limits.maxFilesScanned) {
    state.truncationReasons.add("file-cap");
    return true;
  }
  if (state.atoms.length >= maxMatches) {
    state.truncationReasons.add("match-cap");
    return true;
  }
  const currentMs = nowMs();
  if (
    (deadlineAtMs !== undefined && currentMs >= deadlineAtMs) ||
    currentMs - startMs > limits.elapsedMsMax
  ) {
    state.truncationReasons.add("timeout");
    return true;
  }
  return false;
}

function collectFileListings(
  ctx: FindFilesContext,
  candidateSet: CandidateSet,
  policy: SearchPolicy,
  inputs: {
    readonly limits: SearchLimits;
    readonly maxMatches: number;
    readonly startMs: number;
    readonly deadlineAtMs?: number | undefined;
    readonly signal?: AbortSignal;
  },
): FindFilesState {
  const state: FindFilesState = {
    atoms: [],
    candidates: [],
    filesScanned: 0,
    truncated: candidateSet.truncated,
    truncationReasons: new Set<ContextCoverageTruncationReason>(),
  };
  for (const file of candidateSet.files) {
    if (
      hitFileListingLimit(
        state,
        inputs.maxMatches,
        inputs.startMs,
        ctx.nowMs,
        inputs.limits,
        inputs.deadlineAtMs,
        inputs.signal,
      )
    ) {
      state.truncated = true;
      break;
    }
    if (isDenied(file.relativePath)) {
      state.candidates.push(buildCandidate(file.relativePath, "ignored"));
      continue;
    }
    const omitted = policyOmissionReason(file.relativePath, policy);
    if (omitted !== undefined) {
      state.candidates.push(buildCandidate(file.relativePath, omitted));
      continue;
    }
    state.filesScanned += 1;
    if (ctx.regex.test(file.relativePath)) {
      emitFileListing(ctx, file.relativePath, state.atoms);
    }
  }
  return state;
}

function selectedPathSet(atoms: readonly EvidenceAtom[]): ReadonlySet<string> {
  return new Set(atoms.map((atom) => atom.scopePath));
}

function omitSelectedCandidates(
  candidates: readonly CandidateFile[],
  selectedPaths: ReadonlySet<string>,
): CandidateFile[] {
  return candidates.filter((candidate) => !selectedPaths.has(candidate.scopePath));
}

function shouldConsiderLowValueFileListingRescue(
  policy: SearchPolicy,
  state: FindFilesState,
  candidateSet: CandidateSet,
  limits: SearchLimits,
): boolean {
  if (!policy.omitLowValueWorkspaceFiles || state.atoms.length > 0) {
    return false;
  }
  if (state.filesScanned >= limits.maxFilesScanned) {
    return false;
  }
  return (
    candidateSet.diagnostics.ignoredByDiscovery > 0 ||
    state.candidates.some((candidate) => candidate.omitted === "generated")
  );
}

function combineFileListingStates(primary: FindFilesState, rescue: FindFilesState): FindFilesState {
  const atoms = [...primary.atoms, ...rescue.atoms];
  const truncationReasons = new Set<ContextCoverageTruncationReason>([
    ...primary.truncationReasons,
    ...rescue.truncationReasons,
  ]);
  return {
    atoms,
    candidates: omitSelectedCandidates(
      [...primary.candidates, ...rescue.candidates],
      selectedPathSet(atoms),
    ),
    filesScanned: primary.filesScanned + rescue.filesScanned,
    truncated: primary.truncated || rescue.truncated,
    truncationReasons,
  };
}

function candidateSetWithLowValueRescueDiagnostics(
  primarySet: CandidateSet,
  lowValueSet: CandidateSet,
  rescueState: FindFilesState,
): CandidateSet {
  return {
    ...primarySet,
    diagnostics: diagnosticsWithLowValueRescue(
      primarySet.diagnostics,
      lowValueSet.files.length,
      rescueState.filesScanned,
    ),
  };
}

interface FileListingRescueInputs {
  readonly query: RetrievalQuery;
  readonly limits: SearchLimits;
  readonly fs: WorkspaceFs;
  readonly policy: SearchPolicy;
  readonly candidateSet: CandidateSet;
  readonly state: FindFilesState;
  readonly maxMatches: number;
  readonly startMs: number;
  readonly deadlineAtMs?: number | undefined;
  readonly candidateSetFor?: CandidateSetProvider | undefined;
  readonly signal?: AbortSignal | undefined;
}

function fileListingStopReason(
  ctx: FindFilesContext,
  inputs: FileListingRescueInputs,
): "aborted" | "timeout" | undefined {
  if (isAborted(inputs.signal)) return "aborted";
  const currentMs = ctx.nowMs();
  return (inputs.deadlineAtMs !== undefined && currentMs >= inputs.deadlineAtMs) ||
    currentMs - inputs.startMs > inputs.limits.elapsedMsMax
    ? "timeout"
    : undefined;
}

function stoppedFileListingRescue(
  inputs: FileListingRescueInputs,
  reason: "aborted" | "timeout",
): { readonly state: FindFilesState; readonly candidateSet: CandidateSet } {
  inputs.state.truncated = true;
  inputs.state.truncationReasons.add(reason);
  return { state: inputs.state, candidateSet: inputs.candidateSet };
}

function gatherLowValueFileCandidates(
  ctx: FindFilesContext,
  inputs: FileListingRescueInputs,
  limits: SearchLimits,
  policy: SearchPolicy,
): CandidateSet {
  if (inputs.candidateSetFor !== undefined) {
    return inputs.candidateSetFor(inputs.query, limits, policy);
  }
  return gatherCandidates(ctx.scope, inputs.query, limits, inputs.fs, policy, undefined, {
    nowMs: ctx.nowMs,
    deadlineAtMs: Math.min(
      inputs.deadlineAtMs ?? inputs.startMs + inputs.limits.elapsedMsMax,
      inputs.startMs + inputs.limits.elapsedMsMax,
    ),
    ...(inputs.signal === undefined ? {} : { signal: inputs.signal }),
  });
}

function rescueLowValueFileListings(
  ctx: FindFilesContext,
  inputs: FileListingRescueInputs,
): { readonly state: FindFilesState; readonly candidateSet: CandidateSet } {
  const stopReason = fileListingStopReason(ctx, inputs);
  if (stopReason !== undefined) return stoppedFileListingRescue(inputs, stopReason);
  if (
    !shouldConsiderLowValueFileListingRescue(
      inputs.policy,
      inputs.state,
      inputs.candidateSet,
      inputs.limits,
    )
  ) {
    return { state: inputs.state, candidateSet: inputs.candidateSet };
  }
  const maxFilesScanned = Math.max(0, inputs.limits.maxFilesScanned - inputs.state.filesScanned);
  const lowValuePolicy = lowValueRescuePolicy(inputs.policy);
  const lowValueLimits = { ...inputs.limits, maxFilesScanned };
  const gatheredSet = gatherLowValueFileCandidates(ctx, inputs, lowValueLimits, lowValuePolicy);
  const lowValueSet = lowValueOnlyCandidateSet(gatheredSet, inputs.policy);
  const rescueState = collectFileListings(ctx, lowValueSet, lowValuePolicy, {
    limits: lowValueLimits,
    maxMatches: inputs.maxMatches,
    startMs: inputs.startMs,
    ...(inputs.deadlineAtMs === undefined ? {} : { deadlineAtMs: inputs.deadlineAtMs }),
    ...(inputs.signal !== undefined ? { signal: inputs.signal } : {}),
  });
  return {
    state: combineFileListingStates(inputs.state, rescueState),
    candidateSet: candidateSetWithLowValueRescueDiagnostics(
      inputs.candidateSet,
      lowValueSet,
      rescueState,
    ),
  };
}

function fileListingResult(
  state: FindFilesState,
  candidateSet: CandidateSet,
  elapsedMs: number,
  limits: SearchLimits,
): SearchResult {
  return completedSearchResult({
    atoms: state.atoms,
    candidates: state.candidates,
    filesScanned: state.filesScanned,
    oversizedFilesScanned: 0,
    matchesReturned: state.atoms.length,
    elapsedMs,
    truncated: state.truncated,
    diagnostics: candidateSet.diagnostics,
    limits,
    candidateTruncated: candidateSet.truncated,
    truncationReasons: state.truncationReasons,
    workspaceIndex: undefined,
  });
}

function findFilesContext(
  scope: SearchScope,
  query: RetrievalQuery,
  nowMs: () => number,
): FindFilesContext {
  return {
    scope,
    regex: compileGlob(query.text, query.caseSensitive),
    fingerprint: fingerprintFor(query),
    nowMs,
  };
}

interface FindFilesExecutionInputs {
  readonly scope: SearchScope;
  readonly query: RetrievalQuery;
  readonly limits: SearchLimits;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly hints: SearchHints | undefined;
  readonly candidateSetFor: CandidateSetProvider | undefined;
  readonly deadlineAtMs: number | undefined;
  readonly signal: AbortSignal | undefined;
  readonly startMs: number;
}

function findFilesCandidateSet(
  inputs: FindFilesExecutionInputs,
  policy: SearchPolicy,
): CandidateSet {
  const { scope, query, limits, fs, nowMs, startMs, deadlineAtMs, signal, candidateSetFor } =
    inputs;
  return candidateSetFor === undefined
    ? gatherCandidates(scope, query, limits, fs, policy, undefined, {
        nowMs,
        deadlineAtMs: Math.min(
          deadlineAtMs ?? startMs + limits.elapsedMsMax,
          startMs + limits.elapsedMsMax,
        ),
        ...(signal === undefined ? {} : { signal }),
      })
    : candidateSetFor(query, limits, policy);
}

function effectiveFindFilesLimits(query: RetrievalQuery, limits: SearchLimits): SearchLimits {
  return {
    ...limits,
    maxMatchesReturned: Math.min(limits.maxMatchesReturned, query.maxResults),
  };
}

function executeFindFilesSync(inputs: FindFilesExecutionInputs): SearchResult {
  const { scope, query, limits, fs, nowMs, deadlineAtMs, signal, startMs } = inputs;
  const stopped = stoppedFindFilesResult(nowMs, startMs, limits, deadlineAtMs, signal);
  if (stopped !== undefined) return stopped;
  const effectiveLimits = effectiveFindFilesLimits(query, limits);
  const ctx = findFilesContext(scope, query, nowMs);
  const policy = resolveSearchPolicy(scope.relativePaths.length > 0, inputs.hints);
  const candidateSet = findFilesCandidateSet(inputs, policy);
  const stoppedAfterDiscovery = stoppedFindFilesResult(
    nowMs,
    startMs,
    limits,
    deadlineAtMs,
    signal,
    candidateSet,
  );
  if (stoppedAfterDiscovery !== undefined) return stoppedAfterDiscovery;
  return completeFindFilesSearch(ctx, candidateSet, policy, {
    query,
    limits,
    effectiveLimits,
    effectiveMaxMatches: effectiveLimits.maxMatchesReturned,
    fs,
    startMs,
    deadlineAtMs,
    candidateSetFor: inputs.candidateSetFor,
    signal,
  });
}

// The caller-supplied half of a find-files run: everything the execution inputs carry except the
// start timestamp, which `findFilesSync` takes itself so the elapsed budget is measured from the
// same clock read that anchors the execution control.
type FindFilesRequest = Omit<FindFilesExecutionInputs, "startMs">;

function findFilesSync(request: FindFilesRequest): SearchResult {
  const { limits, fs, nowMs, deadlineAtMs, signal } = request;
  const startMs = nowMs();
  const control: StructuralExecutionControl = {
    nowMs,
    deadlineAtMs: Math.min(
      deadlineAtMs ?? Number.POSITIVE_INFINITY,
      startMs + Math.max(0, limits.elapsedMsMax),
    ),
    ...(signal === undefined ? {} : { signal }),
  };
  const controlledFs = executionControlledWorkspaceFs(fs, control);
  try {
    return executeFindFilesSync({ ...request, fs: controlledFs, startMs });
  } catch (error) {
    if (error instanceof StructuralExecutionStoppedError) {
      return stoppedSearchResult(error.reason, nowMs() - startMs, limits);
    }
    throw error;
  }
}

function stoppedFindFilesResult(
  nowMs: () => number,
  startMs: number,
  limits: SearchLimits,
  deadlineAtMs: number | undefined,
  signal: AbortSignal | undefined,
  candidateSet?: CandidateSet,
): SearchResult | undefined {
  const elapsedMs = nowMs() - startMs;
  if (isAborted(signal)) {
    return abortedSearchResult(
      elapsedMs,
      limits,
      candidateSet?.diagnostics,
      candidateSet?.truncated,
    );
  }
  return absoluteDeadlineReached(nowMs, deadlineAtMs)
    ? timedOutSearchResult(
        nowMs() - startMs,
        limits,
        candidateSet?.diagnostics,
        candidateSet?.truncated,
      )
    : undefined;
}

interface CompleteFindFilesInputs {
  readonly query: RetrievalQuery;
  readonly limits: SearchLimits;
  readonly effectiveLimits: SearchLimits;
  readonly effectiveMaxMatches: number;
  readonly fs: WorkspaceFs;
  readonly startMs: number;
  readonly deadlineAtMs: number | undefined;
  readonly candidateSetFor: CandidateSetProvider | undefined;
  readonly signal: AbortSignal | undefined;
}

function completeFindFilesSearch(
  ctx: FindFilesContext,
  candidateSet: CandidateSet,
  policy: SearchPolicy,
  inputs: CompleteFindFilesInputs,
): SearchResult {
  const state = collectFileListings(ctx, candidateSet, policy, {
    limits: inputs.limits,
    maxMatches: inputs.effectiveMaxMatches,
    startMs: inputs.startMs,
    ...(inputs.deadlineAtMs === undefined ? {} : { deadlineAtMs: inputs.deadlineAtMs }),
    ...(inputs.signal !== undefined ? { signal: inputs.signal } : {}),
  });
  const rescued = rescueLowValueFileListings(ctx, {
    query: inputs.query,
    limits: inputs.limits,
    fs: inputs.fs,
    policy,
    candidateSet,
    state,
    maxMatches: inputs.effectiveMaxMatches,
    startMs: inputs.startMs,
    ...(inputs.deadlineAtMs === undefined ? {} : { deadlineAtMs: inputs.deadlineAtMs }),
    ...(inputs.candidateSetFor === undefined ? {} : { candidateSetFor: inputs.candidateSetFor }),
    ...(inputs.signal !== undefined ? { signal: inputs.signal } : {}),
  });
  return fileListingResult(
    rescued.state,
    rescued.candidateSet,
    ctx.nowMs() - inputs.startMs,
    inputs.effectiveLimits,
  );
}

export async function findFiles(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
  deps: FacadeDeps = {},
): Promise<SearchResult> {
  assertWorkspaceRoot(scope.workspace);
  assertQuery(query);
  validateSearchScopeRelativePaths(scope.relativePaths);
  if (query.kind !== "file-pattern") {
    throw new RepoSearchInvalidQueryError("findFiles requires a file-pattern query");
  }
  const fs = deps.fs ?? nodeWorkspaceFs;
  const nowMs = deps.nowMs ?? Date.now;
  return await Promise.resolve(
    findFilesSync({
      scope,
      query,
      limits,
      fs,
      nowMs,
      hints: deps.searchHints,
      candidateSetFor: deps.candidateSetFor,
      deadlineAtMs: deps.deadlineAtMs,
      signal: deps.signal,
    }),
  );
}

function buildExcerptFingerprint(request: ReadExcerptRequest): string {
  return fingerprintFor({
    kind: "natural-language",
    text: `${request.scopePath}:${request.startLine.toString()}-${request.endLine.toString()}`,
    caseSensitive: false,
    maxResults: 1,
    emittedAtMs: 0,
  });
}

function isWithinSelectedScope(scope: SearchScope, scopePath: string): boolean {
  if (scope.relativePaths.length === 0) {
    return true;
  }
  return scope.relativePaths.some(
    (selectedPath) => scopePath === selectedPath || scopePath.startsWith(`${selectedPath}/`),
  );
}

function normalizeScopePath(scopePath: string): string {
  return scopePath.replaceAll("\\", "/");
}

function assertExcerptWithinSelectedScope(scope: SearchScope, scopePath: string): void {
  if (isWithinSelectedScope(scope, scopePath)) {
    return;
  }
  throw new RepoSearchUnsupportedFileError(
    `cannot read excerpt outside selected scope: ${scopePath}`,
    "outside-scope",
  );
}

function resolveExcerptTarget(
  scope: SearchScope,
  scopePath: string,
  fs: WorkspaceFs,
): { readonly path: string; readonly realScopePath: string } {
  const abs = resolveWithinWorkspace(scope.workspace.root, scopePath);
  const contained = containedRealPathInfo(fs, scope.workspace.root, abs);
  const realScopePath = normalizeScopePath(contained.realRelative);
  if (
    !isCanonicalAllowedContainedPath(contained, scope.workspace.root, scopePath) &&
    isWithinSelectedScope(scope, realScopePath)
  ) {
    throw new RepoSearchUnsupportedFileError(
      `cannot read excerpt through a denied or non-canonical path: ${scopePath}`,
      "denied",
    );
  }
  return { path: contained.path, realScopePath };
}

function assertExcerptReadableByPolicy(requestPath: string, realScopePath: string): void {
  // Deny gates must fire BEFORE any byte read (incl. the binary probe) so that a denied path such
  // as .env is never read at all, including through an in-workspace symlink. .gitignore is not a
  // context policy boundary; safe ignored/dot files remain readable when the user scopes them in.
  if (isDenied(requestPath) || isDenied(realScopePath)) {
    throw new RepoSearchUnsupportedFileError(
      `cannot read excerpt of denied path: ${requestPath}`,
      "denied",
    );
  }
}

function assertExcerptRange(request: ReadExcerptRequest): void {
  if (
    !Number.isInteger(request.startLine) ||
    !Number.isInteger(request.endLine) ||
    request.startLine < 1 ||
    request.endLine < request.startLine
  ) {
    throw new RepoSearchInvalidRangeError(
      `invalid line range: ${request.startLine.toString()}-${request.endLine.toString()}`,
    );
  }
  if (
    !Number.isFinite(request.maxBytes) ||
    !Number.isInteger(request.maxBytes) ||
    request.maxBytes < 0
  ) {
    throw new RepoSearchInvalidRangeError(
      `invalid maxBytes: ${String(request.maxBytes)} (must be a finite non-negative integer)`,
    );
  }
  if (!isValidScopePath(request.scopePath, { mustBeRelative: true })) {
    throw new RepoSearchInvalidRangeError(`invalid scopePath: ${request.scopePath}`);
  }
}

// The single "this excerpt cannot be served, skip it" outcome of the excerpt read lane. Every
// producer below funnels a non-denial read failure through it so `readKeptExcerpts` in the
// grounded orchestrator drops exactly one excerpt instead of failing the whole answer.
function excerptUnreadable(scopePath: string): RepoSearchUnsupportedFileError {
  return new RepoSearchUnsupportedFileError(
    `cannot read excerpt of unreadable file: ${scopePath}`,
    "io-error",
  );
}

// Probes for binary content and throws RepoSearchUnsupportedFileError on both binary detection
// and IO errors (EACCES, ENOENT, …) so the caller can treat both as a graceful skip.
async function assertExcerptNotBinary(
  fs: WorkspaceFs,
  absolutePath: string,
  size: number,
  scopePath: string,
): Promise<void> {
  let isBinary: boolean;
  try {
    isBinary = await probeBinary(fs, absolutePath, size);
  } catch (err) {
    // TOCTOU: permissions or availability may change between stat and probe (EACCES, ENOENT, …).
    // Re-classify as an unsupported-file skip so readKeptExcerpts degrades gracefully instead
    // of crashing the whole grounded answer (the comment at grounded-orchestrator readKeptExcerpts
    // explicitly promises this invariant).
    if (isIoError(err) || err instanceof WorkspaceDescriptorReadError) {
      throw excerptUnreadable(scopePath);
    }
    throw err;
  }
  if (isBinary) {
    throw new RepoSearchUnsupportedFileError(
      `cannot read excerpt of binary file: ${scopePath}`,
      "binary",
    );
  }
}

// Line numbering has to agree with whatever lane produced the coordinates being read. `redact()`
// collapses a multi-line PEM block into a single token, so an excerpt taken from redacted text
// addresses different lines than the raw file: an editor-lane match at raw line N would be shown
// with the wrong source lines. The editor lane therefore splits RAW lines here and leaves masking to
// the surface that emits the excerpt (the BFF applies the live-payload redactor to the response).
function excerptFileLines(
  scope: SearchScope,
  request: ReadExcerptRequest,
  fs: WorkspaceFs,
  lane: WorkspaceContentLane,
): readonly string[] {
  const opts = { maxBytes: MAX_EXCERPT_FILE_BYTES };
  if (lane === "editor") {
    return readWorkspaceFileForEditing(scope.workspace, request.scopePath, opts, fs).rawText.split(
      "\n",
    );
  }
  return readWorkspaceFile(scope.workspace, request.scopePath, opts, fs).text.split("\n");
}

// Reads the bounded byte prefix of an oversized file. An IO failure of that probe is the same
// one-file, non-denial read outcome `readExcerptLines` degrades for a WorkspaceReadError, so it
// costs this excerpt alone; anything else keeps propagating.
async function excerptPrefixBytes(
  readFileBytes: NonNullable<WorkspaceFs["readFileBytes"]>,
  targetPath: string,
  expected: WorkspaceStat,
  scopePath: string,
): Promise<Uint8Array> {
  try {
    return await readFileBytes(targetPath, MAX_EXCERPT_FILE_BYTES, "reject", expected);
  } catch (readErr) {
    if (isIoError(readErr)) {
      throw excerptUnreadable(scopePath);
    }
    throw readErr;
  }
}

interface OversizedExcerptInputs {
  readonly request: ReadExcerptRequest;
  readonly fs: WorkspaceFs;
  readonly targetPath: string;
  readonly expected: WorkspaceStat;
  readonly lane: WorkspaceContentLane;
  // The budget error that sent the read down this path. It is rethrown unchanged whenever the
  // bounded prefix cannot answer the request, so a caller still sees the original file-too-large
  // outcome instead of a fallback-specific error it does not handle.
  readonly tooLarge: FileTooLargeError;
}

// The bounded fallback for a file that exceeded the excerpt read budget: decode the byte prefix the
// port can still serve, re-check the descriptor identity so a file rewritten mid-read is reported
// rather than mixed, and split the lines under the caller's lane (the editor lane keeps raw text —
// see the note on excerptFileLines about redaction shifting line coordinates).
async function oversizedExcerptLines(inputs: OversizedExcerptInputs): Promise<readonly string[]> {
  const { request, fs, targetPath, expected, lane, tooLarge } = inputs;
  const readFileBytes = fs.readFileBytes;
  if (readFileBytes === undefined) {
    throw tooLarge;
  }
  const bytes = await excerptPrefixBytes(readFileBytes, targetPath, expected, request.scopePath);
  const prefix = decodeUtf8Prefix(bytes);
  if (!isWorkspacePathSnapshotCurrent(fs, targetPath, targetPath, expected)) {
    throw new RepoSearchUnsupportedFileError("file changed during excerpt read", "io-error");
  }
  const lines = (lane === "editor" ? prefix : redact(prefix)).split("\n");
  if (request.startLine > lines.length) {
    throw tooLarge;
  }
  return lines;
}

async function readExcerptLines(
  scope: SearchScope,
  request: ReadExcerptRequest,
  fs: WorkspaceFs,
  targetPath: string,
  expected: WorkspaceStat,
  lane: WorkspaceContentLane,
): Promise<readonly string[]> {
  try {
    return excerptFileLines(scope, request, fs, lane);
  } catch (err) {
    // The guarded read lane serves content ONLY through the bounded same-descriptor primitive
    // (ADR-0005 D1). Everything it reports as a WorkspaceReadError — a port that does not offer
    // that primitive, a stat it cannot take, a path it cannot resolve, or a file whose identity
    // changed under the open descriptor — is a non-denial read outcome for ONE file, the same
    // class assertExcerptNotBinary re-classifies one call earlier. Degrade it to the same skip so
    // a concurrently rewritten (or unreadable) file costs its own excerpt instead of the whole
    // grounded answer. PathDeniedError/PathEscapeError are distinct types and still propagate.
    if (err instanceof WorkspaceReadError) {
      throw excerptUnreadable(request.scopePath);
    }
    if (!(err instanceof FileTooLargeError)) {
      throw err;
    }
    return await oversizedExcerptLines({
      request,
      fs,
      targetPath,
      expected,
      lane,
      tooLarge: err,
    });
  }
}

function assertExcerptStartWithinLines(
  request: ReadExcerptRequest,
  lines: readonly string[],
): void {
  if (request.startLine > lines.length) {
    throw new RepoSearchUnsupportedFileError(
      "cannot read excerpt outside the file line range",
      "outside-range",
    );
  }
}

// Slices the requested line window out of `allLines`, clamps it to the caller's byte budget, and
// reports the end line the clamped content actually reaches.
function excerptWindow(
  request: ReadExcerptRequest,
  allLines: readonly string[],
): { readonly content: string; readonly truncated: boolean; readonly endLine: number } {
  const sourceEndLine = Math.min(request.endLine, allLines.length);
  const slice = allLines.slice(request.startLine - 1, request.endLine).join("\n");
  const clamped = clampToBytes(slice, request.maxBytes);
  const returnedLineCount = clamped.excerpt.split("\n").length;
  return {
    content: clamped.excerpt,
    truncated: clamped.truncated,
    endLine: clamped.truncated
      ? Math.min(sourceEndLine, request.startLine + returnedLineCount - 1)
      : sourceEndLine,
  };
}

function excerptExecutionError(reason: "aborted" | "timeout"): RepoSearchUnsupportedFileError {
  return new RepoSearchUnsupportedFileError(`repo-search operation ${reason}`, reason);
}

async function readExcerptWithControl(
  scope: SearchScope,
  request: ReadExcerptRequest,
  deps: FacadeDeps,
  control: StructuralExecutionControl,
): Promise<ReadExcerptResult> {
  assertStructuralExecutionActive(control);
  assertExcerptRange(request);
  assertWorkspaceRoot(scope.workspace);
  assertExcerptWithinSelectedScope(scope, request.scopePath);
  if (isImageScopePath(request.scopePath)) {
    throw new RepoSearchUnsupportedFileError(
      `cannot read excerpt of image file: ${request.scopePath}`,
      "binary",
    );
  }
  const fs = executionControlledWorkspaceFs(deps.fs ?? nodeWorkspaceFs, control);
  const nowMs = deps.nowMs ?? Date.now;
  const target = resolveExcerptTarget(scope, request.scopePath, fs);
  assertExcerptReadableByPolicy(request.scopePath, target.realScopePath);
  assertExcerptWithinSelectedScope(scope, target.realScopePath);
  const stat = fs.stat(target.path);
  await assertExcerptNotBinary(fs, target.path, stat.size, request.scopePath);
  assertStructuralExecutionActive(control);
  // Read enough of the file to reach the requested line window (bounded by MAX_EXCERPT_FILE_BYTES),
  // then clamp the returned content to the caller's request.maxBytes budget. For files larger than
  // the read cap, the optional raw-byte port can still serve early windows from the bounded prefix.
  const allLines = await readExcerptLines(
    scope,
    request,
    fs,
    target.path,
    stat,
    deps.contentLane ?? "evidence",
  );
  if (!isWorkspacePathSnapshotCurrent(fs, target.path, target.path, stat)) {
    throw new RepoSearchUnsupportedFileError("file changed during excerpt read", "io-error");
  }
  assertStructuralExecutionActive(control);
  assertExcerptStartWithinLines(request, allLines);
  const window = excerptWindow(request, allLines);
  const atom = buildAtom({
    scopeId: scope.scopeId,
    scopePath: request.scopePath,
    lineRange: { startLine: request.startLine, endLine: window.endLine },
    provenanceKind: "excerpt-read",
    tool: "repo.readExcerpt",
    queryFingerprint: buildExcerptFingerprint(request),
    score: 1,
    emittedAtMs: nowMs(),
  });
  return { atom, content: window.content, truncated: window.truncated };
}

export async function readExcerpt(
  scope: SearchScope,
  request: ReadExcerptRequest,
  deps: FacadeDeps = {},
): Promise<ReadExcerptResult> {
  const nowMs = deps.nowMs ?? Date.now;
  const control: StructuralExecutionControl = {
    nowMs,
    deadlineAtMs: deps.deadlineAtMs ?? Number.POSITIVE_INFINITY,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  };
  try {
    return await readExcerptWithControl(scope, request, deps, control);
  } catch (error) {
    if (error instanceof StructuralExecutionStoppedError) {
      throw excerptExecutionError(error.reason);
    }
    throw error;
  }
}
