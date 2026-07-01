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
import { createHash } from "node:crypto";
import {
  isValidScopePath,
  validateRetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { readWorkspaceFile } from "./discovery.js";
import {
  RepoSearchInvalidQueryError,
  RepoSearchInvalidRangeError,
  RepoSearchUnsupportedFileError,
} from "./errors.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo } from "./realpath.js";
import { buildMatcher, compileGlob, fingerprintFor } from "./repoSearchMatchers.js";
import {
  buildAtom,
  buildCandidate,
  elapsed,
  gatherCandidates,
  hitLimit,
  isImageScopePath,
  isIoError,
  probeBinary,
  scanFile,
  type CandidateSet,
  type RunState,
  type SearchTextRunner,
} from "./repoSearchScan.js";
import {
  policyOmissionReason,
  resolveSearchPolicy,
  type SearchDiagnostics,
  type SearchHints,
} from "./repoSearchPolicy.js";
import type { WorkspaceInfo } from "./types.js";
import {
  buildWorkspaceIndexScopeKey,
  buildWorkspaceIndexSnapshot,
  isWorkspaceIndexSnapshotFresh,
  prepareWorkspaceIndexSnapshot,
  workspaceIndexCandidateSet,
  type PreparedWorkspaceIndexEntry,
  type WorkspaceIndexDirectorySnapshot,
  type WorkspaceIndexPreparationReport,
  type WorkspaceIndex,
  type WorkspaceIndexDiscoverySnapshot,
  type WorkspaceIndexDiscoveredFile,
  type WorkspaceIndexRecord,
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
  readonly elapsedMs: number;
  readonly truncated: boolean;
  readonly diagnostics: SearchDiagnostics | undefined;
  readonly coverage: ContextCoverageDiagnostics;
  readonly workspaceIndex: WorkspaceIndexPreparationReport | undefined;
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
  readonly fs?: WorkspaceFs;
  readonly nowMs?: () => number;
  readonly searchHints?: SearchHints | undefined;
  readonly signal?: AbortSignal;
  readonly workspaceIndex?: WorkspaceIndex | undefined;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function clampToBytes(text: string, maxBytes: number): { excerpt: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { excerpt: "", truncated: true };
  }
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) {
    return { excerpt: text, truncated: false };
  }
  const buffer = encoded.subarray(0, maxBytes);
  const excerpt = new TextDecoder("utf-8", { fatal: false }).decode(buffer).replace(/�+$/u, "");
  return { excerpt, truncated: true };
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
}

const EMPTY_COVERAGE_STATS: CoverageStats = {
  filesDiscovered: 0,
  filesAfterPolicy: 0,
  ignoredByDiscovery: 0,
  deniedByDiscovery: 0,
  depthPrunedByDiscovery: 0,
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
    ignoredByDiscovery: stats.ignoredByDiscovery,
    deniedByDiscovery: stats.deniedByDiscovery,
    depthPrunedByDiscovery: stats.depthPrunedByDiscovery,
    matchesReturned: inputs.matchesReturned,
    elapsedMs: inputs.elapsedMs,
    limits: {
      maxFilesScanned: inputs.limits.maxFilesScanned,
      maxMatchesReturned: inputs.limits.maxMatchesReturned,
      elapsedMsMax: inputs.limits.elapsedMsMax,
    },
  };
}

