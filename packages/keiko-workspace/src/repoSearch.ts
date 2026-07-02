// Governed, deterministic, audit-friendly repository search facade (Epic #177, Issue #179).
// Composes the existing workspace primitives — discovery, deny policy, realpath gate,
// readWorkspaceFile, plus the new binaryDetect and stableId modules — into three public
// APIs that emit normalized EvidenceAtom output: searchText, findFiles, readExcerpt.
// Pure JS (no subprocess, no ripgrep — deferred). Every fs touch goes through the
// WorkspaceFs port. Stable IDs are reproducible across runs given the same inputs.

import type {
  CandidateFile,
  EvidenceAtom,
  LineRange,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  isValidScopePath,
  validateRetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { redact } from "@oscharko-dev/keiko-security";
import { readWorkspaceFile } from "./discovery.js";
import {
  FileTooLargeError,
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
  collectFileMatches,
  emitFileMatches,
  elapsed,
  gatherCandidates,
  hitScanLimit,
  isImageScopePath,
  isIoError,
  probeBinary,
  type CandidateSet,
  type FileMatches,
  type RunState,
  type SearchTextRunner,
} from "./repoSearchScan.js";
import {
  lowValueRescuePolicy,
  policyOmissionReason,
  resolveSearchPolicy,
  type SearchDiagnostics,
  type SearchHints,
  type SearchPolicy,
} from "./repoSearchPolicy.js";
import type { WorkspaceInfo } from "./types.js";

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
  readonly semanticSearchProvider?: SemanticSearchProvider | undefined;
}

export interface SemanticSearchRequest {
  readonly scope: SearchScope;
  readonly query: RetrievalQuery;
  readonly limits: SearchLimits;
  readonly candidatePaths: readonly string[];
  readonly maxResults: number;
  readonly signal?: AbortSignal | undefined;
}

export interface SemanticSearchHit {
  readonly scopePath: string;
  readonly lineRange?: LineRange | undefined;
  readonly score: number;
}