function abortedSearchResult(
  elapsedMs: number,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
  diagnostics?: SearchDiagnostics,
  candidateTruncated = false,
): SearchResult {
  const truncationReasons = new Set<ContextCoverageTruncationReason>(["aborted"]);
  return {
    atoms: [],
    candidates: [],
    filesScanned: 0,
    elapsedMs,
    truncated: true,
    diagnostics,
    coverage: buildCoverageDiagnostics({
      diagnostics,
      filesScanned: 0,
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

// ─── Public API ───────────────────────────────────────────────────────────────

// Yields to the event loop every SCAN_YIELD_INTERVAL files so a large cold NFS/SMB workspace
// cannot block the event loop for multiple seconds. discoverFiles() itself remains synchronous
// (sync walk is load-bearing for importGraph/testSourcePairing callers); the yield here covers
// the already-async per-file scan pass where the loop overhead is measurable.
const SCAN_YIELD_INTERVAL = 64;

function buildSearchTextRunner(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  deps: Required<Pick<FacadeDeps, "fs" | "nowMs">> & Pick<FacadeDeps, "searchHints" | "signal">,
): SearchTextRunner {
  return {
    scope,
    limits: {
      ...limits,
      maxMatchesReturned: Math.min(limits.maxMatchesReturned, query.maxResults),
    },
    fs: deps.fs,
    nowMs: deps.nowMs,
    startMs: deps.nowMs(),
    signal: deps.signal,
    matcher: buildMatcher(query),
    fingerprint: fingerprintFor(query),
    policy: resolveSearchPolicy(scope.relativePaths.length > 0, deps.searchHints),
    query,
  };
}

interface SearchWorkspaceIndexSession {
  readonly candidateSet: CandidateSet;
  readonly preparedEntries: ReadonlyMap<string, PreparedWorkspaceIndexEntry>;
  readonly recordByPath: Map<string, WorkspaceIndexRecord>;
  readonly discoveryByPath: Map<string, WorkspaceIndexDiscoveredFile>;
  dirty: boolean;
  readonly report: WorkspaceIndexPreparationReport | undefined;
  readonly persist: () => Promise<void>;
}

function discoveredFileSnapshot(
  scopePath: string,
  sizeBytes: number,
  mtimeMs: number | undefined,
): WorkspaceIndexDiscoveredFile {
  return {
    scopePath,
    sizeBytes,
    ...(mtimeMs !== undefined ? { mtimeMs: Math.trunc(mtimeMs) } : {}),
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

function directoryFingerprint(entries: readonly { readonly name: string; readonly isDirectory: boolean; readonly isFile: boolean }[]): string {
  return createHash("sha256").update(JSON.stringify(
    entries
      .map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
        isFile: entry.isFile,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  )).digest("hex");
}

function ancestorDirectoryPaths(scopePath: string): readonly string[] {
  const normalized = scopePath.split("\\").join("/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  const paths: string[] = [""];
  let current = "";
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current.length === 0 ? (parts[index] ?? "") : `${current}/${parts[index] ?? ""}`;
    paths.push(current);
  }
  return [...new Set(paths)];
}

function buildWorkspaceIndexDirectories(
  workspaceRoot: string,
  discoveryByPath: ReadonlyMap<string, WorkspaceIndexDiscoveredFile>,
  fs: WorkspaceFs,
): readonly WorkspaceIndexDirectorySnapshot[] {
  const directories = new Set<string>();
  for (const scopePath of discoveryByPath.keys()) {
    for (const ancestor of ancestorDirectoryPaths(scopePath)) {
      directories.add(ancestor);
    }
  }
  const snapshots: WorkspaceIndexDirectorySnapshot[] = [];
  for (const scopePath of [...directories].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const absolutePath = scopePath.length === 0 ? workspaceRoot : resolveWithinWorkspace(workspaceRoot, scopePath);
    try {
      const entries = fs.readDir(absolutePath);
      const stat = fs.stat(absolutePath);
      snapshots.push({
        scopePath,
        fingerprint: directoryFingerprint(entries),
        ...(typeof stat.mtimeMs === "number" ? { mtimeMs: Math.trunc(stat.mtimeMs) } : {}),
      });
    } catch {
      snapshots.push({ scopePath, fingerprint: "unavailable", mtimeMs: undefined });
    }
  }
  return snapshots;
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

function workspaceIndexScopeKey(
  scope: SearchScope,
  runner: SearchTextRunner,
): ReturnType<typeof buildWorkspaceIndexScopeKey> {
  return buildWorkspaceIndexScopeKey(
    scope,
    workspaceIndexPolicyShape(runner),
    runner.limits.maxBytesPerFileScanned,
    runner.limits.maxFilesScanned,
  );
}

function seedWorkspaceIndexCaches(
  prepared: ReturnType<typeof prepareWorkspaceIndexSnapshot> | undefined,
  candidateSet: CandidateSet,
): Pick<
  SearchWorkspaceIndexSession,
  "preparedEntries" | "recordByPath" | "discoveryByPath"
> {
  const preparedEntries = new Map<string, PreparedWorkspaceIndexEntry>();
  const recordByPath = new Map<string, WorkspaceIndexRecord>();
  const discoveryByPath = new Map<string, WorkspaceIndexDiscoveredFile>();
  if (prepared === undefined) {
    for (const file of candidateSet.files) {
      discoveryByPath.set(
        file.relativePath,
        discoveredFileSnapshot(file.relativePath, file.sizeBytes, undefined),
      );
    }
    return { preparedEntries, recordByPath, discoveryByPath };
  }
  for (const entry of prepared.entries) {
    preparedEntries.set(entry.scopePath, entry);
    discoveryByPath.set(
      entry.scopePath,
      discoveredFileSnapshot(entry.scopePath, entry.file.sizeBytes, entry.mtimeMs),
    );
    if (entry.record !== undefined) {
      recordByPath.set(entry.scopePath, entry.record);
    }
  }
  return { preparedEntries, recordByPath, discoveryByPath };
}

function persistWorkspaceIndexSession(
  workspaceIndex: WorkspaceIndex,
  scope: SearchScope,
  runner: SearchTextRunner,
  session: Omit<SearchWorkspaceIndexSession, "persist">,
): () => Promise<void> {
  const scopeKey = workspaceIndexScopeKey(scope, runner);
  return async (): Promise<void> => {
    if (!session.dirty) {
      return;
    }
    const directories = buildWorkspaceIndexDirectories(
      scope.workspace.root,
      session.discoveryByPath,
      runner.fs,
    );
    await workspaceIndex.saveSnapshot(
      scopeKey,
      buildWorkspaceIndexSnapshot({
        scope,
        policy: workspaceIndexPolicyShape(runner),
        maxBytesPerFileScanned: runner.limits.maxBytesPerFileScanned,
        maxFilesScanned: runner.limits.maxFilesScanned,
        discovery: candidateSetDiscoverySnapshot(
          session.candidateSet,
          [...session.discoveryByPath.values()],
          directories,
        ),
        records: session.recordByPath.values(),
      }),
    );
  };
}

async function buildSearchWorkspaceIndexSession(
  scope: SearchScope,
  query: RetrievalQuery,
  runner: SearchTextRunner,
  limits: SearchLimits,
  workspaceIndex: WorkspaceIndex,
): Promise<SearchWorkspaceIndexSession> {
  const snapshot = await workspaceIndex.loadSnapshot(workspaceIndexScopeKey(scope, runner));
  const freshSnapshot =
    snapshot !== undefined && isWorkspaceIndexSnapshotFresh(snapshot, scope.workspace, runner.fs)
      ? snapshot
      : undefined;
  const prepared =
    freshSnapshot === undefined
      ? undefined
      : prepareWorkspaceIndexSnapshot(freshSnapshot, scope.workspace, runner.fs);
  const candidateSet =
    prepared === undefined
      ? gatherCandidates(scope, query, limits, runner.fs, runner.policy)
      : workspaceIndexCandidateSet(prepared, query, runner.policy);
  const session: Omit<SearchWorkspaceIndexSession, "persist"> = {
    candidateSet,
    ...seedWorkspaceIndexCaches(prepared, candidateSet),
    dirty: prepared === undefined,
    report: prepared?.report,
  };
  return { ...session, persist: persistWorkspaceIndexSession(workspaceIndex, scope, runner, session) };
}

async function runScanLoop(
  runner: SearchTextRunner,
  candidateSet: CandidateSet,
  state: RunState,
  atoms: EvidenceAtom[],
  candidates: CandidateFile[],
): Promise<void> {
  let loopIndex = 0;
  for (const file of candidateSet.files) {
    if (hitLimit(runner, state)) {
      break;
    }
    loopIndex += 1;
    if (loopIndex % SCAN_YIELD_INTERVAL === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (hitLimit(runner, state)) {
        break;
      }
    }
    await scanFile(runner, file, state, atoms, candidates);
  }
}

interface CompletedSearchResultInputs {
  readonly atoms: readonly EvidenceAtom[];
  readonly candidates: readonly CandidateFile[];
  readonly filesScanned: number;
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
    elapsedMs: inputs.elapsedMs,
    truncated: inputs.truncated,
    diagnostics: inputs.diagnostics,
    coverage: buildCoverageDiagnostics({
      diagnostics: inputs.diagnostics,
      filesScanned: inputs.filesScanned,
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

function buildSearchTextDeps(
  deps: FacadeDeps,
): Required<Pick<FacadeDeps, "fs" | "nowMs">> & Pick<FacadeDeps, "searchHints" | "signal"> {
  return {
    fs: deps.fs ?? nodeWorkspaceFs,
    nowMs: deps.nowMs ?? Date.now,
    ...(deps.searchHints !== undefined ? { searchHints: deps.searchHints } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  };
}

function searchTextRunner(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  deps: FacadeDeps,
): SearchTextRunner {
  return buildSearchTextRunner(scope, query, limits, buildSearchTextDeps(deps));
}

function candidateSetForSearch(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  runner: SearchTextRunner,
  session: SearchWorkspaceIndexSession | undefined,
): CandidateSet {
  return session?.candidateSet ?? gatherCandidates(scope, query, limits, runner.fs, runner.policy);
}

function indexedSearchRunner(
  runner: SearchTextRunner,
  session: SearchWorkspaceIndexSession | undefined,
): SearchTextRunner {
  if (session === undefined) {
    return runner;
  }
  return {
    ...runner,
    workspaceIndex: {
      entries: session.preparedEntries,
      onRecord: (record: WorkspaceIndexRecord): void => {
        const previousRecord = session.recordByPath.get(record.scopePath);
        const discovery = discoveredFileSnapshot(record.scopePath, record.sizeBytes, record.mtimeMs);
        const previousDiscovery = session.discoveryByPath.get(record.scopePath);
        if (!sameWorkspaceIndexRecord(previousRecord, record) || !sameDiscoveryFile(previousDiscovery, discovery)) {
          session.dirty = true;
        }
        session.recordByPath.set(record.scopePath, record);
        session.discoveryByPath.set(record.scopePath, discovery);
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

async function persistSearchTextSession(
  session: SearchWorkspaceIndexSession | undefined,
): Promise<void> {
  if (session !== undefined) {
    await session.persist();
  }
}

function workspaceIndexReport(
  session: SearchWorkspaceIndexSession | undefined,
): WorkspaceIndexPreparationReport | undefined {
  if (session === undefined) {
    return undefined;
  }
  if (session.report !== undefined) {
    return session.report;
  }
  return {
    discoveredEntries: session.candidateSet.diagnostics.filesDiscovered,
    retainedEntries: session.discoveryByPath.size,
    indexedRecords: session.recordByPath.size,
    reusedRecords: 0,
    staleRecords: 0,
    skippedEntries: Math.max(
      0,
      session.candidateSet.diagnostics.filesDiscovered - session.discoveryByPath.size,
    ),
    deletedEntries: 0,
    droppedRecords: 0,
  };
}

export async function searchText(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
  deps: FacadeDeps = {},
): Promise<SearchResult> {
  assertWorkspaceRoot(scope.workspace);
  assertQuery(query);
  if (query.kind === "file-pattern") {
    throw new RepoSearchInvalidQueryError("searchText does not accept file-pattern queries");
  }
  const runner = searchTextRunner(scope, query, limits, deps);
  if (isAborted(deps.signal)) {
    return abortedSearchResult(elapsed(runner), limits);
  }
  const workspaceIndexSession =
    deps.workspaceIndex === undefined
      ? undefined
      : await buildSearchWorkspaceIndexSession(scope, query, runner, limits, deps.workspaceIndex);
  const searchRunner = indexedSearchRunner(runner, workspaceIndexSession);
  const candidateSet = candidateSetForSearch(scope, query, limits, runner, workspaceIndexSession);
  if (isAborted(deps.signal)) {
    return abortedSearchResult(
      elapsed(searchRunner),
      limits,
      candidateSet.diagnostics,
      candidateSet.truncated,
    );
  }
  const atoms: EvidenceAtom[] = [];
  const candidates: CandidateFile[] = [];
  const { state, truncationReasons } = searchRunState(candidateSet);
  await runScanLoop(searchRunner, candidateSet, state, atoms, candidates);
  await persistSearchTextSession(workspaceIndexSession);
  return completedSearchTextResult(
    searchRunner,
    candidateSet,
    state,
    atoms,
    candidates,
    truncationReasons,
    workspaceIndexReport(workspaceIndexSession),
  );
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
  signal?: AbortSignal,
): boolean {
  if (isAborted(signal)) {
    state.truncationReasons.add("aborted");
    return true;
  }
  if (state.atoms.length >= maxMatches) {
    state.truncationReasons.add("match-cap");
    return true;
  }
  if (nowMs() - startMs > limits.elapsedMsMax) {
    state.truncationReasons.add("timeout");
    return true;
  }
  return false;
}

function collectFileListings(
  ctx: FindFilesContext,
  candidateSet: CandidateSet,
  policy: ReturnType<typeof resolveSearchPolicy>,
  inputs: {
    readonly limits: SearchLimits;
    readonly maxMatches: number;
    readonly startMs: number;
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

function findFilesSync(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  fs: WorkspaceFs,
  nowMs: () => number,
  hints: SearchHints | undefined,
  signal?: AbortSignal,
): SearchResult {
  const startMs = nowMs();
  if (isAborted(signal)) {
    return abortedSearchResult(0, limits);
  }
  // Honor the per-query cap alongside the global limit (Finding 2).
  const effectiveMaxMatches = Math.min(limits.maxMatchesReturned, query.maxResults);
  const ctx: FindFilesContext = {
    scope,
    regex: compileGlob(query.text, query.caseSensitive),
    fingerprint: fingerprintFor(query),
    nowMs,
  };
  const policy = resolveSearchPolicy(scope.relativePaths.length > 0, hints);
  const candidateSet: CandidateSet = gatherCandidates(scope, query, limits, fs, policy);
  if (isAborted(signal)) {
    return abortedSearchResult(nowMs() - startMs, limits, candidateSet.diagnostics, candidateSet.truncated);
  }
  const state = collectFileListings(ctx, candidateSet, policy, {
    limits,
    maxMatches: effectiveMaxMatches,
    startMs,
    ...(signal !== undefined ? { signal } : {}),
  });
  const elapsedMs = nowMs() - startMs;
  return completedSearchResult({
    atoms: state.atoms,
    candidates: state.candidates,
    filesScanned: state.filesScanned,
    matchesReturned: state.atoms.length,
    elapsedMs,
    truncated: state.truncated,
    diagnostics: candidateSet.diagnostics,
    limits: { ...limits, maxMatchesReturned: effectiveMaxMatches },
    candidateTruncated: candidateSet.truncated,
    truncationReasons: state.truncationReasons,
    workspaceIndex: undefined,
  });
}

export async function findFiles(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
  deps: FacadeDeps = {},
): Promise<SearchResult> {
  assertWorkspaceRoot(scope.workspace);
  assertQuery(query);
  if (query.kind !== "file-pattern") {
    throw new RepoSearchInvalidQueryError("findFiles requires a file-pattern query");
  }
  const fs = deps.fs ?? nodeWorkspaceFs;
  const nowMs = deps.nowMs ?? Date.now;
  return await Promise.resolve(
    findFilesSync(scope, query, limits, fs, nowMs, deps.searchHints, deps.signal),
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
  return scopePath.split("\\").join("/");
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
    if (isIoError(err)) {
      throw new RepoSearchUnsupportedFileError(
        `cannot read excerpt of unreadable file: ${scopePath}`,
        "io-error",
      );
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

export async function readExcerpt(
  scope: SearchScope,
  request: ReadExcerptRequest,
  deps: FacadeDeps = {},
): Promise<ReadExcerptResult> {
  if (isAborted(deps.signal)) {
    throw new RepoSearchUnsupportedFileError("repo-search operation aborted", "aborted");
  }
  assertExcerptRange(request);
  assertWorkspaceRoot(scope.workspace);
  assertExcerptWithinSelectedScope(scope, request.scopePath);
  if (isImageScopePath(request.scopePath)) {
    throw new RepoSearchUnsupportedFileError(
      `cannot read excerpt of image file: ${request.scopePath}`,
      "binary",
    );
  }
  const fs = deps.fs ?? nodeWorkspaceFs;
  const nowMs = deps.nowMs ?? Date.now;
  const target = resolveExcerptTarget(scope, request.scopePath, fs);
  assertExcerptReadableByPolicy(request.scopePath, target.realScopePath);
  assertExcerptWithinSelectedScope(scope, target.realScopePath);
  const stat = fs.stat(target.path);
  await assertExcerptNotBinary(fs, target.path, stat.size, request.scopePath);
  if (isAborted(deps.signal)) {
    throw new RepoSearchUnsupportedFileError("repo-search operation aborted", "aborted");
  }
  // Read enough of the file to reach the requested line window (bounded by MAX_EXCERPT_FILE_BYTES),
  // then clamp the returned content to the caller's request.maxBytes budget. The read cap is
  // intentionally larger than request.maxBytes so a window deep in a multi-kibibyte file is still
  // reachable instead of the whole file being rejected.
  const content = readWorkspaceFile(
    scope.workspace,
    request.scopePath,
    { maxBytes: MAX_EXCERPT_FILE_BYTES },
    fs,
  );
  const allLines = content.text.split("\n");
  const slice = allLines.slice(request.startLine - 1, request.endLine).join("\n");
  const clamped = clampToBytes(slice, request.maxBytes);
  const atom = buildAtom({
    scopeId: scope.scopeId,
    scopePath: request.scopePath,
    lineRange: { startLine: request.startLine, endLine: request.endLine },
    provenanceKind: "excerpt-read",
    tool: "repo.readExcerpt",
    queryFingerprint: buildExcerptFingerprint(request),
    score: 1,
    emittedAtMs: nowMs(),
  });
  return { atom, content: clamped.excerpt, truncated: clamped.truncated };
}