export interface SemanticSearchProvider {
  readonly search: (request: SemanticSearchRequest) => Promise<readonly SemanticSearchHit[]>;
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

function decodeUtf8Prefix(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/�+$/u, "");
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

function abortedSearchResult(elapsedMs: number): SearchResult {
  return {
    atoms: [],
    candidates: [],
    filesScanned: 0,
    oversizedFilesScanned: 0,
    elapsedMs,
    truncated: true,
    diagnostics: undefined,
  };
}

function isValidLineRange(range: LineRange | undefined): boolean {
  return (
    range === undefined ||
    (Number.isInteger(range.startLine) &&
      Number.isInteger(range.endLine) &&
      range.startLine >= 1 &&
      range.endLine >= range.startLine)
  );
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function semanticHitAtom(
  scope: SearchScope,
  query: RetrievalQuery,
  nowMs: number,
  hit: SemanticSearchHit,
): EvidenceAtom {
  return buildAtom({
    scopeId: scope.scopeId,
    scopePath: hit.scopePath,
    lineRange: hit.lineRange,
    provenanceKind: "semantic-search",
    tool: "repo.semanticSearch",
    queryFingerprint: fingerprintFor(query),
    score: clampUnit(hit.score),
    emittedAtMs: nowMs,
  });
}

function isUsableSemanticHit(hit: SemanticSearchHit, allowedPaths: ReadonlySet<string>): boolean {
  return (
    Number.isFinite(hit.score) &&
    hit.score > 0 &&
    allowedPaths.has(hit.scopePath) &&
    isValidScopePath(hit.scopePath, { mustBeRelative: true }) &&
    isValidLineRange(hit.lineRange)
  );
}

function appendSemanticHit(inputs: {
  readonly atoms: EvidenceAtom[];
  readonly seen: Set<string>;
  readonly runner: SearchTextRunnerWithSemantic;
  readonly hit: SemanticSearchHit;
}): void {
  const atom = semanticHitAtom(
    inputs.runner.scope,
    inputs.runner.query,
    inputs.runner.nowMs(),
    inputs.hit,
  );
  if (inputs.seen.has(atom.stableId)) {
    return;
  }
  inputs.seen.add(atom.stableId);
  inputs.atoms.push(atom);
}

function compareAtoms(a: EvidenceAtom, b: EvidenceAtom): number {
  return (
    b.score - a.score ||
    a.scopePath.localeCompare(b.scopePath) ||
    a.stableId.localeCompare(b.stableId)
  );
}

async function semanticAtoms(
  runner: SearchTextRunnerWithSemantic,
  candidateSet: CandidateSet,
): Promise<readonly EvidenceAtom[]> {
  const provider = runner.semanticSearchProvider;
  if (provider === undefined || runner.query.kind === "regex") {
    return [];
  }
  const candidatePaths = candidateSet.files.map((file) => file.relativePath);
  const allowedPaths = new Set(candidatePaths);
  const maxResults = Math.min(runner.limits.maxMatchesReturned, runner.query.maxResults);
  if (maxResults <= 0 || isAborted(runner.signal)) {
    return [];
  }
  const hits = await provider.search({
    scope: runner.scope,
    query: runner.query,
    limits: runner.limits,
    candidatePaths,
    maxResults,
    ...(runner.signal !== undefined ? { signal: runner.signal } : {}),
  });
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (atoms.length >= maxResults) {
      break;
    }
    if (!isUsableSemanticHit(hit, allowedPaths)) {
      continue;
    }
    appendSemanticHit({ atoms, seen, runner, hit });
  }
  return atoms;
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
const SCAN_YIELD_INTERVAL = 64;
const PROJECT_METADATA_SCAN_MIN_FILES = 256;
const PROJECT_METADATA_SCAN_MAX_FILES = 512;

type SearchTextRunnerWithSemantic = SearchTextRunner & {
  readonly semanticSearchProvider?: SemanticSearchProvider | undefined;
};

interface SearchTextCollection {
  readonly atoms: readonly EvidenceAtom[];
  readonly candidates: readonly CandidateFile[];
  readonly state: RunState;
}

function effectiveScanCandidateLimit(
  runner: SearchTextRunner,
  candidateCount: number,
): number {
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

function buildSearchTextRunner(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  deps: Required<Pick<FacadeDeps, "fs" | "nowMs">> & Pick<FacadeDeps, "searchHints" | "signal">,
  semanticSearchProvider?: SemanticSearchProvider,
): SearchTextRunnerWithSemantic {
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
    ...(semanticSearchProvider !== undefined ? { semanticSearchProvider } : {}),
  };
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
  matches.sort((a, b) => b.maxScore - a.maxScore || a.order - b.order);
  for (const fileMatches of matches) {
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

function searchResultFromState(inputs: {
  readonly runner: SearchTextRunnerWithSemantic;
  readonly candidateSet: CandidateSet;
  readonly atoms: readonly EvidenceAtom[];
  readonly candidates: readonly CandidateFile[];
  readonly state: RunState;
}): SearchResult {
  return {
    atoms: inputs.atoms,
    candidates: inputs.candidates,
    filesScanned: inputs.state.filesScanned,
    oversizedFilesScanned: inputs.state.oversizedFilesScanned ?? 0,
    elapsedMs: elapsed(inputs.runner),
    truncated: inputs.state.truncated,
    diagnostics: inputs.candidateSet.diagnostics,
  };
}

async function collectSearchTextAtoms(
  runner: SearchTextRunnerWithSemantic,
  candidateSet: CandidateSet,
): Promise<SearchTextCollection> {
  const atoms: EvidenceAtom[] = [];
  const candidates: CandidateFile[] = [];
  const state = buildRunState(candidateSet);
  await runScanLoop(runner, candidateSet, state, atoms, candidates);
  const semantic = await semanticAtoms(runner, candidateSet);
  const cap = Math.min(runner.limits.maxMatchesReturned, runner.query.maxResults);
  const mergedAtoms = mergeSearchAtoms(atoms, semantic, cap);
  if (semantic.length > 0 && atoms.length + semantic.length > mergedAtoms.length) {
    state.truncated = true;
  }
  return { atoms: mergedAtoms, candidates, state };
}

function shouldConsiderLowValueRescue(
  runner: SearchTextRunnerWithSemantic,
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

function remainingScanLimit(
  runner: SearchTextRunnerWithSemantic,
  primary: SearchTextCollection,
): number {
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

function rescueRunner(
  runner: SearchTextRunnerWithSemantic,
  maxFilesScanned: number,
): SearchTextRunnerWithSemantic {
  return {
    ...runner,
    limits: { ...runner.limits, maxFilesScanned },
    policy: lowValueRescuePolicy(runner.policy),
  };
}

function combineStates(primary: RunState, rescue: RunState): RunState {
  return {
    filesScanned: primary.filesScanned + rescue.filesScanned,
    matchesReturned: primary.matchesReturned + rescue.matchesReturned,
    oversizedFilesScanned:
      (primary.oversizedFilesScanned ?? 0) + (rescue.oversizedFilesScanned ?? 0),
    truncated: primary.truncated || rescue.truncated,
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
  runner: SearchTextRunnerWithSemantic,
  primary: SearchTextCollection,
  rescue: SearchTextCollection,
): SearchTextCollection {
  const cap = Math.min(runner.limits.maxMatchesReturned, runner.query.maxResults);
  const atoms = mergeSearchAtoms(primary.atoms, rescue.atoms, cap);
  const selectedPaths = new Set(atoms.map((atom) => atom.scopePath));
  return {
    atoms,
    candidates: [...primary.candidates, ...rescue.candidates].filter(
      (candidate) => !selectedPaths.has(candidate.scopePath),
    ),
    state: combineStates(primary.state, rescue.state),
  };
}

async function rescueLowValueEvidence(
  runner: SearchTextRunnerWithSemantic,
  primarySet: CandidateSet,
  primary: SearchTextCollection,
): Promise<{ readonly collection: SearchTextCollection; readonly candidateSet: CandidateSet }> {
  if (
    !shouldConsiderLowValueRescue(runner, primary) ||
    !hasLowValueEvidenceSkipped(primary, primarySet.diagnostics)
  ) {
    return { collection: primary, candidateSet: primarySet };
  }
  const maxFilesScanned = remainingScanLimit(runner, primary);
  const lowValueRunner = rescueRunner(runner, maxFilesScanned);
  const gatheredSet = gatherCandidates(
    runner.scope,
    runner.query,
    lowValueRunner.limits,
    runner.fs,
    lowValueRunner.policy,
  );
  const lowValueSet = lowValueOnlyCandidateSet(gatheredSet, runner.policy);
  if (lowValueSet.files.length === 0) {
    return {
      collection: primary,
      candidateSet: {
        ...primarySet,
        diagnostics: diagnosticsWithLowValueRescue(
          primarySet.diagnostics,
          0,
          0,
        ),
      },
    };
  }
  const rescue = await collectSearchTextAtoms(lowValueRunner, lowValueSet);
  return {
    collection: mergeCollections(runner, primary, rescue),
    candidateSet: {
      ...primarySet,
      diagnostics: diagnosticsWithLowValueRescue(
        primarySet.diagnostics,
        lowValueSet.files.length,
        rescue.state.filesScanned,
      ),
    },
  };
}

export async function searchText(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
  deps: FacadeDeps = {},
): Promise<SearchResult> {
  assertWorkspaceRoot(scope.workspace);
  assertSearchTextQuery(query);
  const fs = deps.fs ?? nodeWorkspaceFs;
  const nowMs = deps.nowMs ?? Date.now;
  const runner = buildSearchTextRunner(
    scope,
    query,
    limits,
    {
      fs,
      nowMs,
      ...(deps.searchHints !== undefined ? { searchHints: deps.searchHints } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    },
    deps.semanticSearchProvider,
  );
  if (isAborted(deps.signal)) {
    return abortedSearchResult(elapsed(runner));
  }
  const candidateSet: CandidateSet = gatherCandidates(scope, query, limits, fs, runner.policy);
  if (isAborted(deps.signal)) {
    return { ...abortedSearchResult(elapsed(runner)), diagnostics: candidateSet.diagnostics };
  }
  const primary = await collectSearchTextAtoms(runner, candidateSet);
  const result = await rescueLowValueEvidence(runner, candidateSet, primary);
  return searchResultFromState({
    runner,
    candidateSet: result.candidateSet,
    ...result.collection,
  });
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
  return (
    isAborted(signal) ||
    state.filesScanned >= limits.maxFilesScanned ||
    state.atoms.length >= maxMatches ||
    nowMs() - startMs > limits.elapsedMsMax
  );
}

function collectFileListings(
  ctx: FindFilesContext,
  candidateSet: CandidateSet,
  policy: SearchPolicy,
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
  return {
    atoms,
    candidates: omitSelectedCandidates(
      [...primary.candidates, ...rescue.candidates],
      selectedPathSet(atoms),
    ),
    filesScanned: primary.filesScanned + rescue.filesScanned,
    truncated: primary.truncated || rescue.truncated,
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

function rescueLowValueFileListings(
  ctx: FindFilesContext,
  inputs: {
    readonly query: RetrievalQuery;
    readonly limits: SearchLimits;
    readonly fs: WorkspaceFs;
    readonly policy: SearchPolicy;
    readonly candidateSet: CandidateSet;
    readonly state: FindFilesState;
    readonly maxMatches: number;
    readonly startMs: number;
    readonly signal?: AbortSignal | undefined;
  },
): { readonly state: FindFilesState; readonly candidateSet: CandidateSet } {
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
  const gatheredSet = gatherCandidates(
    ctx.scope,
    inputs.query,
    lowValueLimits,
    inputs.fs,
    lowValuePolicy,
  );
  const lowValueSet = lowValueOnlyCandidateSet(gatheredSet, inputs.policy);
  const rescueState = collectFileListings(ctx, lowValueSet, lowValuePolicy, {
    limits: lowValueLimits,
    maxMatches: inputs.maxMatches,
    startMs: inputs.startMs,
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
): SearchResult {
  return {
    atoms: state.atoms,
    candidates: state.candidates,
    filesScanned: state.filesScanned,
    oversizedFilesScanned: 0,
    elapsedMs,
    truncated: state.truncated,
    diagnostics: candidateSet.diagnostics,
  };
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
    return abortedSearchResult(0);
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
    return { ...abortedSearchResult(nowMs() - startMs), diagnostics: candidateSet.diagnostics };
  }
  const state = collectFileListings(ctx, candidateSet, policy, {
    limits,
    maxMatches: effectiveMaxMatches,
    startMs,
    ...(signal !== undefined ? { signal } : {}),
  });
  const rescued = rescueLowValueFileListings(ctx, {
    query,
    limits,
    fs,
    policy,
    candidateSet,
    state,
    maxMatches: effectiveMaxMatches,
    startMs,
    ...(signal !== undefined ? { signal } : {}),
  });
  return fileListingResult(rescued.state, rescued.candidateSet, nowMs() - startMs);
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

async function readExcerptLines(
  scope: SearchScope,
  request: ReadExcerptRequest,
  fs: WorkspaceFs,
  targetPath: string,
): Promise<readonly string[]> {
  try {
    return readWorkspaceFile(
      scope.workspace,
      request.scopePath,
      { maxBytes: MAX_EXCERPT_FILE_BYTES },
      fs,
    ).text.split("\n");
  } catch (err) {
    if (!(err instanceof FileTooLargeError)) {
      throw err;
    }
    const readFileBytes = fs.readFileBytes;
    if (readFileBytes === undefined) {
      throw err;
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFileBytes(targetPath, MAX_EXCERPT_FILE_BYTES);
    } catch (readErr) {
      if (isIoError(readErr)) {
        throw new RepoSearchUnsupportedFileError(
          `cannot read excerpt of unreadable file: ${request.scopePath}`,
          "io-error",
        );
      }
      throw readErr;
    }
    const lines = redact(decodeUtf8Prefix(bytes)).split("\n");
    if (request.startLine > lines.length) {
      throw err;
    }
    return lines;
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
  // then clamp the returned content to the caller's request.maxBytes budget. For files larger than
  // the read cap, the optional raw-byte port can still serve early windows from the bounded prefix.
  const allLines = await readExcerptLines(scope, request, fs, target.path);
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
